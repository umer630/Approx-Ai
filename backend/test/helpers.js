import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'approx-test-'));
process.env.APPROX_DATA_DIR = dir;
process.env.APPROX_ENV = 'test';
process.env.APPROX_DEV_PROVIDER = '1';
process.env.QUOTA_WINDOW_LIMIT = process.env.QUOTA_WINDOW_LIMIT || '100';

const { createServer } = await import('../src/server.js');
const db = await import('../src/db.js');

export const server = createServer();
await new Promise((r) => server.listen(0, '127.0.0.1', r));
export const BASE = `http://127.0.0.1:${server.address().port}`;
export { db };

export async function req(method, p, { body, token, cookie, csrf, headers = {}, raw } = {}) {
  const h = { ...headers };
  if (body !== undefined && !raw) h['content-type'] = 'application/json';
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
  db.run("DELETE FROM rate_buckets WHERE key LIKE 'signup:%' OR key LIKE 'login-ip:%'");
  const email = `user${++n}_${Date.now()}@example.com`;
  const s = await req('POST', '/api/auth/signup', { body: { email, password } });
  if (s.status !== 202) throw new Error('signup failed ' + JSON.stringify(s.data));
  const user = db.one('SELECT * FROM users WHERE email = ?', email);
  if (verify) db.run('UPDATE users SET email_verified = 1 WHERE id = ?', user.id);
  const l = await req('POST', '/api/auth/login', { body: { email, password, client: 'mobile' } });
  return { email, password, id: user.id, token: l.data.token };
}

export function parseSse(text) {
  return text.split('\n\n').filter(Boolean).map((b) => {
    const ev = /event: (.*)/.exec(b)?.[1];
    const d = /data: (.*)/.exec(b)?.[1];
    return { event: ev, data: d ? JSON.parse(d) : null };
  });
}

export function close() { server.close(); server.closeAllConnections?.(); }
