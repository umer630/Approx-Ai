import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'approx-test-'));
process.env.APPROX_DATA_DIR = dir;
process.env.APPROX_ENV = 'test';
process.env.APPROX_DEV_PROVIDER = '1';
process.env.QUOTA_WINDOW_LIMIT = process.env.QUOTA_WINDOW_LIMIT || '100';

// Supabase Auth test double (configuration is read once, at import time, so it must exist before the server loads).
const { startFakeSupabase } = await import('./fake-supabase.js');
export const supabase = await startFakeSupabase();
process.env.SUPABASE_URL = supabase.url;
process.env.SUPABASE_PUBLISHABLE_KEY = supabase.publishableKey;
process.env.SUPABASE_SECRET_KEY = supabase.secretKey;

const { createServer } = await import('../src/server.js');
const db = await import('../src/db.js');

export const server = createServer();
await new Promise((r) => server.listen(0, '127.0.0.1', r));
export const BASE = `http://127.0.0.1:${server.address().port}`;
export { db };

// Admin sessions created by asAdmin(), keyed by the user's client token. /api/admin/* never accepts client tokens, so
// req() swaps a registered token for that user's admin-session cookie + admin CSRF header on admin paths.
const adminSessions = new Map();
export async function req(method, p, { body, token, cookie, csrf, headers = {}, raw } = {}) {
  const h = { ...headers };
  if (body !== undefined && !raw) h['content-type'] = 'application/json';
  if (token && p.startsWith('/api/admin/') && adminSessions.has(token)) {
    const a = adminSessions.get(token); h.cookie = a.cookie; h['x-admin-csrf'] = a.csrf; token = undefined;
  }
  if (token) h.authorization = `Bearer ${token}`;
  if (cookie) h.cookie = cookie;
  if (csrf) h['x-csrf-token'] = csrf;
  const res = await fetch(BASE + p, { method, headers: h, body: raw ? body : body !== undefined ? JSON.stringify(body) : undefined });
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('json') ? await res.json() : await res.text();
  return { status: res.status, data, headers: res.headers };
}

let n = 0;
export async function makeUser({ verify = true, password = 'GoodPassw0rd!' } = {}) {
  await db.run("DELETE FROM rate_buckets WHERE key LIKE 'signup:%' OR key LIKE 'login-ip:%'");
  const email = `user${++n}_${Date.now()}@example.com`;
  const s = await req('POST', '/api/auth/signup', { body: { email, password } });
  if (s.status !== 202) throw new Error('signup failed ' + JSON.stringify(s.data));
  const user = await db.one('SELECT * FROM users WHERE email = ?', email);
  if (verify) supabase.confirm(email); // the person clicked the Supabase confirmation link
  const l = await req('POST', '/api/auth/login', { body: { email, password, client: 'mobile' } });
  return { email, password, id: user.id, token: l.data.token };
}

/** Put the user on the server-side admin allowlist, give them `role`, and sign in through /api/admin/auth/login. */
export async function asAdmin(u, role = 'admin') {
  const list = new Set(String(process.env.APPROX_ADMIN_EMAILS || '').split(',').filter(Boolean)); list.add(u.email);
  process.env.APPROX_ADMIN_EMAILS = [...list].join(',');
  await db.run('UPDATE users SET role = ? WHERE id = ?', role, u.id);
  await db.run("DELETE FROM rate_buckets WHERE key LIKE 'admin-login%'");
  const r = await req('POST', '/api/admin/auth/login', { body: { email: u.email, password: u.password } });
  if (r.status !== 200) throw new Error('admin login failed ' + JSON.stringify(r.data));
  const cookie = r.headers.get('set-cookie').split(';')[0];
  u.admin = { cookie, csrf: r.data.csrf_token };
  if (u.token) adminSessions.set(u.token, u.admin);
  return u;
}

/** Auth headers for a raw fetch to /api/admin/*: the admin session for a token registered by asAdmin(), else the bearer. */
export function adminAuthHeaders(token) {
  const a = adminSessions.get(token);
  return a ? { cookie: a.cookie, 'x-admin-csrf': a.csrf } : { authorization: `Bearer ${token}` };
}

export function parseSse(text) {
  return text.split('\n\n').filter(Boolean).map((b) => {
    const ev = /event: (.*)/.exec(b)?.[1];
    const d = /data: (.*)/.exec(b)?.[1];
    return { event: ev, data: d ? JSON.parse(d) : null };
  });
}

export function close() { server.close(); server.closeAllConnections?.(); supabase.close(); }
