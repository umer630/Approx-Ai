// Platform tests: efficiency modes, model registry (import → verify → activate → serve), version selection,
// reload notification, compute jobs, media capability layer, health/status, and extra auth checks.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { req, makeUser, parseSse, db, close, BASE } from './helpers.js';
import { config } from '../src/config.js';
import * as registry from '../src/registry.js';

after(close);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'approx-art-'));
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

/** Builds a release tree <root>/<model>/versions/<version>/… and returns { root, dir, tar, tarSha }. */
function makeRelease({ model = 'nick-4.8', version = '1.0.0', status = 'validated', productionReady = false, smoke = false, base = 'Qwen/Qwen2.5-3B-Instruct',
  kind = 'language_model', extraFiles = {}, mutate = null, tamperAfterSums = null, sign = null } = {}) {
  const root = fs.mkdtempSync(path.join(tmp, 'rel-'));
  const dir = path.join(root, model, 'versions', version);
  fs.mkdirSync(path.join(dir, 'adapter'), { recursive: true });
  const weights = crypto.randomBytes(4096);
  fs.writeFileSync(path.join(dir, 'adapter/adapter_model.safetensors'), weights);
  fs.writeFileSync(path.join(dir, 'adapter/adapter_config.json'), JSON.stringify({ peft_type: 'LORA', r: 16 }));
  fs.writeFileSync(path.join(dir, 'adapter/tokenizer_config.json'), '{}');
  fs.writeFileSync(path.join(dir, 'metadata.json'), JSON.stringify({ model_id: model, version }));
  fs.writeFileSync(path.join(dir, 'evaluation.json'), JSON.stringify({ score: 91.5 }));
  const release = {
    schema: 'approx.release/v1', model_id: model, version, kind, status, production_ready: productionReady,
    blockers: productionReady ? [] : ['dataset is not production-ready'], base_model: base, base_model_revision: 'abc123',
    adapter_path: 'adapter', adapter_sha256: sha(weights), adapter_bytes: weights.length, smoke_test: smoke,
    dataset: { version: 'edu-1.0.0', fingerprint: 'f'.repeat(64), production_ready: productionReady },
    evaluation: { score: 91.5, target: 100, minimum: 85, gate_passed: productionReady },
    verification: { passed: status === 'validated', safety_passed: status === 'validated' }, created_at: new Date().toISOString(),
  };
  if (mutate) mutate(release);
  fs.writeFileSync(path.join(dir, 'release.json'), JSON.stringify(release, null, 2));
  for (const [name, content] of Object.entries(extraFiles)) { fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true }); fs.writeFileSync(path.join(dir, name), content); }
  const files = [];
  const walk = (d, rel) => { for (const n of fs.readdirSync(d).sort()) { const a = path.join(d, n); const r = rel ? `${rel}/${n}` : n; if (fs.statSync(a).isDirectory()) walk(a, r); else files.push(r); } };
  walk(dir, '');
  const sums = files.map((f) => `${sha(fs.readFileSync(path.join(dir, f)))}  ${f}\n`).join('');
  fs.writeFileSync(path.join(dir, 'SHA256SUMS'), sums);
  if (sign) fs.writeFileSync(path.join(dir, 'SIGNATURE'), crypto.createHmac('sha256', sign).update(sums).digest('hex') + '\n');
  if (tamperAfterSums) tamperAfterSums(dir);
  const tar = path.join(root, `${model}-${version}.tar.gz`);
  execFileSync('tar', ['-czf', tar, '-C', root, model]);
  return { root, dir, tar, tarSha: sha(fs.readFileSync(tar)), adapterSha: release.adapter_sha256 };
}

async function upload(tarFile, token, { shaHeader } = {}) {
  const body = fs.readFileSync(tarFile);
  const res = await fetch(`${BASE}/api/admin/registry/import`, { method: 'POST', body,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/gzip', 'x-artifact-sha256': shaHeader ?? sha(body) } });
  return { status: res.status, data: await res.json() };
}
async function superadmin() { const u = await makeUser(); await db.run("UPDATE users SET role = 'superadmin' WHERE id = ?", u.id); return u; }
async function resetRegistry() { fs.rmSync(config.registry.dir, { recursive: true, force: true }); await registry.scan({ force: true }); }

async function mockUpstream() {
  const seen = [];
  const server = http.createServer((rq, rs) => {
    if (rq.url === '/health') { rs.writeHead(200, { 'content-type': 'application/json' }); return rs.end(JSON.stringify({ status: 'ok', serving: { 'nick-4.8': '1.0.0' } })); }
    let b = ''; rq.on('data', (c) => { b += c; }); rq.on('end', () => {
      seen.push({ url: rq.url, auth: rq.headers.authorization, body: b ? JSON.parse(b) : null });
      if (rq.url === '/admin/reload') { rs.writeHead(200, { 'content-type': 'application/json' }); return rs.end(JSON.stringify({ serving: { 'nick-4.8': '1.0.0' } })); }
      rs.writeHead(200, { 'content-type': 'text/event-stream' });
      rs.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'real upstream text' } }] })}\n\n`);
      rs.end('data: [DONE]\n\n');
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { seen, url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
}

// ---------------------------------------------------------------- efficiency modes
test('efficiency modes: low/medium/high are separate from the model and change real inference parameters', async () => {
  const u = await makeUser();
  const m = await req('GET', '/api/models', { token: u.token });
  assert.deepEqual(m.data.modes, ['low', 'medium', 'high']);
  assert.deepEqual(m.data.mode_details.map((x) => x.label), ['Low', 'Medium', 'High']);
  assert.equal((await req('PATCH', '/api/settings', { token: u.token, body: { default_mode: 'low' } })).status, 200);
  assert.equal((await req('PATCH', '/api/settings', { token: u.token, body: { default_mode: 'turbo' } })).status, 400);
  assert.equal((await req('POST', '/api/chats', { token: u.token, body: { mode: 'nick-4.8' } })).status, 400, 'a model id is not a mode');

  const up = await mockUpstream();
  process.env.APPROX_MODEL_NICK_URL = `${up.url}/v1`; process.env.APPROX_MODEL_NICK_NAME = 'external-nick';
  try {
    const c = await req('POST', '/api/chats', { token: u.token, body: { model: 'nick-4.8' } });
    for (const [mode, tokens] of [['low', 384], ['medium', 1024], ['high', 4096]]) {
      const r = await req('POST', `/api/chats/${c.data.chat.id}/messages`, { token: u.token, body: { content: 'hi', model: 'nick-4.8', mode } });
      assert.equal(parseSse(r.data)[0].data.mode, mode);
      const sent = up.seen.at(-1).body;
      assert.equal(sent.max_tokens, tokens, `${mode} token budget reaches the backend`);
      assert.equal(sent.model, 'external-nick', 'the model is unchanged by the mode');
      assert.match(sent.messages[0].content, new RegExp(`Mode: ${mode.toUpperCase()}`));
      assert.equal(typeof sent.frequency_penalty, 'number');
    }
    assert.ok(up.seen.at(-3).body.temperature > up.seen.at(-1).body.temperature, 'high mode is more deterministic');
  } finally { delete process.env.APPROX_MODEL_NICK_URL; delete process.env.APPROX_MODEL_NICK_NAME; up.close(); }
});

test('database migration: an old database (medium/high CHECK) accepts "low" afterwards and keeps its rows', async () => {
  // Build a database in the PRE-1.1.0 format with libSQL (the engine the backend now uses).
  const { createClient } = await import('@libsql/client');
  const file = path.join(tmp, 'old.db');
  const old = createClient({ url: `file:${file}` });
  await old.executeMultiple(`CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE COLLATE NOCASE, password_hash TEXT NOT NULL, email_verified INTEGER NOT NULL DEFAULT 0,
      role TEXT NOT NULL DEFAULT 'user', plan TEXT NOT NULL DEFAULT 'free', failed_logins INTEGER NOT NULL DEFAULT 0, locked_until INTEGER, status TEXT NOT NULL DEFAULT 'active', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE settings (user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, default_model TEXT NOT NULL DEFAULT 'nick-4.8',
      default_mode TEXT NOT NULL DEFAULT 'medium' CHECK (default_mode IN ('medium','high')), memory_enabled INTEGER NOT NULL DEFAULT 1, training_opt_in INTEGER NOT NULL DEFAULT 0,
      notifications_email INTEGER NOT NULL DEFAULT 1, personalization TEXT NOT NULL DEFAULT '', theme TEXT NOT NULL DEFAULT 'dark');
    CREATE TABLE messages (id TEXT PRIMARY KEY, chat_id TEXT, user_id TEXT, role TEXT, content TEXT, model_id TEXT, mode TEXT, route_reason TEXT, attachments TEXT, status TEXT, tokens_in INTEGER, tokens_out INTEGER, created_at INTEGER);
    INSERT INTO users (id,email,password_hash,created_at,updated_at) VALUES ('u1','old@example.com','x',1,1);
    INSERT INTO settings (user_id, default_mode, personalization) VALUES ('u1','high','keep me');`);
  await assert.rejects(old.execute("UPDATE settings SET default_mode = 'low'"), /CHECK/);
  const before = (await old.execute('SELECT default_mode, personalization FROM settings')).rows[0];
  old.close();
  // Open it with the real backend db.js in a fresh process: schema + migrations run on first use.
  const out = execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', `
    const db = await import(${JSON.stringify(path.resolve('src/db.js'))});
    await db.run("UPDATE settings SET default_mode = 'low'");
    const cols = (await db.all('PRAGMA table_info(messages)')).map((c) => c.name);
    const kept = await db.one('SELECT personalization FROM settings');
    console.log(JSON.stringify({ after: await db.one('SELECT default_mode FROM settings'), kept, hasVersion: cols.includes('model_version'),
      models: (await db.one('SELECT COUNT(*) c FROM models')).c,
      migrations: (await db.all('SELECT id FROM schema_migrations ORDER BY id')).map((r) => r.id) }));
    db.close();`],
  { env: { ...process.env, APPROX_DB_URL: '', APPROX_DB_FILE: file }, encoding: 'utf8', input: '' });
  const r = JSON.parse(out.trim().split('\n').pop());
  assert.deepEqual({ default_mode: before.default_mode, personalization: before.personalization }, { default_mode: 'high', personalization: 'keep me' });
  assert.equal(r.after.default_mode, 'low', 'the rebuilt settings table accepts low');
  assert.equal(r.kept.personalization, 'keep me', 'existing rows survive the table rebuild');
  assert.equal(r.hasVersion, true);
  assert.equal(r.models, 5);
  assert.deepEqual(r.migrations, ['2026-11-model-version-columns', '2026-11-settings-low-mode']);
});

// ---------------------------------------------------------------- registry: happy path to real serving
test('registry: import → verify → discover → controlled activation → API serves that version', async () => {
  await resetRegistry();
  const sa = await superadmin();
  const u = await makeUser();
  const rel = makeRelease({ version: '1.0.0' });

  assert.equal((await upload(rel.tar, u.token)).status, 403, 'ordinary users cannot import');
  assert.equal((await upload(rel.tar, sa.token, { shaHeader: 'a'.repeat(64) })).data.error.code, 'sha256_mismatch');
  const imp = await upload(rel.tar, sa.token);
  assert.equal(imp.status, 201);
  assert.equal(imp.data.release.status, 'validated');
  assert.equal(imp.data.release.verified, true);
  assert.equal(imp.data.active_version, null, 'import never activates');
  assert.equal((await upload(rel.tar, sa.token)).data.status, 'already_imported', 'idempotent');

  // discoverable, SHA-256 metadata consistent
  const reg = await req('GET', '/api/admin/registry', { token: sa.token });
  const nick = reg.data.models.find((m) => m.id === 'nick-4.8');
  assert.equal(nick.versions[0].version, '1.0.0');
  assert.equal(nick.versions[0].adapter_sha256, rel.adapterSha);
  assert.equal(nick.versions[0].adapter_sha256, sha(fs.readFileSync(path.join(config.registry.dir, 'nick-4.8/versions/1.0.0/adapter/adapter_model.safetensors'))));
  assert.equal((await db.one("SELECT adapter_sha256, artifact_uri FROM model_releases WHERE model_id = 'nick-4.8' AND version = '1.0.0'")).adapter_sha256, rel.adapterSha);
  const detail = await req('GET', '/api/admin/registry/nick-4.8/1.0.0', { token: sa.token });
  assert.equal(detail.data.evaluation.score, 91.5);

  // managed upstream without an active version → explicit 503, nothing fabricated
  const up = await mockUpstream();
  process.env.APPROX_MODEL_NICK_URL = `${up.url}/v1`;
  config.registry.inferenceAdminUrl = up.url; config.registry.inferenceAdminKey = 'adm';
  try {
    const k = await req('POST', '/api/developer/keys', { token: u.token, body: { name: 'k', scopes: ['chat', 'models:read'] } });
    const key = k.data.secret;
    const chat = (b) => req('POST', '/api/v1/chat/completions', { token: key, body: { model: 'nick-4.8', messages: [{ role: 'user', content: 'hi' }], ...b } });
    const none = await chat({});
    assert.equal(none.status, 503);
    assert.equal(none.data.error.code, 'model_version_not_active');

    // activation: superadmin only; not production-ready needs an explicit override
    const act = (token, body) => req('POST', '/api/admin/registry/activate', { token, body: { model_id: 'nick-4.8', version: '1.0.0', ...body } });
    assert.equal((await act(u.token, {})).status, 403);
    const blocked = await act(sa.token, {});
    assert.equal(blocked.status, 409);
    assert.equal(blocked.data.error.code, 'not_production_ready');
    assert.deepEqual(blocked.data.error.blockers, ['dataset is not production-ready']);
    const ok = await act(sa.token, { allow_non_production: true, reason: 'pipeline validation' });
    assert.equal(ok.status, 200);
    assert.equal(ok.data.inference.status, 'reloaded', 'inference server was told to reload');
    assert.equal(up.seen.find((s) => s.url === '/admin/reload').auth, 'Bearer adm');
    const activeFile = JSON.parse(fs.readFileSync(path.join(config.registry.dir, 'active.json'), 'utf8'));
    assert.equal(activeFile.active['nick-4.8'].version, '1.0.0');
    assert.equal(activeFile.active['nick-4.8'].adapter_sha256, rel.adapterSha);
    assert.ok((await db.one("SELECT COUNT(*) c FROM audit_logs WHERE action = 'registry.activated' AND target = 'nick-4.8@1.0.0'")).c === 1, 'activation is audited');

    // the API now serves the registry version
    const served = await chat({});
    assert.equal(served.status, 200);
    assert.equal(served.data.model_version, '1.0.0');
    assert.equal(served.data.choices[0].message.content, 'real upstream text');
    assert.equal(up.seen.at(-1).body.model, 'nick-4.8@1.0.0');
    assert.equal((await chat({ version: '1.0.0' })).status, 200);
    assert.equal((await chat({ version: '9.9.9' })).data.error.code, 'unknown_model_version');
    assert.equal((await chat({ version: 'latest' })).data.error.code, 'invalid_version');
    assert.equal((await req('POST', '/api/v1/chat/completions', { token: key, body: { version: '1.0.0', messages: [{ role: 'user', content: 'hi' }] } })).data.error.code, 'version_requires_model');
    const models = await req('GET', '/api/v1/models', { token: key });
    const pub = models.data.data.find((m) => m.id === 'nick-4.8');
    assert.deepEqual([pub.active_version, pub.backend, pub.kind], ['1.0.0', 'active', 'language_model']);
    const one = await req('GET', '/api/v1/models/nick-4.8', { token: key });
    assert.deepEqual(one.data.versions, ['1.0.0']);
    assert.equal((await req('GET', '/api/v1/models/fab-500x', { token: key })).status, 403);
    assert.equal((await req('GET', '/api/v1/models/nope', { token: key })).status, 404);
    assert.equal((await db.one('SELECT model_version FROM api_requests WHERE user_id = ? AND status = 200 ORDER BY created_at DESC', u.id)).model_version, '1.0.0');

    // second version: existing but not active → 409; activation switches; versions are immutable
    const v2 = makeRelease({ version: '1.1.0', productionReady: true });
    assert.equal((await upload(v2.tar, sa.token)).status, 201);
    assert.equal((await chat({ version: '1.1.0' })).data.error.code, 'model_version_not_active');
    const sw = await req('POST', '/api/admin/registry/activate', { token: sa.token, body: { model_id: 'nick-4.8', version: '1.1.0' } });
    assert.equal(sw.status, 200, 'production-ready release needs no override');
    assert.equal(sw.data.previous_version, '1.0.0');
    assert.equal((await chat({})).data.model_version, '1.1.0');
    const clash = makeRelease({ version: '1.1.0' });
    assert.equal((await upload(clash.tar, sa.token)).data.error.code, 'version_exists');

    // status endpoint reflects it
    const st = await req('GET', '/api/status', { token: u.token });
    const sm = st.data.models.find((m) => m.id === 'nick-4.8');
    assert.deepEqual([sm.active_version, sm.production_ready, sm.backend], ['1.1.0', true, 'active']);
    assert.equal(st.data.gpu, undefined, 'GPU/worker details are admin-only');
    assert.equal(st.data.inference.nick.reachable, true);

    // tampering with the live artifact takes the model offline (fail closed) and raises a security event
    fs.appendFileSync(path.join(config.registry.dir, 'nick-4.8/versions/1.1.0/adapter/adapter_model.safetensors'), 'x');
    await registry.scan({ force: true });
    const off = await chat({});
    assert.equal(off.status, 503);
    assert.match(off.data.error.message, /offline/);
    assert.ok((await db.one("SELECT COUNT(*) c FROM security_events WHERE kind = 'registry_active_invalid'")).c >= 1);

    // deactivate
    const de = await req('POST', '/api/admin/registry/deactivate', { token: sa.token, body: { model_id: 'nick-4.8' } });
    assert.equal(de.status, 200);
    assert.equal((await chat({})).data.error.code, 'model_version_not_active');
  } finally {
    delete process.env.APPROX_MODEL_NICK_URL; config.registry.inferenceAdminUrl = ''; config.registry.inferenceAdminKey = ''; up.close();
  }
});

test('registry: unsafe, unverified, failed, smoke and wrong-base artifacts are rejected or never activatable', async () => {
  await resetRegistry();
  const sa = await superadmin();
  const bad = async (opts, code = 'invalid_artifact') => {
    const r = await upload(makeRelease(opts).tar, sa.token);
    assert.equal(r.status >= 400, true, JSON.stringify(opts));
    assert.equal(r.data.error.code, code);
    return r.data.error;
  };
  await bad({ extraFiles: { 'adapter/adapter_model.bin': 'pickle' } });                 // pickle weights
  await bad({ extraFiles: { 'adapter/hook.py': 'import os' } });                         // code file
  await bad({ tamperAfterSums: (d) => fs.appendFileSync(path.join(d, 'adapter/adapter_config.json'), ' ') });   // SHA mismatch
  await bad({ tamperAfterSums: (d) => fs.writeFileSync(path.join(d, 'adapter/extra.json'), '{}') });            // unlisted file
  await bad({ tamperAfterSums: (d) => fs.rmSync(path.join(d, 'SHA256SUMS')) });                                 // no sums
  await bad({ base: 'google/gemma-2b' });                                                // wrong base model for Nick
  await bad({ mutate: (r) => { r.adapter_sha256 = 'b'.repeat(64); } });                  // manifest hash lie
  await bad({ mutate: (r) => { r.production_ready = true; } });                          // production flag without evidence
  await bad({ mutate: (r) => { r.model_id = 'hike-6.5'; } });                            // manifest/model mismatch
  await bad({ kind: 'video_pipeline' });                                                 // kind must match the catalog
  await bad({ model: 'not-a-model' });                                                   // unknown model
  await bad({ tamperAfterSums: (d) => fs.symlinkSync('/etc/passwd', path.join(d, 'adapter/link.json')) });      // symlink
  // path traversal archive
  const evil = path.join(tmp, 'evil.tar.gz');
  const er = fs.mkdtempSync(path.join(tmp, 'evil-'));
  fs.mkdirSync(path.join(er, 'a'), { recursive: true }); fs.writeFileSync(path.join(er, 'pwn.json'), '{}');
  execFileSync('tar', ['-czf', evil, '-C', path.join(er, 'a'), '--transform', 's,^,../../,', '-P', '../pwn.json']);
  assert.equal((await upload(evil, sa.token)).data.error.code, 'invalid_artifact');
  assert.equal((await upload(path.resolve('package.json'), sa.token)).data.error.code, 'invalid_artifact', 'not a tar.gz');
  assert.equal(fs.existsSync(path.join(config.registry.dir, 'nick-4.8')), false, 'nothing rejected was installed');
  assert.deepEqual(fs.readdirSync(path.join(config.registry.dir, '.incoming')), [], 'staging is cleaned up');

  // failed + smoke releases import (for inspection) but can never be activated
  assert.equal((await upload(makeRelease({ version: '0.9.0', status: 'failed' }).tar, sa.token)).status, 201);
  assert.equal((await upload(makeRelease({ version: '0.0.1', status: 'smoke_test', smoke: true, base: '/tmp/tiny' }).tar, sa.token)).status, 201);
  for (const version of ['0.9.0', '0.0.1']) {
    const a = await req('POST', '/api/admin/registry/activate', { token: sa.token, body: { model_id: 'nick-4.8', version, allow_non_production: true } });
    assert.equal(a.status, 409);
    assert.equal(a.data.error.code, 'version_not_activatable');
  }
  assert.equal(registry.getActive('nick-4.8'), null);
  // smoke artifacts become activatable only when explicitly allowed outside production (integration tests)
  config.registry.allowSmoke = true;
  try {
    const a = await req('POST', '/api/admin/registry/activate', { token: sa.token, body: { model_id: 'nick-4.8', version: '0.0.1', allow_non_production: true } });
    assert.equal(a.status, 200);
  } finally { config.registry.allowSmoke = false; }
  await registry.scan({ force: true });
  assert.equal(registry.getActive('nick-4.8'), null, 'a smoke version left active is refused again once smoke is disallowed');
});

test('registry: signing key and automatic activation policy', async () => {
  await resetRegistry();
  const sa = await superadmin();
  config.registry.signingKey = 'shared-secret';
  try {
    assert.match((await upload(makeRelease({ version: '2.0.0' }).tar, sa.token)).data.error.message, /not signed/);
    assert.match((await upload(makeRelease({ version: '2.0.0', sign: 'wrong' }).tar, sa.token)).data.error.message, /SIGNATURE/);
    const ok = await upload(makeRelease({ version: '2.0.0', sign: 'shared-secret' }).tar, sa.token);
    assert.equal(ok.status, 201);
    assert.equal(ok.data.release.signed, true);
  } finally { config.registry.signingKey = ''; }

  await resetRegistry();
  config.registry.autoActivate = 'production';
  try {
    await upload(makeRelease({ version: '1.0.0' }).tar, sa.token);                      // validated, not production-ready
    assert.equal(registry.getActive('nick-4.8'), null, 'policy "production" ignores non-production releases');
    await upload(makeRelease({ version: '1.2.0', productionReady: true }).tar, sa.token);
    assert.equal(registry.getActive('nick-4.8').version, '1.2.0');
    assert.equal(registry.getActive('nick-4.8').activated_by, 'auto-policy');
    await upload(makeRelease({ version: '1.1.0', productionReady: true }).tar, sa.token);
    assert.equal(registry.getActive('nick-4.8').version, '1.2.0', 'never downgrades');
    await upload(makeRelease({ version: '1.3.0', status: 'failed' }).tar, sa.token);
    assert.equal(registry.getActive('nick-4.8').version, '1.2.0', 'never activates a failed release');
    assert.ok((await db.one("SELECT COUNT(*) c FROM audit_logs WHERE action = 'registry.activated' AND actor = 'auto-policy'")).c >= 1);
  } finally { config.registry.autoActivate = 'off'; }
});

test('registry import with an admin API key (training pipeline) and privileged-scope rules', async () => {
  await resetRegistry();
  const sa = await superadmin();
  const u = await makeUser();
  assert.equal((await req('POST', '/api/developer/keys', { token: u.token, body: { name: 'x', scopes: ['registry:import'] } })).status, 400, 'users cannot mint privileged scopes');
  const k = await req('POST', '/api/developer/keys', { token: sa.token, body: { name: 'pipeline', scopes: ['registry:import', 'training:worker'] } });
  assert.equal(k.status, 201);
  const plain = await req('POST', '/api/developer/keys', { token: sa.token, body: { name: 'plain', scopes: ['chat'] } });
  const rel = makeRelease({ version: '3.0.0' });
  assert.equal((await upload(rel.tar, plain.data.secret)).data.error.code, 'insufficient_scope');
  assert.equal((await upload(rel.tar, k.data.secret)).status, 201);
  await db.run("UPDATE users SET role = 'user' WHERE id = ?", sa.id);   // demoted owner → key loses the capability at once
  assert.equal((await upload(makeRelease({ version: '3.0.1' }).tar, k.data.secret)).status, 403);
});

// ---------------------------------------------------------------- compute control plane
test('compute: admin starts/stops jobs; a GPU worker claims, reports progress and finishes', async () => {
  const sa = await superadmin();
  const u = await makeUser();
  assert.equal((await req('GET', '/api/admin/compute', { token: u.token })).status, 403);
  assert.equal((await req('POST', '/api/admin/compute/jobs', { token: u.token, body: {} })).status, 403);
  assert.equal((await req('POST', '/api/admin/compute/jobs', { token: sa.token, body: { models: ['fab-100x'] } })).status, 400, 'no training config for fab-100x');
  const j = await req('POST', '/api/admin/compute/jobs', { token: sa.token, body: { models: ['nick-4.8', 'hike-6.5'], max_hours: 2 } });
  assert.equal(j.status, 201);
  assert.equal(j.data.workers_online, 0);
  assert.match(j.data.note, /No GPU worker is online/);

  const key = (await req('POST', '/api/developer/keys', { token: sa.token, body: { name: 'colab', scopes: ['training:worker'] } })).data.secret;
  const userKey = (await req('POST', '/api/developer/keys', { token: u.token, body: { name: 'u', scopes: ['chat'] } })).data.secret;
  const worker = { id: 'colab-t4-abc', name: 'Colab T4', gpu: { name: 'Tesla T4', vram_gb: 15.6 }, runtime: { torch: '2.5' } };
  assert.equal((await req('POST', '/api/v1/worker/claim', { token: userKey, body: { worker } })).status, 403);
  const c = await req('POST', '/api/v1/worker/claim', { token: key, body: { worker } });
  assert.equal(c.data.job.id, j.data.job.id);
  assert.equal(c.data.job.status, 'running');
  assert.equal((await req('POST', '/api/v1/worker/claim', { token: key, body: { worker } })).data.job, null, 'nothing else queued');

  const rep = (body) => req('POST', `/api/v1/worker/jobs/${j.data.job.id}/report`, { token: key, body: { worker, ...body } });
  const r1 = await rep({ phase: 'nick-4.8: training', progress: { 'nick-4.8': { step: 3, max_steps: 100, loss: 1.9 } }, log_append: 'step 3 loss 1.9\n' });
  assert.equal(r1.data.stop_requested, false);
  assert.equal((await req('POST', `/api/v1/worker/jobs/${j.data.job.id}/report`, { token: key, body: { worker: { ...worker, id: 'other-worker' }, phase: 'x' } })).status, 403);

  const st = await req('GET', '/api/status', { token: sa.token });
  // both authorised workers have sent a heartbeat (the second one was only refused access to a job it does not own)
  assert.equal(st.data.gpu.workers_online, 2);
  const mine = st.data.gpu.workers.find((w) => w.id === 'colab-t4-abc');
  assert.equal(mine.gpu.name, 'Tesla T4');
  assert.equal(mine.current_job_id, j.data.job.id);
  assert.equal(st.data.gpu.workers.find((w) => w.id === 'other-worker').current_job_id ?? null, null);
  assert.equal(st.data.training.active_job.phase, 'nick-4.8: training');
  const view = await req('GET', `/api/admin/compute/jobs/${j.data.job.id}`, { token: sa.token });
  assert.match(view.data.job.log_tail, /step 3 loss 1.9/);

  assert.equal((await req('POST', `/api/admin/compute/jobs/${j.data.job.id}/stop`, { token: sa.token })).data.job.status, 'stop_requested');
  assert.equal((await rep({ phase: 'stopping' })).data.stop_requested, true, 'worker learns it must stop');
  assert.equal((await rep({ status: 'stopped', results: { 'nick-4.8': { status: 'stopped' } } })).data.status, 'stopped');
  assert.equal((await rep({ phase: 'late' })).status, 409, 'finished jobs accept no more reports');
  assert.equal((await req('POST', `/api/admin/compute/jobs/${j.data.job.id}/stop`, { token: sa.token })).status, 409);

  // a run started by hand on the GPU machine registers itself
  const self = await req('POST', '/api/v1/worker/jobs', { token: key, body: { worker, models: ['nick-4.8'] } });
  assert.equal(self.status, 201);
  assert.equal(self.data.job.options.self_started, true);
  // queued job can be cancelled before any worker takes it
  const q = await req('POST', '/api/admin/compute/jobs', { token: sa.token, body: { models: 'all' } });
  assert.deepEqual(q.data.job.models, ['nick-4.8', 'hike-6.5', 'sona-9.0', 'fab-500x']);
  assert.equal((await req('POST', `/api/admin/compute/jobs/${q.data.job.id}/stop`, { token: sa.token })).data.job.status, 'stopped');
});

// ---------------------------------------------------------------- media capability layer
test('media: video generation is unavailable until a real pipeline is connected; storyboard is text planning', async () => {
  const sa = await superadmin();
  const u = await makeUser();
  const caps = await req('GET', '/api/capabilities', { token: sa.token });
  const fab = caps.data.models.find((m) => m.id === 'fab-500x');
  assert.equal(fab.kind, 'code_model');
  assert.deepEqual(caps.data.pipelines.map((p) => [p.id, p.kind, p.status]), [
    ['video-generation', 'video_pipeline', 'not_connected'], ['video-understanding', 'multimodal_model', 'not_connected'],
    ['image-understanding', 'multimodal_model', 'not_connected'], ['audio', 'multimodal_model', 'not_connected']]);
  assert.equal(caps.data.models.find((m) => m.id === 'nick-4.8').kind, 'language_model');

  const gen = (token, body) => req('POST', '/api/v1/media/video/generations', { token, body: { prompt: 'a sunrise over Hunza valley', ...body } });
  assert.equal((await gen(u.token, {})).status, 403, 'FAB access is required');
  assert.equal((await gen(sa.token, { model: 'nick-4.8' })).data.error.code, 'capability_not_supported');
  const off = await gen(sa.token, {});
  assert.equal(off.status, 501);
  assert.equal(off.data.error.code, 'capability_unavailable');
  assert.equal((await req('POST', '/api/v1/media/video/understanding', { token: sa.token, body: { question: 'what happens?', video_url: 'https://example.com/v.mp4' } })).status, 501);

  // connect a (mock) pipeline: the request is forwarded with the documented contract
  let got = null;
  const pipe = http.createServer((rq, rs) => { let b = ''; rq.on('data', (c) => { b += c; }); rq.on('end', () => { got = { url: rq.url, auth: rq.headers.authorization, body: JSON.parse(b) }; rs.writeHead(200, { 'content-type': 'application/json' }); rs.end(JSON.stringify({ job_id: 'vid_1', status: 'queued' })); }); });
  await new Promise((r) => pipe.listen(0, '127.0.0.1', r));
  process.env.APPROX_VIDEO_PIPELINE_URL = `http://127.0.0.1:${pipe.address().port}`; process.env.APPROX_VIDEO_PIPELINE_KEY = 'vk';
  try {
    const on = await gen(sa.token, { duration_s: 8, aspect_ratio: '9:16' });
    assert.equal(on.status, 202);
    assert.deepEqual([on.data.kind, on.data.task, on.data.result.job_id], ['video_pipeline', 'text-to-video', 'vid_1']);
    assert.deepEqual([got.url, got.auth, got.body.duration_s, got.body.aspect_ratio], ['/v1/text-to-video', 'Bearer vk', 8, '9:16']);
  } finally { delete process.env.APPROX_VIDEO_PIPELINE_URL; delete process.env.APPROX_VIDEO_PIPELINE_KEY; pipe.close(); }

  const sb = await req('POST', '/api/v1/media/storyboard', { token: sa.token, body: { brief: 'A 20 second ad for a school science fair', scenes: 2 } });
  assert.equal(sb.status, 200);
  assert.equal(sb.data.kind, 'storyboard_plan');
  assert.ok(Array.isArray(sb.data.storyboard.scenes));
  assert.equal(sb.data.video_generation.status, 'not_connected', 'the plan never claims a rendered video');
  assert.equal((await req('POST', '/api/v1/media/storyboard', { token: sa.token, body: { brief: 'x'.repeat(10), model: 'nick-4.8' } })).data.error.code, 'capability_not_supported');
});

// ---------------------------------------------------------------- health, validation, auth
test('health/status endpoints, unauthorized access, malformed and oversized input', async () => {
  for (const p of ['/api/health', '/api/v1/health', '/healthz']) assert.equal((await req('GET', p)).status, 200);
  const h = await req('GET', '/api/health');
  assert.deepEqual([h.data.status, h.data.database], ['ok', 'ok']);
  assert.equal(JSON.stringify(h.data).includes('secret'), false);
  for (const p of ['/api/status', '/api/capabilities', '/api/admin/registry', '/api/admin/compute', '/api/v1/models', '/api/v1/models/nick-4.8']) {
    assert.equal((await req('GET', p)).status, 401, p);
  }
  assert.equal((await req('POST', '/api/v1/chat/completions', { body: { messages: [{ role: 'user', content: 'hi' }] } })).status, 401);
  assert.equal((await req('POST', '/api/v1/chat/completions', { token: 'apx_not-a-real-key', body: { messages: [] } })).status, 401);

  const u = await makeUser();
  const key = (await req('POST', '/api/developer/keys', { token: u.token, body: { name: 'k', scopes: ['chat'] } })).data.secret;
  const post = (body, headers = { 'content-type': 'application/json' }) => fetch(`${BASE}/api/v1/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${key}`, ...headers }, body });
  assert.equal((await post('{not json')).status, 400);
  assert.equal((await post('[]')).status, 400);
  assert.equal((await post(JSON.stringify({ messages: [{ role: 'user', content: 'x' }] }), { 'content-type': 'text/plain' })).status, 400);
  assert.equal((await post(JSON.stringify({ messages: [{ role: 'user', content: 'x'.repeat(1100 * 1024) }] }))).status, 413, 'oversized body');
  const bad = async (body) => (await (await post(JSON.stringify(body))).json()).error.code;
  assert.equal(await bad({ messages: 'hi' }), 'invalid_request');
  assert.equal(await bad({ messages: [{ role: 'robot', content: 'x' }] }), 'invalid_request');
  assert.equal(await bad({ messages: [{ role: 'user', content: 'x' }], mode: 'ultra' }), 'invalid_request');
  assert.equal(await bad({ messages: [{ role: 'user', content: 'x' }], model: 'gpt-4' }), 'unknown_model');
  assert.equal(await bad({ messages: [{ role: 'user', content: 'x' }], stream: 'yes' }), 'invalid_request');
  assert.equal(await bad({ messages: [{ role: 'user', content: 'x'.repeat(100_001) }] }), 'invalid_request');
  const ok = await (await post(JSON.stringify({ model: 'nick-4.8', mode: 'low', messages: [{ role: 'user', content: 'hi' }] }))).json();
  assert.deepEqual([ok.model, ok.mode, ok.object], ['nick-4.8', 'low', 'chat.completion']);
});

test('API rate limiting returns 429 with Retry-After', async () => {
  const u = await makeUser();
  const key = (await req('POST', '/api/developer/keys', { token: u.token, body: { name: 'k', scopes: ['models:read', 'chat'] } })).data.secret;
  await db.run('INSERT INTO rate_buckets (key, count, reset_at) VALUES (?,?,?)', `api-burst:${u.id}`, 60, Date.now() + 60_000);
  const r = await req('POST', '/api/v1/chat/completions', { token: key, body: { messages: [{ role: 'user', content: 'hi' }] } });
  assert.equal(r.status, 429);
  assert.equal(r.data.error.code, 'rate_limited');
  assert.ok(Number(r.headers.get('retry-after')) > 0);
});

test('sessions: logout revokes, expired sessions are rejected, admin routes need the role', async () => {
  const u = await makeUser();
  assert.equal((await req('GET', '/api/auth/me', { token: u.token })).status, 200);
  for (const p of ['/api/admin/users', '/api/admin/audit', '/api/admin/registry', '/api/admin/training']) assert.equal((await req('GET', p, { token: u.token })).status, 403, p);
  await db.run('UPDATE sessions SET expires_at = ? WHERE user_id = ?', Date.now() - 1000, u.id);
  assert.equal((await req('GET', '/api/auth/me', { token: u.token })).status, 401, 'expired session');
  const l = await req('POST', '/api/auth/login', { body: { email: u.email, password: u.password, client: 'mobile' } });
  assert.equal((await req('POST', '/api/auth/logout', { token: l.data.token, body: {} })).status, 200);
  assert.equal((await req('GET', '/api/auth/me', { token: l.data.token })).status, 401, 'logged-out session');
  await db.run("UPDATE users SET status = 'suspended' WHERE id = ?", u.id);
  assert.equal((await req('POST', '/api/auth/login', { body: { email: u.email, password: u.password } })).status, 401, 'suspended account');
});
