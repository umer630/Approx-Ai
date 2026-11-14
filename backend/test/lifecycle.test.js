// Model lifecycle: TRAINING_REQUIRED/REGISTERED → … → ACTIVE only after the backend verifies the live deployment.
// The GPU inference server is a local mock that speaks the real inference/server.py contract (/health with
// per-model version + adapter SHA-256, OpenAI-compatible completions). Nothing here is a real model.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

const NICK_PIN = '2faae21620ef0aea6140b296b43ab5fcf5ba2c5b721067f91797b288a09c34c4';
const HIKE_SHA = 'a'.repeat(64);
const gpu = { serving: {}, calls: [] }; // what the mock GPU host currently serves: { modelId: { version, sha, ready } }
const srv = http.createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c);
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ status: 'ok', serving: Object.fromEntries(Object.entries(gpu.serving).map(([m, s]) => [m, s.version])),
      details: Object.fromEntries(Object.entries(gpu.serving).map(([m, s]) => [m, { version: s.version, adapter_sha256: s.sha, production_ready: s.ready !== false, smoke_test: false }])) }));
  }
  const b = JSON.parse(Buffer.concat(chunks).toString() || '{}');
  gpu.calls.push(b.model);
  if (b.stream === false) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ choices: [{ message: { content: `I am ${b.model}.` } }] })); }
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: `Answer from ${b.model}` } }] })}\n\n`); res.end('data: [DONE]\n\n');
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
process.env.APPROX_REGISTRY_SOURCE = 'inference';
process.env.APPROX_MODEL_DEFAULT_URL = `http://127.0.0.1:${srv.address().port}/v1`;
process.env.APPROX_DEV_PROVIDER = '0';
const { req, db, makeUser, close } = await import('./helpers.js');
const lifecycle = await import('../src/lifecycle.js');
after(() => { srv.close(); close(); });

const wait = () => new Promise((r) => setTimeout(r, 11_000)); // inference health is cached 10 s
const artifact = (sha, base, rev = '0123456789abcdef0123456789abcdef01234567') => ({ uri: 'gs://approx-models/x/adapter.tar.gz', sha256: sha, base_model: base, base_revision: rev });
const goodEval = (sha, base) => ({ verification_passed: true, safety_passed: true, base_model: base, adapter_model_safetensors: { sha256: sha },
  checks: Object.fromEntries(['files_exist', 'hashes_match', 'weights_nonempty', 'adapter_trained', 'adapter_loads', 'generation_works', 'malformed_input_handled'].map((k) => [k, true])) });

let sa; let user;
test('setup: superadmin + normal user; initial registry entries', async () => {
  sa = await makeUser(); await db.run("UPDATE users SET role = 'superadmin' WHERE id = ?", sa.id);
  user = await makeUser();
  const r = await req('GET', '/api/admin/models/lifecycle', { token: sa.token });
  const st = Object.fromEntries(r.data.models.map((m) => [m.model_id, m.state]));
  assert.deepEqual(st, { 'fab-500x': 'TRAINING_REQUIRED', 'hike-6.5': 'TRAINING_REQUIRED', 'nick-4.8': 'REGISTERED', 'sona-9.0': 'TRAINING_REQUIRED' });
  const nick = r.data.models.find((m) => m.model_id === 'nick-4.8');
  assert.equal(nick.pinned_sha256, NICK_PIN);
  assert.equal(nick.base_model, 'Qwen/Qwen2.5-3B-Instruct');
  assert.equal(nick.version, null, 'no version invented');
  assert.equal(nick.artifact_uri, null, 'no artifact path invented');
});

test('nothing serves before activation, even if the GPU host has it loaded', async () => {
  gpu.serving = { 'nick-4.8': { version: '1.0.0', sha: NICK_PIN }, 'hike-6.5': { version: '1.0.0', sha: HIKE_SHA } };
  const models = (await req('GET', '/api/models', { token: user.token })).data.models;
  for (const id of ['nick-4.8', 'hike-6.5', 'sona-9.0', 'fab-500x']) assert.equal(models.find((m) => m.id === id).active_version, null, id);
  assert.equal(models.find((m) => m.id === 'hike-6.5').lifecycle.label, 'Training required');
  const c = await req('POST', '/api/chats', { token: user.token, body: { model: 'hike-6.5' } });
  const send = await req('POST', `/api/chats/${c.data.chat.id}/messages`, { token: user.token, body: { content: 'hello' } });
  assert.match(JSON.stringify(send.data), /model_version_not_active/);
  assert.match(JSON.stringify(send.data), /not available yet \(Training required\)/);
});

test('guards: ACTIVE cannot be set; bad artifacts, wrong base, wrong pin and failed evaluations are rejected', async () => {
  const post = (id, body) => req('POST', `/api/admin/models/${id}/lifecycle`, { token: sa.token, body });
  assert.equal((await post('hike-6.5', { to: 'ACTIVE' })).data.error.code, 'activation_requires_verification');
  assert.equal((await post('hike-6.5', { to: 'DEPLOYING' })).data.error.code, 'invalid_transition', 'cannot skip training');
  assert.equal((await post('hike-6.5', { to: 'TRAINING', reason: 'job_1' })).data.lifecycle.state, 'TRAINING');
  assert.equal((await post('hike-6.5', { to: 'TRAINING_COMPLETE', version: '1.0.0', artifact: artifact('xyz', 'Qwen/Qwen2.5-7B-Instruct') })).data.error.code, 'invalid_sha256');
  assert.equal((await post('hike-6.5', { to: 'TRAINING_COMPLETE', version: '1.0.0', artifact: artifact(HIKE_SHA, 'Qwen/Qwen2.5-3B-Instruct') })).data.error.code, 'base_model_mismatch');
  assert.equal((await post('hike-6.5', { to: 'TRAINING_COMPLETE', version: '1.0.0', artifact: { ...artifact(HIKE_SHA, 'Qwen/Qwen2.5-7B-Instruct'), base_revision: '' } })).data.error.code, 'base_revision_required');
  assert.equal((await post('hike-6.5', { to: 'TRAINING_COMPLETE', version: '1.0.0', artifact: { ...artifact(HIKE_SHA, 'Qwen/Qwen2.5-7B-Instruct'), uri: '/tmp/adapter' } })).data.error.code, 'invalid_artifact_uri');
  assert.equal((await post('nick-4.8', { to: 'DEPLOYING', version: '1.0.0', artifact: artifact('b'.repeat(64), 'Qwen/Qwen2.5-3B-Instruct') })).data.error.code, 'sha256_not_pinned');
  assert.equal((await post('hike-6.5', { to: 'TRAINING_COMPLETE', version: '1.0.0', artifact: artifact(HIKE_SHA, 'Qwen/Qwen2.5-7B-Instruct') })).data.lifecycle.state, 'TRAINING_COMPLETE');
  assert.equal((await post('hike-6.5', { to: 'EVALUATING' })).data.lifecycle.state, 'EVALUATING');
  assert.equal((await post('hike-6.5', { to: 'VERIFIED', evaluation: { ...goodEval(HIKE_SHA, 'Qwen/Qwen2.5-7B-Instruct'), safety_passed: false } })).data.error.code, 'safety_failed');
  assert.equal((await post('hike-6.5', { to: 'VERIFIED', evaluation: goodEval('c'.repeat(64), 'Qwen/Qwen2.5-7B-Instruct') })).data.error.code, 'sha256_mismatch');
  assert.equal((await post('hike-6.5', { to: 'VERIFIED', evaluation: goodEval(HIKE_SHA, 'Qwen/Qwen2.5-7B-Instruct') })).data.lifecycle.state, 'VERIFIED');
  // Not authorized: ordinary users / admins cannot move models.
  assert.equal((await req('POST', '/api/admin/models/hike-6.5/lifecycle', { token: user.token, body: { to: 'DEPLOYING' } })).status, 403);
});

test('deployment verification: wrong loaded adapter → FAILED and never served; correct one → ACTIVE and selectable without an app update', async () => {
  gpu.serving['hike-6.5'] = { version: '1.0.0', sha: 'd'.repeat(64) }; // GPU host loaded a different adapter
  await wait();
  const bad = await req('POST', '/api/admin/models/hike-6.5/lifecycle', { token: sa.token, body: { to: 'DEPLOYING' } });
  assert.equal(bad.status, 409);
  assert.equal(bad.data.error.code, 'deployment_verification_failed');
  assert.equal(bad.data.error.stage, 'sha256');
  const row = await db.one("SELECT state, failed_stage FROM model_lifecycle WHERE model_id = 'hike-6.5'");
  assert.deepEqual({ ...row }, { state: 'FAILED', failed_stage: 'sha256' });
  // Recover: re-register the artifact, re-evaluate, redeploy with the right adapter loaded.
  gpu.serving['hike-6.5'] = { version: '1.0.0', sha: HIKE_SHA };
  await wait();
  const post = (body) => req('POST', '/api/admin/models/hike-6.5/lifecycle', { token: sa.token, body });
  assert.equal((await post({ to: 'TRAINING_COMPLETE', version: '1.0.0', artifact: artifact(HIKE_SHA, 'Qwen/Qwen2.5-7B-Instruct') })).status, 200);
  await post({ to: 'EVALUATING' }); await post({ to: 'VERIFIED', evaluation: goodEval(HIKE_SHA, 'Qwen/Qwen2.5-7B-Instruct') });
  const ok = await post({ to: 'DEPLOYING' });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal(ok.data.lifecycle.state, 'ACTIVE');
  assert.equal(ok.data.lifecycle.generation_sample, 'I am hike-6.5@1.0.0.', 'real generation call was made to the deployed model');
  // The same /api/models endpoint the web and Android apps read now lists Hike as active — no rebuild needed.
  lifecycle.invalidateLifecycleCache();
  const models = (await req('GET', '/api/models', { token: user.token })).data.models;
  const hike = models.find((m) => m.id === 'hike-6.5');
  assert.equal(hike.active_version, '1.0.0');
  assert.equal(hike.lifecycle.state, 'ACTIVE');
  const c = await req('POST', '/api/chats', { token: user.token, body: { model: 'hike-6.5' } });
  const send = await req('POST', `/api/chats/${c.data.chat.id}/messages`, { token: user.token, body: { content: 'hello' } });
  assert.match(send.data, /Answer from hike-6\.5@1\.0\.0/);
  const events = (await req('GET', '/api/admin/models/lifecycle', { token: sa.token })).data.events.filter((e) => e.model_id === 'hike-6.5').map((e) => e.to_state).reverse();
  assert.deepEqual(events, ['TRAINING', 'TRAINING_COMPLETE', 'EVALUATING', 'VERIFIED', 'DEPLOYING', 'FAILED', 'TRAINING_COMPLETE', 'EVALUATING', 'VERIFIED', 'DEPLOYING', 'ACTIVE']);
});

test('Nick 4.8: pinned trained adapter deploys from REGISTERED, verified live; Auto routes to an active model', async () => {
  const r = await req('POST', '/api/admin/models/nick-4.8/lifecycle', { token: sa.token,
    body: { to: 'DEPLOYING', version: '1.0.0', artifact: artifact(NICK_PIN, 'Qwen/Qwen2.5-3B-Instruct') } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.lifecycle.state, 'ACTIVE');
  assert.equal(r.data.lifecycle.adapter_sha256, NICK_PIN);
  // Auto: a complex question would prefer Sona (not trained) → skipped; Hike (active) answers.
  const c = await req('POST', '/api/chats', { token: user.token, body: {} });
  const send = await req('POST', `/api/chats/${c.data.chat.id}/messages`, { token: user.token, body: { content: 'Prove step by step that the square root of 2 is irrational, then compare three proof strategies in depth with examples and edge cases.' } });
  assert.match(send.data, /Answer from (hike-6\.5|nick-4\.8)@1\.0\.0/);
  assert.doesNotMatch(send.data, /sona-9\.0/);
});

test('FAB 500X stays restricted after activation: no access without a superadmin grant', async () => {
  const FAB_SHA = 'f'.repeat(64);
  gpu.serving['fab-500x'] = { version: '1.0.0', sha: FAB_SHA };
  await wait();
  const post = (body) => req('POST', '/api/admin/models/fab-500x/lifecycle', { token: sa.token, body });
  await post({ to: 'TRAINING' });
  await post({ to: 'TRAINING_COMPLETE', version: '1.0.0', artifact: artifact(FAB_SHA, 'Qwen/Qwen2.5-Coder-32B-Instruct') });
  await post({ to: 'EVALUATING' }); await post({ to: 'VERIFIED', evaluation: goodEval(FAB_SHA, 'Qwen/Qwen2.5-Coder-32B-Instruct') });
  assert.equal((await post({ to: 'DEPLOYING' })).data.lifecycle.state, 'ACTIVE');
  const c = await req('POST', '/api/chats', { token: user.token, body: { model: 'fab-500x' } });
  assert.equal(c.status, 403, 'normal user cannot use FAB even when active');
});

test('GPU workers report progress but can never activate', async () => {
  const k = await req('POST', '/api/developer/keys', { token: sa.token, body: { name: 'gpu-worker', scopes: ['training:worker'] } });
  const w = (body) => req('POST', '/api/v1/worker/models/sona-9.0/lifecycle', { token: k.data.secret, body });
  assert.equal((await w({ to: 'TRAINING', reason: 'job started on L4' })).data.lifecycle.state, 'TRAINING');
  assert.equal((await w({ to: 'ACTIVE' })).data.error.code, 'activation_requires_verification');
  assert.equal((await w({ to: 'FAILED', failed_stage: 'training', reason: 'CUDA OOM at step 120' })).data.lifecycle.state, 'FAILED');
  const row = await db.one("SELECT state, failed_stage, detail FROM model_lifecycle WHERE model_id = 'sona-9.0'");
  assert.deepEqual({ ...row }, { state: 'FAILED', failed_stage: 'training', detail: 'CUDA OOM at step 120' });
  const plain = await req('POST', '/api/developer/keys', { token: user.token, body: { name: 'x', scopes: ['models:read'] } });
  assert.equal((await req('POST', '/api/v1/worker/models/sona-9.0/lifecycle', { token: plain.data.secret, body: { to: 'TRAINING' } })).status, 403);
});

test('training jobs: no duplicates, worker claim → TRAINING, failure → FAILED(training), retry', async () => {
  const k = await req('POST', '/api/developer/keys', { token: sa.token, body: { name: 'gpu-worker-2', scopes: ['training:worker'] } });
  const job = await req('POST', '/api/admin/compute/jobs', { token: sa.token, body: { models: ['hike-6.5', 'sona-9.0'].slice(1) } });
  assert.equal(job.status, 201);
  const dup = await req('POST', '/api/admin/compute/jobs', { token: sa.token, body: { models: ['sona-9.0'] } });
  assert.equal(dup.status, 409); assert.equal(dup.data.error.code, 'duplicate_job');
  await db.run("UPDATE model_lifecycle SET state = 'TRAINING_REQUIRED' WHERE model_id = 'sona-9.0'");
  lifecycle.invalidateLifecycleCache();
  const claim = await req('POST', '/api/v1/worker/claim', { token: k.data.secret, body: { worker: { id: 'gpu-l4-1', gpu: { name: 'L4' } } } });
  assert.equal(claim.data.job.id, job.data.job.id);
  assert.equal((await db.one("SELECT state FROM model_lifecycle WHERE model_id = 'sona-9.0'")).state, 'TRAINING');
  const rep = await req('POST', `/api/v1/worker/jobs/${job.data.job.id}/report`, { token: k.data.secret, body: { worker: { id: 'gpu-l4-1' }, status: 'failed', error: 'CUDA out of memory', log_append: 'step 12: OOM\n' } });
  assert.equal(rep.data.status, 'failed');
  const row = await db.one("SELECT state, failed_stage FROM model_lifecycle WHERE model_id = 'sona-9.0'");
  assert.deepEqual({ ...row }, { state: 'FAILED', failed_stage: 'training' });
  const logs = await req('GET', `/api/admin/compute/jobs/${job.data.job.id}`, { token: sa.token });
  assert.match(JSON.stringify(logs.data), /OOM/);
  const retry = await req('POST', `/api/admin/compute/jobs/${job.data.job.id}/retry`, { token: sa.token });
  assert.equal(retry.status, 201);
  assert.equal(retry.data.job.status, 'queued');
});
