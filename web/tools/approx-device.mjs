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
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const CONF = process.env.APPROX_DEVICE_CONFIG || path.join(os.homedir(), '.approx-device.json');
const WORK = process.env.APPROX_DEVICE_WORKDIR || path.join(os.homedir(), '.approx-device', 'work');
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

async function agent(conf, once) {
  const me = await api(conf, 'POST', '/api/device/heartbeat');
  log(`connected as "${me.name}" to ${conf.server}. Waiting for commands you start in Approx Code… (Ctrl+C to stop)`);
  let beat = Date.now();
  for (;;) {
    try {
      const { job } = await api(conf, 'GET', '/api/device/jobs/next');
      if (job) { await handle(conf, job); if (once) return; continue; }
      if (Date.now() - beat > 30_000) { await api(conf, 'POST', '/api/device/heartbeat'); beat = Date.now(); }
    } catch (e) {
      log(`error: ${e.message}`);
      if (/revoked|Unknown/i.test(e.message)) process.exit(1);
    }
    if (once && process.env.APPROX_DEVICE_ONCE_TIMEOUT && Date.now() - beat > Number(process.env.APPROX_DEVICE_ONCE_TIMEOUT)) return;
    await new Promise((r) => setTimeout(r, 2000));
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
} else if (cmd === 'forget') {
  fs.rmSync(CONF, { force: true }); log('device token deleted (also remove the device in Approx → Code → Devices)');
} else {
  console.log('Approx device agent\n  node approx-device.mjs pair <CODE> [--server URL]\n  node approx-device.mjs run [--once]\n  node approx-device.mjs forget');
}
