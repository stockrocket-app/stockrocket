// StockRocket -- Finnhub proxy (Vercel Edge Function)
// ----------------------------------------------------
// The client never sees the Finnhub API key. It calls /api/finnhub?path=quote&symbol=AAPL,
// this function injects the key from Vercel env vars, and returns the JSON response.
//
// Why Edge instead of Node: lower cold-start latency, closer to the user, matches
// the on-demand refresh pattern of a live-price app.
//
// Env var: FINNHUB_KEY (set in Vercel project > Settings > Environment Variables)
//
// Supported paths (allowlist -- anything else is rejected):
//   quote          -> /api/v1/quote?symbol=
//   candle         -> /api/v1/stock/candle?symbol=&resolution=&from=&to=
//   profile2       -> /api/v1/stock/profile2?symbol=
//   metric         -> /api/v1/stock/metric?symbol=&metric=all
//   news           -> /api/v1/news?category=general
//   company-news   -> /api/v1/company-news?symbol=&from=&to=
//   search         -> /api/v1/search?q=
//
// All other query params from the client are forwarded as-is. The API key is
// appended server-side so it never leaks into browser network logs.

export const config = { runtime: 'edge' };

const ALLOWED_PATHS = new Set([
  'quote',
  'candle',
  'stock/candle',
  'stock/profile2',
  'profile2',
  'stock/metric',
  'metric',
  'news',
  'company-news',
  'search',
]);

// Path aliases the client can use (shorter names) -> real Finnhub paths
const PATH_ALIAS = {
  'quote': 'quote',
  'candle': 'stock/candle',
  'profile2': 'stock/profile2',
  'metric': 'stock/metric',
  'news': 'news',
  'company-news': 'company-news',
  'search': 'search',
};

export default async function handler(req) {
  const origin = req.headers.get('origin') || '';
  const cors = {
    'Access-Control-Allow-Origin': '*', // private app -- fine to be permissive
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: cors });
  }

  if (req.method !== 'GET') {
    return json({ error: 'method_not_allowed' }, 405, cors);
  }

  const key = process.env.FINNHUB_KEY;
  if (!key) {
    return json({ error: 'finnhub_key_missing', detail: 'Set FINNHUB_KEY in Vercel env vars.' }, 500, cors);
  }

  const url = new URL(req.url);
  const rawPath = (url.searchParams.get('path') || '').trim().replace(/^\//, '');
  const resolvedPath = PATH_ALIAS[rawPath] || rawPath;

  if (!ALLOWED_PATHS.has(rawPath) && !ALLOWED_PATHS.has(resolvedPath)) {
    return json({ error: 'path_not_allowed', path: rawPath }, 400, cors);
  }

  // Forward all client params except our internal `path` param
  const forward = new URLSearchParams();
  for (const [k, v] of url.searchParams.entries()) {
    if (k === 'path') continue;
    forward.set(k, v);
  }
  forward.set('token', key); // inject key server-side

  const upstream = `https://finnhub.io/api/v1/${resolvedPath}?${forward.toString()}`;

  try {
    const res = await fetch(upstream, {
      headers: { 'Accept': 'application/json' },
      // Short timeout -- UI should gracefully degrade rather than hang
      signal: AbortSignal.timeout ? AbortSignal.timeout(8000) : undefined,
    });

    const body = await res.text();
    const contentType = res.headers.get('content-type') || 'application/json';

    // Cache short-lived for list endpoints to reduce API spend
    const cacheControl = (() => {
      if (resolvedPath === 'news') return 'public, s-maxage=300, stale-while-revalidate=600';
      if (resolvedPath === 'company-news') return 'public, s-maxage=300, stale-while-revalidate=600';
      if (resolvedPath === 'stock/profile2') return 'public, s-maxage=86400, stale-while-revalidate=604800';
      if (resolvedPath === 'stock/candle') return 'public, s-maxage=60, stale-while-revalidate=120';
      if (resolvedPath === 'quote') return 'public, s-maxage=15, stale-while-revalidate=30';
      return 'public, s-maxage=30, stale-while-revalidate=60';
    })();

    return new Response(body, {
      status: res.status,
      headers: {
        'content-type': contentType,
        'cache-control': cacheControl,
        ...cors,
      },
    });
  } catch (e) {
    return json({ error: 'upstream_failure', detail: String(e && e.message || e) }, 502, cors);
  }
}

function json(obj, status = 200, extra = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json', ...extra },
  });
}
