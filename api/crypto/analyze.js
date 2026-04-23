// StockRocket -- Crypto Bot Market Read (Vercel Edge Function)
// --------------------------------------------------------------
// Deterministic strategy engine. Pulls 90 days of daily candles for each
// supported asset, computes range position + trend + volatility, applies a
// fixed rule set, and returns a signal with suggested buy/sell targets.
//
// Admin-only. No AI / LLM calls -- signals are rule-based so they're
// repeatable and the prediction log can score their accuracy over time.
//
//   GET /api/crypto/analyze                  -> all 5 supported symbols
//   GET /api/crypto/analyze?symbol=BTC       -> single symbol
//
// Auth: X-Admin-Code header.
//
// Response:
//   { ok, generated_at, analyses: [{ symbol, price, change_7d_pct,
//     change_30d_pct, high_30d, low_30d, high_90d, low_90d, ma_20,
//     range_position, volatility_30d_pct, signal, signal_label,
//     reasoning[], suggested_sell_target, suggested_buy_target }] }
//
// Env vars: SUPABASE_URL, SUPABASE_SERVICE_KEY (for admin auth)

export const config = { runtime: 'edge' };

const ALLOWED_SYMBOLS = ['BTC', 'ETH', 'ADA', 'SOL', 'XRP'];

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Code',
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

  // Admin auth
  const adminCode = (req.headers.get('x-admin-code') || '').trim();
  if (!adminCode) return json({ error: 'admin_code_required' }, 401);

  const authRes = await fetch(
    `${SUPABASE_URL}/rest/v1/stockrocket_access_codes?code=eq.${encodeURIComponent(adminCode)}&is_admin=eq.true&active=eq.true&limit=1`,
    {
      headers: {
        apikey: SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      },
    }
  );
  const authRows = await authRes.json();
  if (!Array.isArray(authRows) || !authRows.length) {
    return json({ error: 'admin_denied' }, 403);
  }

  const url = new URL(req.url);
  const single = (url.searchParams.get('symbol') || '').toUpperCase();
  const symbols = single
    ? (ALLOWED_SYMBOLS.includes(single) ? [single] : [])
    : ALLOWED_SYMBOLS;

  if (!symbols.length) {
    return json({ error: 'invalid_symbol', detail: `Allowed: ${ALLOWED_SYMBOLS.join(', ')}` }, 400);
  }

  const analyses = await Promise.all(symbols.map(async (sym) => {
    try {
      const candles = await fetchDailyCandles(sym);
      if (candles.length < 30) {
        return { symbol: sym, error: 'insufficient_history', candles: candles.length };
      }
      return { symbol: sym, ...analyze(candles) };
    } catch (e) {
      return { symbol: sym, error: String((e && e.message) || e) };
    }
  }));

  return json({ ok: true, generated_at: new Date().toISOString(), analyses });
}

// ------------------------------------------------------------------
// Candle fetch -- Coinbase public API. No key, no cost.
// Returns array of { time, low, high, open, close, volume } ASCENDING.
// ------------------------------------------------------------------
async function fetchDailyCandles(symbol) {
  const res = await fetch(
    `https://api.exchange.coinbase.com/products/${encodeURIComponent(symbol)}-USD/candles?granularity=86400`,
    { signal: AbortSignal.timeout ? AbortSignal.timeout(6000) : undefined }
  );
  if (!res.ok) throw new Error(`coinbase_${res.status}`);
  const rows = await res.json();
  if (!Array.isArray(rows)) throw new Error('coinbase_malformed');
  // Coinbase returns [time, low, high, open, close, volume] descending by time.
  rows.sort((a, b) => a[0] - b[0]);
  return rows.map(r => ({
    time: Number(r[0]),
    low: Number(r[1]),
    high: Number(r[2]),
    open: Number(r[3]),
    close: Number(r[4]),
    volume: Number(r[5]),
  })).filter(c =>
    Number.isFinite(c.low) && Number.isFinite(c.high) &&
    Number.isFinite(c.open) && Number.isFinite(c.close) &&
    c.low > 0 && c.high > 0 && c.close > 0
  );
}

// ------------------------------------------------------------------
// Analysis rules (deterministic)
// ------------------------------------------------------------------
function analyze(candles) {
  const n = candles.length;
  const last = candles[n - 1];
  const price = last.close;

  const last7 = candles.slice(-7);
  const last30 = candles.slice(-30);
  const last90 = candles.slice(-90);

  const high30 = Math.max(...last30.map(c => c.high));
  const low30 = Math.min(...last30.map(c => c.low));
  const high90 = Math.max(...last90.map(c => c.high));
  const low90 = Math.min(...last90.map(c => c.low));

  const price7dAgo = last7[0].close;
  const price30dAgo = last30[0].close;

  const change_7d_pct = ((price - price7dAgo) / price7dAgo) * 100;
  const change_30d_pct = ((price - price30dAgo) / price30dAgo) * 100;

  // 20-day simple moving average
  const last20 = candles.slice(-20);
  const ma_20 = last20.reduce((s, c) => s + c.close, 0) / last20.length;

  // Where is price within the 30-day range: 0 = at low, 1 = at high
  const range_position = high30 > low30 ? (price - low30) / (high30 - low30) : 0.5;

  // Annualized volatility from 30d daily returns
  const returns = [];
  for (let i = 1; i < last30.length; i++) {
    returns.push((last30[i].close - last30[i - 1].close) / last30[i - 1].close);
  }
  const mean = returns.reduce((s, r) => s + r, 0) / returns.length;
  const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / returns.length;
  const volatility_30d_pct = Math.sqrt(variance) * 100 * Math.sqrt(365);

  // -----------------------------------------------------------------
  // Rule set -- returns a signal bucket + suggested prices + 1-3 reasoning lines.
  // Tuning note: these thresholds are deliberately conservative for crypto
  // volatility. Tighten only after prediction-log data backs a change.
  // -----------------------------------------------------------------
  const reasoning = [];
  let signal = 'HOLD';
  let signal_label = 'Hold';

  const above_ma_pct = ((price / ma_20) - 1) * 100;

  if (range_position > 0.85) {
    signal = 'SELL_ZONE';
    signal_label = 'Sell Zone';
    reasoning.push(`Near 30d high -- ${(range_position * 100).toFixed(0)}% into range`);
  } else if (range_position < 0.2) {
    signal = 'BUY_ZONE';
    signal_label = 'Buy Zone';
    reasoning.push(`Near 30d low -- ${(range_position * 100).toFixed(0)}% into range`);
  } else if (range_position > 0.6 && change_7d_pct > 10) {
    signal = 'TAKE_PARTIALS';
    signal_label = 'Take Partials';
    reasoning.push(`Upper third, +${change_7d_pct.toFixed(1)}% last 7d`);
  } else if (range_position < 0.4 && change_7d_pct < -10) {
    signal = 'ACCUMULATE';
    signal_label = 'Accumulate';
    reasoning.push(`Lower third, ${change_7d_pct.toFixed(1)}% last 7d`);
  } else {
    reasoning.push(
      `Mid-range (${(range_position * 100).toFixed(0)}%), ` +
      `7d ${change_7d_pct >= 0 ? '+' : ''}${change_7d_pct.toFixed(1)}%`
    );
  }

  if (above_ma_pct > 5) {
    reasoning.push(`+${above_ma_pct.toFixed(1)}% above 20d MA (bullish trend)`);
  } else if (above_ma_pct < -5) {
    reasoning.push(`${above_ma_pct.toFixed(1)}% below 20d MA (bearish trend)`);
  } else {
    reasoning.push(`Within ±5% of 20d MA (no strong trend)`);
  }

  reasoning.push(`Annualized vol: ${volatility_30d_pct.toFixed(0)}%`);

  // Suggested targets. Round to reasonable precision based on price magnitude.
  const precisionFor = (p) => {
    if (p >= 1000) return 0;
    if (p >= 10) return 2;
    if (p >= 1) return 3;
    return 5;
  };
  const prec = precisionFor(price);
  const roundTo = (v, p) => Number(v.toFixed(p));

  const suggested_sell_target = roundTo(high30, prec);
  // Buy target: 2% cushion above 30d low (reduces chance of catching falling knife exactly)
  const suggested_buy_target = roundTo(low30 * 1.02, prec);

  return {
    price: roundTo(price, prec),
    ma_20: roundTo(ma_20, prec),
    change_7d_pct: Math.round(change_7d_pct * 10) / 10,
    change_30d_pct: Math.round(change_30d_pct * 10) / 10,
    high_30d: roundTo(high30, prec),
    low_30d: roundTo(low30, prec),
    high_90d: roundTo(high90, prec),
    low_90d: roundTo(low90, prec),
    range_position: Math.round(range_position * 100) / 100,
    volatility_30d_pct: Math.round(volatility_30d_pct),
    above_ma_pct: Math.round(above_ma_pct * 10) / 10,
    signal,
    signal_label,
    reasoning,
    suggested_sell_target,
    suggested_buy_target,
  };
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      ...CORS,
    },
  });
}
