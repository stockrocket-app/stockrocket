// StockRocket -- Historical Price Proxy (Vercel Edge Function)
// -------------------------------------------------------------
// Returns daily OHLC history for a stock ticker. Backs the chart hook
// (useChartData) on the client.
//
// Why this exists: Finnhub moved /stock/candle to a premium plan in mid-2024,
// so the old /api/finnhub?path=candle route returns empty on the free key.
// We need a free, reliable, no-auth source of daily bars.
//
// Sources (tried in order, first non-empty wins):
//   1. Yahoo Finance v8 chart  -- JSON, no auth, very reliable from hosted IPs.
//      Ticker format: BRK.B -> BRK-B (dots -> dashes).
//   2. Stooq CSV fallback      -- free, no auth, but known to be flaky from
//      cloud IPs + sometimes returns "no data" for valid US tickers.
//      Ticker format: brk-b.us (lowercase, dots->dashes, .us suffix).
//
// Contract:
//   GET /api/history?symbol=AAPL&days=30
//   GET /api/history?symbol=BRK.B&days=90
//
// Response (success):
//   { ok: true, symbol, days, source: 'yahoo'|'stooq', points: [ { day: 1, price: 187.15, timestamp: 1704153600000 }, ... ] }
// Response (failure):
//   { ok: false, error: 'upstream_failure' | 'no_data' | 'parse_failure' | 'invalid_symbol', attempts: [...] }
//
// Caching: daily bars don't change intraday, so cache aggressively at the edge
// (15 min s-maxage, 1 hr stale-while-revalidate).

export const config = { runtime: 'edge' };

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const MIN_DAYS = 1;
const MAX_DAYS = 365;
const SYMBOL_RE = /^[A-Z][A-Z0-9.\-]{0,9}$/;
const VALID_INTERVALS = new Set(['5m', '15m', '30m', '1h', '1d']);

// Looks like a normal desktop browser -- Yahoo sometimes 429s bare curl-style UAs
const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

export default async function handler(req) {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }
  if (req.method !== 'GET') {
    return json({ ok: false, error: 'method_not_allowed' }, 405);
  }

  const url = new URL(req.url);
  const rawSymbol = (url.searchParams.get('symbol') || '').trim().toUpperCase();
  const rawDays = parseInt(url.searchParams.get('days') || '30', 10);
  const rawInterval = (url.searchParams.get('interval') || '').trim();

  if (!rawSymbol || !SYMBOL_RE.test(rawSymbol)) {
    return json({ ok: false, error: 'invalid_symbol', detail: 'symbol must match /^[A-Z][A-Z0-9.\\-]{0,9}$/' }, 400);
  }
  const days = clamp(isFinite(rawDays) ? rawDays : 30, MIN_DAYS, MAX_DAYS);
  // For 1-day requests we default to 5-minute bars so the intraday view is smooth.
  // Callers can override via ?interval=1h|15m|etc. Unknown values fall back to daily.
  const interval = VALID_INTERVALS.has(rawInterval)
    ? rawInterval
    : (days <= 1 ? '5m' : '1d');
  // Cache budget: intraday moves fast, keep it short. Daily bars can cache 15m.
  const cacheSeconds = (interval === '1d') ? 900 : 60;

  const attempts = [];

  // ---- Source 1: Yahoo Finance ----
  try {
    const yahoo = await tryYahoo(rawSymbol, days, interval);
    attempts.push({ source: 'yahoo', ok: yahoo.ok, detail: yahoo.detail || null, count: yahoo.points?.length || 0 });
    if (yahoo.ok && yahoo.points.length >= 2) {
      return json({ ok: true, symbol: rawSymbol, days, interval, source: 'yahoo', points: yahoo.points, attempts }, 200, edgeCache(cacheSeconds));
    }
  } catch (e) {
    attempts.push({ source: 'yahoo', ok: false, detail: String(e && e.message || e) });
  }

  // ---- Source 2: Stooq fallback (daily bars only) ----
  // Stooq has no free intraday feed. For 1D requests, skip directly to the no_data
  // branch rather than returning daily closes -- a 1D chart with a single daily
  // close is worse than showing the "connecting" placeholder.
  if (interval === '1d') {
    try {
      const stooq = await tryStooq(rawSymbol, days);
      attempts.push({ source: 'stooq', ok: stooq.ok, detail: stooq.detail || null, count: stooq.points?.length || 0 });
      if (stooq.ok && stooq.points.length >= 2) {
        return json({ ok: true, symbol: rawSymbol, days, interval, source: 'stooq', points: stooq.points, attempts }, 200, edgeCache(cacheSeconds));
      }
    } catch (e) {
      attempts.push({ source: 'stooq', ok: false, detail: String(e && e.message || e) });
    }
  }

  // Both sources failed -- return a debuggable error
  return json({ ok: false, error: 'no_data', symbol: rawSymbol, attempts }, 404, edgeCache(60));
}

// ---------- Yahoo ----------

async function tryYahoo(rawSymbol, days, interval = '1d') {
  // Yahoo wants dashes instead of dots for class-B shares etc.
  const yTicker = rawSymbol.replace(/\./g, '-');
  // Pick the smallest range that covers the request; Yahoo returns more
  // points than asked, we trim client-side below.
  // Intraday intervals need a short range -- 5m bars only go back ~60 days
  // on Yahoo, and requesting a long range with a short interval yields empty.
  let range;
  if (interval === '1d') {
    range = days <= 5 ? '5d'
          : days <= 30 ? '1mo'
          : days <= 90 ? '3mo'
          : days <= 180 ? '6mo'
          : '1y';
  } else {
    // intraday: clamp range to something Yahoo accepts for the interval
    range = days <= 1 ? '1d'
          : days <= 5 ? '5d'
          : '1mo';
  }
  const upstream = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yTicker)}?range=${range}&interval=${interval}&includePrePost=false`;

  const res = await fetch(upstream, {
    headers: {
      'Accept': 'application/json',
      'User-Agent': BROWSER_UA,
    },
    signal: AbortSignal.timeout ? AbortSignal.timeout(8000) : undefined,
  });
  if (!res.ok) return { ok: false, detail: `http_${res.status}` };
  const data = await res.json();
  const result = data?.chart?.result?.[0];
  if (!result) return { ok: false, detail: data?.chart?.error?.description || 'no_result' };

  const ts = result.timestamp || [];
  const closes = result.indicators?.quote?.[0]?.close || [];
  if (ts.length < 2 || closes.length < 2) return { ok: false, detail: 'empty_series' };

  const points = [];
  for (let i = 0; i < ts.length; i++) {
    const px = Number(closes[i]);
    if (!isFinite(px) || px <= 0) continue; // Yahoo returns null on non-trading days
    points.push({ price: px, timestamp: ts[i] * 1000 });
  }
  if (points.length < 2) return { ok: false, detail: 'all_null' };

  // Trim to last `days` entries and renumber -- daily only. For intraday,
  // the range clamp above already constrains to the desired window.
  const trimmed = (interval === '1d')
    ? points.slice(Math.max(0, points.length - days))
    : points;
  const out = trimmed.map((p, i) => ({ day: i + 1, price: p.price, timestamp: p.timestamp }));
  return { ok: true, points: out };
}

// ---------- Stooq (fallback) ----------

async function tryStooq(rawSymbol, days) {
  const stooqTicker = rawSymbol.toLowerCase().replace(/\./g, '-') + '.us';
  const now = new Date();
  const end = formatYMD(now);
  const startDate = new Date(now.getTime() - (days + 7) * 86400000);
  const start = formatYMD(startDate);
  const upstream = `https://stooq.com/q/d/l/?s=${encodeURIComponent(stooqTicker)}&d1=${start}&d2=${end}&i=d`;

  const res = await fetch(upstream, {
    headers: { 'Accept': 'text/csv, text/plain', 'User-Agent': BROWSER_UA },
    signal: AbortSignal.timeout ? AbortSignal.timeout(8000) : undefined,
  });
  if (!res.ok) return { ok: false, detail: `http_${res.status}` };
  const csv = (await res.text()).trim();
  if (!csv || /^no data/i.test(csv)) return { ok: false, detail: 'no_data' };

  const points = parseStooqCsv(csv);
  if (!points.length) return { ok: false, detail: 'parse_failure' };

  const trimmed = points.slice(Math.max(0, points.length - days));
  const out = trimmed.map((p, i) => ({ day: i + 1, price: p.price, timestamp: p.timestamp }));
  return { ok: true, points: out };
}

function parseStooqCsv(csv) {
  // Expected header: Date,Open,High,Low,Close,Volume
  const lines = csv.split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return [];
  const header = lines[0].toLowerCase();
  if (!header.includes('date') || !header.includes('close')) return [];

  const points = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',');
    if (cols.length < 5) continue;
    const date = cols[0];
    const close = Number(cols[4]);
    if (!isFinite(close) || close <= 0) continue;
    const ts = Date.parse(date);
    if (!isFinite(ts)) continue;
    points.push({ price: close, timestamp: ts });
  }
  return points;
}

// ---------- helpers ----------

function formatYMD(d) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

function edgeCache(seconds) {
  return { 'cache-control': `public, s-maxage=${seconds}, stale-while-revalidate=${seconds * 4}` };
}

function json(obj, status = 200, extra = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json', ...CORS, ...extra },
  });
}
