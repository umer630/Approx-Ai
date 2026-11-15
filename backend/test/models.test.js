// Model registry policy: roles/capabilities, private FAB 500X (admin-granted, enforced server-side), model status,
// admin availability controls, failure log, per-model upstream selection and role-based routing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { req, makeUser, db, close, asAdmin, parseSse } from './helpers.js';

test.after(close);
let sa, admin, user, pro;
const A = (who) => ({ headers: { cookie: who.admin.cookie, 'x-admin-csrf': who.admin.csrf } });
const send = async (u, model, content = 'hello') => {
  const c = await req('POST', '/api/chats', { token: u.token, body: {} });
  return req('POST', `/api/chats/${c.data.chat.id}/messages`, { token: u.token, body: { content, model } });
};

test('setup', async () => {
  sa = await asAdmin(await makeUser(), 'superadmin');
  admin = await asAdmin(await makeUser(), 'admin');
  user = await makeUser();
  pro = await makeUser(); await db.run("UPDATE users SET plan = 'pro' WHERE id = ?", pro.id);
});

test('catalog roles and capabilities are served by the backend registry', async () => {
  const ms = (await req('GET', '/api/models', { token: pro.token })).data.models;
  const by = Object.fromEntries(ms.map((m) => [m.id, m]));
  assert.equal(by['nick-4.8'].role, 'everyday');
  assert.equal(by['hike-6.5'].role, 'complex');
  assert.equal(by['sona-9.0'].role, 'web-security-analytics');
  assert.equal(by['fab-100x'].role, 'advanced-general');
  assert.ok(by['sona-9.0'].capabilities.includes('security-audit') && by['nick-4.8'].capabilities.includes('roman_urdu'));
  for (const m of ms) assert.ok(['configured', 'training', 'trained', 'packaged', 'deploying', 'online', 'offline', 'failed'].includes(m.status), m.id);
  // Test servers run the development simulator: online but flagged, never presented as a trained model.
  assert.ok(ms.every((m) => m.status !== 'online' || m.simulator === true));
});

test('unauthenticated and invalid-model requests are refused', async () => {
  assert.equal((await req('GET', '/api/models')).status, 401);
  assert.equal((await req('POST', '/api/v1/chat/completions', { body: { model: 'nick-4.8', messages: [{ role: 'user', content: 'hi' }] } })).status, 401);
  const bad = await send(user, 'gpt-x-unknown');
  assert.deepEqual([bad.status, bad.data.error.code], [400, 'unknown_model']);
});

test('Nick, Hike, Sona and FAB 100X stream through the router to their own model (permissions respected)', async () => {
  for (const id of ['nick-4.8', 'hike-6.5']) {
    const r = await send(user, id);
    assert.equal(r.status, 200, id);
    const ev = parseSse(r.data);
    assert.equal(ev[0].event, 'route'); assert.equal(ev[0].data.model_id, id);
    assert.ok(ev.some((e) => e.event === 'delta'), `${id} streamed deltas`);
  }
  assert.equal((await send(user, 'sona-9.0')).status, 403, 'Sona needs a paid plan');
  assert.equal(parseSse((await send(pro, 'sona-9.0')).data)[0].data.model_id, 'sona-9.0');
  assert.equal((await send(pro, 'fab-100x')).data.error.code, 'model_access_denied', 'FAB 100X needs a grant');
  assert.equal((await req('PUT', `/api/admin/clients/${pro.id}/models/fab-100x`, { ...A(sa), body: { access: 'enabled' } })).status, 200);
  assert.equal(parseSse((await send(pro, 'fab-100x')).data)[0].data.model_id, 'fab-100x');
});

test('FAB 500X is private: invisible and refused for normal users, admins and superadmins without a grant', async () => {
  for (const who of [user, pro, sa]) {
    const ms = (await req('GET', '/api/models', { token: who.token })).data.models;
    assert.equal(ms.find((m) => m.id === 'fab-500x'), undefined);
    const r = await send(who, 'fab-500x');
    assert.deepEqual([r.status, r.data.error.code], [400, 'unknown_model'], 'no existence oracle');
  }
  const k = await req('POST', '/api/developer/keys', { token: pro.token, body: { name: 'k', scopes: ['chat'] } });
  assert.equal((await req('POST', '/api/v1/chat/completions', { token: k.data.secret, body: { model: 'fab-500x', messages: [{ role: 'user', content: 'x' }] } })).status, 400);
  assert.equal((await req('GET', '/api/v1/models/fab-500x', { token: k.data.secret })).status >= 400, true);
  // Auto routing never selects it.
  const long = 'Design a full-stack secure multi-file architecture with threat model, step by step, in depth. '.repeat(30);
  assert.notEqual(parseSse((await send(sa, 'auto', long)).data)[0].data.model_id, 'fab-500x');
});

test('admin grant / revoke of FAB 500X: superadmin only, enforced immediately, audited', async () => {
  assert.equal((await req('PUT', `/api/admin/clients/${pro.id}/models/fab-500x`, { ...A(admin), body: { access: 'enabled' } })).status, 403, 'admin role cannot grant FAB');
  assert.equal((await req('PUT', `/api/admin/clients/${pro.id}/models/fab-500x`, { token: pro.token, body: { access: 'enabled' } })).status, 401, 'a client cannot grant itself');
  assert.equal((await req('PUT', `/api/admin/clients/${pro.id}/models/fab-500x`, { ...A(sa), body: { access: 'enabled', reason: 'approved private workspace' } })).status, 200);
  const ms = (await req('GET', '/api/models', { token: pro.token })).data.models;
  const fab = ms.find((m) => m.id === 'fab-500x');
  assert.ok(fab && fab.private === true && fab.available === true && fab.workspace === 'fab500x-code');
  const ok = await send(pro, 'fab-500x');
  assert.equal(ok.status, 200);
  assert.equal(parseSse(ok.data)[0].data.model_id, 'fab-500x');
  assert.equal((await send(user, 'fab-500x')).status, 400, 'still refused for others');
  const grants = await req('GET', '/api/admin/models/fab-500x/grants', A(admin));
  assert.ok(grants.data.grants.some((g) => g.email === pro.email && g.access === 'grant'));
  // revoke → refused on the very next request
  assert.equal((await req('PUT', `/api/admin/clients/${pro.id}/models/fab-500x`, { ...A(sa), body: { access: 'default' } })).status, 200);
  assert.equal((await send(pro, 'fab-500x')).status, 400);
  const log = (await req('GET', '/api/admin/audit-log', A(admin))).data.entries.map((e) => `${e.action}:${e.target}`);
  assert.ok(log.includes('admin.model_enabled:fab-500x') && log.includes('admin.model_default:fab-500x'));
  // Policy: an admin-granted model can never be made public.
  assert.equal((await req('PUT', '/api/admin/models/fab-500x/availability', { ...A(sa), body: { visibility: 'public' } })).data.error.code, 'policy_private_model');
});

test('availability: disabled models are offline, refused and skipped by auto routing; failures are logged', async () => {
  assert.equal((await req('PUT', '/api/admin/models/hike-6.5/availability', { ...A(admin), body: { available: false } })).status, 403, 'superadmin only');
  assert.equal((await req('PUT', '/api/admin/models/hike-6.5/availability', { ...A(sa), body: { available: false } })).status, 200);
  const m = (await req('GET', '/api/models', { token: user.token })).data.models.find((x) => x.id === 'hike-6.5');
  assert.deepEqual([m.status, m.selectable], ['offline', false]);
  const r = await send(user, 'hike-6.5');
  assert.deepEqual([r.status, r.data.error.code], [503, 'model_disabled']);
  const auto = await send(user, 'auto', 'Refactor this python function step by step and optimize it: def f(x): return x');
  assert.notEqual(parseSse(auto.data)[0].data.model_id, 'hike-6.5');
  const ov = (await req('GET', '/api/admin/models-overview', A(admin))).data.models.find((x) => x.id === 'hike-6.5');
  assert.deepEqual([ov.available, ov.status], [false, 'offline']);
  await req('PUT', '/api/admin/models/hike-6.5/availability', { ...A(sa), body: { available: true } });
  const h = await req('GET', '/api/admin/models/nick-4.8/health', A(admin));
  assert.equal(h.status, 200);
  assert.ok(['online', 'offline', 'trained', 'configured'].includes(h.data.status));
  assert.equal((await req('GET', '/api/admin/models/nick-4.8/failures', A(admin))).status, 200);
  assert.equal((await req('GET', '/api/admin/models/nick-4.8/health', { token: user.token })).status, 401);
});

test('router: per-model inference servers take precedence over the family server', async () => {
  const { upstreamFor } = await import('../src/providers/index.js');
  const save = { ...process.env };
  try {
    process.env.APPROX_MODEL_FAB_URL = 'http://fab-family:8000/v1';
    process.env.APPROX_MODEL_FAB_500X_URL = 'http://fab500x:8000/v1';
    process.env.APPROX_MODEL_FAB_500X_KEY = 'k500';
    assert.equal(upstreamFor({ id: 'fab-500x', family: 'fab' }).url, 'http://fab500x:8000/v1');
    assert.equal(upstreamFor({ id: 'fab-500x', family: 'fab' }).key, 'k500');
    assert.equal(upstreamFor({ id: 'fab-100x', family: 'fab' }).url, 'http://fab-family:8000/v1');
    assert.equal(upstreamFor({ id: 'fab-100x', family: 'fab' }).name, 'fab-100x');
  } finally { for (const k of ['APPROX_MODEL_FAB_URL', 'APPROX_MODEL_FAB_500X_URL', 'APPROX_MODEL_FAB_500X_KEY']) if (save[k] === undefined) delete process.env[k]; }
});

test('router: role-based auto selection (web/security → Sona, complex → Hike, everyday → Nick)', async () => {
  const web = await send(pro, 'auto', 'Build a secure React website with an Express REST API and a GA4 analytics dashboard; review it for XSS and CSRF.');
  assert.equal(parseSse(web.data)[0].data.model_id, 'sona-9.0');
  const daily = await send(pro, 'auto', 'Kal ke liye ek simple to-do list bana do');
  assert.equal(parseSse(daily.data)[0].data.model_id, 'nick-4.8');
  const free = await send(user, 'auto', 'Build a secure React website with an Express REST API and review it for XSS.');
  assert.ok(['nick-4.8', 'hike-6.5'].includes(parseSse(free.data)[0].data.model_id), 'free users never routed to Sona');
});
