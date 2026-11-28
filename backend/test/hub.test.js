// Navigation hub (API 1.10): devices + the real device agent, scheduled tasks (schedule maths, runs, cron), recents,
// session history, Co Approx background runs, artifacts search/rename/share, quiz practice.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { req, makeUser, close, db, BASE } from './helpers.js';
import { nextRun, zonedToUtc } from '../src/routes/hub.js';
after(() => close());

let u, other;
const until = async (fn, what, ms = 15000) => { const t = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t > ms) throw new Error(`timeout: ${what}`); await new Promise((r) => setTimeout(r, 150)); } };

test('devices: pair with a one-time code, the real agent runs a Code command from a session, revoke', async () => {
  u = await makeUser(); other = await makeUser();
  assert.deepEqual((await req('GET', '/api/devices', { token: u.token })).data.devices, []);
  const p = await req('POST', '/api/devices', { token: u.token, body: { name: 'Work laptop' } });
  assert.equal(p.status, 201);
  assert.match(p.data.pairing_code, /^[A-Z0-9X]{8}$/);
  assert.match(p.data.command, /approx-device\.mjs pair/);
  assert.match(p.data.command_windows, /^Invoke-WebRequest -UseBasicParsing \S+\/tools\/approx-device\.mjs -OutFile approx-device\.mjs; node approx-device\.mjs pair [A-Z0-9X]{8} --server /);
  assert.doesNotMatch(p.data.command_windows, /&&/);
  assert.equal((await req('POST', '/api/device/claim', { body: { code: 'WRONG123' } })).status, 401);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'approx-dev-'));
  const agent = spawn(process.execPath, [path.resolve('../web/tools/approx-device.mjs'), 'pair', p.data.pairing_code, '--server', BASE, '--once'],
    { env: { ...process.env, APPROX_DEVICE_CONFIG: path.join(dir, 'conf.json'), APPROX_DEVICE_WORKDIR: path.join(dir, 'work') } });
  const exited = new Promise((r) => agent.on('exit', r));   // --once: the agent exits after its first job
  let agentOut = ''; agent.stdout.on('data', (d) => { agentOut += d; }); agent.stderr.on('data', (d) => { agentOut += d; });
  const dev = await until(async () => (await req('GET', '/api/devices', { token: u.token })).data.devices.find((d) => d.status === 'connected'), 'device connected');
  assert.equal(dev.name, 'Work laptop'); assert.equal(dev.online, true);
  assert.equal(fs.statSync(path.join(dir, 'conf.json')).mode & 0o777, 0o600, 'token file readable only by the owner');
  assert.equal((await req('POST', '/api/device/claim', { body: { code: p.data.pairing_code } })).status, 401, 'a code works once');
  const pr = (await req('POST', '/api/workspaces/code/projects', { token: u.token, body: { name: 'dev-repo' } })).data.project;
  await req('PUT', `/api/fabbox/${pr.id}/file`, { token: u.token, body: { path: 'src/t.js', content: "console.log('hello from ' + require('path').basename(process.cwd()) + ' ' + (2 + 3))\n" } });
  assert.equal((await req('POST', '/api/work-sessions', { token: other.token, body: { workspace: 'code', project_id: pr.id, device_id: dev.id } })).status, 404);
  const s = (await req('POST', '/api/work-sessions', { token: u.token, body: { workspace: 'code', project_id: pr.id, device_id: dev.id } })).data.session;
  assert.equal(s.device.id, dev.id); assert.equal(s.branch, 'main');
  const job = await req('POST', `/api/code/${pr.id}/run`, { token: u.token, body: { command: 'node src/t.js', kind: 'test', session_id: s.id } });
  assert.equal(job.status, 202, JSON.stringify(job.data));
  const done = await until(async () => { const j = (await req('GET', `/api/code/jobs/${job.data.job.id}`, { token: u.token })).data.job; return j.status === 'completed' || j.status === 'failed' ? j : null; }, 'job finished');
  assert.equal(done.exit_code, 0, done.output + agentOut);
  assert.match(done.output, new RegExp(`hello from ${pr.id} 5`));
  assert.equal((await req('GET', `/api/code/jobs/${job.data.job.id}`, { token: other.token })).status, 404);
  const logs = (await req('GET', `/api/work-sessions/${s.id}`, { token: u.token })).data.session.logs;
  assert.ok(logs.some((l) => l.tool === 'run:test' && l.status === 'ok' && /exit 0/.test(l.output)), JSON.stringify(logs));
  await exited;
  // Revoke: the token stops working immediately.
  const conf = JSON.parse(fs.readFileSync(path.join(dir, 'conf.json'), 'utf8'));
  assert.equal((await req('DELETE', `/api/devices/${dev.id}`, { token: other.token })).status, 404);
  assert.equal((await req('DELETE', `/api/devices/${dev.id}`, { token: u.token })).status, 200);
  const hb = await fetch(`${BASE}/api/device/heartbeat`, { method: 'POST', headers: { authorization: `Device ${conf.token}` } });
  assert.equal(hb.status, 401);
  // Without a device the honest 501 remains.
  assert.equal((await req('POST', `/api/code/${pr.id}/run`, { token: u.token, body: { command: 'ls' } })).data.error.code, 'runner_not_configured');
});

test('schedule maths: time zones, DST, weekdays, weekly, hourly, once', () => {
  const ny = { frequency: 'daily', timezone: 'America/New_York', start_at: zonedToUtc(2026, 3, 1, 9, 0, 'America/New_York') };
  const n1 = nextRun(ny, Date.UTC(2026, 2, 7, 12));          // 7 Mar 07:00 NY (EST) → 7 Mar 09:00 EST = 14:00 UTC
  assert.equal(new Date(n1).toISOString(), '2026-03-07T14:00:00.000Z');
  const n2 = nextRun(ny, Date.UTC(2026, 2, 9, 12));          // after DST: 09:00 EDT = 13:00 UTC
  assert.equal(new Date(n2).toISOString(), '2026-03-09T13:00:00.000Z');
  const kh = { frequency: 'weekdays', timezone: 'Asia/Karachi', start_at: zonedToUtc(2026, 11, 1, 8, 30, 'Asia/Karachi') };
  assert.equal(new Date(nextRun(kh, Date.UTC(2026, 10, 27, 10))).toISOString(), '2026-11-30T03:30:00.000Z', 'Friday afternoon → Monday 08:30 PKT');
  const wk = { frequency: 'weekly', timezone: 'UTC', start_at: Date.UTC(2026, 10, 2, 7) };   // a Monday
  assert.equal(new Date(nextRun(wk, Date.UTC(2026, 10, 3))).toISOString(), '2026-11-09T07:00:00.000Z');
  const hr = { frequency: 'hourly', timezone: 'UTC', start_at: Date.UTC(2026, 10, 1, 0, 15) };
  assert.equal(new Date(nextRun(hr, Date.UTC(2026, 10, 1, 5, 20))).toISOString(), '2026-11-01T06:15:00.000Z');
  assert.equal(nextRun({ frequency: 'once', timezone: 'UTC', start_at: 5, last_run_at: 7 }, 10), null);
});

test('scheduled tasks: create, validate, run now → a real session; cron runs due tasks once; isolation', async () => {
  assert.equal((await req('GET', '/api/scheduled', { token: u.token })).data.tasks.length, 0);
  for (const body of [{ name: 'x', instructions: 'do it', frequency: 'sometimes', start_at: '2026-12-01T09:00', timezone: 'UTC' },
    { name: 'x', instructions: 'do it', frequency: 'daily', start_at: '2026-12-01T09:00', timezone: 'Mars/Base' },
    { name: 'x', instructions: 'do it', frequency: 'daily', start_at: 'tomorrow', timezone: 'UTC' },
    { name: 'x', instructions: 'do it', frequency: 'daily', start_at: '2026-12-01T09:00', timezone: 'UTC', tools: ['email_everyone'] }]) {
    assert.equal((await req('POST', '/api/scheduled', { token: u.token, body })).status, 400, JSON.stringify(body));
  }
  const c = await req('POST', '/api/scheduled', { token: u.token, body: { name: 'Morning brief', instructions: 'Summarise my open tasks.', frequency: 'daily',
    start_at: '2026-12-01T09:00', timezone: 'Asia/Karachi', tools: ['artifacts'] } });
  assert.equal(c.status, 201, JSON.stringify(c.data));
  const t = c.data.task;
  assert.match(t.id, /^sch_/); assert.equal(t.enabled, true);
  assert.equal(new Date(t.next_run_at).toISOString(), '2026-12-01T04:00:00.000Z', '09:00 Karachi');
  const r = await req('POST', `/api/scheduled/${t.id}/run`, { token: u.token });
  assert.equal(r.data.run.status, 'completed', JSON.stringify(r.data));
  const s = (await req('GET', `/api/work-sessions/${r.data.run.session_id}`, { token: u.token })).data.session;
  assert.match(s.title, /^Morning brief · /); assert.equal(s.kind, 'work');
  const msgs = (await req('GET', `/api/chats/${s.threads[0].id}`, { token: u.token })).data.messages;
  assert.deepEqual(msgs.map((m) => m.role), ['user', 'assistant']);
  assert.match(msgs[0].content, /Summarise my open tasks/);
  assert.ok((await req('GET', '/api/notifications', { token: u.token })).data.notifications.some((n) => /Scheduled task finished: Morning brief/.test(n.title)));
  // Cron: due task runs exactly once, next run moves forward.
  assert.equal((await req('GET', '/api/cron/scheduled')).status, 401);
  process.env.CRON_SECRET = 'cron-test-secret';
  await db.run('UPDATE scheduled_tasks SET next_run_at = ? WHERE id = ?', Date.now() - 60_000, t.id);
  const cr = await req('GET', '/api/cron/scheduled', { headers: { authorization: 'Bearer cron-test-secret' } });
  assert.equal(cr.data.ran.length, 1); assert.equal(cr.data.ran[0].status, 'completed');
  assert.equal((await req('GET', '/api/cron/scheduled', { headers: { authorization: 'Bearer cron-test-secret' } })).data.ran.length, 0, 'not twice');
  const after2 = (await req('GET', '/api/scheduled', { token: u.token })).data.tasks[0];
  assert.ok(after2.next_run_at > Date.now(), 'next run in the future');
  assert.equal((await req('GET', `/api/scheduled/${t.id}/runs`, { token: u.token })).data.runs.length, 2);
  // Disable / edit / isolation / delete.
  assert.equal((await req('PATCH', `/api/scheduled/${t.id}`, { token: u.token, body: { enabled: false } })).data.task.next_run_at, null);
  for (const [m, p2] of [['PATCH', `/api/scheduled/${t.id}`], ['POST', `/api/scheduled/${t.id}/run`], ['DELETE', `/api/scheduled/${t.id}`], ['GET', `/api/scheduled/${t.id}/runs`]]) {
    assert.equal((await req(m, p2, { token: other.token, body: m === 'PATCH' ? { enabled: true } : undefined })).status, 404, `${m} ${p2}`);
  }
  assert.equal((await req('GET', '/api/scheduled', { token: other.token })).data.tasks.length, 0);
  assert.equal((await req('DELETE', `/api/scheduled/${t.id}`, { token: u.token })).status, 200);
});

test('Co Approx: a task run continues server-side and its result stays in the session', async () => {
  const s = (await req('POST', '/api/work-sessions', { token: u.token, body: { workspace: 'work', title: 'Market research' } })).data.session;
  const r = await req('POST', `/api/work-sessions/${s.id}/run`, { token: u.token, body: { instruction: 'List three competitors' } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.agent_run.status, 'completed');
  const d = (await req('GET', `/api/work-sessions/${s.id}`, { token: u.token })).data.session;
  assert.ok(d.agent_runs.some((x) => x.kind === 'task' && x.status === 'completed'));
  const th = d.threads.find((x) => x.id === r.data.agent_run.thread_id);
  assert.equal(th.message_count, 2);
  assert.equal((await req('POST', `/api/work-sessions/${s.id}/run`, { token: other.token, body: { instruction: 'x x' } })).status, 404);
});

test('recents, session history (recent / active / archived, search, filter), artifacts search/rename/share, quiz practice', async () => {
  const chat = (await req('POST', '/api/chats', { token: u.token, body: { title: 'Plain chat' } })).data.chat;
  const art = (await req('POST', '/api/workspace/artifacts', { token: u.token, body: { title: 'Q4 report', kind: 'markdown', content: 'Revenue grew 12%' } })).data.artifact;
  const rec = (await req('GET', '/api/recents', { token: u.token })).data.recents;
  const types = new Set(rec.map((x) => x.type));
  for (const tp of ['chat', 'co_approx', 'code', 'artifact']) assert.ok(types.has(tp), `recents include ${tp}: ${[...types]}`);
  assert.ok(rec.some((x) => x.type === 'chat' && x.id === chat.id));
  assert.deepEqual((await req('GET', '/api/recents', { token: other.token })).data.recents.filter((x) => x.id === chat.id), []);
  const all1 = (await req('GET', '/api/session-history?view=recent', { token: u.token })).data.sessions;
  assert.ok(all1.length >= 3);
  assert.ok(all1.every((x) => x.workspace && x.last_activity && x.created_at));
  assert.ok(all1.some((x) => x.kind === 'code' && x.branch === 'main' && x.project?.name === 'dev-repo'));
  const code = (await req('GET', '/api/session-history?workspace=code', { token: u.token })).data.sessions;
  assert.ok(code.length >= 1 && code.every((x) => x.kind === 'code'));
  const target = all1.find((x) => x.kind === 'work' && /Market research/.test(x.title));
  assert.deepEqual((await req('GET', '/api/session-history?q=competitors', { token: u.token })).data.sessions.map((x) => x.id), [target.id], 'search reaches message text');
  assert.ok((await req('GET', '/api/session-history?view=active', { token: u.token })).data.sessions.some((x) => x.id === target.id));
  await req('PATCH', `/api/work-sessions/${target.id}`, { token: u.token, body: { status: 'archived' } });
  assert.deepEqual((await req('GET', '/api/session-history?view=archived', { token: u.token })).data.sessions.map((x) => x.id), [target.id]);
  assert.deepEqual((await req('GET', '/api/session-history', { token: other.token })).data.sessions, []);
  // Artifacts.
  assert.deepEqual((await req('GET', '/api/artifacts?q=Revenue', { token: u.token })).data.artifacts.map((x) => x.id), [art.id], 'search reaches content');
  assert.equal((await req('PATCH', `/api/artifacts/${art.id}`, { token: other.token, body: { title: 'x' } })).status, 404);
  await req('PATCH', `/api/artifacts/${art.id}`, { token: u.token, body: { title: 'Q4 report (final)' } });
  const sh = await req('POST', `/api/artifacts/${art.id}/share`, { token: u.token });
  const pub = await fetch(`${BASE}/api/shared/artifacts/${sh.data.token}`);
  assert.equal(pub.status, 200);
  const pj = await pub.json();
  assert.deepEqual([pj.artifact.title, pj.artifact.content], ['Q4 report (final)', 'Revenue grew 12%']);
  assert.equal((await req('POST', `/api/artifacts/${art.id}/share`, { token: other.token })).status, 404);
  await req('DELETE', `/api/artifacts/${art.id}/share`, { token: u.token });
  assert.equal((await fetch(`${BASE}/api/shared/artifacts/${sh.data.token}`)).status, 404, 'turning sharing off kills the link');
  // Education: practise a saved quiz again (no answers sent).
  const es = (await req('POST', '/api/work-sessions', { token: u.token, body: { workspace: 'education', title: 'Ch 4' } })).data.session;
  await req('POST', '/api/files', { token: u.token, raw: true, body: 'Ohm law: V = I R. Power P = V I.', headers: { 'x-filename': 'o.txt', 'x-session-id': es.id } });
  const q = (await req('POST', `/api/work-sessions/${es.id}/quiz`, { token: u.token, body: {} })).data.quiz;
  const again = await req('GET', `/api/work-sessions/${es.id}/quiz/${q.artifact_id}`, { token: u.token });
  assert.equal(again.data.quiz.questions.length, q.questions.length);
  assert.ok(again.data.quiz.questions.every((x) => !('answer' in x)));
  assert.equal((await req('GET', `/api/work-sessions/${es.id}/quiz/${q.artifact_id}`, { token: other.token })).status, 404);
});
