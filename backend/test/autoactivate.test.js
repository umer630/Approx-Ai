// Training → lifecycle → automatic activation, end to end across both languages:
// the real Python publisher (training/engine/publisher.py) reports a finished release to this backend over HTTP with a
// worker API key; the backend activates the model only after its own deployment check against the (mock) GPU host.
// The GPU host is a local stand-in speaking the inference/server.py contract — not a real model.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execFileP = promisify(execFile);

const SHA = 'b'.repeat(64);
const gpu = { serving: {} };
const srv = http.createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c);
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ status: 'ok', serving: Object.fromEntries(Object.entries(gpu.serving).map(([m, s]) => [m, s.version])),
      details: Object.fromEntries(Object.entries(gpu.serving).map(([m, s]) => [m, { version: s.version, adapter_sha256: s.sha, production_ready: true, smoke_test: false }])) }));
  }
  const b = JSON.parse(Buffer.concat(chunks).toString() || '{}');
  if (b.stream === false) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ choices: [{ message: { content: `Ready (${b.model}).` } }] })); }
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: `Hello from ${b.model}` } }] })}\n\n`); res.end('data: [DONE]\n\n');
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
process.env.APPROX_REGISTRY_SOURCE = 'inference';
process.env.APPROX_MODEL_DEFAULT_URL = `http://127.0.0.1:${srv.address().port}/v1`;
process.env.APPROX_DEV_PROVIDER = '0';
const { req, db, makeUser, close, asAdmin, BASE, parseSse } = await import('./helpers.js');
after(() => { srv.close(); close(); });
const wait = () => new Promise((r) => setTimeout(r, 10_500));   // inference health is cached 10 s
const TRAINING = path.resolve('../training');

function release({ version, productionReady = true, verified = true, model = 'hike-6.5', base = 'Qwen/Qwen2.5-7B-Instruct' }) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'rel-'));
  fs.mkdirSync(path.join(d, 'adapter'));
  fs.writeFileSync(path.join(d, 'release.json'), JSON.stringify({ model_id: model, version, status: productionReady ? 'validated' : 'failed', smoke_test: false,
    production_ready: productionReady, blockers: productionReady ? [] : ['evaluation gate: mathematics — below target'], base_model: base,
    base_model_revision: 'a09a35458c702b33eeacc393d103063234e8bc28', adapter_sha256: SHA, verification: { passed: verified, safety_passed: true } }));
  fs.writeFileSync(path.join(d, 'adapter', 'verification.json'), JSON.stringify({ verification_passed: verified, base_model: base,
    adapter_model_safetensors: { sha256: SHA }, checks: Object.fromEntries(['files_exist', 'hashes_match', 'weights_nonempty', 'adapter_trained', 'adapter_loads', 'generation_works', 'malformed_input_handled'].map((k) => [k, true])) }));
  return d;
}
const publish = async (key, model, dir, fail) => JSON.parse((await execFileP('python3', ['-c', `
import json, sys
sys.path.insert(0, ${JSON.stringify(TRAINING)})
from engine.publisher import Publisher
p = Publisher(${JSON.stringify(BASE)}, ${JSON.stringify(key)}, log=lambda *a: None)
p.started(${JSON.stringify(model)})
print(json.dumps(${fail ? `(p.failed(${JSON.stringify(model)}, "training", ${JSON.stringify(fail)}), {"verified": False})[1]` : `p.completed(${JSON.stringify(model)}, ${JSON.stringify(dir || '')})`}))`], { encoding: 'utf8' })).stdout.trim().split('\n').pop());

let sa, user, key;
test('setup: superadmin, worker key, normal user', async () => {
  sa = await asAdmin(await makeUser(), 'superadmin');
  user = await makeUser();
  key = (await req('POST', '/api/developer/keys', { token: sa.token, body: { name: 'colab-worker', scopes: ['training:worker'] } })).data.secret;
  assert.ok(key.startsWith('apx_'));
});

test('a failed / not production-ready release is reported FAILED and never activated', async () => {
  const out = await publish(key, 'hike-6.5', release({ version: '1.0.0', productionReady: false }));
  assert.equal(out.verified, false);
  assert.match(out.reason, /not production-ready/);
  const lc = await db.one("SELECT state, detail FROM model_lifecycle WHERE model_id = 'hike-6.5'");
  assert.equal(lc.state, 'FAILED'); assert.match(lc.detail, /NOT ACTIVATED/);
  assert.equal((await db.one("SELECT COUNT(*) n FROM model_lifecycle WHERE state = 'ACTIVE' AND model_id = 'hike-6.5'")).n, 0);
  const crash = await publish(key, 'sona-9.0', null, 'CUDA out of memory at step 120');
  assert.equal(crash.verified, false);
  assert.equal((await db.one("SELECT state FROM model_lifecycle WHERE model_id = 'sona-9.0'")).state, 'FAILED');
});

test('a verified release waits (VERIFIED) until the inference server serves exactly that version + SHA', async () => {
  const out = await publish(key, 'hike-6.5', release({ version: '1.1.0' }));
  assert.equal(out.verified, true, out.reason);
  assert.equal((await db.one("SELECT state, version FROM model_lifecycle WHERE model_id = 'hike-6.5'")).state, 'VERIFIED');
  gpu.serving['hike-6.5'] = { version: '1.1.0', sha: 'c'.repeat(64) };   // GPU host loaded different weights
  await req('GET', '/api/models', { token: user.token });
  assert.equal((await db.one("SELECT state FROM model_lifecycle WHERE model_id = 'hike-6.5'")).state, 'VERIFIED', 'wrong SHA → not activated');
  const m = (await req('GET', '/api/models', { token: user.token })).data.models.find((x) => x.id === 'hike-6.5');
  assert.equal(m.selectable, false);
});

test('when the server serves the verified release, the backend activates it; web + APK discover it via /api/models', async () => {
  await wait();
  gpu.serving['hike-6.5'] = { version: '1.1.0', sha: SHA };
  const ms = (await req('GET', '/api/models', { token: user.token })).data.models;   // health check → auto-activation
  const lc = await db.one("SELECT state, version FROM model_lifecycle WHERE model_id = 'hike-6.5'");
  assert.deepEqual({ ...lc }, { state: 'ACTIVE', version: '1.1.0' });
  const after2 = (await req('GET', '/api/models', { token: user.token })).data.models.find((x) => x.id === 'hike-6.5');
  assert.deepEqual([after2.status, after2.selectable, after2.active_version], ['online', true, '1.1.0']);
  void ms;
  // Same contract for a mobile session (bearer token): the APK sees the same active version, no app update.
  const c = await req('POST', '/api/chats', { token: user.token, body: { model: 'hike-6.5' } });
  const r = await req('POST', `/api/chats/${c.data.chat.id}/messages`, { token: user.token, body: { content: 'hi' } });
  const ev = parseSse(r.data);
  assert.equal(ev[0].data.model_id, 'hike-6.5'); assert.equal(ev[0].data.model_version, '1.1.0');
  assert.ok(ev.some((e) => e.event === 'delta' && /Hello from hike-6.5@1.1.0/.test(e.data.text)));
  const audit = await db.one("SELECT actor FROM audit_logs WHERE action = 'model.auto_activated' AND target = 'hike-6.5'");
  assert.equal(audit.actor, 'auto-activation');
});

test('auto-activation can be switched off; workers can never set ACTIVE themselves', async () => {
  const r = await req('POST', '/api/v1/worker/models/hike-6.5/lifecycle', { token: key, body: { to: 'ACTIVE' } });
  assert.equal(r.data.error.code, 'activation_requires_verification');
  const lifecycle = await import('../src/lifecycle.js');
  process.env.APPROX_AUTO_ACTIVATE_VERIFIED = '0';
  assert.equal(await lifecycle.autoActivate('hike-6.5', { version: '1.1.0', adapter_sha256: SHA }, {}), null);
  delete process.env.APPROX_AUTO_ACTIVATE_VERIFIED;
});
