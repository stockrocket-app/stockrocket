// StockRocket -- Historical Price Proxy (Vercel Edge Function)
// -------------------------------------------------------------
// Returns daily OHLC history for a stock ticker. Backs the chart hook
// (useChartData) on the client.
//
// Why this exists: Finnhub moved /stock/candle to a premium plan in mid-2024,
// so the old /api/finnhub?path=candle route returns empty on the free key.
// Stooq has a free, no-auth CSV endpoint with daily history for all US
// tickers, which is what our charts need. Daily-only is fine: the UI renders
// 30/90 day views, not intraday.
//
// Contract:
//   GET /api/history?symbol=AAPL&days=30
//   GET /api/history?symbol=BRK.B&days=90
//
// Response (success):
//   { ok: true, symbol, days, points: [ { day: 1, price: 187.15, timestamp: 1704153600000 }, ... ] }
// Response (failure):
//   { ok: false, error: 'upstream_failure' | 'no_data' | 'parse_failure' | 'invalid_symbol' }
//
// Ticker normalisation for Stooq:
//   - lowercase
//   - replace "." with "-"  (BRK.B -> brk-b)
//   - append ".us"          (aapl -> aapl.us)
//
// Caching: daily bars don't change intraday, so cache aggressively at the edge
// (15 min s-maxage, 1 hr stale-while-revalidate).

export const config = { runtime: 'edge' };

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const MIN_DAYS = 5;
const MAX_DAYS = 365;
const SYMBOL_RE = /^[A-Z][A-Z0-9.\-]{0,9}$/;

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

  if (!rawSymbol || !SYMBOL_RE.test(rawSymbol)) {
    return json({ ok: false, error: 'invalid_symbol', detail: 'symbol must match /^[A-Z][A-Z0-9.\\-]{0,9}$/' }, 400);
  }
  const days = clamp(isFinite(rawDays) ? rawDays : 30, MIN_DAYS, MAX_DAYS);

  // Stooq ticker: lowercase, dots -> dashes, then .us suffix.
  const stooqTicker = rawSymbol.toLowerCase().replace(/\./g, '-') + '.us';

  // Stooq accepts d1/d2 as YYYYMMDD. Leave a small buffer on both ends so
  // weekends/holidays don't eat the window.
  const now = new Date();
  const end = formatYMD(now);
  const startDate = new Date(now.getTime() - (days + 7) * 86400000);
  const start = formatYMD(startDate);

  const upstream = `https://stooq.com/q/d/l/?s=${encodeURIComponent(stooqTicker)}&d1=${start}&d2=${end}&i=d`;

  try {
    const res = await fetch(upstream, {
      headers: { 'Accept': 'text/csv, text/plain' },
      signal: AbortSignal.timeout ? AbortSignal.timeout(8000) : undefined,
    });
    if (!res.ok) {
      return json({ ok: false, error: 'upstream_failure', status: res.status, symbol: rawSymbol }, 502, edgeCache(300));
    }
    const csv = (await res.text()).trim();
    if (!csv || /^no data/i.test(csv)) {
      return json({ ok: false, error: 'no_data', symbol: rawSymbol }, 404, edgeCache(300));
    }

    const points = parseStooqCsv(csv);
    if (!points.length) {
      return json({ ok: false, error: 'parse_failure', symbol: rawSymbol }, 502, edgeCache(60));
    }

    // Trim to the last `days` points (Stooq returns whatever fits the window).
    const trimmed = points.slice(Math.max(0, points.length - days));
    // Re-number `day` to be sequential starting at 1 after trim.
    const out = trimmed.map((p, i) => ({ day: i + 1, price: p.price, timestamp: p.timestamp }));

    return json({ ok: true, symbol: rawSymbol, days, source: 'stooq', points: out }, 200, edgeCache(900));
  } catch (e) {
    return json({ ok: false, error: 'upstream_failure', detail: String(e && e.message || e), symbol: rawSymbol }, 502, edgeCache(60));
  }
}

// ---------- helpers ----------

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
  // Stooq returns ascending by date; keep that order (charts draw left-to-right).
  return points;
}

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
