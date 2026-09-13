// StockRocket -- Crypto Bot Fill Engine (Vercel Edge Function)
// -----------------------------------------------------------
// Runs a sweep of the existing admin crypto queue. Quote retrieval remains here;
// stockrocket_execute_trade atomically checks/locks each order and portfolio,
// then writes ledger, cash/holdings and terminal state in one transaction.
// Crypto preserves the trigger-price policy (docs/PRICE_INVARIANTS.md I8).
// User stock target orders are separately handled by /api/orders.
//
//   POST /api/crypto/fill-order                       -> run one sweep
//     Auth: X-Admin-Code header (admin code)
//           OR Authorization: Bearer <CRON_SECRET> (Vercel Cron)
//     Response: { ok, scanned, filled, expired, details: [...] }
//
// Env vars:
//   SUPABASE_URL, SUPABASE_SERVICE_KEY -- required
//   CRON_SECRET                         -- optional; enables Vercel Cron auth

export const config = { runtime: 'edge' };

const EPSILON = 1e-8;
const STARTING_CASH = 100000;

// CoinGecko map (mirrored from api/price.js -- duplicated, not imported, by
// Edge Function convention).
const COINGECKO_IDS = {
  BTC: 'bitcoin',
  ETH: 'ethereum',
  SOL: 'solana',
  ADA: 'cardano',
  DOT: 'polkadot',
  XRP: 'ripple',
};

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Code, Authorization',
};

export default async function handler(req) {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }
  if (req.method !== 'POST') {
    return json({ error: 'method_not_allowed' }, 405);
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    return json({ error: 'supabase_not_configured' }, 500);
  }

  // Auth: either admin code OR cron secret
  const adminCode = (req.headers.get('x-admin-code') || '').trim();
  const authHeader = (req.headers.get('authorization') || '').trim();
  const cronSecret = process.env.CRON_SECRET;

  let authedAs = null;
  if (adminCode) {
    const db0 = supabase(SUPABASE_URL, SUPABASE_SERVICE_KEY);
    const { data } = await db0.select(
      'stockrocket_access_codes',
      `code=eq.${encodeURIComponent(adminCode)}&is_admin=eq.true&active=eq.true&limit=1`
    );
    if (data?.length) authedAs = `admin:${data[0].code}`;
  } else if (cronSecret && authHeader === `Bearer ${cronSecret}`) {
    authedAs = 'cron';
  }
  if (!authedAs) return json({ error: 'auth_required' }, 401);

  const db = supabase(SUPABASE_URL, SUPABASE_SERVICE_KEY);
  const now = new Date();
  const details = [];
  let filled = 0;
  let expired = 0;

  // ------------------------------------------------------------------
  // Step 1: Expire anything past its TTL.
  // ------------------------------------------------------------------
  const { data: staleOrders } = await db.select(
    'stockrocket_crypto_orders',
    `status=eq.pending&expire_at=lt.${encodeURIComponent(now.toISOString())}&limit=500`
  );
  for (const order of (staleOrders || [])) {
    await db.update(
      'stockrocket_crypto_orders',
      `id=eq.${encodeURIComponent(order.id)}&status=eq.pending`,
      { status: 'expired', expired_reason: 'ttl' }
    );
    expired++;
    details.push({ id: order.id, action: 'expired', reason: 'ttl' });
  }

  // ------------------------------------------------------------------
  // Step 2: Fetch pending orders still in their window.
  // ------------------------------------------------------------------
  const { data: pending } = await db.select(
    'stockrocket_crypto_orders',
    `status=eq.pending&expire_at=gte.${encodeURIComponent(now.toISOString())}&order=created_at.asc&limit=500`
  );
  const scanned = (pending || []).length;

  if (!scanned) {
    return json({ ok: true, scanned: 0, filled: 0, expired, details, authedAs });
  }

  // ------------------------------------------------------------------
  // Step 3: Batch-fetch live prices for the distinct symbols.
  // ------------------------------------------------------------------
  const symbols = Array.from(new Set(pending.map(o => o.symbol)));
  const priceMap = await fetchCryptoPrices(symbols);
  // priceMap: { SYM: { price: number, source: string } | null }

  // ------------------------------------------------------------------
  // Step 4: For each pending order, evaluate and fill if crossed.
  // ------------------------------------------------------------------
  // Process in creation order (FIFO) so earlier orders get first claim on
  // cash/shares when multiple target the same asset.
  for (const order of pending) {
    const live=priceMap[order.symbol];
    if(!live || !Number.isFinite(live.price) || live.price<=0) continue;
    const {data,error}=await db.rpc('stockrocket_execute_trade',{
      p_user:order.user_code,p_type:order.side,p_symbol:order.symbol,p_name:order.name,
      p_asset:'crypto',p_qty:Number(order.qty),p_price:live.price,p_crypto:order.id,
    });
    if(error){details.push({id:order.id,action:'error'});continue;}
    if(data.action==='filled')filled++;
    if(data.action==='expired')expired++;
    details.push({id:order.id,action:data.action});
  }

  return json({ ok: true, scanned, filled, expired, details, authedAs });
}

// ==================== Price fetch ====================
// Same multi-source chain as /api/price: Coinbase primary, CoinGecko fallback.
// Returns { SYM: { price, source } } for each symbol; null entry if both fail.
async function fetchCryptoPrices(symbols) {
  const out = {};
  const coinbaseResults = await Promise.all(symbols.map(async (sym) => {
    try {
      const res = await fetch(
        `https://api.exchange.coinbase.com/products/${encodeURIComponent(sym)}-USD/stats`,
        { signal: AbortSignal.timeout ? AbortSignal.timeout(4000) : undefined }
      );
      if (!res.ok) return { sym, ok: false };
      const d = await res.json();
      const px = Number(d?.last);
      if (!isFinite(px) || px <= 0) return { sym, ok: false };
      return { sym, ok: true, price: px, source: 'coinbase' };
    } catch {
      return { sym, ok: false };
    }
  }));
  const fallback = [];
  for (const r of coinbaseResults) {
    if (r.ok) out[r.sym] = { price: r.price, source: r.source };
    else fallback.push(r.sym);
  }

  if (fallback.length) {
    const ids = fallback.map(s => COINGECKO_IDS[s]).filter(Boolean);
    let lp = {};
    if (ids.length) {
      try {
        const res = await fetch(
          `https://api.coingecko.com/api/v3/simple/price?ids=${ids.join(',')}&vs_currencies=usd`,
          { signal: AbortSignal.timeout ? AbortSignal.timeout(5000) : undefined }
        );
        if (res.ok) lp = await res.json();
      } catch { lp = {}; }
    }
    for (const sym of fallback) {
      const id = COINGECKO_IDS[sym];
      const px = Number(id ? lp?.[id]?.usd : null);
      if (isFinite(px) && px > 0) out[sym] = { price: px, source: 'coingecko' };
      else out[sym] = null;
    }
  }
  return out;
}

// ==================== Minimal Supabase REST client ====================
function supabase(url, serviceKey) {
  const base = `${url.replace(/\/$/, '')}/rest/v1`;
  const headers = {
    'apikey': serviceKey,
    'Authorization': `Bearer ${serviceKey}`,
    'Content-Type': 'application/json',
    'Prefer': 'return=representation',
  };
  return {
    async rpc(name, body) {
      const res=await fetch(`${base}/rpc/${name}`,{method:'POST',headers,body:JSON.stringify(body)});
      return res.ok?{data:await res.json()}:{error:true};
    },
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
      const res = await fetch(`${base}/${table}?${query}`, { method: 'PATCH', headers, body: JSON.stringify(patch) });
      if (!res.ok) return { data: null, error: await res.text() };
      return { data: await res.json(), error: null };
    },
    async upsert(table, row, conflictCol) {
      const res = await fetch(`${base}/${table}?on_conflict=${encodeURIComponent(conflictCol)}`, {
        method: 'POST',
        headers: { ...headers, 'Prefer': 'return=representation,resolution=merge-duplicates' },
        body: JSON.stringify(row),
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
