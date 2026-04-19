// StockRocket -- Predictions API (Vercel Edge Function)
// --------------------------------------------------------
// The forcing-function companion to Teardowns. Every prediction MUST cite
// one of the unlocked Playbook cards -- reading is optional, predicting is
// where the learning happens.
//
//   GET  /api/predictions                         -> { predictions: [...my own, newest first...] }
//        /api/predictions?teardown=aapl-deep-dive -> my predictions for a teardown
//        /api/predictions?admin=1                 -> all predictions (leaderboard / resolver)
//        /api/predictions?leaderboard=1           -> aggregated points per user
//   POST /api/predictions  body: {
//         symbol, asset_type, teardown_slug?, playbook_slug, direction,
//         target_price, target_date (YYYY-MM-DD), confidence (1-5), rationale
//       }
//
// Server-authoritative submission-price snapshot:
//   We do NOT trust whatever price the client thought was live. We refetch
//   via the SAME multi-source chain used by /api/trades (Coinbase->CoinGecko
//   for crypto, Finnhub for stocks) and write that price as submitted_price.
//   This means scoring is always anchored to a price the server actually saw,
//   not a phantom UI price. Same pattern as server-authoritative execution
//   for trades (see docs/PRICE_INVARIANTS.md rules 10+11).
//
// Env vars required:
//   SUPABASE_URL
//   SUPABASE_SERVICE_KEY
//   FINNHUB_KEY   (for stock price snapshots)

export const config = { runtime: 'edge' };

const MIN_RATIONALE_CHARS = 40;
const MIN_TARGET_DAYS = 7;
const MAX_TARGET_DAYS = 365;

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
  'Access-Control-Allow-Headers': 'Content-Type, X-User-Code',
};

export default async function handler(req) {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    return json({ error: 'supabase_not_configured' }, 500);
  }

  const url = new URL(req.url);
  const db = supabase(SUPABASE_URL, SUPABASE_SERVICE_KEY);

  // Auth
  const userCode = (req.headers.get('x-user-code') || '').trim();
  if (!userCode) return json({ error: 'auth_required' }, 401);
  const me = await authenticate(db, userCode);
  if (!me) return json({ error: 'auth_denied' }, 403);

  // ==================== GET variants ====================
  if (req.method === 'GET') {
    // Aggregate leaderboard: { user_code, total_points, resolved_count, avg_score }
    if (url.searchParams.get('leaderboard') === '1') {
      const { data } = await db.select(
        'stockrocket_predictions',
        'resolved_at=not.is.null&select=user_code,points_awarded,accuracy_score&limit=10000'
      );
      const byUser = new Map();
      for (const row of (data || [])) {
        const u = row.user_code;
        if (!u) continue;
        const entry = byUser.get(u) || { user_code: u, total_points: 0, resolved_count: 0, score_sum: 0 };
        entry.total_points += Number(row.points_awarded) || 0;
        entry.resolved_count += 1;
        entry.score_sum += Number(row.accuracy_score) || 0;
        byUser.set(u, entry);
      }
      const leaderboard = Array.from(byUser.values())
        .map(e => ({
          user_code: e.user_code,
          total_points: Math.round(e.total_points),
          resolved_count: e.resolved_count,
          avg_score: e.resolved_count > 0 ? e.score_sum / e.resolved_count : 0,
        }))
        .sort((a, b) => b.total_points - a.total_points);
      return json({ ok: true, leaderboard });
    }

    // Admin view: all predictions (used by resolver + admin UI)
    if (url.searchParams.get('admin') === '1') {
      if (!me.admin) return json({ error: 'admin_required' }, 403);
      const { data } = await db.select(
        'stockrocket_predictions',
        'order=submitted_at.desc&limit=500'
      );
      return json({ ok: true, predictions: data || [] });
    }

    // Per-teardown filter (still scoped to this user)
    const teardownSlug = url.searchParams.get('teardown');
    let q = `user_code=eq.${encodeURIComponent(userCode)}&order=submitted_at.desc&limit=200`;
    if (teardownSlug) q += `&teardown_slug=eq.${encodeURIComponent(teardownSlug)}`;
    const { data } = await db.select('stockrocket_predictions', q);
    return json({ ok: true, predictions: data || [] });
  }

  // ==================== POST: submit new prediction ====================
  if (req.method === 'POST') {
    let body;
    try { body = await req.json(); } catch { return json({ error: 'bad_json' }, 400); }

    // ---- validation ----
    const symbol = String(body?.symbol || '').trim().toUpperCase();
    const assetType = String(body?.asset_type || '').trim().toLowerCase();
    const teardownSlug = body?.teardown_slug ? String(body.teardown_slug).trim() : null;
    const playbookSlug = String(body?.playbook_slug || '').trim();
    const direction = String(body?.direction || '').trim().toUpperCase();
    const targetPrice = Number(body?.target_price);
    const targetDateRaw = String(body?.target_date || '').trim();
    const confidence = Math.floor(Number(body?.confidence));
    const rationale = String(body?.rationale || '').trim();

    if (!symbol) return json({ error: 'missing_symbol' }, 400);
    if (!['stock', 'crypto'].includes(assetType)) return json({ error: 'invalid_asset_type' }, 400);
    if (!playbookSlug) return json({ error: 'missing_playbook_citation' }, 400);
    if (!['UP', 'DOWN'].includes(direction)) return json({ error: 'invalid_direction' }, 400);
    if (!isFinite(targetPrice) || targetPrice <= 0) return json({ error: 'invalid_target_price' }, 400);
    if (!(confidence >= 1 && confidence <= 5)) return json({ error: 'invalid_confidence' }, 400);
    if (rationale.length < MIN_RATIONALE_CHARS) {
      return json({ error: 'rationale_too_short', min_chars: MIN_RATIONALE_CHARS }, 400);
    }

    // Target date must be a real YYYY-MM-DD, at least MIN_TARGET_DAYS out
    const targetDate = parseISODate(targetDateRaw);
    if (!targetDate) return json({ error: 'invalid_target_date' }, 400);
    const now = new Date();
    const daysOut = Math.floor((targetDate.getTime() - now.getTime()) / (24 * 60 * 60 * 1000));
    if (daysOut < MIN_TARGET_DAYS) {
      return json({ error: 'target_date_too_soon', min_days: MIN_TARGET_DAYS }, 400);
    }
    if (daysOut > MAX_TARGET_DAYS) {
      return json({ error: 'target_date_too_far', max_days: MAX_TARGET_DAYS }, 400);
    }

    // Playbook must exist (forcing function: you cite a real card)
    const { data: pb } = await db.select(
      'stockrocket_playbooks',
      `slug=eq.${encodeURIComponent(playbookSlug)}&select=slug&limit=1`
    );
    if (!pb?.[0]) return json({ error: 'unknown_playbook', slug: playbookSlug }, 400);

    // Teardown (if supplied) must exist
    if (teardownSlug) {
      const { data: td } = await db.select(
        'stockrocket_teardowns',
        `slug=eq.${encodeURIComponent(teardownSlug)}&select=slug&limit=1`
      );
      if (!td?.[0]) return json({ error: 'unknown_teardown', slug: teardownSlug }, 400);
    }

    // ---- server-authoritative submission price ----
    const resolved = await fetchLivePrice(symbol, assetType);
    if (!resolved) {
      return json({ error: 'price_unverifiable', symbol, assetType }, 503);
    }

    const predRow = {
      user_code: userCode,
      symbol,
      asset_type: assetType,
      teardown_slug: teardownSlug,
      playbook_slug: playbookSlug,
      direction,
      target_price: targetPrice,
      target_date: targetDateRaw,
      confidence,
      rationale,
      submitted_price: resolved.price,
      submitted_price_source: resolved.source,
    };

    const { data: ins, error: insErr } = await db.insert('stockrocket_predictions', predRow);
    if (insErr) return json({ error: 'insert_failed', detail: insErr }, 500);

    return json({ ok: true, prediction: ins?.[0] });
  }

  return json({ error: 'method_not_allowed' }, 405);
}

// -------- Auth --------
async function authenticate(db, userCode) {
  const { data } = await db.select(
    'stockrocket_access_codes',
    `code=eq.${encodeURIComponent(userCode)}&active=eq.true&limit=1`
  );
  return data?.[0] || null;
}

// -------- Date parsing: strict YYYY-MM-DD --------
function parseISODate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  // Parse at noon UTC to avoid timezone edge cases flipping day on day-out math
  const d = new Date(`${s}T12:00:00.000Z`);
  return isNaN(d.getTime()) ? null : d;
}

// ==================== Server-side live price ====================
// Mirrors api/trades.js fetchLivePrice. Kept local so this Edge Function
// has zero cross-file imports.
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
    async insert(table, row) {
      const res = await fetch(`${base}/${table}`, { method: 'POST', headers, body: JSON.stringify(row) });
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
