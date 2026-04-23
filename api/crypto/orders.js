// StockRocket -- Crypto Bot Orders API (Vercel Edge Function)
// -----------------------------------------------------------
// Admin-only CRUD for the crypto bot's limit orders.
//
//   GET    /api/crypto/orders                       -> admin: list orders
//          ?status=pending|filled|cancelled|expired|all (default: all)
//          ?user_code=RSJ-ADMIN (optional filter)
//          ?limit=100
//   POST   /api/crypto/orders                       -> admin: create a limit order
//          body: { user_code, symbol, name, side, trigger_price, qty,
//                  thesis, source, expected_direction?, expected_by?,
//                  ttl_days? (default 30) }
//   DELETE /api/crypto/orders?id=<uuid>             -> admin: cancel a pending order
//
// Auth: X-Admin-Code header must resolve to an active admin access code.
// Hidden from every non-admin surface. Writes go through SUPABASE_SERVICE_KEY
// which bypasses RLS (table has no anon/authenticated policies).
//
// Env vars:
//   SUPABASE_URL
//   SUPABASE_SERVICE_KEY

export const config = { runtime: 'edge' };

const ALLOWED_SYMBOLS = new Set(['BTC', 'ETH', 'ADA', 'SOL', 'XRP']);
const DEFAULT_TTL_DAYS = 30;
const MAX_TTL_DAYS = 365;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Code',
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

  // Admin auth. Same pattern as /api/codes.
  const adminCode = (req.headers.get('x-admin-code') || '').trim();
  if (!adminCode) return json({ error: 'admin_code_required' }, 401);
  const { data: adminRows } = await db.select(
    'stockrocket_access_codes',
    `code=eq.${encodeURIComponent(adminCode)}&is_admin=eq.true&active=eq.true&limit=1`
  );
  if (!adminRows?.length) return json({ error: 'admin_denied' }, 403);
  const admin = adminRows[0];

  // -------------------- GET --------------------
  if (req.method === 'GET') {
    const status = (url.searchParams.get('status') || 'all').toLowerCase();
    const userCode = (url.searchParams.get('user_code') || '').trim();
    const limit = Math.max(1, Math.min(500, parseInt(url.searchParams.get('limit'), 10) || 100));

    const filters = [];
    if (status !== 'all' && ['pending', 'filled', 'cancelled', 'expired'].includes(status)) {
      filters.push(`status=eq.${status}`);
    }
    if (userCode) filters.push(`user_code=eq.${encodeURIComponent(userCode)}`);
    filters.push(`order=created_at.desc`);
    filters.push(`limit=${limit}`);

    const { data, error } = await db.select('stockrocket_crypto_orders', filters.join('&'));
    if (error) return json({ error: 'list_failed', detail: error }, 500);
    return json({ ok: true, orders: data || [] });
  }

  // -------------------- POST --------------------
  if (req.method === 'POST') {
    let body;
    try { body = await req.json(); } catch { return json({ error: 'invalid_json' }, 400); }

    const userCode = String(body.user_code || '').trim();
    const symbol = String(body.symbol || '').trim().toUpperCase();
    const name = String(body.name || '').slice(0, 120) || symbol;
    const side = String(body.side || '').trim().toUpperCase();
    const triggerPrice = Number(body.trigger_price);
    const qty = Number(body.qty);
    const thesis = String(body.thesis || '').trim();
    const source = String(body.source || '').trim();
    const expectedDirection = body.expected_direction
      ? String(body.expected_direction).trim().toLowerCase()
      : null;
    const expectedBy = body.expected_by ? String(body.expected_by) : null;
    const ttlDays = Math.max(1, Math.min(MAX_TTL_DAYS, parseInt(body.ttl_days, 10) || DEFAULT_TTL_DAYS));

    // Validate
    if (!userCode) return json({ error: 'user_code_required' }, 400);
    if (!ALLOWED_SYMBOLS.has(symbol)) {
      return json({ error: 'invalid_symbol', detail: `Allowed: ${Array.from(ALLOWED_SYMBOLS).join(', ')}` }, 400);
    }
    if (!['BUY', 'SELL'].includes(side)) return json({ error: 'invalid_side' }, 400);
    if (!isFinite(triggerPrice) || triggerPrice <= 0) return json({ error: 'invalid_trigger_price' }, 400);
    if (!isFinite(qty) || qty <= 0) return json({ error: 'invalid_qty' }, 400);
    if (!thesis) return json({ error: 'thesis_required', detail: 'Every order logs a thesis -- no empty strings.' }, 400);
    if (!source) return json({ error: 'source_required', detail: 'Every order logs a source -- no empty strings.' }, 400);
    if (expectedDirection && !['up', 'down'].includes(expectedDirection)) {
      return json({ error: 'invalid_expected_direction' }, 400);
    }
    if (expectedBy && isNaN(new Date(expectedBy).getTime())) {
      return json({ error: 'invalid_expected_by' }, 400);
    }

    // Verify the target user_code exists in access codes (no typos on target)
    const { data: targetRows } = await db.select(
      'stockrocket_access_codes',
      `code=eq.${encodeURIComponent(userCode)}&active=eq.true&limit=1`
    );
    if (!targetRows?.length) {
      return json({ error: 'target_user_not_found', detail: `No active access code '${userCode}'` }, 400);
    }

    const expireAt = new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000).toISOString();

    const row = {
      user_code: userCode,
      asset_type: 'crypto',
      symbol,
      name,
      side,
      order_type: 'limit',
      trigger_price: triggerPrice,
      qty,
      status: 'pending',
      expire_at: expireAt,
      thesis,
      source,
      expected_direction: expectedDirection,
      expected_by: expectedBy,
      created_by_code: admin.code,
    };

    const { data, error } = await db.insert('stockrocket_crypto_orders', row);
    if (error) return json({ error: 'insert_failed', detail: error }, 500);
    return json({ ok: true, order: data?.[0] || row });
  }

  // -------------------- DELETE (cancel) --------------------
  if (req.method === 'DELETE') {
    const id = (url.searchParams.get('id') || '').trim();
    if (!id) return json({ error: 'id_required' }, 400);

    // Fetch order to confirm it's still pending
    const { data: existing } = await db.select(
      'stockrocket_crypto_orders',
      `id=eq.${encodeURIComponent(id)}&limit=1`
    );
    const order = existing?.[0];
    if (!order) return json({ error: 'order_not_found' }, 404);
    if (order.status !== 'pending') {
      return json({ error: 'not_cancellable', detail: `Order is ${order.status}, only pending orders can be cancelled.` }, 400);
    }

    const { error } = await db.update(
      'stockrocket_crypto_orders',
      `id=eq.${encodeURIComponent(id)}`,
      { status: 'cancelled' }
    );
    if (error) return json({ error: 'cancel_failed', detail: error }, 500);
    return json({ ok: true, cancelled: id });
  }

  return json({ error: 'method_not_allowed' }, 405);
}

// -------- Minimal Supabase REST client --------
// Same shape as api/trades.js -- duplicated, not imported, because Edge
// Functions don't share code across files.
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
      const res = await fetch(`${base}/${table}`, {
        method: 'POST', headers, body: JSON.stringify(row),
      });
      if (!res.ok) return { data: null, error: await res.text() };
      return { data: await res.json(), error: null };
    },
    async update(table, query, patch) {
      const res = await fetch(`${base}/${table}?${query}`, {
        method: 'PATCH', headers, body: JSON.stringify(patch),
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
