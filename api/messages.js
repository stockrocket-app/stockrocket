// StockRocket -- Messages API (Vercel Edge Function)
// --------------------------------------------------------
// Chat + trade alerts + "Ask Milburn" DM threads.
//
//   GET  /api/messages?channel=group                   -> last 100 group messages
//   GET  /api/messages?channel=alerts                  -> last 100 trade alerts
//   GET  /api/messages?channel=milburn&thread_for=CODE -> one user's Milburn DM thread
//   GET  /api/messages?channel=milburn&admin=1         -> admin: all Milburn threads grouped
//
//   POST /api/messages  body:{channel, thread_for?, content}
//       - Auth by X-User-Code header (any active access code).
//       - 'group'   : anyone writes
//       - 'alerts'  : anyone writes (client posts on trade execution)
//       - 'milburn' : thread_for must equal author's code, OR author is admin
//       - Author display name sourced from access_codes.label (fallback: code).
//
// Env vars required (set in Vercel project settings):
//   SUPABASE_URL
//   SUPABASE_SERVICE_KEY

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

  // Auth: every request needs a valid active code
  const userCode = (req.headers.get('x-user-code') || '').trim();
  if (!userCode) return json({ error: 'auth_required' }, 401);
  const { data: authRows } = await db.select(
    'stockrocket_access_codes',
    `code=eq.${encodeURIComponent(userCode)}&active=eq.true&limit=1`
  );
  const me = authRows?.[0];
  if (!me) return json({ error: 'auth_denied' }, 403);

  // -------- GET --------
  if (req.method === 'GET') {
    const channel = url.searchParams.get('channel');
    if (!['group', 'alerts', 'milburn'].includes(channel)) {
      return json({ error: 'invalid_channel' }, 400);
    }

    if (channel === 'milburn') {
      // Admin view: all threads grouped
      if (url.searchParams.get('admin') === '1') {
        if (!me.is_admin) return json({ error: 'admin_only' }, 403);
        const { data } = await db.select(
          'stockrocket_messages',
          `channel=eq.milburn&order=created_at.desc&limit=1000`
        );
        const threads = groupByThread(data || []);
        return json({ ok: true, threads });
      }
      // User view: own thread only
      const threadFor = url.searchParams.get('thread_for') || me.code;
      if (threadFor !== me.code && !me.is_admin) {
        return json({ error: 'forbidden' }, 403);
      }
      const { data } = await db.select(
        'stockrocket_messages',
        `channel=eq.milburn&thread_for=eq.${encodeURIComponent(threadFor)}&order=created_at.asc&limit=200`
      );
      return json({ ok: true, messages: data || [] });
    }

    // Group or alerts: public feed
    const { data } = await db.select(
      'stockrocket_messages',
      `channel=eq.${channel}&order=created_at.desc&limit=100`
    );
    return json({ ok: true, messages: (data || []).reverse() });
  }

  // -------- POST --------
  if (req.method === 'POST') {
    let body;
    try { body = await req.json(); } catch { return json({ error: 'invalid_json' }, 400); }

    const channel = body.channel;
    const content = (body.content || '').toString().trim().slice(0, 2000);
    if (!['group', 'alerts', 'milburn'].includes(channel)) {
      return json({ error: 'invalid_channel' }, 400);
    }
    if (!content) return json({ error: 'empty_message' }, 400);

    let threadFor = null;
    if (channel === 'milburn') {
      threadFor = (body.thread_for || '').toString().trim();
      if (!threadFor) return json({ error: 'thread_for_required' }, 400);
      // A user can only post in their own thread. Admin can post in any thread.
      if (threadFor !== me.code && !me.is_admin) {
        return json({ error: 'forbidden' }, 403);
      }
    }

    const authorName = me.label || me.code;
    const row = {
      channel,
      thread_for: threadFor,
      author_code: me.code,
      author_name: authorName,
      content,
    };
    const { data, error } = await db.insert('stockrocket_messages', row);
    if (error) return json({ error: 'insert_failed', detail: error }, 400);
    return json({ ok: true, message: data?.[0] || row });
  }

  return json({ error: 'method_not_allowed' }, 405);
}

// Group a flat list of milburn messages by thread_for, newest-active first.
function groupByThread(messages) {
  const map = new Map();
  for (const m of messages) {
    const key = m.thread_for || 'unknown';
    if (!map.has(key)) {
      map.set(key, { thread_for: key, messages: [], last_at: m.created_at });
    }
    const t = map.get(key);
    t.messages.push(m);
    if (m.created_at > t.last_at) t.last_at = m.created_at;
  }
  // Each thread's messages should be chronological
  for (const t of map.values()) {
    t.messages.sort((a, b) => a.created_at.localeCompare(b.created_at));
  }
  // Return threads sorted newest-active first
  return [...map.values()].sort((a, b) => b.last_at.localeCompare(a.last_at));
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
  };
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...CORS },
  });
}
