// StockRocket -- Trades API (Vercel Edge Function)
// --------------------------------------------------------
// Server-side source of truth for portfolios + trade ledger.
// localStorage is now just a fast-paint cache; this endpoint is authoritative.
//
//   GET  /api/trades            -> my portfolio + last 50 trades
//   GET  /api/trades?admin=1    -> admin: all portfolios for leaderboard
//   POST /api/trades  body:{type:'BUY'|'SELL', symbol, name, asset_type, shares, price}
//       - Auth by X-User-Code header (any active access code)
//       - Validates cash (BUY) / share count (SELL)
//       - Inserts row in stockrocket_trades, upserts stockrocket_portfolios
//       - Returns updated portfolio + trade row
//
// Env vars required (set in Vercel project settings):
//   SUPABASE_URL
//   SUPABASE_SERVICE_KEY

export const config = { runtime: 'edge' };

const STARTING_CASH = 100000;
const EPSILON = 1e-8;

// Server-side price verification bounds. Client-submitted price must land
// within these deviation bands of the live price the server pulls at trade
// time. See docs/PRICE_INVARIANTS.md for the rationale. Bounds are intentionally
// loose enough to absorb normal tick drift between the client's last sample
// and the server fetch, tight enough to reject a stale or mocked value.
const PRICE_DEVIATION_LIMITS = { stock: 0.03, crypto: 0.05 };

// CoinGecko symbol -> id map (mirrored from api/price.js). Kept local so this
// Edge Function has zero imports from neighbours.
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
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }

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
  const { data: authRows } = await db.select(
    'stockrocket_access_codes',
    `code=eq.${encodeURIComponent(userCode)}&active=eq.true&limit=1`
  );
  const me = authRows?.[0];
  if (!me) return json({ error: 'auth_denied' }, 403);

  // Fetch or bootstrap a portfolio row for the given user_code
  async function getPortfolio(targetCode) {
    const { data } = await db.select(
      'stockrocket_portfolios',
      `user_code=eq.${encodeURIComponent(targetCode)}&limit=1`
    );
    if (data?.[0]) return data[0];
    const seed = {
      user_code: targetCode,
      cash: STARTING_CASH,
      starting_cash: STARTING_CASH,
      holdings: {},
    };
    const { data: inserted } = await db.insert('stockrocket_portfolios', seed);
    return inserted?.[0] || seed;
  }

  // -------- GET --------
  if (req.method === 'GET') {
    if (url.searchParams.get('admin') === '1') {
      if (!me.is_admin) return json({ error: 'admin_only' }, 403);
      const { data: portfolios } = await db.select(
        'stockrocket_portfolios',
        'order=updated_at.desc&limit=100'
      );
      return json({ ok: true, portfolios: portfolios || [] });
    }
    const portfolio = await getPortfolio(me.code);
    const { data: trades } = await db.select(
      'stockrocket_trades',
      `user_code=eq.${encodeURIComponent(me.code)}&order=executed_at.desc&limit=50`
    );
    return json({ ok: true, portfolio, trades: trades || [] });
  }

  // -------- POST --------
  if (req.method === 'POST') {
    let body;
    try { body = await req.json(); } catch { return json({ error: 'invalid_json' }, 400); }

    const type = (body.type || '').toString().toUpperCase();
    const symbol = (body.symbol || '').toString().trim().toUpperCase();
    const name = (body.name || '').toString().slice(0, 120);
    const assetType = (body.asset_type || 'stock').toString();
    const shares = Number(body.shares);
    const price = Number(body.price);

    if (!['BUY', 'SELL'].includes(type)) return json({ error: 'invalid_type' }, 400);
    if (!['stock', 'crypto'].includes(assetType)) return json({ error: 'invalid_asset_type' }, 400);
    if (!symbol) return json({ error: 'symbol_required' }, 400);
    if (!isFinite(shares) || shares <= 0) return json({ error: 'invalid_shares' }, 400);
    if (!isFinite(price) || price <= 0) return json({ error: 'invalid_price' }, 400);

    // ------------------------------------------------------------------
    // SERVER-SIDE PRICE VERIFICATION -- 2026-04-18 incident fix
    // ------------------------------------------------------------------
    // The client sends the price it just rendered; the server MUST NOT trust
    // it. We pull a live price here (Coinbase primary, CoinGecko fallback for
    // crypto; Finnhub for stocks) and reject the trade if the client price
    // deviates more than PRICE_DEVIATION_LIMITS allows. If the server cannot
    // get a live price at all, we FAIL CLOSED -- no trade, no phantom ledger
    // row. This closes the last hole that made the 04-18 incident possible.
    // See docs/PRICE_INVARIANTS.md.
    const verification = await verifyTradePrice(symbol, assetType, price);
    if (!verification.ok) {
      return json({
        error: verification.error,
        detail: verification.detail,
        server_price: verification.serverPrice ?? null,
        client_price: price,
        deviation_pct: verification.deviationPct ?? null,
        source: verification.source ?? null,
      }, 400);
    }

    const total = shares * price;

    const portfolio = await getPortfolio(me.code);
    const cash = Number(portfolio.cash) || 0;
    const holdings = (portfolio.holdings && typeof portfolio.holdings === 'object') ? portfolio.holdings : {};
    let newCash = cash;
    const newHoldings = { ...holdings };

    if (type === 'BUY') {
      if (total > cash + 0.005) {
        return json({ error: 'insufficient_cash', detail: `Need $${total.toFixed(2)}, have $${cash.toFixed(2)}` }, 400);
      }
      newCash = cash - total;
      const existing = holdings[symbol];
      if (existing) {
        const curShares = Number(existing.shares) || 0;
        const curCost = Number(existing.avgCost) || 0;
        const newShares = curShares + shares;
        const newAvg = newShares > 0 ? ((curShares * curCost) + total) / newShares : price;
        newHoldings[symbol] = {
          symbol,
          name: name || existing.name || symbol,
          assetType: existing.assetType || assetType,
          shares: newShares,
          avgCost: newAvg,
        };
      } else {
        newHoldings[symbol] = { symbol, name: name || symbol, assetType, shares, avgCost: price };
      }
    } else {
      // SELL
      const existing = holdings[symbol];
      const curShares = Number(existing?.shares) || 0;
      if (!existing || curShares <= 0) {
        return json({ error: 'no_shares_to_sell', detail: `You don't own any ${symbol}` }, 400);
      }
      if (shares > curShares + EPSILON) {
        return json({ error: 'insufficient_shares', detail: `You own ${curShares} ${symbol}, tried to sell ${shares}` }, 400);
      }
      newCash = cash + total;
      const remaining = curShares - shares;
      if (remaining <= EPSILON) {
        delete newHoldings[symbol];
      } else {
        newHoldings[symbol] = { ...existing, shares: remaining };
      }
    }

    // Insert trade row (append-only ledger)
    const tradeRow = {
      user_code: me.code,
      trade_type: type,
      asset_type: assetType,
      symbol,
      name: name || symbol,
      shares,
      price,
      total,
      cash_after: newCash,
    };
    const { data: tradeIns, error: tradeErr } = await db.insert('stockrocket_trades', tradeRow);
    if (tradeErr) return json({ error: 'trade_insert_failed', detail: tradeErr }, 500);

    // Upsert the portfolio row
    const portfolioRow = {
      user_code: me.code,
      cash: newCash,
      starting_cash: Number(portfolio.starting_cash) || STARTING_CASH,
      holdings: newHoldings,
    };
    const { data: portUp, error: portErr } = await db.upsert('stockrocket_portfolios', portfolioRow, 'user_code');
    if (portErr) return json({ error: 'portfolio_upsert_failed', detail: portErr }, 500);

    return json({
      ok: true,
      trade: tradeIns?.[0] || tradeRow,
      portfolio: portUp?.[0] || portfolioRow,
    });
  }

  return json({ error: 'method_not_allowed' }, 405);
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

// ==================== Server-side price verification ====================
// Pull a live price server-side and compare to the client-submitted price.
// Returns:
//   { ok: true, serverPrice, source }
//   { ok: false, error, detail, serverPrice?, deviationPct?, source? }
//
// Fail-closed policy: if no live price is available, the trade is rejected.
// This is the hard stop that prevents a repeat of the 2026-04-18 incident
// where a silent client-side fallback produced phantom prices for the ledger.
async function verifyTradePrice(symbol, assetType, clientPrice) {
  const limit = PRICE_DEVIATION_LIMITS[assetType];
  if (!limit) {
    return { ok: false, error: 'invalid_asset_type', detail: `unsupported asset_type=${assetType}` };
  }

  const live = assetType === 'crypto'
    ? await fetchLiveCryptoPrice(symbol)
    : await fetchLiveStockPrice(symbol);

  if (!live || !isFinite(live.price) || live.price <= 0) {
    // Fail closed -- no price, no trade.
    return {
      ok: false,
      error: 'price_unverifiable',
      detail: 'Live price unavailable for verification. Try again in a moment.',
      source: live?.source || null,
    };
  }

  const deviation = Math.abs(clientPrice - live.price) / live.price;
  if (deviation > limit) {
    return {
      ok: false,
      error: 'price_deviation',
      detail: `Your price is ${(deviation * 100).toFixed(2)}% off the live market (limit ${(limit * 100).toFixed(0)}%). Refresh and retry.`,
      serverPrice: live.price,
      deviationPct: deviation * 100,
      source: live.source,
    };
  }

  return { ok: true, serverPrice: live.price, source: live.source };
}

// Crypto: Coinbase primary, CoinGecko fallback. Single-symbol variant of the
// fetcher in api/price.js -- kept local so trades.js has no cross-file imports.
async function fetchLiveCryptoPrice(symbol) {
  // Coinbase first
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

  // CoinGecko fallback
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

// Stocks: Finnhub. No fallback provider for stocks yet -- if Finnhub fails,
// verifyTradePrice returns fail-closed, which is the correct outcome.
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
