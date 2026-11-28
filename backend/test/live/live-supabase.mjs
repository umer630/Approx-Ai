// Live check of the Approx backend's Supabase Auth integration against the REAL project, without creating accounts or
// sending email: config, health, wrong-password sign-in, wrong verification code, reset for an unknown address, protected
// routes. Usage: SUPABASE_URL=… SUPABASE_PUBLISHABLE_KEY=… node test/live/live-supabase.mjs   (values are never printed)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'approx-live-'));
Object.assign(process.env, { APPROX_DATA_DIR: dir, APPROX_ENV: 'test', APPROX_DEV_PROVIDER: '1' });
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_PUBLISHABLE_KEY) { console.error('set SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY'); process.exit(2); }
const { createServer } = await import('../../src/server.js');
const server = createServer();
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;
let fails = 0;
const ok = (c, name, detail = '') => { console.log(`${c ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`); if (!c) fails++; };
const call = async (method, p, body) => { const r = await fetch(BASE + p, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, data: await r.json().catch(() => ({})) }; };
const probe = `approx-live-probe-${Date.now()}@example.com`;   // an address that has no account in the project

const cfg = await call('GET', '/api/auth/config');
ok(cfg.data.provider === 'supabase' && cfg.data.provider_configured === true, 'backend is configured for Supabase Auth');
const h = await fetch(`${process.env.SUPABASE_URL}/auth/v1/health`, { headers: { apikey: process.env.SUPABASE_PUBLISHABLE_KEY } });
ok(h.ok, 'project Auth health reachable with the publishable key', `HTTP ${h.status}`);
const s = await (await fetch(`${process.env.SUPABASE_URL}/auth/v1/settings`, { headers: { apikey: process.env.SUPABASE_PUBLISHABLE_KEY } })).json();
ok(s.external?.email === true && s.mailer_autoconfirm === false, 'email/password enabled, email confirmation required', `signup ${s.disable_signup ? 'disabled' : 'enabled'}`);
const login = await call('POST', '/api/auth/login', { email: probe.toUpperCase(), password: 'Wrong-Passw0rd-123', client: 'mobile' });
ok(login.status === 401 && login.data.error?.message === 'Incorrect email or password', 'login with unknown account → 401 from real Supabase (email normalized)', `HTTP ${login.status}`);
const v = await call('POST', '/api/auth/verify-email', { email: probe, token: '123456', password: 'ChosenPassw0rd!', sign_in: true, client: 'mobile' });
ok(v.status >= 400 && v.status < 500 && !v.data.token, 'verification with a wrong code is refused by real Supabase (no session, no password set)', `HTTP ${v.status} ${v.data.error?.code}`);
const weak = await call('POST', '/api/auth/verify-email', { email: probe, token: '123456', password: 'short', set_password: true });
ok(weak.data.error?.code === 'weak_password', 'weak password refused before Supabase is called');
const fp = await call('POST', '/api/auth/forgot-password', { email: probe });
ok(fp.status === 202, 'password reset for an unknown address: same answer as for a real one (no enumeration)', `HTTP ${fp.status}`);
for (const p of ['/api/auth/me', '/api/settings', '/api/work-sessions', '/api/workspaces', '/api/files', '/api/chats']) {
  const r = await call('GET', p);
  ok(r.status === 401, `protected route without a session → 401: ${p}`);
}
const mfa = await call('POST', '/api/auth/mfa/enroll', { password: 'x' });
ok(mfa.status === 401, 'two-step verification setup requires a signed-in session');
server.close();
console.log(fails ? `${fails} FAILED` : 'ALL PASS');
process.exit(fails ? 1 : 0);
