// Vercel serverless runtime simulation. Runs the real function entry (api/index.js) with VERCEL=1 so every
// serverless code path is exercised: fail-closed database, database-backed file storage, inference-server
// registry source (the GPU host is the source of truth for which Nick 4.8 version is served), superadmin
// bootstrap and the Brevo mail adapter. Persistence is checked across a simulated cold start (new process).
//
// Limitation (stated, not hidden): no Turso server is reachable from the test environment, so the database
// is a scratch libSQL file enabled by APPROX_TEST_EPHEMERAL_DB (ignored when APPROX_ENV=production — tested
// below). The same @libsql/client and SQL run against libsql:// in production.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { startFakeSupabase } from './fake-supabase.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const supabase = await startFakeSupabase();
const SUPA_ENV = { SUPABASE_URL: supabase.url, SUPABASE_PUBLISHABLE_KEY: supabase.publishableKey };
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'approx-vercel-'));
const procs = [];
const servers = [];
after(() => { for (const p of procs) p.kill(); for (const s of servers) { s.close(); s.closeAllConnections?.(); } supabase.close(); });

// ---------- mock services ----------
async function listen(handler) {
  const s = http.createServer(handler);
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  servers.push(s);
  return `http://127.0.0.1:${s.address().port}`;
}
async function body(req) { const c = []; for await (const x of req) c.push(x); return Buffer.concat(c).toString('utf8'); }

/** Mock GPU inference server (inference/server.py contract): /health reports what it serves; streams OpenAI SSE. */
const NICK_PIN = '2faae21620ef0aea6140b296b43ab5fcf5ba2c5b721067f91797b288a09c34c4';
async function mockInference(serving, { sha = NICK_PIN, productionReady = true } = {}) {
  const calls = [];
  const url = await listen(async (req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      const details = Object.fromEntries(Object.entries(serving).map(([m, v]) => [m, { version: v, adapter_sha256: sha, production_ready: productionReady, smoke_test: false }]));
      return res.end(JSON.stringify({ status: 'ok', serving, details, gpu: null }));
    }
    if (req.method === 'POST' && req.url === '/v1/chat/completions') {
      const b = JSON.parse(await body(req));
      calls.push({ auth: req.headers.authorization, model: b.model, stream: b.stream });
      if (b.stream === false) { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'Ready.' } }] })); }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      for (const piece of ['Hello ', 'from the GPU host.']) res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`);
      res.write('data: [DONE]\n\n');
      return res.end();
    }
    res.writeHead(404); res.end();
  });
  return { url: `${url}/v1`, calls };
}

/** Mock Brevo transactional mail endpoint. */
async function mockBrevo() {
  const mails = [];
  const url = await listen(async (req, res) => {
    mails.push({ apiKey: req.headers['api-key'], payload: JSON.parse(await body(req)) });
    res.writeHead(201, { 'Content-Type': 'application/json' }); res.end('{"messageId":"m"}');
  });
  return { url, mails };
}

// ---------- function process ----------
const BASE_ENV = { PATH: process.env.PATH, HOME: process.env.HOME, NODE_OPTIONS: '', VERCEL: '1', ...SUPA_ENV };
async function startFunction(env) {
  const p = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(here, 'vercel-runner.mjs')],
    { env: { ...BASE_ENV, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  procs.push(p);
  let err = '';
  p.stderr.on('data', (d) => { err += d; });
  const port = await new Promise((resolve, reject) => {
    let out = '';
    p.stdout.on('data', (d) => { out += d; const m = /PORT (\d+)/.exec(out); if (m) resolve(m[1]); });
    p.on('exit', (c) => reject(new Error(`function process exited ${c}: ${err}`)));
  });
  const base = `http://127.0.0.1:${port}`;
  const call = async (method, p2, { json, token, raw, headers = {} } = {}) => {
    const h = { ...headers };
    if (json !== undefined) h['content-type'] = 'application/json';
    if (token) h.authorization = `Bearer ${token}`;
    const r = await fetch(base + p2, { method, headers: h, body: raw ?? (json !== undefined ? JSON.stringify(json) : undefined) });
    const ct = r.headers.get('content-type') || '';
    return { status: r.status, headers: r.headers, data: ct.includes('json') ? await r.json() : await r.text() };
  };
  return { call, stop: () => p.kill() };
}

const codeFor = (email) => supabase.lastEmail(email, 'signup')?.token_hash; // the code/link Supabase emailed

// ---------- scenarios ----------
test('serverless without a database fails closed (never falls back to ephemeral /tmp storage)', async () => {
  const fn = await startFunction({ APPROX_ENV: 'test' });
  const hz = await fn.call('GET', '/healthz');
  assert.equal(hz.status, 200, 'liveness does not need the database');
  const h = await fn.call('GET', '/api/health');
  assert.equal(h.status, 503);
  assert.equal(h.data.database, 'not_configured');
  assert.equal(h.data.runtime, 'serverless');
  const s = await fn.call('POST', '/api/auth/signup', { json: { email: 'a@example.com', password: 'GoodPassw0rd!' } });
  assert.equal(s.status, 503);
  assert.equal(s.data.error.code, 'database_not_configured');
  fn.stop();
});

test('a file: database is refused on serverless in production even with the test hatch set', async () => {
  const fn = await startFunction({ APPROX_ENV: 'production', APPROX_DB_URL: `file:${path.join(scratch, 'prod.db')}`, APPROX_TEST_EPHEMERAL_DB: '1' });
  const h = await fn.call('GET', '/api/health');
  assert.equal(h.status, 503);
  assert.equal(h.data.database, 'not_configured');
  assert.equal(fs.existsSync(path.join(scratch, 'prod.db')), false, 'no local database file was created');
  fn.stop();
});

test('serverless end-to-end: brevo mail, superadmin bootstrap, Nick 4.8 via inference server, db file storage, cold start', async () => {
  const inf = await mockInference({ 'nick-4.8': '1.0.0' });
  const brevo = await mockBrevo();
  const dbFile = path.join(scratch, 'e2e.db');
  const env = {
    APPROX_ENV: 'test', APPROX_DB_URL: `file:${dbFile}`, APPROX_TEST_EPHEMERAL_DB: '1',
    APPROX_MODEL_NICK_URL: inf.url, APPROX_MODEL_NICK_KEY: 'test-inference-key',
    MAIL_TRANSPORT: 'brevo', MAIL_HTTP_ENDPOINT: brevo.url, MAIL_HTTP_API_KEY: 'test-mail-key', MAIL_FROM: 'Approx AI <noreply@example.com>',
    APPROX_BOOTSTRAP_SUPERADMIN_EMAIL: 'owner@example.com',
  };
  let fn = await startFunction(env);

  const h = await fn.call('GET', '/api/health');
  assert.equal(h.status, 200);
  assert.deepEqual([h.data.database, h.data.runtime, h.data.registry_source, h.data.file_storage], ['ok', 'serverless', 'inference', 'db']);
  assert.equal(h.headers.get('x-content-type-options'), 'nosniff');

  // Signup → Supabase confirmation email → verify → bootstrap superadmin.
  assert.equal((await fn.call('POST', '/api/auth/signup', { json: { email: 'owner@example.com', password: 'OwnerPassw0rd!' } })).status, 202);
  assert.ok(codeFor('owner@example.com'), 'Supabase sent the confirmation email');
  const unverified = await fn.call('POST', '/api/auth/login', { json: { email: 'owner@example.com', password: 'OwnerPassw0rd!', client: 'mobile' } });
  assert.equal(unverified.status, 403, 'no sign-in (and no promotion) before the email is verified');
  assert.equal((await fn.call('POST', '/api/auth/verify-email', { json: { token: codeFor('owner@example.com') } })).status, 200);
  const owner = await fn.call('POST', '/api/auth/login', { json: { email: 'owner@example.com', password: 'OwnerPassw0rd!', client: 'mobile' } });
  assert.equal(owner.status, 200);
  assert.equal(owner.data.user.role, 'superadmin');

  // A second verified account is a normal user (bootstrap is one-time and email-bound).
  await fn.call('POST', '/api/auth/signup', { json: { email: 'member@example.com', password: 'MemberPassw0rd!' } });
  await fn.call('POST', '/api/auth/verify-email', { json: { token: codeFor('member@example.com') } });
  const member = await fn.call('POST', '/api/auth/login', { json: { email: 'member@example.com', password: 'MemberPassw0rd!', client: 'mobile' } });
  assert.equal(member.data.user.role, 'user');

  // Before activation the loaded model is NOT served (lifecycle REGISTERED).
  const pre = await fn.call('GET', '/api/models', { token: member.data.token });
  assert.equal(pre.data.models.find((m) => m.id === 'nick-4.8').lifecycle.state, 'REGISTERED');
  assert.equal(pre.data.models.find((m) => m.id === 'nick-4.8').active_version, null, 'loaded on the GPU host is not enough');
  // Superadmin deploys the trained, pinned artifact → the backend verifies health + SHA-256 + a real generation → ACTIVE.
  const act = await fn.call('POST', '/api/admin/models/nick-4.8/lifecycle', { token: owner.data.token, json: { to: 'DEPLOYING', version: '1.0.0',
    artifact: { uri: 'gs://approx-models/nick-4.8/1.0.0/adapter.tar.gz', sha256: NICK_PIN, base_model: 'Qwen/Qwen2.5-3B-Instruct', base_revision: 'aa8e72537993ba99e69dfaafa59ed015b17504d1' } } });
  assert.equal(act.status, 200, JSON.stringify(act.data));
  assert.equal(act.data.lifecycle.state, 'ACTIVE');
  assert.equal(act.data.lifecycle.generation_sample, 'Ready.');
  assert.deepEqual(inf.calls.at(-1), { auth: 'Bearer test-inference-key', model: 'nick-4.8@1.0.0', stream: false });

  // Nick 4.8 is served by the inference server's verified version; the backend never relabels another model.
  const models = await fn.call('GET', '/api/models', { token: member.data.token });
  const nick = (models.data.models || []).find((m) => m.id === 'nick-4.8');
  assert.ok(nick, 'Nick 4.8 listed');
  assert.equal(nick.active_version, '1.0.0');
  const chat = await fn.call('POST', '/api/chats', { token: member.data.token, json: { model: 'nick-4.8' } });
  assert.equal(chat.status, 201);
  const send = await fn.call('POST', `/api/chats/${chat.data.chat.id}/messages`, { token: member.data.token, json: { content: 'hello' } });
  assert.equal(send.status, 200);
  assert.match(send.data, /from the GPU host/);
  assert.deepEqual(inf.calls.at(-1), { auth: 'Bearer test-inference-key', model: 'nick-4.8@1.0.0', stream: true });

  // Admin registry view reports what the GPU host actually serves.
  const reg = await fn.call('GET', '/api/admin/registry', { token: owner.data.token });
  assert.equal(reg.data.source, 'inference');
  const regNick = reg.data.models.find((m) => m.id === 'nick-4.8');
  assert.equal(regNick.active_version, '1.0.0');
  assert.equal(regNick.versions[0].activatable, false, 'activation is managed on the GPU host, not here');
  assert.equal(reg.data.models.find((m) => m.id === 'hike-6.5').active_version, null, 'Hike is not served → no version claimed');

  // Registry writes belong to the GPU host in inference mode.
  const imp = await fn.call('POST', '/api/admin/registry/rescan', { token: owner.data.token, json: {} });
  assert.equal(imp.status, 409);
  assert.equal(imp.data.error.code, 'registry_managed_by_inference_server');

  // Uploads are stored in the database, not on the function's ephemeral disk.
  const up = await fn.call('POST', '/api/files', { token: member.data.token, raw: 'serverless notes', headers: { 'x-filename': 'n.txt' } });
  assert.equal(up.status, 201);
  const fileId = up.data.file.id;

  // Simulated cold start: a brand-new function instance sees all data.
  fn.stop();
  fn = await startFunction(env);
  const again = await fn.call('POST', '/api/auth/login', { json: { email: 'member@example.com', password: 'MemberPassw0rd!', client: 'mobile' } });
  assert.equal(again.status, 200);
  // Account notices still go through the configured mail adapter (Brevo): password change → notice email.
  assert.equal((await fn.call('POST', '/api/auth/change-password', { token: again.data.token, json: { current_password: 'MemberPassw0rd!', new_password: 'MemberPassw0rd2!' } })).status, 200);
  const notice = brevo.mails.at(-1);
  assert.equal(notice.apiKey, 'test-mail-key');
  assert.deepEqual(notice.payload.sender, { email: 'noreply@example.com', name: 'Approx AI' });
  assert.deepEqual(notice.payload.to, [{ email: 'member@example.com' }]);
  const hist = await fn.call('GET', `/api/chats/${chat.data.chat.id}`, { token: again.data.token });
  assert.equal(hist.status, 200);
  assert.ok(hist.data.messages.some((m) => m.role === 'assistant' && m.content.includes('from the GPU host')), 'chat history persisted');
  const dl = await fn.call('GET', `/api/files/${fileId}/download`, { token: again.data.token });
  assert.equal(dl.status, 200);
  assert.equal(dl.data, 'serverless notes');
  fn.stop();
});

test('serverless: Nick 4.8 not served or GPU unreachable → honest 503, never a substitute model', async () => {
  for (const [label, url, re] of [
    ['not serving', (await mockInference({})).url, /not being served|not available yet/],
    ['unreachable', 'http://127.0.0.1:9/v1', /offline|unreachable/],
  ]) {
    const dbFile = path.join(scratch, `down-${label.replace(' ', '')}.db`);
    const fn = await startFunction({ APPROX_ENV: 'test', APPROX_DB_URL: `file:${dbFile}`, APPROX_TEST_EPHEMERAL_DB: '1',
      APPROX_MODEL_NICK_URL: url, REQUIRE_VERIFIED_EMAIL: 'false' });
    await fn.call('POST', '/api/auth/signup', { json: { email: 'u@example.com', password: 'GoodPassw0rd!' } });
    supabase.confirm('u@example.com');
    const l = await fn.call('POST', '/api/auth/login', { json: { email: 'u@example.com', password: 'GoodPassw0rd!', client: 'mobile' } });
    const models = await fn.call('GET', '/api/models', { token: l.data.token });
    const nick = models.data.models.find((m) => m.id === 'nick-4.8');
    assert.equal(nick.active_version ?? null, null, `${label}: no version claimed`);
    const chat = await fn.call('POST', '/api/chats', { token: l.data.token, json: { model: 'nick-4.8' } });
    const send = await fn.call('POST', `/api/chats/${chat.data.chat.id}/messages`, { token: l.data.token, json: { content: 'hi' } });
    const text = typeof send.data === 'string' ? send.data : JSON.stringify(send.data);
    assert.match(text, /model_version_not_active/, `${label}: ${text.slice(0, 300)}`);
    assert.match(text, re, label);
    fn.stop();
  }
});

test('health reports a sanitized database error (no URL or token) when the database fails', async () => {
  // An unreachable remote libSQL URL: the driver fails at connect/initialise time, like a misconfigured Turso DB.
  const fn = await startFunction({ APPROX_ENV: 'test', APPROX_DB_URL: 'http://127.0.0.1:9', APPROX_DB_AUTH_TOKEN: 'eyJhbGciOiJFZERTQSJ9.eyJzZWNyZXQiOiJ5ZXMifQ.c2lnbmF0dXJlc2lnbmF0dXJl' });
  const h = await fn.call('GET', '/api/health');
  assert.equal(h.status, 503);
  assert.equal(h.data.database, 'error');
  assert.ok(h.data.database_error?.code, 'error code reported');
  const raw = JSON.stringify(h.data);
  assert.doesNotMatch(raw, /127\.0\.0\.1:9|eyJhbGci|c2lnbmF0dXJl/, 'no URL or token leaked');
  fn.stop();
});

// ---------- Gmail-style SMTP (implicit TLS on a local port, real SMTP protocol) ----------
import { SMTPServer } from 'smtp-server';
import { execFileSync } from 'node:child_process';
import { createClient } from '@libsql/client';

function selfSignedCert() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'approx-smtp-tls-'));
  const key = path.join(dir, 'key.pem'); const cert = path.join(dir, 'cert.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1',
    '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'], { stdio: 'ignore' });
  return { key: fs.readFileSync(key), cert: fs.readFileSync(cert), certPath: cert };
}

async function mockGmailSmtp({ user, pass }) {
  const tls = selfSignedCert();
  const mails = [];
  const srv = new SMTPServer({
    secure: true, key: tls.key, cert: tls.cert, authOptional: false, authMethods: ['PLAIN', 'LOGIN'],
    onAuth(auth, session, cb) {
      if (auth.username === user && auth.password === pass) return cb(null, { user });
      const e = new Error('Username and Password not accepted'); e.responseCode = 535; return cb(e);
    },
    onMailFrom(addr, session, cb) { session.envFrom = addr.address; cb(); },
    onData(stream, session, cb) {
      const c = []; stream.on('data', (d) => c.push(d));
      stream.on('end', () => { mails.push({ authUser: session.user, envFrom: session.envFrom, to: session.envelope.rcptTo.map((r) => r.address), raw: Buffer.concat(c).toString('utf8') }); cb(); });
    },
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  servers.push(srv.server);
  return { port: srv.server.address().port, mails, caPath: tls.certPath, close: () => srv.close() };
}

test('SMTP (Gmail App Password over implicit TLS): account notices delivered; secrets never exposed; delivery failure is honest', async () => {
  const OWNER = 'owner.approx@gmail.example';
  const APP_PASSWORD = 'abcd efgh ijkl mnop'; // shown by Google with spaces; the spaces are not part of it
  const smtp = await mockGmailSmtp({ user: OWNER, pass: 'abcdefghijklmnop' });
  const dbFile = path.join(scratch, 'smtp.db');
  const env = { APPROX_ENV: 'test', APPROX_DB_URL: `file:${dbFile}`, APPROX_TEST_EPHEMERAL_DB: '1',
    NODE_EXTRA_CA_CERTS: smtp.caPath, MAIL_TRANSPORT: 'smtp', MAIL_SMTP_HOST: 'localhost', MAIL_SMTP_PORT: String(smtp.port),
    MAIL_SMTP_PASS: APP_PASSWORD, APPROX_BOOTSTRAP_SUPERADMIN_EMAIL: OWNER };
  const fn = await startFunction(env);
  const h = await fn.call('GET', '/api/health');
  assert.equal(h.data.mail_transport, 'smtp');
  assert.equal(h.data.mail_configured, true);
  assert.equal(h.data.auth_provider, 'supabase');
  assert.equal(h.data.auth_configured, true);
  assert.doesNotMatch(JSON.stringify(h.data), /abcd|efgh|mnop|sb_publishable|sb_secret/, 'no secrets or keys in health');

  // Verification emails come from Supabase (not this SMTP account); the verified owner becomes superadmin.
  assert.equal((await fn.call('POST', '/api/auth/signup', { json: { email: OWNER, password: 'OwnerPassw0rd!' } })).status, 202);
  assert.equal(smtp.mails.length, 0, 'the backend no longer sends verification emails itself');
  assert.equal((await fn.call('POST', '/api/auth/verify-email', { json: { token: codeFor(OWNER) } })).status, 200);
  const login = await fn.call('POST', '/api/auth/login', { json: { email: OWNER, password: 'OwnerPassw0rd!', client: 'mobile' } });
  assert.equal(login.data.user.role, 'superadmin');
  // Password-change notice over SMTP.
  assert.equal((await fn.call('POST', '/api/auth/change-password', { token: login.data.token, json: { current_password: 'OwnerPassw0rd!', new_password: 'NewOwnerPassw0rd!' } })).status, 200);
  const v = smtp.mails.at(-1);
  assert.equal(v.authUser, OWNER, 'authenticated as the Gmail account');
  assert.equal(v.envFrom, OWNER, 'sent from the authenticated account');
  assert.deepEqual(v.to, [OWNER]);
  assert.match(v.raw, /^Subject: Your Approx AI password was changed/m);
  fn.stop();

  // Wrong App Password: the notice fails (recorded honestly) but the password change itself still succeeds.
  const bad = await startFunction({ ...env, MAIL_SMTP_PASS: 'wrong wrong wrong wrong' });
  const l2 = await bad.call('POST', '/api/auth/login', { json: { email: OWNER, password: 'NewOwnerPassw0rd!', client: 'mobile' } });
  assert.equal((await bad.call('POST', '/api/auth/change-password', { token: l2.data.token, json: { current_password: 'NewOwnerPassw0rd!', new_password: 'ThirdOwnerPassw0rd!' } })).status, 200);
  const db = createClient({ url: `file:${dbFile}` });
  const row = (await db.execute({ sql: 'SELECT status FROM mail_outbox WHERE to_email = ? ORDER BY created_at DESC LIMIT 1', args: [OWNER] })).rows[0];
  assert.equal(row.status, 'failed_smtp_535');
  db.close();
  bad.stop();
});

test('production without Supabase Auth configured: sign-up and sign-in refuse honestly; no account is created', async () => {
  const dbFile = path.join(scratch, 'noauth.db');
  // APPROX_ENV=production refuses a file database on serverless, so this uses the non-serverless server path (same handler).
  const p = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', `
    const { createServer } = await import(${JSON.stringify(path.join(here, '../src/server.js'))});
    const s = createServer(); s.listen(0, '127.0.0.1', () => console.log('PORT ' + s.address().port));`],
  { env: { PATH: process.env.PATH, HOME: process.env.HOME, APPROX_ENV: 'production', APPROX_DB_URL: `file:${dbFile}`,
    APPROX_PUBLIC_URL: 'https://approx.example', APPROX_TRUST_PROXY: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
  procs.push(p);
  let err = ''; p.stderr.on('data', (d) => { err += d; });
  const port = await new Promise((resolve, reject) => { let o = ''; p.stdout.on('data', (d) => { o += d; const m = /PORT (\d+)/.exec(o); if (m) resolve(m[1]); }); p.on('exit', (c) => reject(new Error(err))); });
  for (const route of ['/api/auth/signup', '/api/auth/login', '/api/auth/forgot-password']) {
    const r = await fetch(`http://127.0.0.1:${port}${route}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'x@gmail.example', password: 'GoodPassw0rd!x' }) });
    const body = await r.json();
    assert.equal(r.status, 503, route);
    assert.equal(body.error.code, 'auth_not_configured', route);
  }
  const h = await (await fetch(`http://127.0.0.1:${port}/api/health`)).json();
  assert.equal(h.auth_configured, false);
  const db = createClient({ url: `file:${dbFile}` });
  assert.equal((await db.execute("SELECT COUNT(*) n FROM users")).rows[0].n, 0, 'no account created');
  db.close();
  p.kill();
});

test('Vercel with "expose system environment variables" off: still detected as serverless', async () => {
  const fn = await startFunction({ VERCEL: '', AWS_LAMBDA_FUNCTION_NAME: 'approx-fn', APPROX_ENV: 'test',
    APPROX_DB_URL: `file:${path.join(scratch, 'hidden-sysvars.db')}`, APPROX_TEST_EPHEMERAL_DB: '1' });
  const h = await fn.call('GET', '/api/health');
  assert.equal(h.data.runtime, 'serverless');
  assert.equal(h.data.registry_source, 'inference');
  fn.stop();
});

// ---------- production redirect URLs for Supabase emails (verify / resend / reset) ----------
async function startProdServer(env) {
  const p = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', `
    const { createServer } = await import(${JSON.stringify(path.join(here, '../src/server.js'))});
    const s = createServer(); s.listen(0, '127.0.0.1', () => console.log('PORT ' + s.address().port));`],
  { env: { PATH: process.env.PATH, HOME: process.env.HOME, APPROX_ENV: 'production', ...SUPA_ENV, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  procs.push(p);
  let err = ''; p.stderr.on('data', (d) => { err += d; });
  const port = await new Promise((resolve, reject) => { let o = ''; p.stdout.on('data', (d) => { o += d; const m = /PORT (\d+)/.exec(o); if (m) resolve(m[1]); }); p.on('exit', () => reject(new Error(err))); });
  const call = async (method, pth, json) => { const r = await fetch(`http://127.0.0.1:${port}${pth}`, { method, headers: json ? { 'content-type': 'application/json' } : {}, body: json ? JSON.stringify(json) : undefined }); return { status: r.status, data: await r.json() }; };
  return { call, stop: () => p.kill() };
}

for (const [label, publicUrl, expected] of [
  ['APPROX_PUBLIC_URL unset', undefined, 'https://approx-ai.vercel.app'],
  ['APPROX_PUBLIC_URL=http://localhost:8080 (ignored in production)', 'http://localhost:8080', 'https://approx-ai.vercel.app'],
  ['APPROX_PUBLIC_URL=https://approx-ai.vercel.app/#/login (not an origin, ignored)', 'https://approx-ai.vercel.app/#/login', 'https://approx-ai.vercel.app'],
  ['APPROX_PUBLIC_URL=https://approx-ai.vercel.app', 'https://approx-ai.vercel.app', 'https://approx-ai.vercel.app'],
  ['APPROX_PUBLIC_URL=https://ai.approx.example', 'https://ai.approx.example', 'https://ai.approx.example'],
]) {
  test(`production (${label}): Supabase verify, resend and reset links return to ${expected}/?auth=callback, never localhost; they work`, async () => {
    const slug = `${label.length}-${label.replace(/[^a-z0-9]+/gi, '-').slice(-30)}`;   // unique per case
    const srv = await startProdServer({ APPROX_DB_URL: `file:${path.join(scratch, `links-${slug}.db`)}`, ...(publicUrl !== undefined ? { APPROX_PUBLIC_URL: publicUrl } : {}) });
    const h = await srv.call('GET', '/api/health');
    assert.equal(h.data.public_url, expected);
    assert.equal(h.data.auth_callback_url, `${expected}/?auth=callback`);
    const email = `person-${slug}@gmail.example`.toLowerCase();
    assert.equal((await srv.call('POST', '/api/auth/signup', { email, password: 'GoodPassw0rd!x' })).status, 202);
    assert.equal((await srv.call('POST', '/api/auth/resend-verification', { email })).status, 202);
    const sent = supabase.emails.filter((m) => m.to === email);
    assert.equal(sent.length, 2);
    for (const m of sent) {
      assert.equal(m.redirect_to, `${expected}/?auth=callback`);
      assert.doesNotMatch(m.redirect_to, /localhost|127\.0\.0\.1|0\.0\.0\.0/i, 'no local URL in production links');
    }
    // Clicking the resent link lands on the app with a session → the account is verified.
    const v = await supabase.click(sent[1].link);
    assert.equal(v.target, `${expected}/?auth=callback`);
    assert.equal((await srv.call('POST', '/api/auth/verify-email', { access_token: v.params.access_token })).status, 200);
    // Password reset link.
    assert.equal((await srv.call('POST', '/api/auth/forgot-password', { email })).status, 202);
    const reset = supabase.lastEmail(email, 'recovery');
    assert.equal(reset.redirect_to, `${expected}/?auth=callback`);
    const r = await supabase.click(reset.link);
    assert.equal((await srv.call('POST', '/api/auth/reset-password', { access_token: r.params.access_token, password: 'NewGoodPassw0rd!x' })).status, 200);
    assert.equal((await srv.call('POST', '/api/auth/login', { email, password: 'NewGoodPassw0rd!x', client: 'mobile' })).status, 200);
    srv.stop();
  });
}
