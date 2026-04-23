// StockRocket -- Crypto Bot Fill Engine (Vercel Edge Function)
// -----------------------------------------------------------
// Runs one sweep of the limit-order queue:
//   1. Mark any pending order with expire_at <= now as expired (ttl).
//   2. Fetch live prices for the distinct symbols still pending.
//   3. For each pending order, check if the trigger has been crossed.
//   4. On cross, verify target user's cash (BUY) or holdings (SELL).
//      - Insufficient -> expire with reason.
//      - Sufficient   -> write a trade row at the TRIGGER price (not live),
//                        upsert the portfolio, flip the order to filled.
//
// This endpoint lives outside /api/trades because limit fills have different
// semantics than market orders:
//   - /api/trades = server-authoritative, executes at server's live price.
//   - /api/crypto/fill-order = executes at the preset trigger price after the
//     server verifies the live market crossed it.
// See docs/PRICE_INVARIANTS.md I8.
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
  const portfolioCache = new Map(); // user_code -> portfolio row

  async function getPortfolio(userCode) {
    if (portfolioCache.has(userCode)) return portfolioCache.get(userCode);
    const { data } = await db.select(
      'stockrocket_portfolios',
      `user_code=eq.${encodeURIComponent(userCode)}&limit=1`
    );
    let p = data?.[0];
    if (!p) {
      // Bootstrap portfolio if it doesn't exist. Shouldn't happen for Milburn
      // or Ella -- both already have portfolios.
      const seed = {
        user_code: userCode,
        cash: STARTING_CASH,
        starting_cash: STARTING_CASH,
        holdings: {},
      };
      const { data: ins } = await db.insert('stockrocket_portfolios', seed);
      p = ins?.[0] || seed;
    }
    portfolioCache.set(userCode, p);
    return p;
  }

  for (const order of pending) {
    const live = priceMap[order.symbol];
    if (!live || !isFinite(live.price) || live.price <= 0) {
      details.push({ id: order.id, action: 'skip', reason: 'no_live_price' });
      continue;
    }

    const trigger = Number(order.trigger_price);
    const qty = Number(order.qty);
    const side = order.side;

    // Crossed? SELL when live >= trigger. BUY when live <= trigger.
    const crossed = side === 'SELL' ? live.price >= trigger : live.price <= trigger;
    if (!crossed) {
      details.push({ id: order.id, action: 'wait', live: live.price, trigger });
      continue;
    }

    // Cash / holdings guard before writing.
    const portfolio = await getPortfolio(order.user_code);
    const cash = Number(portfolio.cash) || 0;
    const holdings = (portfolio.holdings && typeof portfolio.holdings === 'object') ? portfolio.holdings : {};
    const existing = holdings[order.symbol];
    const total = qty * trigger;

    if (side === 'BUY' && total > cash + 0.005) {
      await db.update(
        'stockrocket_crypto_orders',
        `id=eq.${encodeURIComponent(order.id)}&status=eq.pending`,
        { status: 'expired', expired_reason: 'insufficient_cash' }
      );
      expired++;
      details.push({ id: order.id, action: 'expired', reason: 'insufficient_cash', need: total, have: cash });
      continue;
    }
    if (side === 'SELL') {
      const curShares = Number(existing?.shares) || 0;
      if (!existing || curShares <= 0 || qty > curShares + EPSILON) {
        await db.update(
          'stockrocket_crypto_orders',
          `id=eq.${encodeURIComponent(order.id)}&status=eq.pending`,
          { status: 'expired', expired_reason: 'insufficient_holdings' }
        );
        expired++;
        details.push({ id: order.id, action: 'expired', reason: 'insufficient_holdings', need: qty, have: curShares });
        continue;
      }
    }

    // Compute portfolio mutation.
    let newCash = cash;
    const newHoldings = { ...holdings };
    let preTradeAvgCost = Number(existing?.avgCost) || null;

    if (side === 'BUY') {
      newCash = cash - total;
      if (existing) {
        const curShares = Number(existing.shares) || 0;
        const curCost = Number(existing.avgCost) || 0;
        const newShares = curShares + qty;
        const newAvg = newShares > 0 ? ((curShares * curCost) + total) / newShares : trigger;
        newHoldings[order.symbol] = {
          symbol: order.symbol,
          name: order.name || existing.name || order.symbol,
          assetType: existing.assetType || 'crypto',
          shares: newShares,
          avgCost: newAvg,
        };
      } else {
        newHoldings[order.symbol] = {
          symbol: order.symbol,
          name: order.name || order.symbol,
          assetType: 'crypto',
          shares: qty,
          avgCost: trigger,
        };
      }
    } else {
      // SELL
      const curShares = Number(existing.shares) || 0;
      newCash = cash + total;
      const remaining = curShares - qty;
      if (remaining <= EPSILON) {
        delete newHoldings[order.symbol];
      } else {
        newHoldings[order.symbol] = { ...existing, shares: remaining };
      }
    }

    // Write trade row (append-only ledger). price = trigger_price per I8.
    const tradeRow = {
      user_code: order.user_code,
      trade_type: side,
      asset_type: 'crypto',
      symbol: order.symbol,
      name: order.name || order.symbol,
      shares: qty,
      price: trigger,
      total,
      cash_after: newCash,
      source: 'crypto_bot_limit',
    };
    const { data: tradeIns, error: tradeErr } = await db.insert('stockrocket_trades', tradeRow);
    if (tradeErr) {
      details.push({ id: order.id, action: 'error', step: 'trade_insert', err: tradeErr });
      continue;
    }
    const tradeId = tradeIns?.[0]?.id;

    // Upsert portfolio.
    const portfolioRow = {
      user_code: order.user_code,
      cash: newCash,
      starting_cash: Number(portfolio.starting_cash) || STARTING_CASH,
      holdings: newHoldings,
    };
    const { error: portErr } = await db.upsert('stockrocket_portfolios', portfolioRow, 'user_code');
    if (portErr) {
      // Trade row was written but portfolio upsert failed. That's a bad
      // partial state -- log the order with an error action. The trade row
      // stays; manual cleanup if needed.
      details.push({ id: order.id, action: 'error', step: 'portfolio_upsert', err: portErr, trade_id: tradeId });
      continue;
    }

    // Refresh cache so downstream orders in the same sweep see the new state.
    portfolioCache.set(order.user_code, portfolioRow);

    // Mark order filled.
    const { error: orderErr } = await db.update(
      'stockrocket_crypto_orders',
      `id=eq.${encodeURIComponent(order.id)}&status=eq.pending`,
      {
        status: 'filled',
        filled_at: new Date().toISOString(),
        filled_price: trigger,
        fill_trade_id: tradeId,
      }
    );
    if (orderErr) {
      details.push({ id: order.id, action: 'error', step: 'order_mark_filled', err: orderErr, trade_id: tradeId });
      continue;
    }

    filled++;
    details.push({
      id: order.id,
      action: 'filled',
      side,
      symbol: order.symbol,
      user_code: order.user_code,
      trigger,
      live: live.price,
      qty,
      total,
      trade_id: tradeId,
      pre_trade_avg_cost: preTradeAvgCost,
    });
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
