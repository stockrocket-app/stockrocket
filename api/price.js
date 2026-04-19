// StockRocket -- Unified Price Service (Vercel Edge Function)
// -----------------------------------------------------------
// Single endpoint for all price lookups. Routes to the correct vendor based on
// asset_type, validates every price strictly, and returns a uniform shape with
// a server timestamp on every entry. No silent fallbacks, no sentinel values.
//
// Why this exists: Incident 2026-04-18. The client had two parallel price
// pipelines (CoinGecko for crypto, Finnhub for stocks) each with its own
// silent-fallback behavior. When CoinGecko failed, the crypto pipeline
// returned null; the UI then fell back to a hardcoded MOCK_CRYPTO seed with
// BTC @ $97,245, and six trades were written at that phantom price. Unifying
// the price fetch behind one endpoint with one validation policy makes that
// class of bug impossible.
//
// Contract:
//   GET /api/price?symbol=AAPL                           -> single stock
//   GET /api/price?symbol=BTC&asset_type=crypto          -> single crypto
//   GET /api/price?symbols=AAPL,MSFT&asset_type=stock    -> batch stocks
//   GET /api/price?symbols=BTC,ETH&asset_type=crypto     -> batch crypto
//
// Response (success):
//   { ok: true, prices: [ { symbol, asset_type, price, change, change_pct,
//                           source, fetched_at, stale } ] }
// Response per-symbol failure is reported inline with price=null, stale=true,
// error: 'upstream_failure' | 'invalid_price' | 'unknown_symbol'.
//
// INVARIANTS (enforced here; see docs/PRICE_INVARIANTS.md):
//   I1. A returned entry with price !== null implies price is finite and > 0.
//   I2. Every entry carries fetched_at in ms since epoch.
//   I3. Every entry carries source ('finnhub' | 'coinbase' | 'coingecko').
//   I4. No entry ever carries a hardcoded seed value.
//
// CRYPTO SOURCING (2026-04-18 post-incident):
//   Primary: Coinbase Exchange public stats endpoint
//     (https://api.exchange.coinbase.com/products/{SYM}-USD/stats) -- public,
//     no key, per-symbol, reliable.
//   Fallback: CoinGecko simple/price -- used only if Coinbase fails for a given
//     symbol. CoinGecko was the original primary and caused the 04-18 incident
//     via rate-limiting + silent failures; it's retained as a last resort so a
//     single-vendor outage doesn't kill the feed.
//
// Env vars: FINNHUB_KEY

export const config = { runtime: 'edge' };

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// CoinGecko symbol -> id map. Extend when adding support for a new coin.
const COINGECKO_IDS = {
  BTC: 'bitcoin',
  ETH: 'ethereum',
  SOL: 'solana',
  ADA: 'cardano',
  DOT: 'polkadot',
};

// Bounds used for the deviation guard in consumers. Not enforced here (this
// endpoint returns raw live data); exported for client-side reference.
// const DEVIATION_LIMITS = { stock: 0.05, crypto: 0.15 };

export default async function handler(req) {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }
  if (req.method !== 'GET') {
    return json({ ok: false, error: 'method_not_allowed' }, 405);
  }

  const url = new URL(req.url);
  const assetType = (url.searchParams.get('asset_type') || 'stock').toLowerCase();
  const singleSymbol = (url.searchParams.get('symbol') || '').trim().toUpperCase();
  const batchSymbols = (url.searchParams.get('symbols') || '')
    .split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
  const symbols = singleSymbol ? [singleSymbol] : batchSymbols;

  if (!symbols.length) return json({ ok: false, error: 'symbol_required' }, 400);
  if (!['stock', 'crypto'].includes(assetType)) {
    return json({ ok: false, error: 'invalid_asset_type', detail: 'asset_type must be stock or crypto' }, 400);
  }
  if (symbols.length > 20) {
    return json({ ok: false, error: 'too_many_symbols', detail: 'max 20 per request' }, 400);
  }

  try {
    let prices;
    if (assetType === 'crypto') {
      prices = await fetchCryptoBatch(symbols);
    } else {
      prices = await fetchStockBatch(symbols);
    }
    return json({ ok: true, prices });
  } catch (e) {
    return json({ ok: false, error: 'service_failure', detail: String(e && e.message || e) }, 502);
  }
}

// ---------------- Stocks (Finnhub) ----------------
async function fetchStockBatch(symbols) {
  const key = process.env.FINNHUB_KEY;
  if (!key) throw new Error('finnhub_key_missing');

  // Finnhub /quote is single-symbol; issue in parallel.
  const results = await Promise.all(symbols.map(async (sym) => {
    try {
      const res = await fetch(
        `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(sym)}&token=${key}`,
        { signal: AbortSignal.timeout ? AbortSignal.timeout(5000) : undefined }
      );
      if (!res.ok) return staleEntry(sym, 'stock', 'finnhub', 'upstream_failure');
      const d = await res.json();
      // Invariant I1: c must be finite and > 0 to be a valid price.
      const px = Number(d?.c);
      if (!isFinite(px) || px <= 0) {
        return staleEntry(sym, 'stock', 'finnhub', 'invalid_price');
      }
      return {
        symbol: sym,
        asset_type: 'stock',
        price: px,
        change: isFinite(Number(d?.d)) ? Number(d.d) : null,
        change_pct: isFinite(Number(d?.dp)) ? Number(d.dp) : null,
        high: isFinite(Number(d?.h)) ? Number(d.h) : null,
        low: isFinite(Number(d?.l)) ? Number(d.l) : null,
        prev_close: isFinite(Number(d?.pc)) ? Number(d.pc) : null,
        source: 'finnhub',
        fetched_at: Date.now(),
        stale: false,
      };
    } catch (e) {
      return staleEntry(sym, 'stock', 'finnhub', 'upstream_failure', String(e && e.message || e));
    }
  }));
  return results;
}

// ---------------- Crypto (Coinbase primary, CoinGecko fallback) ----------------
// Per-symbol two-phase strategy: try Coinbase first (fast, reliable, no key).
// If Coinbase fails for a symbol, try CoinGecko for just that symbol. If both
// fail, surface a stale entry with source='coingecko' and error='upstream_failure'.
// CoinGecko is batch-aware, so we only hit it once per request for whichever
// symbols fell through.
async function fetchCryptoBatch(symbols) {
  const known = [];
  const unknown = [];
  for (const sym of symbols) {
    if (COINGECKO_IDS[sym]) known.push(sym);
    else unknown.push(sym);
  }

  // Phase 1: Coinbase per-symbol, in parallel.
  const coinbasePrimary = await Promise.all(known.map(async sym => {
    try {
      const res = await fetch(
        `https://api.exchange.coinbase.com/products/${encodeURIComponent(sym)}-USD/stats`,
        { signal: AbortSignal.timeout ? AbortSignal.timeout(4000) : undefined }
      );
      if (!res.ok) return { symbol: sym, ok: false };
      const d = await res.json();
      const px = Number(d?.last);
      const open = Number(d?.open);
      if (!isFinite(px) || px <= 0) return { symbol: sym, ok: false };
      const pct = (isFinite(open) && open > 0) ? ((px - open) / open) * 100 : null;
      return {
        symbol: sym,
        ok: true,
        entry: {
          symbol: sym,
          asset_type: 'crypto',
          price: px,
          change: pct !== null ? px * (pct / 100) : null,
          change_pct: pct,
          high: isFinite(Number(d?.high)) ? Number(d.high) : null,
          low: isFinite(Number(d?.low)) ? Number(d.low) : null,
          volume: isFinite(Number(d?.volume)) ? Number(d.volume) : null,
          market_cap: null, // Coinbase stats does not expose mcap
          source: 'coinbase',
          fetched_at: Date.now(),
          stale: false,
        },
      };
    } catch {
      return { symbol: sym, ok: false };
    }
  }));

  const entries = new Map();
  const needFallback = [];
  for (const r of coinbasePrimary) {
    if (r.ok) entries.set(r.symbol, r.entry);
    else needFallback.push(r.symbol);
  }

  // Phase 2: CoinGecko batch fallback for any symbols that Coinbase couldn't
  // serve. Single request for all fallback symbols.
  if (needFallback.length) {
    const ids = needFallback.map(s => COINGECKO_IDS[s]).filter(Boolean);
    let livePrices = {};
    if (ids.length) {
      try {
        const res = await fetch(
          `https://api.coingecko.com/api/v3/simple/price?ids=${ids.join(',')}&vs_currencies=usd&include_24hr_change=true&include_market_cap=true`,
          { signal: AbortSignal.timeout ? AbortSignal.timeout(5000) : undefined }
        );
        if (res.ok) livePrices = await res.json();
      } catch (_) {
        livePrices = {};
      }
    }
    for (const sym of needFallback) {
      const id = COINGECKO_IDS[sym];
      const d = id ? livePrices[id] : null;
      const px = Number(d?.usd);
      if (!isFinite(px) || px <= 0) {
        entries.set(sym, staleEntry(sym, 'crypto', 'coingecko', d ? 'invalid_price' : 'upstream_failure'));
        continue;
      }
      const pct = isFinite(Number(d?.usd_24h_change)) ? Number(d.usd_24h_change) : null;
      entries.set(sym, {
        symbol: sym,
        asset_type: 'crypto',
        price: px,
        change: pct !== null ? px * (pct / 100) : null,
        change_pct: pct,
        market_cap: isFinite(Number(d?.usd_market_cap)) ? Number(d.usd_market_cap) : null,
        source: 'coingecko',
        fetched_at: Date.now(),
        stale: false,
      });
    }
  }

  // Unknown symbols -- surface as stale with a clear error, never a price.
  for (const sym of unknown) {
    entries.set(sym, staleEntry(sym, 'crypto', 'coinbase', 'unknown_symbol'));
  }

  // Preserve the caller-requested ordering.
  return symbols.map(s => entries.get(s) || staleEntry(s, 'crypto', 'coinbase', 'unknown_symbol'));
}

function staleEntry(symbol, asset_type, source, error, detail) {
  return {
    symbol,
    asset_type,
    price: null,
    change: null,
    change_pct: null,
    source,
    fetched_at: Date.now(),
    stale: true,
    error,
    ...(detail ? { detail } : {}),
  };
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'content-type': 'application/json',
      // Short cache -- live prices are cheap to re-fetch, the point of a
      // unified service is freshness not throughput.
      'cache-control': 'public, s-maxage=10, stale-while-revalidate=20',
      ...CORS,
    },
  });
}
