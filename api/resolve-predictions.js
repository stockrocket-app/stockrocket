// StockRocket -- Resolve Predictions Cron (Vercel Edge Function)
// --------------------------------------------------------
// Runs daily. Pulls every prediction whose target_date has arrived and
// that hasn't been resolved yet. Fetches the current price via the same
// multi-source chain as trades/predictions submission (server-authoritative).
// Computes accuracy + points and writes back.
//
// Scoring rule (v0):
//   direction correct? +40 pts base
//   proximity bonus?   +60 pts * max(0, 1 - error_pct / 0.10)
//                       where error_pct = |resolved - target| / submitted
//   final points       = (direction + proximity) * confidence (1..5)
//   wrong direction    = 0 pts total, outcome = 'wrong_direction'
//   no live price      = null, outcome = 'no_data' (retried next run)
//
// Max per prediction = 100 raw * 5 confidence = 500 points.
//
// Cron schedule (vercel.json): 0 22 * * *  (22:00 UTC daily)
//   EDT: 18:00 local (2h after US close)
//   EST: 17:00 local (1h after US close)
// For v0 we use whatever price is live at run-time as the "closing" price.
// v1 should pull end-of-day candles via Finnhub for stocks.
//
// Auth: no user auth required -- this endpoint is invoked by Vercel Cron
// or manually via a CRON_SECRET header. It only reads/writes the DB.
//
// Env vars required:
//   SUPABASE_URL
//   SUPABASE_SERVICE_KEY
//   FINNHUB_KEY
//   CRON_SECRET   (optional; if set, callers must pass Authorization: Bearer <secret>)

export const config = { runtime: 'edge' };

const DIRECTION_PTS = 40;
const PROXIMITY_MAX_PTS = 60;
const PROXIMITY_MAX_ERROR = 0.10; // 10%+ error = zero proximity points

const COINGECKO_IDS = {
  BTC: 'bitcoin',
  ETH: 'ethereum',
  SOL: 'solana',
  ADA: 'cardano',
  DOT: 'polkadot',
};

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

export default async function handler(req) {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

  // Optional secret gate. Vercel Cron injects Authorization header if CRON_SECRET is set.
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const auth = req.headers.get('authorization') || '';
    if (auth !== `Bearer ${cronSecret}`) {
      return json({ error: 'cron_auth_failed' }, 401);
    }
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    return json({ error: 'supabase_not_configured' }, 500);
  }

  const db = supabase(SUPABASE_URL, SUPABASE_SERVICE_KEY);

  // Today's date as YYYY-MM-DD (UTC). We resolve anything where target_date <= today.
  const todayISO = new Date().toISOString().slice(0, 10);

  const { data: pending, error: fetchErr } = await db.select(
    'stockrocket_predictions',
    `resolved_at=is.null&target_date=lte.${todayISO}&order=target_date.asc&limit=500`
  );
  if (fetchErr) return json({ error: 'fetch_pending_failed', detail: fetchErr }, 500);

  const summary = { found: (pending || []).length, resolved: 0, no_data: 0, errors: [] };

  // Cache prices per (symbol, asset_type) so a batch with multiple BTC
  // predictions only pulls Coinbase once.
  const priceCache = new Map();

  for (const pred of (pending || [])) {
    const key = `${pred.asset_type}:${pred.symbol}`;
    let live = priceCache.get(key);
    if (live === undefined) {
      live = await fetchLivePrice(pred.symbol, pred.asset_type);
      priceCache.set(key, live);
    }

    if (!live) {
      // No vendor available -- leave open, mark outcome no_data on this pass
      // but DO NOT set resolved_at so the next run will try again.
      summary.no_data += 1;
      continue;
    }

    const score = scorePrediction({
      direction: pred.direction,
      submittedPrice: Number(pred.submitted_price),
      targetPrice: Number(pred.target_price),
      resolvedPrice: live.price,
      confidence: Number(pred.confidence) || 1,
    });

    const { error: upErr } = await db.update(
      'stockrocket_predictions',
      `id=eq.${encodeURIComponent(pred.id)}`,
      {
        resolved_at: new Date().toISOString(),
        resolved_price: live.price,
        resolved_price_source: live.source,
        outcome: score.outcome,
        accuracy_score: score.accuracyScore,
        points_awarded: score.pointsAwarded,
      }
    );
    if (upErr) {
      summary.errors.push({ id: pred.id, error: upErr });
      continue;
    }
    summary.resolved += 1;
  }

  return json({ ok: true, date: todayISO, ...summary });
}

// ==================== Scoring ====================
function scorePrediction({ direction, submittedPrice, targetPrice, resolvedPrice, confidence }) {
  if (!isFinite(submittedPrice) || submittedPrice <= 0 ||
      !isFinite(targetPrice) || targetPrice <= 0 ||
      !isFinite(resolvedPrice) || resolvedPrice <= 0) {
    return { outcome: 'no_data', accuracyScore: null, pointsAwarded: null };
  }

  // Direction check
  const wentUp = resolvedPrice > submittedPrice;
  const wentDown = resolvedPrice < submittedPrice;
  const flat = !wentUp && !wentDown;

  let directionCorrect;
  if (flat) {
    // Treat perfectly flat as a miss for both UP and DOWN (zero-move rare but possible)
    directionCorrect = false;
  } else if (direction === 'UP') {
    directionCorrect = wentUp;
  } else if (direction === 'DOWN') {
    directionCorrect = wentDown;
  } else {
    directionCorrect = false;
  }

  if (!directionCorrect) {
    return {
      outcome: 'wrong_direction',
      accuracyScore: 0,
      pointsAwarded: 0,
    };
  }

  // Proximity: how close the resolved price was to the target
  const errorPct = Math.abs(resolvedPrice - targetPrice) / submittedPrice;
  const proximityFactor = Math.max(0, 1 - errorPct / PROXIMITY_MAX_ERROR);
  const proximityPts = PROXIMITY_MAX_PTS * proximityFactor;

  const accuracyScore = Math.min(100, DIRECTION_PTS + proximityPts);
  const confMult = Math.max(1, Math.min(5, Math.floor(confidence)));
  const pointsAwarded = accuracyScore * confMult;

  return {
    outcome: 'correct_direction',
    accuracyScore: Number(accuracyScore.toFixed(2)),
    pointsAwarded: Number(pointsAwarded.toFixed(2)),
  };
}

// ==================== Server-side live price (mirrors trades.js / predictions.js) ====================
async function fetchLivePrice(symbol, assetType) {
  if (assetType === 'crypto') return fetchLiveCryptoPrice(symbol);
  if (assetType === 'stock') return fetchLiveStockPrice(symbol);
  return null;
}

async function fetchLiveCryptoPrice(symbol) {
  try {
    const res = await fetch(
      `https://api.exchange.coinbase.com/products/${encodeURIComponent(symbol)}-USD/stats`,
      { signal: AbortSignal.timeout ? AbortSignal.timeout(4000) : undefined }
    );
    if (res.ok) {
      const d = await res.json();
      const px = Number(d?.last);
      if (isFinite(px) && px > 0) return { price: px, source: 'coinbase' };
    }
  } catch (_) { /* fall through */ }

  const id = COINGECKO_IDS[symbol];
  if (!id) return null;
  try {
    const res = await fetch(
      `https://api.coingecko.com/api/v3/simple/price?ids=${id}&vs_currencies=usd`,
      { signal: AbortSignal.timeout ? AbortSignal.timeout(5000) : undefined }
    );
    if (!res.ok) return null;
    const d = await res.json();
    const px = Number(d?.[id]?.usd);
    if (isFinite(px) && px > 0) return { price: px, source: 'coingecko' };
  } catch (_) { /* fall through */ }

  return null;
}

async function fetchLiveStockPrice(symbol) {
  const key = process.env.FINNHUB_KEY;
  if (!key) return null;
  try {
    const res = await fetch(
      `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}&token=${key}`,
      { signal: AbortSignal.timeout ? AbortSignal.timeout(5000) : undefined }
    );
    if (!res.ok) return null;
    const d = await res.json();
    const px = Number(d?.c);
    if (isFinite(px) && px > 0) return { price: px, source: 'finnhub' };
  } catch (_) { /* fall through */ }
  return null;
}

// -------- Minimal Supabase REST client --------
function supabase(url, serviceKey) {
  const base = `${url.replace(/\/$/, '')}/rest/v1`;
  const headers = {
    'apikey': serviceKey,
    'Authorization': `Bearer ${serviceKey}`,
    'Content-Type': 'application/json',
    'Prefer': 'return=representation',
  };
  return {
    async select(table, query = '') {
      const res = await fetch(`${base}/${table}?${query}`, { headers });
      if (!res.ok) return { data: null, error: await res.text() };
      return { data: await res.json(), error: null };
    },
    async update(table, query, patch) {
      const res = await fetch(`${base}/${table}?${query}`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify(patch),
      });
      if (!res.ok) return { data: null, error: await res.text() };
      return { data: await res.json(), error: null };
    },
  };
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...CORS },
  });
}
