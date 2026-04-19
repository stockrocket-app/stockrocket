// StockRocket -- Study API (Vercel Edge Function)
// --------------------------------------------------------
// Serves the Academy content: playbooks (mental models) + teardowns (company
// deep-dives). Also tracks which teardowns each user has opened.
//
//   GET  /api/study                         -> { playbooks: [...], teardowns: [summary...] }
//   GET  /api/study?teardown=aapl-deep-dive -> { teardown: { ...full body... } }
//   GET  /api/study?completions=1           -> { completions: ['aapl-deep-dive', ...] }
//         (requires X-User-Code)
//   POST /api/study  body: { teardown_slug }
//         -> upserts a completion row (requires X-User-Code)
//
// Env vars required (set in Vercel project settings):
//   SUPABASE_URL
//   SUPABASE_SERVICE_KEY
//
// Playbook + teardown rows are PUBLIC content. Only completion reads/writes
// require auth. The Edge Function uses the service_role key for all writes.

export const config = { runtime: 'edge' };

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

  // ==================== POST: mark teardown complete ====================
  if (req.method === 'POST') {
    const userCode = (req.headers.get('x-user-code') || '').trim();
    if (!userCode) return json({ error: 'auth_required' }, 401);
    const me = await authenticate(db, userCode);
    if (!me) return json({ error: 'auth_denied' }, 403);

    let body;
    try { body = await req.json(); } catch { return json({ error: 'bad_json' }, 400); }
    const teardownSlug = String(body?.teardown_slug || '').trim();
    if (!teardownSlug) return json({ error: 'missing_teardown_slug' }, 400);

    // Verify teardown exists before writing a completion row
    const { data: td } = await db.select(
      'stockrocket_teardowns',
      `slug=eq.${encodeURIComponent(teardownSlug)}&select=slug&limit=1`
    );
    if (!td?.[0]) return json({ error: 'unknown_teardown' }, 404);

    const { data: comp, error: compErr } = await db.upsert(
      'stockrocket_teardown_completions',
      { user_code: userCode, teardown_slug: teardownSlug },
      'user_code,teardown_slug'
    );
    if (compErr) return json({ error: 'completion_upsert_failed', detail: compErr }, 500);
    return json({ ok: true, completion: comp?.[0] });
  }

  if (req.method !== 'GET') return json({ error: 'method_not_allowed' }, 405);

  // ==================== GET: user's completion set ====================
  if (url.searchParams.get('completions') === '1') {
    const userCode = (req.headers.get('x-user-code') || '').trim();
    if (!userCode) return json({ error: 'auth_required' }, 401);
    const me = await authenticate(db, userCode);
    if (!me) return json({ error: 'auth_denied' }, 403);

    const { data } = await db.select(
      'stockrocket_teardown_completions',
      `user_code=eq.${encodeURIComponent(userCode)}&select=teardown_slug,completed_at`
    );
    return json({ ok: true, completions: (data || []).map(r => r.teardown_slug) });
  }

  // ==================== GET: single teardown with full body ====================
  const singleSlug = url.searchParams.get('teardown');
  if (singleSlug) {
    const { data, error } = await db.select(
      'stockrocket_teardowns',
      `slug=eq.${encodeURIComponent(singleSlug)}&status=eq.published&limit=1`
    );
    if (error) return json({ error: 'teardown_fetch_failed', detail: error }, 500);
    const teardown = data?.[0];
    if (!teardown) return json({ error: 'not_found' }, 404);
    return json({ ok: true, teardown });
  }

  // ==================== GET: catalog (playbooks + teardown summaries) ====================
  const [{ data: playbooks, error: pbErr }, { data: teardowns, error: tdErr }] = await Promise.all([
    db.select('stockrocket_playbooks', 'order=order_hint.asc,slug.asc'),
    // Exclude body from summary view -- keep this endpoint fast.
    db.select(
      'stockrocket_teardowns',
      'status=eq.published&select=slug,symbol,title,difficulty,linked_playbooks,estimated_read_minutes,author,published_at&order=published_at.desc'
    ),
  ]);
  if (pbErr) return json({ error: 'playbooks_fetch_failed', detail: pbErr }, 500);
  if (tdErr) return json({ error: 'teardowns_fetch_failed', detail: tdErr }, 500);

  return json({
    ok: true,
    playbooks: playbooks || [],
    teardowns: teardowns || [],
  });
}

// -------- Auth via stockrocket_access_codes (mirrors trades.js) --------
async function authenticate(db, userCode) {
  const { data } = await db.select(
    'stockrocket_access_codes',
    `code=eq.${encodeURIComponent(userCode)}&active=eq.true&limit=1`
  );
  return data?.[0] || null;
}

// -------- Minimal Supabase REST client (mirrors trades.js) --------
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
