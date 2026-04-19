// StockRocket -- Access Codes API (Vercel Edge Function)
// --------------------------------------------------------
// Single endpoint that handles:
//   GET  /api/codes?code=XYZ           -> public code validation (+ increments use count)
//   GET  /api/codes                    -> admin: list all codes (requires admin header)
//   POST /api/codes                    -> admin: create code
//   PATCH /api/codes                   -> admin: update (activate/deactivate, edit fields)
//   DELETE /api/codes?code=XYZ         -> admin: hard delete
//   GET  /api/codes?log=1              -> admin: recent audit log entries
//
// Admin auth: client sends `X-Admin-Code` header with their RSJ-ADMIN code.
// The edge function validates it matches the DB (must be active + is_admin=true).
//
// Env vars required (set in Vercel project settings):
//   SUPABASE_URL
//   SUPABASE_SERVICE_KEY   -- service role key (bypasses RLS). Never ship to client.

export const config = { runtime: 'edge' };

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Code',
};

export default async function handler(req) {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    return json({ error: 'supabase_not_configured', detail: 'Set SUPABASE_URL and SUPABASE_SERVICE_KEY in Vercel env vars.' }, 500);
  }

  const url = new URL(req.url);
  const db = supabase(SUPABASE_URL, SUPABASE_SERVICE_KEY);

  // -------- PUBLIC: validate code (password) --------
  // Passwords are case-sensitive. Existing admin code "RSJ-ADMIN" is uppercase.
  if (req.method === 'GET' && url.searchParams.has('code') && !url.searchParams.has('admin')) {
    const code = (url.searchParams.get('code') || '').trim();
    const displayName = (url.searchParams.get('name') || '').slice(0, 60);
    if (!code) return json({ ok: false, error: 'Enter your password' }, 200);

    const { data: rows, error } = await db.select('stockrocket_access_codes', `code=eq.${code}&limit=1`);
    if (error) return json({ ok: false, error: 'Lookup failed' }, 200);
    const row = rows?.[0];
    if (!row) {
      await db.insert('stockrocket_access_log', { code: null, action: 'reject', display_name: displayName, detail: { attempted: code, reason: 'not_found' } }).catch(() => {});
      return json({ ok: false, error: 'That password is not valid' }, 200);
    }
    if (!row.active) return json({ ok: false, error: 'That account has been deactivated' }, 200);
    if (row.expires_at && new Date(row.expires_at) < new Date()) return json({ ok: false, error: 'That account has expired' }, 200);
    if (row.uses_max && row.uses_current >= row.uses_max) return json({ ok: false, error: 'That account has reached its use limit' }, 200);

    // Increment use count + log. Fire and forget -- don't block response on log writes.
    db.update('stockrocket_access_codes', `code=eq.${code}`, { uses_current: row.uses_current + 1, last_used_at: new Date().toISOString() }).catch(() => {});
    db.insert('stockrocket_access_log', { code, action: 'redeem', display_name: displayName, detail: null }).catch(() => {});

    return json({
      ok: true,
      code: row.code,
      tier: row.tier,
      admin: row.is_admin,
      label: row.label,
      email: row.email,
      expires: row.expires_at,
      usesRemaining: row.uses_max - row.uses_current - 1,
    });
  }

  // -------- PUBLIC: list active chat members (label + admin flag only) --------
  // Used by the group chat avatar strip so anyone who logs in sees everyone who
  // has an active account. Never exposes the raw `code` (password), email, note,
  // tier, or use counts -- only the fields needed to render a name + badge.
  if (req.method === 'GET' && url.searchParams.get('public') === '1') {
    const { data, error } = await db.select(
      'stockrocket_access_codes',
      'select=label,code,is_admin,avatar_url&active=eq.true&order=is_admin.desc'
    );
    if (error) return json({ ok: false, error: 'list_failed' }, 200);
    // Dedupe stable public id from code hash so client can key without ever seeing the raw code
    const members = (data || []).map(u => ({
      label: u.label || 'Unnamed',
      is_admin: !!u.is_admin,
      avatar_url: u.avatar_url || null,
      // Short stable id from the code -- lets the client dedupe + key React lists
      // without exposing the code itself. Any 8-char slice of a hash is fine.
      id: hashId(u.code || ''),
    })).sort((a, b) => {
      if (a.is_admin !== b.is_admin) return a.is_admin ? -1 : 1;
      return a.label.localeCompare(b.label);
    });
    return json({ ok: true, members });
  }

  // -------- ADMIN routes: require valid admin code --------
  const adminCode = (req.headers.get('x-admin-code') || '').trim().toUpperCase();
  if (!adminCode) return json({ error: 'admin_code_required' }, 401);
  const { data: adminRows } = await db.select('stockrocket_access_codes', `code=eq.${adminCode}&is_admin=eq.true&active=eq.true&limit=1`);
  if (!adminRows?.length) return json({ error: 'admin_denied' }, 403);

  // GET /api/codes -> list, or ?log=1 for audit entries
  if (req.method === 'GET') {
    if (url.searchParams.get('log') === '1') {
      const { data } = await db.select('stockrocket_access_log', 'order=created_at.desc&limit=100');
      return json({ ok: true, log: data || [] });
    }
    const { data } = await db.select('stockrocket_access_codes', 'order=created_at.desc');
    return json({ ok: true, codes: data || [] });
  }

  // POST /api/codes -> create user
  if (req.method === 'POST') {
    let body;
    try { body = await req.json(); } catch { return json({ error: 'invalid_json' }, 400); }
    const code = String(body.code || '').trim();
    // Passwords: 4-64 chars, printable non-whitespace. Case preserved.
    if (!/^[\x21-\x7e]{4,64}$/.test(code)) {
      return json({ error: 'invalid_password_format', detail: 'Password must be 4-64 characters, no spaces.' }, 400);
    }
    const email = (body.email || '').trim().slice(0, 120) || null;
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return json({ error: 'invalid_email_format', detail: 'Enter a valid email or leave blank.' }, 400);
    }
    // Avatar: accept base64 data URL, capped at ~200KB to keep row size sane.
    // Client should resize to 200x200 JPEG @ 0.8 quality before sending (~5-15KB typical).
    let avatarUrl = null;
    if (typeof body.avatar_url === 'string' && body.avatar_url.trim()) {
      const a = body.avatar_url.trim();
      if (!/^data:image\/(jpeg|png|webp);base64,/.test(a)) {
        return json({ error: 'invalid_avatar_format', detail: 'Avatar must be a data:image/(jpeg|png|webp);base64,... URL.' }, 400);
      }
      if (a.length > 300000) {
        return json({ error: 'avatar_too_large', detail: 'Avatar must be under ~200KB. Try a smaller image.' }, 400);
      }
      avatarUrl = a;
    }
    const payload = {
      code,
      tier: ['free', 'family', 'pro'].includes(body.tier) ? body.tier : 'family',
      is_admin: !!body.is_admin,
      label: (body.label || '').slice(0, 80) || null,
      email,
      note: (body.note || '').slice(0, 500) || null,
      expires_at: body.expires_at || null,
      uses_max: Math.max(1, Math.min(10000, parseInt(body.uses_max, 10) || 999)),
      uses_current: 0,
      active: true,
      created_by: adminCode,
      avatar_url: avatarUrl,
    };
    const { data, error } = await db.insert('stockrocket_access_codes', payload);
    if (error) return json({ error: 'create_failed', detail: error }, 400);
    db.insert('stockrocket_access_log', { code, action: 'create', display_name: adminCode, detail: { ...payload, code: '***' } }).catch(() => {});
    return json({ ok: true, code: data?.[0] || payload });
  }

  // PATCH /api/codes -> update existing user
  if (req.method === 'PATCH') {
    let body;
    try { body = await req.json(); } catch { return json({ error: 'invalid_json' }, 400); }
    const code = String(body.code || '').trim();
    if (!code) return json({ error: 'code_required' }, 400);
    const patch = {};
    if (body.active !== undefined) patch.active = !!body.active;
    if (body.label !== undefined) patch.label = (body.label || '').slice(0, 80) || null;
    if (body.email !== undefined) {
      const email = (body.email || '').trim().slice(0, 120) || null;
      if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return json({ error: 'invalid_email_format' }, 400);
      }
      patch.email = email;
    }
    if (body.note !== undefined) patch.note = (body.note || '').slice(0, 500) || null;
    if (body.tier !== undefined && ['free', 'family', 'pro'].includes(body.tier)) patch.tier = body.tier;
    if (body.expires_at !== undefined) patch.expires_at = body.expires_at || null;
    if (body.uses_max !== undefined) patch.uses_max = Math.max(1, Math.min(10000, parseInt(body.uses_max, 10) || 999));
    if (body.reset_uses === true) patch.uses_current = 0;
    // Avatar: null clears it, data URL sets it. Same size + mime validation as POST.
    if (body.avatar_url !== undefined) {
      if (body.avatar_url === null || body.avatar_url === '') {
        patch.avatar_url = null;
      } else if (typeof body.avatar_url === 'string') {
        const a = body.avatar_url.trim();
        if (!/^data:image\/(jpeg|png|webp);base64,/.test(a)) {
          return json({ error: 'invalid_avatar_format', detail: 'Avatar must be a data:image/(jpeg|png|webp);base64,... URL.' }, 400);
        }
        if (a.length > 300000) {
          return json({ error: 'avatar_too_large', detail: 'Avatar must be under ~200KB.' }, 400);
        }
        patch.avatar_url = a;
      }
    }
    // Change password: body.new_code rotates the code column
    if (body.new_code !== undefined) {
      const newCode = String(body.new_code || '').trim();
      if (!/^[\x21-\x7e]{4,64}$/.test(newCode)) {
        return json({ error: 'invalid_password_format', detail: 'Password must be 4-64 characters, no spaces.' }, 400);
      }
      patch.code = newCode;
    }
    const { data, error } = await db.update('stockrocket_access_codes', `code=eq.${code}`, patch);
    if (error) return json({ error: 'update_failed', detail: error }, 400);
    const logDetail = { ...patch };
    if (logDetail.code) logDetail.code = '***';
    db.insert('stockrocket_access_log', { code: patch.code ? '***' : code, action: 'update', display_name: adminCode, detail: logDetail }).catch(() => {});
    return json({ ok: true, code: data?.[0] || null });
  }

  // DELETE /api/codes?code=XYZ -> hard delete
  if (req.method === 'DELETE') {
    const code = (url.searchParams.get('code') || '').trim();
    if (!code) return json({ error: 'code_required' }, 400);
    // Never let admin delete the sole remaining admin code
    if (code === adminCode) return json({ error: 'cannot_delete_self' }, 400);
    const { error } = await db.delete('stockrocket_access_codes', `code=eq.${code}`);
    if (error) return json({ error: 'delete_failed', detail: error }, 400);
    db.insert('stockrocket_access_log', { code: null, action: 'delete', display_name: adminCode, detail: { deleted: code } }).catch(() => {});
    return json({ ok: true });
  }

  return json({ error: 'method_not_allowed' }, 405);
}

// -------- Minimal Supabase REST client (no dependencies) --------
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
    async delete(table, query) {
      const res = await fetch(`${base}/${table}?${query}`, { method: 'DELETE', headers });
      if (!res.ok) return { data: null, error: await res.text() };
      return { data: null, error: null };
    },
  };
}

// Tiny deterministic 8-char hex id from a string. Used to give each member
// a stable React key without exposing their raw access code.
function hashId(str) {
  let h1 = 0xdeadbeef ^ 0;
  let h2 = 0x41c6ce57 ^ 0;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const hex = ((h2 >>> 0) * 4294967296 + (h1 >>> 0)).toString(16).padStart(16, '0');
  return hex.slice(0, 8);
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...CORS },
  });
}
