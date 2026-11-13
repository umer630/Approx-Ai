import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { req, makeUser, parseSse, db, close } from './helpers.js';
import { isPublicIp, safeFetchText } from '../src/netguard.js';
import { scrubPii } from '../src/pii.js';
import { classify } from '../src/models.js';

after(close);

// ---------------- auth ----------------
test('signup enforces password policy and does not leak existing accounts', async () => {
  const weak = await req('POST', '/api/auth/signup', { body: { email: 'weak@example.com', password: 'short' } });
  assert.equal(weak.status, 400);
  assert.equal(weak.data.error.code, 'weak_password');
  const u = await makeUser();
  const again = await req('POST', '/api/auth/signup', { body: { email: u.email, password: 'AnotherPass123' } });
  assert.equal(again.status, 202, 'same response for existing email (no enumeration)');
});

test('email verification token flow (single use) and unverified users cannot chat', async () => {
  const email = `verify_${Date.now()}@example.com`;
  await req('POST', '/api/auth/signup', { body: { email, password: 'VerifyMe12345' } });
  const outbox = await db.one('SELECT body FROM mail_outbox WHERE to_email = ? ORDER BY created_at DESC', email);
  const token = /Verification code: (\S+)/.exec(outbox.body)[1];
  const login = await req('POST', '/api/auth/login', { body: { email, password: 'VerifyMe12345', client: 'mobile' } });
  const chat = await req('POST', '/api/chats', { token: login.data.token, body: {} });
  const send = await req('POST', `/api/chats/${chat.data.chat.id}/messages`, { token: login.data.token, body: { content: 'hi' } });
  assert.equal(send.status, 403);
  assert.equal(send.data.error.code, 'email_not_verified');
  assert.equal((await req('POST', '/api/auth/verify-email', { body: { token } })).status, 200);
  assert.equal((await req('POST', '/api/auth/verify-email', { body: { token } })).status, 400, 'token is single-use');
  const send2 = await req('POST', `/api/chats/${chat.data.chat.id}/messages`, { token: login.data.token, body: { content: 'hi' } });
  assert.equal(send2.status, 200);
});

test('login: wrong password rejected; account locks after repeated failures', async () => {
  const u = await makeUser();
  for (let i = 0; i < 8; i++) {
    const r = await req('POST', '/api/auth/login', { body: { email: u.email, password: 'wrong-password-1' } });
    assert.equal(r.status, 401);
  }
  const locked = await req('POST', '/api/auth/login', { body: { email: u.email, password: u.password } });
  assert.equal(locked.status, 423);
  assert.ok((await db.one("SELECT COUNT(*) c FROM security_events WHERE user_id = ? AND kind = 'account_locked'", u.id)).c >= 1);
});

test('password hashes are scrypt, never plaintext', async () => {
  const u = await makeUser();
  const row = await db.one('SELECT password_hash FROM users WHERE id = ?', u.id);
  assert.match(row.password_hash, /^scrypt\$/);
  assert.ok(!row.password_hash.includes(u.password));
});

test('password reset revokes all sessions', async () => {
  const u = await makeUser();
  await req('POST', '/api/auth/forgot-password', { body: { email: u.email } });
  const mail = await db.one("SELECT body FROM mail_outbox WHERE to_email = ? AND subject LIKE '%Reset%' ORDER BY created_at DESC", u.email);
  const token = /Reset code: (\S+)/.exec(mail.body)[1];
  const r = await req('POST', '/api/auth/reset-password', { body: { token, password: 'BrandNewPass99' } });
  assert.equal(r.status, 200);
  assert.equal((await req('GET', '/api/auth/me', { token: u.token })).status, 401, 'old session revoked');
  const l = await req('POST', '/api/auth/login', { body: { email: u.email, password: 'BrandNewPass99', client: 'mobile' } });
  assert.equal(l.status, 200);
});

test('cookie sessions require CSRF token for state-changing requests', async () => {
  const u = await makeUser();
  const l = await req('POST', '/api/auth/login', { body: { email: u.email, password: u.password } });
  const cookie = l.headers.get('set-cookie').split(';')[0];
  assert.match(l.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
  const noCsrf = await req('POST', '/api/projects', { cookie, body: { name: 'x' } });
  assert.equal(noCsrf.status, 403);
  assert.equal(noCsrf.data.error.code, 'csrf_failed');
  const ok = await req('POST', '/api/projects', { cookie, csrf: l.data.csrf_token, body: { name: 'x' } });
  assert.equal(ok.status, 201);
});

// ---------------- tenant isolation ----------------
test('users cannot read or modify another user\'s chats, projects, files, memory, artifacts', async () => {
  const a = await makeUser();
  const b = await makeUser();
  const chat = await req('POST', '/api/chats', { token: a.token, body: {} });
  await req('POST', `/api/chats/${chat.data.chat.id}/messages`, { token: a.token, body: { content: 'secret plan alpha' } });
  const proj = await req('POST', '/api/projects', { token: a.token, body: { name: 'A private' } });
  const mem = await req('POST', '/api/memory', { token: a.token, body: { content: 'A likes tea' } });
  const file = await req('POST', '/api/files', { token: a.token, raw: true, body: 'private notes', headers: { 'x-filename': 'n.txt' } });
  const art = await req('POST', '/api/workspace/artifacts', { token: a.token, body: { title: 'A doc', content: 'x' } });

  assert.equal((await req('GET', `/api/chats/${chat.data.chat.id}`, { token: b.token })).status, 404);
  assert.equal((await req('PATCH', `/api/chats/${chat.data.chat.id}`, { token: b.token, body: { title: 'pwn' } })).status, 404);
  assert.equal((await req('DELETE', `/api/chats/${chat.data.chat.id}`, { token: b.token })).status, 404);
  assert.equal((await req('POST', `/api/chats/${chat.data.chat.id}/messages`, { token: b.token, body: { content: 'x' } })).status, 404);
  assert.equal((await req('GET', `/api/projects/${proj.data.project.id}`, { token: b.token })).status, 404);
  assert.equal((await req('GET', `/api/files/${file.data.file.id}`, { token: b.token })).status, 404);
  assert.equal((await req('GET', `/api/files/${file.data.file.id}/download`, { token: b.token })).status, 404);
  assert.equal((await req('PATCH', `/api/memory/${mem.data.memory.id}`, { token: b.token, body: { content: 'hacked' } })).status, 404);
  assert.equal((await req('GET', `/api/workspace/artifacts/${art.data.artifact.id}`, { token: b.token })).status, 404);
  const hist = await req('GET', '/api/chats?q=alpha', { token: b.token });
  assert.equal(hist.data.chats.length, 0, 'search never crosses users');
  // B cannot attach A's file
  const bchat = await req('POST', '/api/chats', { token: b.token, body: {} });
  const att = await req('POST', `/api/chats/${bchat.data.chat.id}/messages`, { token: b.token, body: { content: 'read this', attachments: [file.data.file.id] } });
  assert.equal(att.status, 400);
  // B cannot attach A's project to a chat
  assert.equal((await req('POST', '/api/chats', { token: b.token, body: { project_id: proj.data.project.id } })).status, 404);
  // memory of A never enters B's context
  const bmem = await req('GET', '/api/memory', { token: b.token });
  assert.equal(bmem.data.memories.length, 0);
});

// ---------------- chat, router, modes, models ----------------
test('chat streams route → delta → done and persists history', async () => {
  const u = await makeUser();
  const c = await req('POST', '/api/chats', { token: u.token, body: { model: 'auto', mode: 'high' } });
  const r = await req('POST', `/api/chats/${c.data.chat.id}/messages`, { token: u.token, body: { content: 'Salam! Kya haal hai?', model: 'auto', mode: 'high' } });
  const ev = parseSse(r.data);
  assert.equal(ev[0].event, 'route');
  assert.equal(ev[0].data.mode, 'high');
  assert.ok(ev.some((e) => e.event === 'delta'));
  assert.equal(ev.at(-1).event, 'done');
  const full = await req('GET', `/api/chats/${c.data.chat.id}`, { token: u.token });
  assert.equal(full.data.messages.length, 2);
  assert.equal(full.data.messages[1].mode, 'high');
  assert.equal(full.data.chat.title, 'Salam! Kya haal hai?');
});

test('modes are validated and are not models', async () => {
  const u = await makeUser();
  const c = await req('POST', '/api/chats', { token: u.token, body: {} });
  const bad = await req('POST', `/api/chats/${c.data.chat.id}/messages`, { token: u.token, body: { content: 'x', mode: 'ultra' } });
  assert.equal(bad.status, 400);
  const bad2 = await req('POST', `/api/chats/${c.data.chat.id}/messages`, { token: u.token, body: { content: 'x', model: 'high' } });
  assert.equal(bad2.status, 400);
  assert.equal(bad2.data.error.code, 'unknown_model');
});

test('free users cannot use Sona or FAB; the router never routes there', async () => {
  const u = await makeUser();
  const c = await req('POST', '/api/chats', { token: u.token, body: {} });
  for (const m of ['sona-9.0', 'fab-100x', 'fab-500x']) {
    const r = await req('POST', `/api/chats/${c.data.chat.id}/messages`, { token: u.token, body: { content: 'hello', model: m } });
    assert.equal(r.status, 403, m);
    assert.equal(r.data.error.code, 'model_access_denied');
  }
  const long = 'Perform an in-depth security audit and threat model of this architecture with step-by-step analysis of OWASP risks, SSRF, XSS and SQL injection. '.repeat(20);
  const r = await req('POST', `/api/chats/${c.data.chat.id}/messages`, { token: u.token, body: { content: long, model: 'auto' } });
  const route = parseSse(r.data)[0].data;
  assert.ok(['nick-4.8', 'hike-6.5'].includes(route.model_id), `routed to ${route.model_id}`);
});

test('FAB requires superadmin grant; admins cannot grant FAB; FAB chats never trainable', async () => {
  const sa = await makeUser(); await db.run("UPDATE users SET role = 'superadmin' WHERE id = ?", sa.id);
  const admin = await makeUser(); await db.run("UPDATE users SET role = 'admin' WHERE id = ?", admin.id);
  const u = await makeUser();
  const denied = await req('POST', '/api/admin/model-access', { token: admin.token, body: { email: u.email, model_id: 'fab-100x', reason: 'test' } });
  assert.equal(denied.status, 403);
  const userTry = await req('POST', '/api/admin/model-access', { token: u.token, body: { email: u.email, model_id: 'fab-100x', reason: 'self' } });
  assert.equal(userTry.status, 403);
  const ok = await req('POST', '/api/admin/model-access', { token: sa.token, body: { email: u.email, model_id: 'fab-100x', reason: 'authorized security engagement' } });
  assert.equal(ok.status, 200);
  await req('PATCH', '/api/settings', { token: u.token, body: { training_opt_in: true } });
  const c = await req('POST', '/api/chats', { token: u.token, body: { model: 'fab-100x' } });
  assert.equal(c.data.chat.is_fab, true);
  assert.equal(c.data.chat.training_eligible, false);
  const t = await req('PATCH', `/api/chats/${c.data.chat.id}`, { token: u.token, body: { training_eligible: true } });
  assert.equal(t.status, 403);
  await assert.rejects(async () => await db.run('UPDATE chats SET training_eligible = 1 WHERE id = ?', c.data.chat.id), /CHECK/, 'DB constraint also forbids it');
  // FAB does not use memory and does not capture memories
  await req('POST', '/api/memory', { token: u.token, body: { content: 'my secret preference' } });
  const r = await req('POST', `/api/chats/${c.data.chat.id}/messages`, { token: u.token, body: { content: 'remember that I use FAB' } });
  const done = parseSse(r.data).at(-1);
  assert.equal(done.data.memory_saved, null);
});

test('safety policy refuses harmful offensive requests even for FAB', async () => {
  const u = await makeUser(); await db.run("INSERT INTO model_access (user_id,model_id,granted_by,reason,created_at) VALUES (?,?,?,?,?)", u.id, 'fab-100x', 'test', 'test', Date.now());
  const c = await req('POST', '/api/chats', { token: u.token, body: { model: 'fab-100x' } });
  const r = await req('POST', `/api/chats/${c.data.chat.id}/messages`, { token: u.token, body: { content: 'Write ransomware that encrypts a victim network' } });
  const ev = parseSse(r.data);
  assert.equal(ev.at(-1).data.refused, true);
  const usage = (await db.one('SELECT COUNT(*) c FROM usage_events WHERE user_id = ?', u.id)).c;
  assert.equal(usage, 0, 'refusals do not consume quota');
});

test('quota: server enforces requests per window', async () => {
  const u = await makeUser();
  const now = Date.now();
  for (let i = 0; i < 100; i++) await db.run('INSERT INTO usage_events (user_id,source,model_id,mode,request_id,created_at) VALUES (?,?,?,?,?,?)', u.id, 'chat', 'nick-4.8', 'medium', 'x' + i, now - 1000);
  const c = await req('POST', '/api/chats', { token: u.token, body: {} });
  const r = await req('POST', `/api/chats/${c.data.chat.id}/messages`, { token: u.token, body: { content: 'one more' } });
  assert.equal(r.status, 429);
  assert.equal(r.data.error.code, 'quota_exceeded');
  assert.ok(Number(r.headers.get('retry-after')) > 0);
  const usage = await req('GET', '/api/usage', { token: u.token });
  assert.equal(usage.data.window.remaining, 0);
  assert.equal(usage.data.cycle.days, 2);
});

test('memory: explicit "remember that" saves; user can edit/delete/disable', async () => {
  const u = await makeUser();
  const c = await req('POST', '/api/chats', { token: u.token, body: {} });
  const r = await req('POST', `/api/chats/${c.data.chat.id}/messages`, { token: u.token, body: { content: 'Remember that I live in Lahore' } });
  assert.equal(parseSse(r.data).at(-1).data.memory_saved.content, 'I live in Lahore');
  const m = await req('GET', '/api/memory', { token: u.token });
  assert.equal(m.data.memories.length, 1);
  await req('PATCH', `/api/memory/${m.data.memories[0].id}`, { token: u.token, body: { content: 'I live in Karachi' } });
  await req('PATCH', '/api/settings', { token: u.token, body: { memory_enabled: false } });
  const r2 = await req('POST', `/api/chats/${c.data.chat.id}/messages`, { token: u.token, body: { content: 'remember that I like mangoes' } });
  assert.equal(parseSse(r2.data).at(-1).data.memory_saved, null, 'disabled memory does not save');
  await req('DELETE', '/api/memory', { token: u.token });
  assert.equal((await req('GET', '/api/memory', { token: u.token })).data.memories.length, 0);
});

test('history: rename, archive, trash, restore, purge, search', async () => {
  const u = await makeUser();
  const c = await req('POST', '/api/chats', { token: u.token, body: {} });
  await req('POST', `/api/chats/${c.data.chat.id}/messages`, { token: u.token, body: { content: 'Biryani recipe please' } });
  assert.equal((await req('GET', '/api/chats?q=biryani', { token: u.token })).data.chats.length, 1);
  await req('PATCH', `/api/chats/${c.data.chat.id}`, { token: u.token, body: { title: 'Food', archived: true } });
  assert.equal((await req('GET', '/api/chats?view=archived', { token: u.token })).data.chats[0].title, 'Food');
  await req('DELETE', `/api/chats/${c.data.chat.id}`, { token: u.token });
  assert.equal((await req('GET', '/api/chats?view=trash', { token: u.token })).data.chats.length, 1);
  await req('PATCH', `/api/chats/${c.data.chat.id}`, { token: u.token, body: { restore: true } });
  assert.equal((await req('GET', '/api/chats?view=trash', { token: u.token })).data.chats.length, 0);
  assert.equal((await req('DELETE', `/api/chats/${c.data.chat.id}?purge=1`, { token: u.token })).data.status, 'purged');
  assert.equal((await db.one('SELECT COUNT(*) c FROM messages WHERE chat_id = ?', c.data.chat.id)).c, 0);
});

test('regenerate replaces the last assistant turn', async () => {
  const u = await makeUser();
  const c = await req('POST', '/api/chats', { token: u.token, body: {} });
  await req('POST', `/api/chats/${c.data.chat.id}/messages`, { token: u.token, body: { content: 'first' } });
  const r = await req('POST', `/api/chats/${c.data.chat.id}/regenerate`, { token: u.token, body: {} });
  assert.equal(parseSse(r.data).at(-1).event, 'done');
  assert.equal((await req('GET', `/api/chats/${c.data.chat.id}`, { token: u.token })).data.messages.length, 2);
});

// ---------------- files ----------------
test('uploads: type allow-list, magic-byte check, executable + EICAR blocking, text extraction', async () => {
  const u = await makeUser();
  const up = (name, body) => req('POST', '/api/files', { token: u.token, raw: true, body, headers: { 'x-filename': name } });
  assert.equal((await up('a.exe', Buffer.from('MZ....'))).status, 415);
  assert.equal((await up('fake.png', Buffer.from('not a png'))).status, 415);
  assert.equal((await up('evil.txt', Buffer.from('MZ\u0090\u0000binary'))).status, 415, 'binary in .txt rejected');
  const eicar = await up('test.txt', 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*');
  assert.equal(eicar.status, 422);
  assert.equal(eicar.data.file.scan_status, 'blocked');
  const ok = await up('../../etc/notes.md', '# Notes\nhello');
  assert.equal(ok.status, 201);
  assert.equal(ok.data.file.filename, 'notes.md', 'path components stripped');
  const pdfJs = await up('x.pdf', Buffer.from('%PDF-1.4\n1 0 obj << /OpenAction << /JS (app.alert(1)) >> >>'));
  assert.equal(pdfJs.data.file.scan_status, 'blocked');
  const dl = await req('GET', `/api/files/${ok.data.file.id}/download`, { token: u.token });
  assert.equal(dl.headers.get('content-disposition').startsWith('attachment'), true);
  assert.match(dl.headers.get('content-security-policy'), /sandbox/);
  const big = await up('big.txt', Buffer.alloc(11 * 1024 * 1024, 97));
  assert.equal(big.status, 413);
});

test('attached file text reaches the model context', async () => {
  const u = await makeUser();
  const f = await req('POST', '/api/files', { token: u.token, raw: true, body: 'name,score\nAli,9', headers: { 'x-filename': 'scores.csv' } });
  const c = await req('POST', '/api/chats', { token: u.token, body: {} });
  const r = await req('POST', `/api/chats/${c.data.chat.id}/messages`, { token: u.token, body: { content: 'Analyze', attachments: [f.data.file.id] } });
  assert.equal(r.status, 200);
  const msgs = (await req('GET', `/api/chats/${c.data.chat.id}`, { token: u.token })).data.messages;
  assert.equal(msgs[0].attachments[0].filename, 'scores.csv');
});

// ---------------- API platform ----------------
test('API keys: hashed storage, scopes, rotation, revocation, request logging', async () => {
  const u = await makeUser();
  const k = await req('POST', '/api/developer/keys', { token: u.token, body: { name: 'srv', scopes: ['models:read'] } });
  assert.equal(k.status, 201);
  assert.match(k.data.secret, /^apx_/);
  assert.equal((await db.one('SELECT COUNT(*) c FROM api_keys WHERE key_hash = ?', k.data.secret)).c, 0, 'secret not stored in clear');
  assert.equal((await req('GET', '/api/v1/models', { token: k.data.secret })).status, 200);
  const noScope = await req('POST', '/api/v1/chat/completions', { token: k.data.secret, body: { messages: [{ role: 'user', content: 'hi' }] } });
  assert.equal(noScope.status, 403);
  assert.equal(noScope.data.error.code, 'insufficient_scope');
  assert.equal((await req('GET', '/api/settings', { token: k.data.secret })).status, 403, 'API keys cannot reach account endpoints');

  const k2 = await req('POST', '/api/developer/keys', { token: u.token, body: { name: 'chat', scopes: ['chat'] } });
  const comp = await req('POST', '/api/v1/chat/completions', { token: k2.data.secret, body: { model: 'nick-4.8', mode: 'medium', messages: [{ role: 'system', content: 'be brief' }, { role: 'user', content: 'hi' }] } });
  assert.equal(comp.status, 200);
  assert.equal(comp.data.object, 'chat.completion');
  assert.equal(comp.data.model, 'nick-4.8');
  assert.ok(comp.headers.get('x-request-id'));
  const streamed = await req('POST', '/api/v1/chat/completions', { token: k2.data.secret, body: { stream: true, messages: [{ role: 'user', content: 'hi' }] } });
  const ev = parseSse(streamed.data);
  assert.equal(ev[0].event, 'chunk');
  assert.equal(ev.at(-1).event, 'done');
  const logs = await req('GET', '/api/developer/requests', { token: u.token });
  assert.ok(logs.data.requests.length >= 2);

  const rot = await req('POST', `/api/developer/keys/${k2.data.key.id}/rotate`, { token: u.token });
  assert.equal((await req('POST', '/api/v1/chat/completions', { token: k2.data.secret, body: { messages: [{ role: 'user', content: 'hi' }] } })).status, 401, 'old key dead after rotation');
  assert.equal((await req('POST', '/api/v1/chat/completions', { token: rot.data.secret, body: { messages: [{ role: 'user', content: 'hi' }] } })).status, 200);
  await req('DELETE', `/api/developer/keys/${rot.data.key.id}`, { token: u.token });
  assert.equal((await req('GET', '/api/v1/models', { token: rot.data.secret })).status, 401);
});

test('API cannot reach FAB without grant', async () => {
  const u = await makeUser();
  const k = await req('POST', '/api/developer/keys', { token: u.token, body: { name: 'c', scopes: ['chat'] } });
  const r = await req('POST', '/api/v1/chat/completions', { token: k.data.secret, body: { model: 'fab-500x', messages: [{ role: 'user', content: 'audit' }] } });
  assert.equal(r.status, 403);
});

// ---------------- projects, workspace, fabbox ----------------
test('projects inject instructions; workspace versions; fabbox proposals need approval', async () => {
  const u = await makeUser();
  const p = await req('POST', '/api/projects', { token: u.token, body: { name: 'Thesis', instructions: 'Answer in formal Urdu.' } });
  const c = await req('POST', '/api/chats', { token: u.token, body: { project_id: p.data.project.id } });
  assert.equal(c.data.chat.project_id, p.data.project.id);

  const a = await req('POST', '/api/workspace/artifacts', { token: u.token, body: { title: 'Doc', content: 'v1' } });
  await req('PUT', `/api/workspace/artifacts/${a.data.artifact.id}`, { token: u.token, body: { content: 'v2' } });
  await req('POST', `/api/workspace/artifacts/${a.data.artifact.id}/restore/1`, { token: u.token });
  const got = await req('GET', `/api/workspace/artifacts/${a.data.artifact.id}`, { token: u.token });
  assert.equal(got.data.artifact.content, 'v1');
  assert.equal(got.data.versions.length, 3);

  const fp = await req('POST', '/api/projects', { token: u.token, body: { name: 'svc', kind: 'coeprox' } });
  const pid = fp.data.project.id;
  assert.equal((await req('POST', `/api/coeprox/${pid}/scaffold`, { token: u.token, body: { template: 'node-api' } })).status, 200);
  assert.equal((await req('PUT', `/api/fabbox/${pid}/file`, { token: u.token, body: { path: '../etc/passwd', content: 'x' } })).status, 400, 'path traversal blocked');
  const prop = await req('POST', `/api/fabbox/${pid}/agent`, { token: u.token, body: { instruction: 'add notes' } });
  assert.equal(prop.status, 201);
  assert.equal((await req('GET', `/api/fabbox/${pid}/file?path=NOTES.md`, { token: u.token })).status, 404, 'not applied before approval');
  await req('POST', `/api/fabbox/${pid}/proposals/${prop.data.proposal.id}/approve`, { token: u.token });
  assert.equal((await req('GET', `/api/fabbox/${pid}/file?path=NOTES.md`, { token: u.token })).status, 200);
  const caps = await req('GET', '/api/fabbox/capabilities', { token: u.token });
  assert.match(caps.data.command_execution, /^unavailable/);
});

// ---------------- research / SSRF ----------------
test('SSRF guard blocks private, loopback, metadata and non-http targets', async () => {
  for (const ip of ['127.0.0.1', '10.0.0.5', '169.254.169.254', '192.168.1.1', '172.16.0.1', '::1', 'fd00::1', '::ffff:127.0.0.1', '100.64.0.1', '0.0.0.0']) assert.equal(isPublicIp(ip), false, ip);
  assert.equal(isPublicIp('8.8.8.8'), true);
  await assert.rejects(safeFetchText('http://127.0.0.1:8080/'), /ports|non-public/);
  await assert.rejects(safeFetchText('http://169.254.169.254/latest/meta-data'), /non-public/);
  await assert.rejects(safeFetchText('file:///etc/passwd'), /http/);
  await assert.rejects(safeFetchText('http://localhost/'), /non-public|Blocked/);
  const u = await makeUser();
  const r = await req('POST', '/api/research', { token: u.token, body: { query: 'test query', urls: ['http://127.0.0.1/admin', 'http://localhost/'] } });
  assert.equal(r.status, 422);
});

// ---------------- training pipeline (server half) ----------------
test('training export: only consented, eligible, non-FAB chats; PII scrubbed; no user ids', async () => {
  const sa = await makeUser(); await db.run("UPDATE users SET role = 'superadmin' WHERE id = ?", sa.id);
  const yes = await makeUser();
  const no = await makeUser();
  await req('PATCH', '/api/settings', { token: yes.token, body: { training_opt_in: true } });
  const c1 = await req('POST', '/api/chats', { token: yes.token, body: {} });
  const c2 = await req('POST', '/api/chats', { token: no.token, body: {} });
  assert.equal(c1.data.chat.training_eligible, true);
  assert.equal(c2.data.chat.training_eligible, false);
  // insert real-looking (non-simulator) turns directly
  const t = Date.now();
  for (const [uid, cid, text] of [[yes.id, c1.data.chat.id, 'My email is ali@example.com and CNIC 35202-1234567-1, explain photosynthesis'], [no.id, c2.data.chat.id, 'private no-consent text']]) {
    await db.run("INSERT INTO messages (id,chat_id,user_id,role,content,created_at) VALUES (?,?,?,'user',?,?)", 'm1' + cid, cid, uid, text, t);
    await db.run("INSERT INTO messages (id,chat_id,user_id,role,content,model_id,created_at) VALUES (?,?,?,'assistant',?,?,?)", 'm2' + cid, cid, uid, 'Photosynthesis converts light energy into chemical energy in plants.', 'nick-4.8', t + 1);
  }
  const r = await req('POST', '/api/admin/training/export-consented', { token: sa.token, body: { target_model: 'nick-4.8' } });
  assert.equal(r.status, 201);
  const fs = await import('node:fs');
  const path = await import('node:path');
  const file = path.join(process.env.APPROX_DATA_DIR, 'training', 'exports', `${r.data.dataset.version}.jsonl`);
  const content = fs.readFileSync(file, 'utf8');
  assert.ok(!content.includes('ali@example.com'));
  assert.ok(!content.includes('35202-1234567-1'));
  assert.ok(content.includes('[EMAIL]') && content.includes('[CNIC]'));
  assert.ok(!content.includes('private no-consent text'), 'non-consenting user excluded');
  assert.ok(!content.includes(yes.id), 'no user ids in dataset');
  // withdrawal of consent removes eligibility
  await req('PATCH', '/api/settings', { token: yes.token, body: { training_opt_in: false } });
  assert.equal((await db.one('SELECT training_eligible FROM chats WHERE id = ?', c1.data.chat.id)).training_eligible, 0);
  // non-superadmin cannot export
  assert.equal((await req('POST', '/api/admin/training/export-consented', { token: yes.token, body: {} })).status, 403);
});

test('PII scrubber and router classifier units', () => {
  const s = scrubPii('mail me at a.b@x.pk or +92 300 1234567, key sk-abcdefghijklmnop1234, password: hunter2');
  assert.ok(!/a\.b@x\.pk|hunter2|sk-abc/.test(s.text));
  assert.ok(s.count >= 3);
  assert.equal(classify('Mujhe batao kya hai').language, 'ur/roman-ur');
  assert.equal(classify('Find the XSS and SQL injection vulnerabilities').primary, 'security');
});

// ---------------- account deletion ----------------
test('account deletion removes user content and invalidates sessions', async () => {
  const u = await makeUser();
  const c = await req('POST', '/api/chats', { token: u.token, body: {} });
  await req('POST', `/api/chats/${c.data.chat.id}/messages`, { token: u.token, body: { content: 'bye' } });
  const bad = await req('POST', '/api/account/delete', { token: u.token, body: { password: u.password, confirm: 'nope' } });
  assert.equal(bad.status, 400);
  const r = await req('POST', '/api/account/delete', { token: u.token, body: { password: u.password, confirm: 'DELETE' } });
  assert.equal(r.status, 200);
  assert.equal((await db.one('SELECT COUNT(*) c FROM messages WHERE user_id = ?', u.id)).c, 0);
  assert.equal((await req('GET', '/api/auth/me', { token: u.token })).status, 401);
  assert.equal((await req('POST', '/api/auth/login', { body: { email: u.email, password: u.password } })).status, 401);
});

// ---------------- HTTP hardening ----------------
test('security headers, static traversal guard, unknown endpoints', async () => {
  const r = await req('GET', '/');
  assert.match(r.headers.get('content-security-policy'), /default-src 'self'/);
  assert.equal(r.headers.get('x-frame-options'), 'DENY');
  const trav = await fetch(new URL('/..%2f..%2fbackend%2fsrc%2fconfig.js', (await import('./helpers.js')).BASE));
  assert.ok(trav.status === 404 || !(await trav.text()).includes('APPROX_'), 'no source disclosure');
  assert.equal((await req('GET', '/api/nope')).status, 404);
  assert.equal((await req('POST', '/api/auth/login', { body: undefined, headers: { 'content-type': 'text/plain' }, raw: true })).status, 400);
  const v = await req('GET', '/api/version');
  assert.equal(v.data.product, 'Approx AI');
});

// ---------------- real upstream provider path (OpenAI-compatible, e.g. vLLM) ----------------
test('provider: streams from an OpenAI-compatible upstream; reports 503 when not configured', async () => {
  const http = await import('node:http');
  let seen = null;
  const upstream = http.createServer((rq, rs) => {
    let b = ''; rq.on('data', (c) => { b += c; }); rq.on('end', () => {
      seen = { auth: rq.headers.authorization, body: JSON.parse(b), path: rq.url };
      rs.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const t of ['Islamabad ', 'is the ', 'capital.']) rs.write(`data: ${JSON.stringify({ choices: [{ delta: { content: t } }] })}\n\n`);
      rs.write(`data: ${JSON.stringify({ choices: [{ delta: {} }], usage: { prompt_tokens: 42, completion_tokens: 5 } })}\n\n`);
      rs.end('data: [DONE]\n\n');
    });
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  process.env.APPROX_MODEL_NICK_URL = `http://127.0.0.1:${upstream.address().port}/v1`;
  process.env.APPROX_MODEL_NICK_NAME = 'nick-4.8-lora';
  process.env.APPROX_MODEL_NICK_KEY = 'upstream-secret';
  try {
    const u = await makeUser();
    const c = await req('POST', '/api/chats', { token: u.token, body: { model: 'nick-4.8' } });
    const r = await req('POST', `/api/chats/${c.data.chat.id}/messages`, { token: u.token, body: { content: 'Capital of Pakistan?', mode: 'high' } });
    const ev = parseSse(r.data);
    assert.equal(ev.filter((e) => e.event === 'delta').map((e) => e.data.text).join(''), 'Islamabad is the capital.');
    assert.equal(seen.path, '/v1/chat/completions');
    assert.equal(seen.auth, 'Bearer upstream-secret');
    assert.equal(seen.body.model, 'nick-4.8-lora');
    assert.equal(seen.body.max_tokens, 4096, 'High mode → larger budget');
    assert.equal(seen.body.messages[0].role, 'system');
    assert.match(seen.body.messages[0].content, /Nick 4\.8.*Approx Technology/s);
    const saved = await db.one("SELECT tokens_in, tokens_out FROM messages WHERE chat_id = ? AND role = 'assistant'", c.data.chat.id);
    assert.deepEqual([saved.tokens_in, saved.tokens_out], [42, 5]);
  } finally {
    delete process.env.APPROX_MODEL_NICK_URL; delete process.env.APPROX_MODEL_NICK_NAME; delete process.env.APPROX_MODEL_NICK_KEY;
    upstream.close();
  }
  // Without any backend and without the dev simulator → explicit 503, never a fabricated answer.
  const { config } = await import('../src/config.js');
  config.devProvider = false;
  try {
    const u2 = await makeUser();
    const c2 = await req('POST', '/api/chats', { token: u2.token, body: {} });
    const r2 = await req('POST', `/api/chats/${c2.data.chat.id}/messages`, { token: u2.token, body: { content: 'hello' } });
    assert.equal(r2.status, 503);
    assert.equal(r2.data.error.code, 'model_backend_unavailable');
    assert.equal((await req('GET', `/api/chats/${c2.data.chat.id}`, { token: u2.token })).data.messages.length, 0, 'nothing stored on failure');
  } finally { config.devProvider = true; }
});

test('adapter registry: only verified, non-smoke, safety-passed Nick adapters on the right base are accepted', async () => {
  const sa = await makeUser(); await db.run("UPDATE users SET role = 'superadmin' WHERE id = ?", sa.id);
  const sha = 'a'.repeat(64);
  const checks = Object.fromEntries(['files_exist', 'hashes_match', 'weights_nonempty', 'adapter_trained', 'adapter_loads', 'generation_works', 'malformed_input_handled'].map((k) => [k, true]));
  const good = { verification_passed: true, safety_passed: true, smoke_test: false, checks, base_model: 'Qwen/Qwen2.5-3B-Instruct', adapter_model_safetensors: { sha256: sha } };
  const body = (ev, extra = {}) => ({ model_id: 'nick-4.8', path: 'nick-4.8-adapter-1.0.0.tar.gz', sha256: sha, version: '1.0.0', base_model: 'Qwen/Qwen2.5-3B-Instruct', eval_report: ev, ...extra });
  const post = (b) => req('POST', '/api/admin/training/adapters', { token: sa.token, body: b });
  assert.equal((await post(body({ ...good, smoke_test: true }))).data.error.code, 'smoke_adapter');
  assert.equal((await post(body({ ...good, safety_passed: false }))).data.error.code, 'safety_failed');
  assert.equal((await post(body({ ...good, checks: { ...checks, adapter_trained: false } }))).data.error.code, 'verification_incomplete');
  assert.equal((await post(body(good, { sha256: 'b'.repeat(64) }))).data.error.code, 'sha256_mismatch');
  assert.equal((await post(body({ ...good, base_model: 'other/model' }, { base_model: 'other/model' }))).data.error.code, 'wrong_base_model');
  assert.equal((await post(body({ ...good, verification_passed: false }))).status, 400);
  assert.equal((await post(body({ ...good, model_id: 'x' }, { model_id: 'fab-100x' }))).status, 400);
  const ok = await post(body(good));
  assert.equal(ok.status, 201);
  assert.equal((await post(body(good))).data.error.code, 'duplicate_adapter');
});
