// Secure admin panel: separate admin sign-in, server-side authorization, approval workflow, model access, quotas,
// audit log, session expiry. Every assertion talks to the real HTTP server (fake Supabase for passwords).
import test from 'node:test';
import assert from 'node:assert/strict';
import { req, makeUser, db, close, asAdmin, BASE } from './helpers.js';

let admin, sa, client;
const A = (who) => ({ headers: { cookie: who.admin.cookie, 'x-admin-csrf': who.admin.csrf } });
const aget = (who, p) => req('GET', p, A(who));
const asend = (who, m, p, body) => req(m, p, { ...A(who), body });
const resetLimits = () => db.run("DELETE FROM rate_buckets WHERE key LIKE 'admin-login%'");

test.after(close);

test('setup: an allowlisted admin, a superadmin and a normal client', async () => {
  admin = await asAdmin(await makeUser(), 'admin');
  sa = await asAdmin(await makeUser(), 'superadmin');
  client = await makeUser();
  assert.ok(admin.admin.cookie.startsWith('approx_admin='));
});

test('1/2/14: a normal client cannot open or call the admin API — no role field, header or URL trick helps', async () => {
  for (const p of ['/api/admin/overview', '/api/admin/clients', `/api/admin/clients/${admin.id}`, '/api/admin/activity', '/api/admin/audit-log', '/api/admin/auth/me'])
    assert.equal((await req('GET', p, { token: client.token })).status, 401, p);
  // Client session cookie, forged headers / query parameters / body fields are all ignored.
  const forged = await req('GET', '/api/admin/clients?isAdmin=true&role=admin', { token: client.token, headers: { 'x-role': 'admin', 'x-is-admin': 'true', cookie: 'approx_admin=forged; isAdmin=true' } });
  assert.equal(forged.status, 401);
  assert.equal((await req('POST', `/api/admin/clients/${client.id}/status`, { token: client.token, body: { status: 'approved' } })).status, 401);
  // Even a database role of "admin" is not enough without being on the server allowlist + an admin session.
  await db.run("UPDATE users SET role = 'admin' WHERE id = ?", client.id);
  assert.equal((await req('GET', '/api/admin/overview', { token: client.token })).status, 401);
  await resetLimits();
  assert.equal((await req('POST', '/api/admin/auth/login', { body: { email: client.email, password: client.password } })).data.error.code, 'invalid_admin_credentials');
  await db.run("UPDATE users SET role = 'user' WHERE id = ?", client.id);
  // The admin page itself is just a sign-in screen; it ships no credentials.
  const page = await fetch(BASE + '/admin/clients');
  if (page.status === 200) assert.doesNotMatch(await page.text(), /APPROX_ADMIN_EMAILS|password\s*[:=]\s*['"][^'"]+/i);
});

test('3/4: valid admin login succeeds; every failure is the same generic message', async () => {
  await resetLimits();
  const ok = await req('POST', '/api/admin/auth/login', { body: { email: admin.email, password: admin.password } });
  assert.equal(ok.status, 200);
  const cookie = ok.headers.get('set-cookie');
  assert.match(cookie, /approx_admin=.+; Path=\/api\/admin; HttpOnly; SameSite=Strict/);
  assert.equal(ok.data.admin.email, admin.email);
  assert.ok(ok.data.csrf_token);
  assert.doesNotMatch(JSON.stringify(ok.data), /password|token_hash|supabase|access_token|refresh/i);
  const wrong = [
    { email: admin.email, password: 'wrong-Passw0rd!' },          // wrong password
    { email: 'nobody@example.com', password: admin.password },   // unknown email
    { email: client.email, password: client.password },          // real client, not allowlisted
    { email: admin.email, password: '' },
  ];
  for (const b of wrong) {
    await resetLimits();
    const r = await req('POST', '/api/admin/auth/login', { body: b });
    assert.equal(r.status, 401);
    assert.deepEqual([r.data.error.code, r.data.error.message], ['invalid_admin_credentials', 'Invalid administrator credentials']);
    assert.equal(r.headers.get('set-cookie'), null);
  }
  assert.ok((await db.one("SELECT COUNT(*) c FROM security_events WHERE kind = 'admin_login_failed'")).c >= 4);
});

test('admin login is rate limited', async () => {
  await resetLimits();
  let last;
  for (let i = 0; i < 7; i++) last = await req('POST', '/api/admin/auth/login', { body: { email: admin.email, password: 'nope-Passw0rd!' } });
  assert.equal(last.status, 429);
  await resetLimits();
});

test('admin CSRF: writes without the admin CSRF header are refused', async () => {
  const r = await req('POST', `/api/admin/clients/${client.id}/status`, { headers: { cookie: admin.admin.cookie }, body: { status: 'approved' } });
  assert.equal(r.status, 403);
  assert.equal(r.data.error.code, 'csrf_failed');
});

test('5: the dashboard reports real counts from the database', async () => {
  const o = await aget(admin, '/api/admin/overview');
  assert.equal(o.status, 200);
  const real = await db.one("SELECT COUNT(*) total, SUM(email_verified = 1) verified FROM users WHERE status != 'deleted'");
  assert.equal(o.data.clients.total, real.total);
  assert.equal(o.data.clients.verified, real.verified);
  assert.equal(o.data.requests.total, (await db.one('SELECT COUNT(*) c FROM usage_events')).c);
  assert.equal(o.data.daily.length, 30);
  const sum = o.data.countries.reduce((s, c) => s + c.users, 0);
  assert.equal(sum, real.total);
  assert.ok(o.data.countries.some((c) => c.country === 'Unknown'), 'no country data → "Unknown", never guessed');
});

test('clients: search, filters, sort and the detail page', async () => {
  const s = await aget(admin, `/api/admin/clients?q=${encodeURIComponent(client.email)}`);
  assert.equal(s.data.total, 1);
  const row = s.data.clients[0];
  assert.equal(row.id, client.id);
  for (const k of ['id', 'name', 'email', 'account_status', 'approval_status', 'email_verified', 'created_at', 'last_login_at', 'country', 'plan', 'requests'])
    assert.ok(k in row, k);
  assert.doesNotMatch(JSON.stringify(s.data), /password_hash|supabase_uid|token/);
  assert.equal((await aget(admin, `/api/admin/clients?q=${client.id}`)).data.total, 1, 'search by ID');
  assert.ok((await aget(admin, '/api/admin/clients?verified=yes&status=approved&sort=oldest')).data.clients.every((c) => c.email_verified && c.approval_status === 'approved'));
  assert.equal((await aget(admin, '/api/admin/clients?status=nonsense')).status, 400);
  const d = await aget(admin, `/api/admin/clients/${client.id}`);
  assert.equal(d.status, 200);
  assert.ok(d.data.usage.quota && d.data.access.models.length);
  assert.equal((await aget(admin, '/api/admin/clients/does-not-exist')).status, 404);
});

test('6/7/8: approve, suspend and reactivate take effect on the very next client request', async () => {
  // Approval workflow on: new sign-ups are pending and cannot chat.
  assert.equal((await asend(admin, 'PUT', '/api/admin/platform-settings', { require_approval: true })).status, 403, 'superadmin only');
  assert.equal((await asend(sa, 'PUT', '/api/admin/platform-settings', { require_approval: true })).status, 200);
  const newbie = await makeUser();
  assert.equal((await db.one('SELECT approval_status FROM users WHERE id = ?', newbie.id)).approval_status, 'pending');
  const me = await req('GET', '/api/auth/me', { token: newbie.token });
  assert.equal(me.data.user.approval_status, 'pending');
  const blocked = await req('POST', '/api/chats', { token: newbie.token, body: { model: 'nick-4.8' } });
  assert.equal(blocked.status, 403);
  assert.equal(blocked.data.error.code, 'account_pending');
  assert.equal((await aget(admin, '/api/admin/overview')).data.clients.pending >= 1, true);
  // approve
  assert.equal((await asend(admin, 'POST', `/api/admin/clients/${newbie.id}/status`, { status: 'approved' })).status, 200);
  assert.equal((await req('POST', '/api/chats', { token: newbie.token, body: { model: 'nick-4.8' } })).status, 201);
  // suspend → existing session revoked, new sign-in refused
  assert.equal((await asend(admin, 'POST', `/api/admin/clients/${newbie.id}/status`, { status: 'suspended', reason: 'abuse report' })).status, 200);
  assert.equal((await req('GET', '/api/chats', { token: newbie.token })).status, 401);
  await db.run("DELETE FROM rate_buckets WHERE key LIKE 'login%'");
  const relog = await req('POST', '/api/auth/login', { body: { email: newbie.email, password: newbie.password, client: 'mobile' } });
  assert.equal(relog.status, 403);
  assert.equal(relog.data.error.code, 'account_suspended');
  // reactivate
  assert.equal((await asend(admin, 'POST', `/api/admin/clients/${newbie.id}/status`, { status: 'approved' })).status, 200);
  const back = await req('POST', '/api/auth/login', { body: { email: newbie.email, password: newbie.password, client: 'mobile' } });
  assert.equal(back.status, 200);
  assert.equal((await req('GET', '/api/chats', { token: back.data.token })).status, 200);
  // reject / disable also block
  for (const st of ['rejected', 'disabled']) {
    await asend(admin, 'POST', `/api/admin/clients/${newbie.id}/status`, { status: st });
    await db.run("DELETE FROM rate_buckets WHERE key LIKE 'login%'");
    assert.equal((await req('POST', '/api/auth/login', { body: { email: newbie.email, password: newbie.password, client: 'mobile' } })).data.error.code, `account_${st}`);
  }
  await asend(admin, 'POST', `/api/admin/clients/${newbie.id}/status`, { status: 'approved' });
  await asend(sa, 'PUT', '/api/admin/platform-settings', { require_approval: false });
  // admins cannot act on themselves or (unless superadmin) on other admins
  assert.equal((await asend(admin, 'POST', `/api/admin/clients/${admin.id}/status`, { status: 'suspended' })).status, 403);
  assert.equal((await asend(admin, 'POST', `/api/admin/clients/${sa.id}/status`, { status: 'suspended' })).status, 403);
});

test('9: model access — restricted beats the plan, enabled grants, FAB needs a superadmin', async () => {
  await db.run("UPDATE users SET plan = 'pro' WHERE id = ?", client.id);
  const can = async (m) => (await req('POST', '/api/chats', { token: client.token, body: { model: m } })).status;
  assert.equal(await can('nick-4.8'), 201);
  assert.equal((await asend(admin, 'PUT', `/api/admin/clients/${client.id}/models/nick-4.8`, { access: 'restricted' })).data.available, false);
  assert.equal(await can('nick-4.8'), 403, 'the router enforces the restriction');
  await asend(admin, 'PUT', `/api/admin/clients/${client.id}/models/nick-4.8`, { access: 'default' });
  assert.equal(await can('nick-4.8'), 201);
  assert.equal((await asend(admin, 'PUT', `/api/admin/clients/${client.id}/models/fab-100x`, { access: 'enabled' })).status, 403);
  assert.equal((await asend(sa, 'PUT', `/api/admin/clients/${client.id}/models/fab-100x`, { access: 'enabled' })).status, 200);
  await asend(sa, 'PUT', `/api/admin/clients/${client.id}/models/fab-100x`, { access: 'default' });
  assert.equal((await asend(admin, 'PUT', `/api/admin/clients/${client.id}/models/not-a-model`, { access: 'enabled' })).status, 404);
});

test('10: quota changes are enforced server-side', async () => {
  const chat = (await req('POST', '/api/chats', { token: client.token, body: { model: 'nick-4.8' } })).data.chat;
  const send = () => req('POST', `/api/chats/${chat.id}/messages`, { token: client.token, body: { content: 'hello' } });
  const used = (await db.one('SELECT COUNT(*) c FROM usage_events WHERE user_id = ?', client.id)).c;
  const r = await asend(admin, 'PUT', `/api/admin/clients/${client.id}/limits`, { window_limit: used + 1, model_limits: { 'nick-4.8': 1000 } });
  assert.equal(r.status, 200);
  assert.equal(r.data.quota.custom_limits, true);
  assert.equal((await send()).status, 200);
  const over = await send();
  assert.equal(over.status, 429);
  // per-model limit
  await asend(admin, 'PUT', `/api/admin/clients/${client.id}/limits`, { model_limits: { 'nick-4.8': 0 } });
  assert.equal((await send()).data.error.code, 'model_quota_exceeded');
  assert.equal((await asend(admin, 'PUT', `/api/admin/clients/${client.id}/limits`, { window_limit: -5 })).status, 400);
  await asend(admin, 'PUT', `/api/admin/clients/${client.id}/limits`, {});   // clear overrides
  assert.equal((await send()).status, 200);
});

test('11: the audit log records admin actions and cannot be changed', async () => {
  const log = await aget(admin, '/api/admin/audit-log');
  const actions = log.data.entries.map((e) => e.action);
  for (const a of ['admin.login', 'admin.client_approved', 'admin.client_suspended', 'admin.model_restricted', 'admin.quota_changed', 'admin.setting_changed', 'admin.login_failed'])
    assert.ok(actions.includes(a), a);
  const e = log.data.entries.find((x) => x.action === 'admin.client_suspended');
  assert.ok(e.admin && e.at && e.target_user);
  assert.doesNotMatch(JSON.stringify(log.data), /password|token_hash|csrf/i);
  await assert.rejects(db.run("UPDATE audit_logs SET action = 'x'"), /append-only/);
  await assert.rejects(db.run('DELETE FROM audit_logs'), /append-only/);
  const act = await aget(admin, '/api/admin/activity');
  assert.ok(act.data.events.some((x) => x.event === 'model.request'));
  assert.ok(act.data.events.some((x) => x.event === 'auth.login'));
  for (const p of ['/api/admin/usage', '/api/admin/models-overview']) assert.equal((await aget(admin, p)).status, 200, p);
});

test('12: admin sessions expire (idle and absolute) and are revoked when the admin is removed', async () => {
  const s = await asAdmin(await makeUser(), 'admin');
  assert.equal((await aget(s, '/api/admin/auth/me')).status, 200);
  await db.run('UPDATE admin_sessions SET last_seen_at = last_seen_at - 31 * 60000 WHERE user_id = ?', s.id);
  assert.equal((await aget(s, '/api/admin/auth/me')).status, 401, 'idle timeout');
  await asAdmin(s, 'admin');
  await db.run('UPDATE admin_sessions SET expires_at = ? WHERE user_id = ? AND revoked_at IS NULL', Date.now() - 1, s.id);
  assert.equal((await aget(s, '/api/admin/auth/me')).status, 401, 'absolute lifetime');
  await asAdmin(s, 'admin');
  process.env.APPROX_ADMIN_EMAILS = process.env.APPROX_ADMIN_EMAILS.split(',').filter((e) => e !== s.email).join(',');
  assert.equal((await aget(s, '/api/admin/auth/me')).status, 401, 'removed from the server allowlist');
});

test('13: logout ends the admin session', async () => {
  const s = await asAdmin(await makeUser(), 'admin');
  const out = await asend(s, 'POST', '/api/admin/auth/logout', {});
  assert.equal(out.status, 200);
  assert.match(out.headers.get('set-cookie'), /approx_admin=; .*Max-Age=0/);
  assert.equal((await aget(s, '/api/admin/overview')).status, 401);
});

test('client sign-up never creates an admin — even for an allowlisted / bootstrap address; elevation only via /admin/login', async () => {
  await db.run("DELETE FROM rate_buckets WHERE key LIKE 'signup%' OR key LIKE 'login%' OR key LIKE 'admin-login%'");
  const c = await makeUser();   // signs up + verifies + client login through the normal Supabase flow
  process.env.APPROX_ADMIN_EMAILS = `${process.env.APPROX_ADMIN_EMAILS},${c.email}`;
  process.env.APPROX_BOOTSTRAP_SUPERADMIN_EMAIL = c.email;
  try {
    const relog = await req('POST', '/api/auth/login', { body: { email: c.email, password: c.password, client: 'mobile' } });
    assert.equal(relog.data.user.role, 'user', 'client login does not elevate');
    assert.equal((await db.one('SELECT role FROM users WHERE id = ?', c.id)).role, 'user');
    assert.equal((await req('GET', '/api/admin/overview', { token: relog.data.token })).status, 401, 'client token is not an admin session');
    const k = await req('POST', '/api/developer/keys', { token: relog.data.token, body: { name: 'w', scopes: ['training:worker'] } });
    assert.notEqual(k.status, 201, 'no privileged worker keys for a client');
    // Only the separate administrator sign-in elevates (allowlist + Supabase password + verified email). A superadmin
    // already exists in this test database, so the allowlisted account becomes admin (not a second superadmin).
    const al = await req('POST', '/api/admin/auth/login', { body: { email: c.email, password: c.password } });
    assert.equal(al.status, 200);
    assert.equal(al.data.admin.role, 'admin');
    assert.ok(await db.one("SELECT 1 FROM audit_logs WHERE action = 'admin.role_granted_by_allowlist' AND user_id = ?", c.id));
  } finally { delete process.env.APPROX_BOOTSTRAP_SUPERADMIN_EMAIL; }
});
