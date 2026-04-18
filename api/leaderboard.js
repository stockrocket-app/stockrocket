// StockRocket -- Leaderboard API (Vercel Edge Function)
// --------------------------------------------------------
// Per-user rollup for the Leaderboard page. Joins three tables:
//   stockrocket_access_codes (active=true) -- canonical user list + labels
//   stockrocket_portfolios                 -- cash + holdings (no live prices)
//   stockrocket_trades                     -- trade count per user
//
//   GET /api/leaderboard  -> { ok: true, players: [...] }
//     Auth: any active X-User-Code (everyone sees the leaderboard)
//
// Shape of each player row:
//   {
//     code: 'RSJ-ADMIN',
//     label: 'Milburn Pennybags',
//     is_admin: true,
//     cash: 100000,
//     starting_cash: 100000,
//     holdings: { SYM: { symbol, name, assetType, shares, avgCost }, ... },
//     trade_count: 0,
//     last_trade_at: null | ISO timestamp,
//   }
//
// Client hydrates holdings with live prices to compute totalValue,
// gainPct, best/worst currently-held position, etc. This endpoint
// stays cheap: no price fetches here.
//
// Env vars required (set in Vercel project settings):
//   SUPABASE_URL
//   SUPABASE_SERVICE_KEY

export const config = { runtime: 'edge' };

const STARTING_CASH = 100000;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-User-Code',
};

export default async function handler(req) {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }
  if (req.method !== 'GET') {
    return json({ error: 'method_not_allowed' }, 405);
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    return json({ error: 'supabase_not_configured' }, 500);
  }

  const db = supabase(SUPABASE_URL, SUPABASE_SERVICE_KEY);

  // Auth: any active code (leaderboard is visible to all users, not admin-only)
  const userCode = (req.headers.get('x-user-code') || '').trim();
  if (!userCode) return json({ error: 'auth_required' }, 401);
  const { data: authRows } = await db.select(
    'stockrocket_access_codes',
    `code=eq.${encodeURIComponent(userCode)}&active=eq.true&limit=1`
  );
  if (!authRows?.[0]) return json({ error: 'auth_denied' }, 403);

  // Pull all active users
  const { data: codes, error: codesErr } = await db.select(
    'stockrocket_access_codes',
    'active=eq.true&order=created_at.asc&limit=200'
  );
  if (codesErr) return json({ error: 'codes_fetch_failed', detail: codesErr }, 500);

  // Pull all portfolios (index by user_code)
  const { data: portfolios } = await db.select(
    'stockrocket_portfolios',
    'limit=500'
  );
  const portfolioByCode = new Map();
  for (const p of (portfolios || [])) {
    if (p.user_code) portfolioByCode.set(p.user_code, p);
  }

  // Pull all trades (count + last timestamp per user_code)
  // Limit high, order by executed_at desc so the first match per code is the last trade
  const { data: trades } = await db.select(
    'stockrocket_trades',
    'select=user_code,executed_at&order=executed_at.desc&limit=2000'
  );
  const tradeCountByCode = new Map();
  const lastTradeAtByCode = new Map();
  for (const t of (trades || [])) {
    const c = t.user_code;
    if (!c) continue;
    tradeCountByCode.set(c, (tradeCountByCode.get(c) || 0) + 1);
    if (!lastTradeAtByCode.has(c)) lastTradeAtByCode.set(c, t.executed_at);
  }

  // Build player rollup
  const players = (codes || []).map(row => {
    const p = portfolioByCode.get(row.code);
    const rawHoldings = (p && p.holdings && typeof p.holdings === 'object') ? p.holdings : {};
    return {
      code: row.code,
      label: row.label || row.code,
      is_admin: !!row.is_admin,
      cash: p ? Number(p.cash) : STARTING_CASH,
      starting_cash: p ? (Number(p.starting_cash) || STARTING_CASH) : STARTING_CASH,
      holdings: rawHoldings,
      trade_count: tradeCountByCode.get(row.code) || 0,
      last_trade_at: lastTradeAtByCode.get(row.code) || null,
    };
  });

  return json({ ok: true, players });
}

// -------- Minimal Supabase REST client --------
function supabase(url, serviceKey) {
  const base = `${url.replace(/\/$/, '')}/rest/v1`;
  const headers = {
    'apikey': serviceKey,
    'Authorization': `Bearer ${serviceKey}`,
    'Content-Type': 'application/json',
  };
  return {
    async select(table, query = '') {
      const res = await fetch(`${base}/${table}?${query}`, { headers });
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
