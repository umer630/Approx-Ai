// Lala 3.5 (API 1.11): Ollama gateway through the REAL device agent, model router temporary default, honest
// unavailability, timeouts, and the Lala → Nick 4.8 transformation state machine with fallback / recovery.
//
// NOTE: "Ollama" in this file is a local stand-in that speaks Ollama's HTTP API (/api/tags, /api/chat streaming NDJSON,
// /api/generate, /api/ps). It verifies Approx's gateway, agent and router — NOT a real model. Real Lala 3.5 inference
// must be checked on the owner's computer (Admin → Models → Lala 3.5 → Test).
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { req, makeUser, asAdmin, close, db, BASE, parseSse } from './helpers.js';
import * as tf from '../src/transform.js';
import { resetLalaHealthCache } from '../src/providers/ollama.js';

const TAG = 'lala-standin:1b';
const loaded = new Set();
let slowMs = 0;
const ollama = http.createServer(async (rq, rs) => {
  let body = ''; for await (const c of rq) body += c;
  const j = body ? JSON.parse(body) : {};
  if (rq.url === '/api/version') return rs.end(JSON.stringify({ version: '0.0.0-standin' }));
  if (rq.url === '/api/tags') return rs.end(JSON.stringify({ models: [{ name: TAG, size: 1, modified_at: '2026-11-28T00:00:00Z' }] }));
  if (rq.url === '/api/ps') return rs.end(JSON.stringify({ models: [...loaded].map((name) => ({ name })) }));
  if (rq.url === '/api/generate') { if (j.keep_alive === 0) loaded.delete(j.model); else loaded.add(j.model); return rs.end(JSON.stringify({ done: true })); }
  if (rq.url === '/api/chat') {
    if (j.model !== TAG) { rs.statusCode = 404; return rs.end(JSON.stringify({ error: `model '${j.model}' not found` })); }
    loaded.add(j.model);
    rs.setHeader('content-type', 'application/x-ndjson');
    const words = ['[stand-in] ', 'Two ', 'plus ', 'two ', 'is ', 'four.'];
    for (const w of words) { rs.write(JSON.stringify({ message: { role: 'assistant', content: w }, done: false }) + '\n'); await new Promise((r) => setTimeout(r, slowMs || 120)); }
    return rs.end(JSON.stringify({ done: true, prompt_eval_count: 7, eval_count: words.length, total_duration: 5e8 }) + '\n');
  }
  rs.statusCode = 404; rs.end('{}');
});
await new Promise((r) => ollama.listen(0, '127.0.0.1', r));
const OLLAMA = `http://127.0.0.1:${ollama.address().port}`;

let agent;
after(() => { agent?.kill(); ollama.close(); close(); });
const until = async (fn, what, ms = 15000) => { const t = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t > ms) throw new Error(`timeout: ${what}`); await new Promise((r) => setTimeout(r, 150)); } };

let admin, user, dev;
test('Lala 3.5 gateway: agent reports Ollama, admin maps the installed tag, real chat/stream/load/unload through the agent', async () => {
  admin = await asAdmin(await makeUser(), 'superadmin'); user = await makeUser();
  // Before any gateway: honest unavailability, no fake answer.
  let st = (await req('GET', '/api/admin/model-router', { token: admin.token })).data;
  assert.equal(st.state, 'TEMPORARY_LALA_ACTIVE');
  assert.equal(st.effective_default, 'lala-3.5');
  assert.equal(st.lala.ok, false); assert.match(st.lala.detail, /no Ollama gateway device/);
  assert.deepEqual(st.registry.map((r) => r.model_id).sort(), ['lala-3.5', 'nick-4.8']);
  const p = await req('POST', '/api/devices', { token: admin.token, body: { name: 'Owner laptop' } });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'approx-gw-'));
  agent = spawn(process.execPath, [path.resolve('../web/tools/approx-device.mjs'), 'pair', p.data.pairing_code, '--server', BASE],
    { env: { ...process.env, APPROX_DEVICE_CONFIG: path.join(dir, 'conf.json'), APPROX_DEVICE_WORKDIR: path.join(dir, 'work'), APPROX_OLLAMA_HOST: OLLAMA } });
  let out = ''; agent.stdout.on('data', (d) => { out += d; }); agent.stderr.on('data', (d) => { out += d; });
  st = await until(async () => { const s = (await req('GET', '/api/admin/model-router', { token: admin.token })).data; return s.gateways.find((g) => g.ollama?.reachable) ? s : null; }, 'gateway reported Ollama');
  dev = st.gateways.find((g) => g.ollama?.reachable);
  assert.deepEqual(dev.ollama.tags.map((t) => t.name), [TAG]);
  // A tag Ollama does not report is refused (never assume a tag is installed).
  const bad = await req('POST', '/api/admin/model-router/lala', { token: admin.token, body: { device_id: dev.id, model_tag: 'llama3.5:latest' } });
  assert.equal(bad.status, 409); assert.equal(bad.data.error.code, 'tag_not_installed');
  const ok = await req('POST', '/api/admin/model-router/lala', { token: admin.token, body: { device_id: dev.id, model_tag: TAG } });
  assert.equal(ok.status, 200, JSON.stringify(ok.data)); assert.equal(ok.data.health.ok, true, ok.data.health.detail);
  // Non-streaming, streaming, load, unload — each a real round trip through the agent.
  const chat = (await req('POST', '/api/admin/model-router/lala/test', { token: admin.token, body: { op: 'chat' } })).data;
  assert.equal(chat.ok, true, JSON.stringify(chat) + out); assert.match(chat.text, /Two plus two is four/);
  assert.equal(chat.usage.completion_tokens, 6);
  const stream = (await req('POST', '/api/admin/model-router/lala/test', { token: admin.token, body: { op: 'stream' } })).data;
  assert.equal(stream.ok, true); assert.ok(stream.deltas >= 2, `streamed in ${stream.deltas} deltas`);
  assert.equal((await req('POST', '/api/admin/model-router/lala/test', { token: admin.token, body: { op: 'unload' } })).data.ok, true);
  assert.equal(loaded.has(TAG), false, 'unload reached Ollama');
  assert.equal((await req('POST', '/api/admin/model-router/lala/test', { token: admin.token, body: { op: 'load' } })).data.ok, true);
  assert.equal(loaded.has(TAG), true, 'load reached Ollama');
});

test('router: ordinary chat (default Nick 4.8, not trained) is answered by Lala 3.5 and says so', async () => {
  const c = (await req('POST', '/api/chats', { token: user.token, body: {} })).data.chat;
  assert.equal(c.model_id, 'nick-4.8');
  const r = await req('POST', `/api/chats/${c.id}/messages`, { token: user.token, body: { content: 'what is 2+2?' } });
  const ev = parseSse(r.data);
  const route = ev.find((e) => e.event === 'route')?.data;
  assert.equal(route?.model_id, 'lala-3.5', JSON.stringify(ev.slice(0, 3)));
  assert.equal(route.model_name, 'Lala 3.5'); assert.match(route.reason, /Nick 4\.8 is not active yet/);
  assert.match(ev.filter((e) => e.event === 'delta').map((e) => e.data.text).join(''), /four/);
  const models = (await req('GET', '/api/models', { token: user.token })).data.models;
  const lala = models.find((m) => m.id === 'lala-3.5');
  assert.equal(lala.status, 'online'); assert.equal(lala.selectable, true);
});

test('timeouts and gateway loss are reported honestly (no fake responses)', async () => {
  process.env.APPROX_LALA_TIMEOUT_MS = '400'; slowMs = 600;
  const t = (await req('POST', '/api/admin/model-router/lala/test', { token: admin.token, body: { op: 'chat' } })).data;
  assert.equal(t.ok, false); assert.equal(t.error.code, 'model_backend_timeout');
  delete process.env.APPROX_LALA_TIMEOUT_MS; slowMs = 0;
  agent.kill(); await new Promise((r) => setTimeout(r, 300));
  await db.run('UPDATE devices SET last_seen_at = ? WHERE id = ?', Date.now() - 120_000, dev.id);
  resetLalaHealthCache();
  const down = (await req('POST', '/api/admin/model-router/lala/test', { token: admin.token, body: { op: 'chat' } })).data;
  assert.equal(down.ok, false); assert.equal(down.error.status, 503); assert.match(down.error.message, /offline/);
  const m = (await req('GET', '/api/models', { token: user.token })).data.models.find((x) => x.id === 'lala-3.5');
  assert.equal(m.selectable, false, 'an offline Lala is never shown as online');
});

// ---------------------------------------------------------------- transformation + fallback (simulated providers)
test('transformation: Nick 4.8 activates only after every gate passes; Lala then hides but stays as fallback', async () => {
  // SIMULATION: Nick 4.8's lifecycle, inference server and generation are stubbed here — the real gates are the
  // lifecycle (artifact + SHA-256 + evaluation + deployment verification) and the inference server.
  const sim = { lc: { state: 'TRAINING_REQUIRED' }, serving: { reachable: false, version: null }, infer: { ok: false, detail: 'down' }, lala: { ok: true, detail: 'ok' } };
  Object.assign(tf.hooks, { nickLifecycle: async () => sim.lc, nickServing: async () => sim.serving, nickInfer: async () => sim.infer, lalaHealth: async () => sim.lala });
  let s = await tf.advance();
  assert.equal(s.state, 'TEMPORARY_LALA_ACTIVE');
  sim.lc = { state: 'TRAINING' }; assert.equal((await tf.advance()).state, 'TRAINING_IN_PROGRESS');
  sim.lc = { state: 'TRAINING_COMPLETE' };   // "training finished" without a registered artifact is not enough
  assert.equal((await tf.advance()).state, 'TRAINING_IN_PROGRESS');
  sim.lc = { state: 'TRAINING_COMPLETE', version: '4.8.0', adapter_sha256: 'a'.repeat(64) };
  s = await tf.advance(); assert.equal(s.state, 'TRAINING_COMPLETED'); assert.match(s.gate_error, /adapter verification/);
  sim.lc = { ...sim.lc, state: 'VERIFIED' };
  s = await tf.advance(); assert.equal(s.state, 'ADAPTER_VERIFICATION'); assert.match(s.gate_error, /unreachable/);
  sim.serving = { reachable: true, version: '4.8.0' };
  s = await tf.advance(); assert.equal(s.state, 'INFERENCE_TEST'); assert.match(s.gate_error, /real inference test failed/);
  sim.infer = { ok: true, detail: 'generated 5 chars' };
  s = await tf.advance(); assert.equal(s.state, 'PRODUCTION_DEPLOYMENT'); assert.match(s.gate_error, /not ACTIVE/);
  assert.equal(await tf.effectiveDefault(), 'lala-3.5', 'still Lala until production deployment is verified');
  sim.lc = { ...sim.lc, state: 'ACTIVE' };
  s = await tf.advance();
  assert.equal(s.state, 'LALA_3_5_HIDDEN'); assert.equal(s.nick_version, '4.8.0');
  assert.equal(await tf.effectiveDefault(), 'nick-4.8');
  assert.equal(await tf.lalaVisible(), false);
  const lala = await db.one("SELECT * FROM model_registry WHERE model_id = 'lala-3.5'");
  assert.equal(lala.fallback_enabled, 1); assert.equal(lala.model_tag, TAG, 'Lala configuration preserved'); assert.equal(lala.activation_state, 'standby_hidden');
  const log = (await req('GET', '/api/admin/model-router', { token: admin.token })).data.log.map((l) => l.to_state).reverse();
  assert.deepEqual(log, ['TRAINING_IN_PROGRESS', 'TRAINING_COMPLETED', 'ADAPTER_VERIFICATION', 'INFERENCE_TEST', 'PRODUCTION_DEPLOYMENT', 'NICK_4_8_ACTIVE', 'LALA_3_5_HIDDEN']);
  const models = (await req('GET', '/api/models', { token: user.token })).data.models;
  assert.equal(models.some((m) => m.id === 'lala-3.5'), false, 'Lala removed from the normal selector');
  tf.hooks.sim = sim;
});

test('fallback: repeated Nick errors → Lala (if healthy), incident + admin notice; cooldown + consecutive checks before switch-back; no flapping', async () => {
  const sim = tf.hooks.sim;
  process.env.APPROX_SWITCH_MIN_DWELL_MS = '0'; process.env.APPROX_RECOVERY_COOLDOWN_MS = '0';
  await tf.reportNick(false, { status: 400, code: 'bad_request' });     // a user error never counts
  assert.equal((await tf.state()).consecutive_failures, 0);
  for (let i = 0; i < 2; i++) await tf.reportNick(false, { status: 502, code: 'model_backend_error' });
  assert.equal((await tf.state()).fallback_active, 0, 'below the threshold: no switch');
  await tf.reportNick(false, { status: 502, code: 'model_backend_error' });
  let s = await tf.state();
  assert.equal(s.fallback_active, 1); assert.equal(s.nick_health, 'degraded');
  assert.equal(await tf.effectiveDefault(), 'lala-3.5'); assert.equal(await tf.lalaVisible(), true);
  const inc = await db.one('SELECT * FROM model_incidents ORDER BY id DESC LIMIT 1');
  assert.equal(inc.kind, 'nick_degraded'); assert.equal(inc.action, 'fallback_to_lala'); assert.match(inc.reason, /3 consecutive provider errors/);
  assert.ok(await db.one("SELECT id FROM notifications WHERE user_id = ? AND title LIKE 'Nick 4.8 degraded%'", admin.id), 'admin notified');
  // Recovery: Nick reachable but generation still failing → stays on Lala.
  sim.infer = { ok: false, detail: 'still broken' };
  await tf.healthTick(); assert.equal((await tf.state()).fallback_active, 1);
  sim.infer = { ok: true, detail: 'ok' };
  await tf.healthTick(); s = await tf.state(); assert.equal(s.fallback_active, 1, 'one good check is not enough'); assert.equal(s.consecutive_successes, 1);
  await tf.healthTick(); s = await tf.state(); assert.equal(s.fallback_active, 0, 'switched back after 2 consecutive verified checks');
  assert.equal(await tf.effectiveDefault(), 'nick-4.8');
  assert.equal((await db.one('SELECT * FROM model_incidents ORDER BY id DESC LIMIT 1')).action, 'switch_back_to_nick');
  // Anti-flapping: a dwell time suppresses an immediate second switch.
  process.env.APPROX_SWITCH_MIN_DWELL_MS = String(60 * 60_000);
  for (let i = 0; i < 3; i++) await tf.reportNick(false, { status: 503 });
  assert.equal((await tf.state()).fallback_active, 0);
  assert.equal((await db.one('SELECT * FROM model_incidents ORDER BY id DESC LIMIT 1')).action, 'switch_suppressed_dwell');
  // Lala unhealthy → Nick marked degraded but no switch to a broken fallback.
  process.env.APPROX_SWITCH_MIN_DWELL_MS = '0';
  await db.run('UPDATE model_transform SET consecutive_failures = 0 WHERE id = 1');
  sim.lala = { ok: false, detail: 'gateway offline' };
  for (let i = 0; i < 3; i++) await tf.reportNick(false, { status: 503 });
  s = await tf.state();
  assert.equal(s.fallback_active, 0); assert.equal(s.nick_health, 'degraded');
  assert.equal((await db.one('SELECT * FROM model_incidents ORDER BY id DESC LIMIT 1')).action, 'no_fallback_lala_unhealthy');
  delete process.env.APPROX_SWITCH_MIN_DWELL_MS; delete process.env.APPROX_RECOVERY_COOLDOWN_MS;
});
