// StockRocket -- Quote cache warmer (Vercel Cron, Edge Function)
// --------------------------------------------------------------
// Runs every minute during US market hours (see vercel.json "crons"). Fetches
// the full stock universe from Finnhub at a throttled pace and upserts the
// results into stockrocket_quote_cache.
//
// Why this exists (2026-06-17): the client used to fire one Finnhub /quote call
// per symbol on every load (~57 calls). Finnhub's free tier caps at 60 req/min,
// so most calls came back 429 and stock prices silently fell back to cost basis.
// This cron is now the ONLY component that fans out across the whole universe.
// Clients read the warm cache through /api/price and almost never hit Finnhub
// directly, so the rate limit is no longer a problem and no money is spent on a
// paid data tier.
//
// Throttling: the universe (~57) is fetched in small concurrent batches with a
// short pause between them, staying under Finnhub's 60/min and 30/sec limits and
// finishing well within the function's wall-clock budget.
//
// Env vars: FINNHUB_KEY, SUPABASE_URL, SUPABASE_SERVICE_KEY, (optional) CRON_SECRET
//
// IMPORTANT: keep STOCK_UNIVERSE in sync with MOCK_STOCKS in index.html.

export const config = { runtime: 'edge' };

const STOCK_UNIVERSE = [
  'AAPL', 'MSFT', 'GOOGL', 'AMZN', 'NVDA', 'META', 'TSLA', 'JPM', 'V', 'MA',
  'GS', 'BRK.B', 'UNH', 'LLY', 'JNJ', 'PFE', 'WMT', 'COST', 'HD', 'NKE',
  'SBUX', 'MCD', 'KO', 'PEP', 'DIS', 'TGT', 'CMG', 'YUM', 'QSR', 'WEN',
  'DPZ', 'XOM', 'CVX', 'COP', 'BA', 'CAT', 'LMT', 'RTX', 'NOC', 'GD',
  'LHX', 'HII', 'T', 'NFLX', 'SPOT', 'AMD', 'CRM', 'ORCL', 'PLTR', 'SMCI',
  'AVGO', 'TSM', 'SNOW', 'ANET', 'VRT', 'ARM', 'PANW',
];

const CONCURRENCY = 8;       // symbols fetched in parallel per batch
const BATCH_PAUSE_MS = 120;  // pause between batches (keeps us < 30 req/sec)

export default async function handler(req) {
  // Optional shared-secret guard. Vercel adds `Authorization: Bearer $CRON_SECRET`
  // to cron requests when CRON_SECRET is set. If it's not set, allow the call --
  // the worst a caller can do is warm a price cache.
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = req.headers.get('authorization') || '';
    if (auth !== `Bearer ${secret}`) return json({ ok: false, error: 'unauthorized' }, 401);
  }

  const key = process.env.FINNHUB_KEY;
  const SB_URL = process.env.SUPABASE_URL;
  const SB_KEY = process.env.SUPABASE_SERVICE_KEY;
  if (!key) return json({ ok: false, error: 'finnhub_key_missing' }, 500);
  if (!SB_URL || !SB_KEY) return json({ ok: false, error: 'supabase_not_configured' }, 500);

  const entries = [];
  let failed = 0;

  for (let i = 0; i < STOCK_UNIVERSE.length; i += CONCURRENCY) {
    const batch = STOCK_UNIVERSE.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map(sym => fetchQuote(sym, key)));
    for (const r of results) {
      if (r.ok) entries.push(r.entry);
      else failed++;
    }
    if (i + CONCURRENCY < STOCK_UNIVERSE.length) await sleep(BATCH_PAUSE_MS);
  }

  if (entries.length) {
    try {
      await upsert(SB_URL, SB_KEY, entries);
    } catch (e) {
      return json({ ok: false, error: 'cache_write_failed', detail: String(e && e.message || e), refreshed: 0, failed }, 502);
    }
  }

  return json({ ok: true, refreshed: entries.length, failed, universe: STOCK_UNIVERSE.length, at: new Date().toISOString() });
}

async function fetchQuote(sym, key) {
  try {
    const res = await fetch(
      `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(sym)}&token=${key}`,
      { signal: AbortSignal.timeout ? AbortSignal.timeout(5000) : undefined }
    );
    if (!res.ok) return { ok: false, symbol: sym };
    const d = await res.json();
    const px = Number(d?.c);
    if (!isFinite(px) || px <= 0) return { ok: false, symbol: sym };
    return {
      ok: true,
      entry: {
        symbol: sym,
        price: px,
        change: isFinite(Number(d?.d)) ? Number(d.d) : null,
        change_pct: isFinite(Number(d?.dp)) ? Number(d.dp) : null,
        high: isFinite(Number(d?.h)) ? Number(d.h) : null,
        low: isFinite(Number(d?.l)) ? Number(d.l) : null,
        prev_close: isFinite(Number(d?.pc)) ? Number(d.pc) : null,
      },
    };
  } catch {
    return { ok: false, symbol: sym };
  }
}

async function upsert(url, key, entries) {
  const nowIso = new Date().toISOString();
  const rows = entries.map(e => ({
    symbol: e.symbol,
    asset_type: 'stock',
    price: e.price,
    change: e.change,
    change_pct: e.change_pct,
    high: e.high,
    low: e.low,
    prev_close: e.prev_close,
    source: 'finnhub',
    fetched_at: nowIso,
    updated_at: nowIso,
  }));
  const res = await fetch(`${url}/rest/v1/stockrocket_quote_cache?on_conflict=symbol`, {
    method: 'POST',
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates,return=minimal',
    },
    body: JSON.stringify(rows),
  });
  if (!res.ok) throw new Error(`cache_upsert_${res.status}`);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
