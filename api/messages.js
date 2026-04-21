// StockRocket -- Messages API (Vercel Edge Function)
// --------------------------------------------------------
// Chat + trade alerts + "Ask Milburn" DM threads.
//
//   GET  /api/messages?channel=group&room=bulls              -> last 100 messages in a group room
//   GET  /api/messages?channel=group&room=bulls&with_reads=1 -> messages + reads map
//   GET  /api/messages?channel=alerts                        -> last 100 trade alerts
//   GET  /api/messages?channel=milburn&thread_for=CODE       -> one user's Milburn DM thread
//   GET  /api/messages?channel=milburn&admin=1               -> admin: all Milburn threads grouped
//   GET  /api/messages?unread=1                              -> unread counts for this user across all channels
//
//   POST /api/messages  body:{channel, room?, thread_for?, content}
//       - Auth by X-User-Code header (any active access code).
//       - 'group'   : `room` is REQUIRED. Caller must be a member of the room
//                     (see GROUP_ROOMS below) OR be admin. Persists as
//                     channel='group', thread_for=<room>.
//       - 'alerts'  : anyone writes (client posts on trade execution)
//       - 'milburn' : thread_for must equal author's code, OR author is admin
//       - Author display name sourced from access_codes.label (fallback: code).
//
//   POST /api/messages  body:{action:'mark_seen', channel, room?}
//       - Upserts last_seen_at=now() for this user + channel.
//       - For channel='group', room is required and the stored channel key is
//         "group:<room>" so per-room read state is tracked without a schema
//         change (stockrocket_chat_reads is still keyed by (user_label, channel)).
//
// Group rooms:
//   The membership map (GROUP_ROOMS) maps room id -> allowed labels/codes.
//   Add/remove names here to change who can read/write each private room.
//   Admins are implicitly members of every room.
//
// Env vars required (set in Vercel project settings):
//   SUPABASE_URL
//   SUPABASE_SERVICE_KEY

export const config = { runtime: 'edge' };

// Private group rooms and their membership. Keys are room ids used in URLs and
// stored in stockrocket_messages.thread_for when channel='group'. Values are
// case-insensitive access-code labels. An admin can always read/write any room.
// Edit this map to add/remove members; no schema change required.
const GROUP_ROOMS = {
  bulls: { name: 'The Bulls', members: ['Ella', 'PCM', 'Taylor'] },
  bears: { name: 'The Bears', members: ['Ella', 'Lawson'] },
};

function canAccessRoom(me, roomId) {
  const room = GROUP_ROOMS[roomId];
  if (!room) return false;
  if (me.is_admin) return true;
  const label = (me.label || me.code || '').trim().toLowerCase();
  return room.members.some(m => m.trim().toLowerCase() === label);
}

function listRoomsFor(me) {
  // Rooms this caller is allowed to read. Admins get everything.
  return Object.keys(GROUP_ROOMS).filter(id => canAccessRoom(me, id));
}

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
    // Unread summary across channels. Single round-trip the client can poll
    // from anywhere (including non-chat pages) to drive the top-nav banner.
    if (url.searchParams.get('unread') === '1') {
      return handleUnreadSummary(db, me);
    }

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

    // Group: private room, gated. Room id lives in thread_for so we can route
    // multiple rooms through the same channel without a schema migration.
    if (channel === 'group') {
      const room = (url.searchParams.get('room') || '').trim();
      if (!room || !GROUP_ROOMS[room]) return json({ error: 'invalid_room' }, 400);
      if (!canAccessRoom(me, room)) return json({ error: 'forbidden' }, 403);
      const { data } = await db.select(
        'stockrocket_messages',
        `channel=eq.group&thread_for=eq.${encodeURIComponent(room)}&order=created_at.desc&limit=100`
      );
      const messages = (data || []).reverse();

      if (url.searchParams.get('with_reads') === '1') {
        const readsKey = `group:${room}`;
        const { data: readRows } = await db.select(
          'stockrocket_chat_reads',
          `channel=eq.${encodeURIComponent(readsKey)}`
        );
        const reads = {};
        for (const r of readRows || []) reads[r.user_label] = r.last_seen_at;
        return json({ ok: true, messages, reads, room });
      }
      return json({ ok: true, messages, room });
    }

    // Alerts: public feed (everyone reads)
    const { data } = await db.select(
      'stockrocket_messages',
      `channel=eq.${channel}&order=created_at.desc&limit=100`
    );
    const messages = (data || []).reverse();

    if (url.searchParams.get('with_reads') === '1') {
      const { data: readRows } = await db.select(
        'stockrocket_chat_reads',
        `channel=eq.${channel}`
      );
      const reads = {};
      for (const r of readRows || []) reads[r.user_label] = r.last_seen_at;
      return json({ ok: true, messages, reads });
    }

    return json({ ok: true, messages });
  }

  // -------- POST --------
  if (req.method === 'POST') {
    let body;
    try { body = await req.json(); } catch { return json({ error: 'invalid_json' }, 400); }

    // Read receipt: upsert last_seen_at for this user + channel.
    // Cheap, idempotent, driven by the client when the user is actively
    // viewing a channel. A single row per (user_label, channel) ever exists.
    // For group rooms the channel key is "group:<room>" so each private room
    // tracks its own read state.
    if (body.action === 'mark_seen') {
      const channel = body.channel;
      if (!['group', 'alerts', 'milburn'].includes(channel)) {
        return json({ error: 'invalid_channel' }, 400);
      }
      let channelKey = channel;
      if (channel === 'group') {
        const room = (body.room || '').toString().trim();
        if (!room || !GROUP_ROOMS[room]) return json({ error: 'invalid_room' }, 400);
        if (!canAccessRoom(me, room)) return json({ error: 'forbidden' }, 403);
        channelKey = `group:${room}`;
      }
      const label = me.label || me.code;
      const { error } = await db.upsert(
        'stockrocket_chat_reads',
        { user_label: label, channel: channelKey, last_seen_at: new Date().toISOString() },
        'user_label,channel'
      );
      if (error) return json({ error: 'mark_seen_failed', detail: error }, 500);
      return json({ ok: true, user_label: label, channel: channelKey });
    }

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
    } else if (channel === 'group') {
      // Group is now private-room-only. The client MUST send a valid room id
      // and the caller must be a member. Room id lives in thread_for so we
      // can filter by it on GETs without a schema change.
      const room = (body.room || '').toString().trim();
      if (!room || !GROUP_ROOMS[room]) return json({ error: 'invalid_room' }, 400);
      if (!canAccessRoom(me, room)) return json({ error: 'forbidden' }, 403);
      threadFor = room;
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

// Unread summary for a single user. Returns per-channel counts + the newest
// unread message's id/author/created_at so the client can render the top-nav
// banner without a follow-up fetch. Cheap: reads one row from chat_reads + up
// to 100 recent messages per channel (same limit the chat already fetches).
async function handleUnreadSummary(db, me) {
  const myLabel = me.label || me.code;
  const { data: readRows } = await db.select(
    'stockrocket_chat_reads',
    `user_label=eq.${encodeURIComponent(myLabel)}`
  );
  const seenByChannel = {};
  for (const r of readRows || []) seenByChannel[r.channel] = r.last_seen_at;

  // Trade alerts are counted per-channel so the sidebar callouts can light up,
  // but are INTENTIONALLY excluded from `total` / `latest_unread` -- the
  // persistent top-nav banner should only nag for real conversations
  // (group rooms + milburn), not the trade-alerts feed which auto-posts on
  // every execution.
  //   RSJ: "getting too loud with the trade alert -- just do the messages."
  const out = { ok: true, channels: {}, total: 0, latest_unread: null };

  // Per-room group unread: only rooms the caller is a member of.
  const myRooms = listRoomsFor(me);
  for (const roomId of myRooms) {
    const { data } = await db.select(
      'stockrocket_messages',
      `channel=eq.group&thread_for=eq.${encodeURIComponent(roomId)}&order=created_at.desc&limit=100`
    );
    const channelKey = `group:${roomId}`;
    const seenAt = seenByChannel[channelKey];
    const unread = (data || []).filter(m => {
      if (m.author_name === myLabel) return false;
      if (!seenAt) return true;
      return new Date(m.created_at) > new Date(seenAt);
    });
    out.channels[channelKey] = {
      unread_count: unread.length,
      latest: unread[0] ? {
        id: unread[0].id,
        author: unread[0].author_name,
        created_at: unread[0].created_at,
        preview: (unread[0].content || '').slice(0, 120),
        room: roomId,
      } : null,
    };
    out.total += unread.length;
    if (unread[0] && (!out.latest_unread || unread[0].created_at > out.latest_unread.created_at)) {
      out.latest_unread = { channel: 'group', room: roomId, ...out.channels[channelKey].latest };
    }
  }

  // Trade alerts: sidebar callout only, not banner.
  {
    const { data } = await db.select(
      'stockrocket_messages',
      `channel=eq.alerts&order=created_at.desc&limit=100`
    );
    const seenAt = seenByChannel.alerts;
    const unread = (data || []).filter(m => {
      if (m.author_name === myLabel) return false;
      if (!seenAt) return true;
      return new Date(m.created_at) > new Date(seenAt);
    });
    out.channels.alerts = {
      unread_count: unread.length,
      latest: unread[0] ? {
        id: unread[0].id,
        author: unread[0].author_name,
        created_at: unread[0].created_at,
        preview: (unread[0].content || '').slice(0, 120),
      } : null,
    };
  }

  // Milburn unread: user sees own-thread replies from admin; admin sees
  // any message from non-admins across all threads.
  const seenMilburn = seenByChannel.milburn;
  if (me.is_admin) {
    const { data } = await db.select(
      'stockrocket_messages',
      `channel=eq.milburn&order=created_at.desc&limit=200`
    );
    const unread = (data || []).filter(m => {
      if (m.author_name === myLabel) return false;
      if (!seenMilburn) return true;
      return new Date(m.created_at) > new Date(seenMilburn);
    });
    out.channels.milburn = {
      unread_count: unread.length,
      latest: unread[0] ? {
        id: unread[0].id,
        author: unread[0].author_name,
        created_at: unread[0].created_at,
        preview: (unread[0].content || '').slice(0, 120),
        thread_for: unread[0].thread_for || null,
      } : null,
    };
    out.total += unread.length;
    if (unread[0] && (!out.latest_unread || unread[0].created_at > out.latest_unread.created_at)) {
      out.latest_unread = { channel: 'milburn', ...out.channels.milburn.latest };
    }
  } else {
    const { data } = await db.select(
      'stockrocket_messages',
      `channel=eq.milburn&thread_for=eq.${encodeURIComponent(me.code)}&order=created_at.desc&limit=50`
    );
    const unread = (data || []).filter(m => {
      if (m.author_name === myLabel) return false;
      if (!seenMilburn) return true;
      return new Date(m.created_at) > new Date(seenMilburn);
    });
    out.channels.milburn = {
      unread_count: unread.length,
      latest: unread[0] ? {
        id: unread[0].id,
        author: unread[0].author_name,
        created_at: unread[0].created_at,
        preview: (unread[0].content || '').slice(0, 120),
        thread_for: unread[0].thread_for || me.code,
      } : null,
    };
    out.total += unread.length;
    if (unread[0] && (!out.latest_unread || unread[0].created_at > out.latest_unread.created_at)) {
      out.latest_unread = { channel: 'milburn', ...out.channels.milburn.latest };
    }
  }

  return json(out);
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
    async upsert(table, row, onConflict) {
      // PostgREST upsert: POST with Prefer: resolution=merge-duplicates + on_conflict.
      const q = onConflict ? `?on_conflict=${encodeURIComponent(onConflict)}` : '';
      const upsertHeaders = { ...headers, Prefer: 'return=representation,resolution=merge-duplicates' };
      const res = await fetch(`${base}/${table}${q}`, { method: 'POST', headers: upsertHeaders, body: JSON.stringify(row) });
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
