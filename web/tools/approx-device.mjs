#!/usr/bin/env node
// Approx device agent — connects YOUR computer to Approx Code so Terminal / Run / Test / Build commands you start in
// Approx run here, on a copy of your Approx repository. Nothing runs unless you start it from your own account.
//
//   node approx-device.mjs pair <CODE> [--server https://approx-ai.vercel.app]   pair (code from Approx → Code → Add device), then run
//   node approx-device.mjs run [--once]                                           run the agent (after pairing)
//   node approx-device.mjs forget                                                 delete the saved device token
//
// Needs Node.js 18+. The device token is saved in ~/.approx-device.json (readable only by you). Remove the device in
// Approx → Code → Devices to revoke it at any time.
//
// Ollama gateway (Lala 3.5): if Ollama runs on this computer (default http://127.0.0.1:11434, override with
// APPROX_OLLAMA_HOST), the agent reports its status and installed models, and — when an administrator assigns this
// device as the Lala 3.5 gateway — answers model requests with the local Ollama. Connections are outbound HTTPS only;
// the Ollama port is never opened to the internet.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const CONF = process.env.APPROX_DEVICE_CONFIG || path.join(os.homedir(), '.approx-device.json');
const WORK = process.env.APPROX_DEVICE_WORKDIR || path.join(os.homedir(), '.approx-device', 'work');
const OLLAMA = (process.env.APPROX_OLLAMA_HOST || 'http://127.0.0.1:11434').replace(/\/+$/, '');
const args = process.argv.slice(2);
const flag = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };
const log = (...m) => console.log(`[approx-device ${new Date().toISOString().slice(11, 19)}]`, ...m);

async function api(conf, method, p, body) {
  const r = await fetch(conf.server + p, { method, headers: { 'content-type': 'application/json', ...(conf.token ? { authorization: `Device ${conf.token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error?.message || `HTTP ${r.status}`);
  return data;
}

function safePath(root, rel) {
  const p = path.resolve(root, rel);
  if (!p.startsWith(path.resolve(root) + path.sep)) throw new Error(`unsafe path: ${rel}`);
  return p;
}

function runCommand(command, cwd, timeoutMs = 10 * 60_000) {
  return new Promise((resolve) => {
    let out = '';
    const child = spawn(command, { cwd, shell: true, env: { ...process.env, CI: '1' } });
    const add = (d) => { out += d.toString(); if (out.length > 200_000) out = out.slice(-100_000); process.stdout.write(d); };
    child.stdout.on('data', add); child.stderr.on('data', add);
    const timer = setTimeout(() => { out += `\n[approx-device] timed out after ${timeoutMs / 1000}s\n`; child.kill('SIGKILL'); }, timeoutMs);
    child.on('close', (code) => { clearTimeout(timer); resolve({ exit_code: code ?? -1, output: out.slice(-64_000) }); });
    child.on('error', (e) => { clearTimeout(timer); resolve({ exit_code: -1, output: `${out}\n${e.message}` }); });
  });
}

async function handle(conf, job) {
  const dir = safePath(WORK, job.project_id);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  for (const f of job.files) { const p = safePath(dir, f.path); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, f.content); }
  log(`${job.kind}: ${job.command}   (in ${dir}, ${job.files.length} files)`);
  const result = await runCommand(job.command, dir);
  log(`exit ${result.exit_code}`);
  await api(conf, 'POST', `/api/device/jobs/${job.id}/result`, result);
}

// ---------------------------------------------------------------- Ollama (local only)
async function ollamaStatus() {
  try {
    const [v, tags, ps] = await Promise.all([
      fetch(`${OLLAMA}/api/version`, { signal: AbortSignal.timeout(3000) }).then((r) => r.json()),
      fetch(`${OLLAMA}/api/tags`, { signal: AbortSignal.timeout(3000) }).then((r) => r.json()),
      fetch(`${OLLAMA}/api/ps`, { signal: AbortSignal.timeout(3000) }).then((r) => r.json()).catch(() => ({ models: [] })),
    ]);
    return { reachable: true, version: v.version || null, tags: (tags.models || []).map((m) => ({ name: m.name, size: m.size, modified_at: m.modified_at })),
      loaded: (ps.models || []).map((m) => m.name) };
  } catch (e) { return { reachable: false, error: e.cause?.code || e.message, tags: [], loaded: [] }; }
}
const beatBody = async () => ({ ollama: await ollamaStatus() });

async function inference(conf, job) {
  const post = (what, body) => api(conf, 'POST', `/api/device/inference/${job.id}/${what}`, body);
  log(`model ${job.op}: ${job.model_tag}`);
  try {
    if (job.op !== 'chat') {
      const r = await fetch(`${OLLAMA}/api/generate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: job.model_tag, keep_alive: job.op === 'unload' ? 0 : '5m' }), signal: AbortSignal.timeout(120_000) });
      if (!r.ok) throw new Error(`Ollama HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
      await r.text(); await post('done', {}); return;
    }
    const r = await fetch(`${OLLAMA}/api/chat`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: job.model_tag, messages: job.messages, stream: true, options: job.options || {} }), signal: AbortSignal.timeout(120_000) });
    if (!r.ok) throw new Error(`Ollama HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
    let seq = 0; let pending = ''; let last = Date.now(); let buf = ''; let final = {};
    const flush = async () => { if (!pending) return; const text = pending; pending = ''; seq += 1; await post('chunk', { seq, text }); };
    const dec = new TextDecoder();
    for await (const chunk of r.body) {
      buf += dec.decode(chunk, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line) continue;
        const j = JSON.parse(line);
        if (j.error) throw new Error(j.error);
        if (j.message?.content) pending += j.message.content;
        if (j.done) final = j;
      }
      if (Date.now() - last > 300) { last = Date.now(); await flush(); }   // stream to Approx about 3 times a second
    }
    await flush();
    await post('done', { prompt_tokens: final.prompt_eval_count || 0, completion_tokens: final.eval_count || 0, total_duration_ms: final.total_duration ? Math.round(final.total_duration / 1e6) : null });
    log(`model done (${final.eval_count || 0} tokens)`);
  } catch (e) {
    log(`model error: ${e.message}`);
    await post('fail', { error: e.message }).catch(() => {});
  }
}

async function agent(conf, once) {
  const me = await api(conf, 'POST', '/api/device/heartbeat', await beatBody());
  log(`connected as "${me.name}" to ${conf.server}.${me.inference_gateway ? ' This computer is the Lala 3.5 gateway (local Ollama).' : ''} Waiting for work… (Ctrl+C to stop)`);
  let beat = Date.now(); let gateway = !!me.inference_gateway; let running = 0;
  for (;;) {
    try {
      if (running < 2) {
        const { job } = await api(conf, 'GET', '/api/device/jobs/next');
        if (job && job.kind === 'inference') {
          running += 1;
          inference(conf, job).finally(() => { running -= 1; });   // in parallel: commands keep flowing
          if (once) { while (running) await new Promise((r) => setTimeout(r, 200)); return; }
          continue;
        }
        if (job) { await handle(conf, job); if (once) return; continue; }
      }
      if (Date.now() - beat > 15_000) { const hb = await api(conf, 'POST', '/api/device/heartbeat', await beatBody()); gateway = !!hb.inference_gateway; beat = Date.now(); }
    } catch (e) {
      log(`error: ${e.message} — retrying`);
      if (/revoked|Unknown/i.test(e.message)) process.exit(1);
      await new Promise((r) => setTimeout(r, 5000));   // network down / server error: back off, then reconnect
    }
    if (once && process.env.APPROX_DEVICE_ONCE_TIMEOUT && Date.now() - beat > Number(process.env.APPROX_DEVICE_ONCE_TIMEOUT)) return;
    await new Promise((r) => setTimeout(r, gateway ? 700 : 2000));
  }
}

const cmd = args[0];
if (cmd === 'pair') {
  const code = args[1];
  const server = (flag('--server', 'https://approx-ai.vercel.app') || '').replace(/\/+$/, '');
  if (!code) { console.error('usage: node approx-device.mjs pair <CODE> [--server URL]'); process.exit(2); }
  const r = await api({ server }, 'POST', '/api/device/claim', { code, hostname: os.hostname(), platform: `${os.platform()} ${os.arch()}` });
  fs.writeFileSync(CONF, JSON.stringify({ server, token: r.device_token, device_id: r.device_id }, null, 2), { mode: 0o600 });
  log(`paired as "${r.name}". Token saved to ${CONF}.`);
  if (!args.includes('--no-run')) await agent({ server, token: r.device_token }, args.includes('--once'));
} else if (cmd === 'run') {
  if (!fs.existsSync(CONF)) { console.error('Not paired yet: node approx-device.mjs pair <CODE>'); process.exit(2); }
  await agent(JSON.parse(fs.readFileSync(CONF, 'utf8')), args.includes('--once'));
} else if (cmd === 'ollama') {
  console.log(JSON.stringify(await ollamaStatus(), null, 2));   // local check only: what this agent would report
} else if (cmd === 'forget') {
  fs.rmSync(CONF, { force: true }); log('device token deleted (also remove the device in Approx → Code → Devices)');
} else {
  console.log('Approx device agent\n  node approx-device.mjs pair <CODE> [--server URL]\n  node approx-device.mjs run [--once]\n  node approx-device.mjs ollama   (show local Ollama status)\n  node approx-device.mjs forget');
}
