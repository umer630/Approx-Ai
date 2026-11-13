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

const here = path.dirname(fileURLToPath(import.meta.url));
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'approx-vercel-'));
const procs = [];
const servers = [];
after(() => { for (const p of procs) p.kill(); for (const s of servers) { s.close(); s.closeAllConnections?.(); } });

// ---------- mock services ----------
async function listen(handler) {
  const s = http.createServer(handler);
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  servers.push(s);
  return `http://127.0.0.1:${s.address().port}`;
}
async function body(req) { const c = []; for await (const x of req) c.push(x); return Buffer.concat(c).toString('utf8'); }

/** Mock GPU inference server (inference/server.py contract): /health reports what it serves; streams OpenAI SSE. */
async function mockInference(serving) {
  const calls = [];
  const url = await listen(async (req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ status: 'ok', serving, gpu: null }));
    }
    if (req.method === 'POST' && req.url === '/v1/chat/completions') {
      const b = JSON.parse(await body(req));
      calls.push({ auth: req.headers.authorization, model: b.model });
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
const BASE_ENV = { PATH: process.env.PATH, HOME: process.env.HOME, NODE_OPTIONS: '', VERCEL: '1' };
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

const codeFrom = (mail) => /Verification code: (\S+)/.exec(mail.payload.textContent)?.[1];

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

  // Signup → verification mail through Brevo → verify → bootstrap superadmin.
  assert.equal((await fn.call('POST', '/api/auth/signup', { json: { email: 'owner@example.com', password: 'OwnerPassw0rd!' } })).status, 202);
  assert.equal(brevo.mails.length, 1);
  assert.equal(brevo.mails[0].apiKey, 'test-mail-key');
  assert.deepEqual(brevo.mails[0].payload.sender, { email: 'noreply@example.com', name: 'Approx AI' });
  assert.deepEqual(brevo.mails[0].payload.to, [{ email: 'owner@example.com' }]);
  const unverified = await fn.call('POST', '/api/auth/login', { json: { email: 'owner@example.com', password: 'OwnerPassw0rd!', client: 'mobile' } });
  assert.notEqual(unverified.data.user?.role, 'superadmin', 'no promotion before the email is verified');
  assert.equal((await fn.call('POST', '/api/auth/verify-email', { json: { token: codeFrom(brevo.mails[0]) } })).status, 200);
  const owner = await fn.call('POST', '/api/auth/login', { json: { email: 'owner@example.com', password: 'OwnerPassw0rd!', client: 'mobile' } });
  assert.equal(owner.status, 200);
  assert.equal(owner.data.user.role, 'superadmin');

  // A second verified account is a normal user (bootstrap is one-time and email-bound).
  await fn.call('POST', '/api/auth/signup', { json: { email: 'member@example.com', password: 'MemberPassw0rd!' } });
  await fn.call('POST', '/api/auth/verify-email', { json: { token: codeFrom(brevo.mails.at(-1)) } });
  const member = await fn.call('POST', '/api/auth/login', { json: { email: 'member@example.com', password: 'MemberPassw0rd!', client: 'mobile' } });
  assert.equal(member.data.user.role, 'user');

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
  assert.deepEqual(inf.calls.at(-1), { auth: 'Bearer test-inference-key', model: 'nick-4.8@1.0.0' });

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
    ['not serving', (await mockInference({})).url, /not being served/],
    ['unreachable', 'http://127.0.0.1:9/v1', /offline|unreachable/],
  ]) {
    const dbFile = path.join(scratch, `down-${label.replace(' ', '')}.db`);
    const fn = await startFunction({ APPROX_ENV: 'test', APPROX_DB_URL: `file:${dbFile}`, APPROX_TEST_EPHEMERAL_DB: '1',
      APPROX_MODEL_NICK_URL: url, REQUIRE_VERIFIED_EMAIL: 'false' });
    await fn.call('POST', '/api/auth/signup', { json: { email: 'u@example.com', password: 'GoodPassw0rd!' } });
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
