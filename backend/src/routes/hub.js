// Navigation hub APIs (API 1.10): Recents, session history, Devices (Code), Scheduled tasks (+ runner), Co Approx
// background runs, Artifacts (search / rename / share).
//
// Everything is owned by the signed-in user and checked on the server. Scheduled runs and Co Approx runs are real:
// each run creates or continues a persistent session + thread, calls the model through the normal engine, and stores
// the messages — nothing is simulated by this module.
import { one, all, run, now, tx, audit } from '../db.js';
import { readJson, sendJson, bad, notFound, newId, str, oneOf, HttpError, clientIp } from '../http.js';
import { requireUser, requireVerified, rateLimit, randomToken, sha256 } from '../security.js';
import { complete } from '../engine.js';
import { notify } from '../notify.js';
import { ensureWorkspace, ownSession, createThread, KINDS } from './worksessions.js';

const ts = () => now();
const DAY = 86400_000;

// ---------------------------------------------------------------- one model turn in a thread, without a client
/** Runs a user message through the engine in a thread and stores both messages. Used by scheduled and background runs. */
export async function runTurn(user, chatId, text, requestId = newId('req_')) {
  const chat = await one('SELECT * FROM chats WHERE id = ? AND user_id = ?', chatId, user.id);
  if (!chat) throw notFound('Thread not found');
  const t0 = ts();
  let out = '';
  const result = await complete({ user, chat, text, requestedModel: chat.model_id, requestedMode: chat.mode, source: 'agent', requestId, onDelta: (d) => { out += d; }, skipMemoryCapture: true });
  const text2 = result.text ?? out;
  await run('INSERT INTO messages (id,chat_id,user_id,role,content,attachments,created_at) VALUES (?,?,?,?,?,?,?)', newId('msg_'), chat.id, user.id, 'user', text, '[]', t0);
  await run('INSERT INTO messages (id,chat_id,user_id,role,content,model_id,model_version,mode,route_reason,status,tokens_in,tokens_out,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
    newId('msg_'), chat.id, user.id, 'assistant', text2, result.route.model.id, result.route.version, result.route.mode, result.route.reason,
    result.refused ? 'refused' : 'complete', result.usage?.prompt_tokens || 0, result.usage?.completion_tokens || 0, Math.max(ts(), t0 + 1));
  await run('UPDATE chats SET updated_at = ? WHERE id = ?', ts(), chat.id);
  if (chat.session_id) await run('UPDATE work_sessions SET updated_at = ? WHERE id = ?', ts(), chat.session_id);
  return { text: text2, model_id: result.route.model.id, refused: !!result.refused };
}

// ---------------------------------------------------------------- schedule arithmetic (IANA time zones, no library)
export function validTimeZone(tz) { try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; } }
function partsIn(ms, tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short' })
    .formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour, mi: +p.minute, wd: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday) };
}
/** Wall-clock time in a zone → UTC milliseconds (DST-aware, two-pass). */
export function zonedToUtc(y, m, d, h, mi, tz) {
  let guess = Date.UTC(y, m - 1, d, h, mi);
  for (let i = 0; i < 2; i++) { const p = partsIn(guess, tz); guess -= Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi) - Date.UTC(y, m - 1, d, h, mi); }
  return guess;
}
/** The first run strictly after `after` (or null when a one-off task already ran). */
export function nextRun(task, after) {
  const start = task.start_at;
  if (task.frequency === 'once') return task.last_run_at ? null : start;
  if (after < start) return start;
  if (task.frequency === 'hourly') return start + (Math.floor((after - start) / 3600_000) + 1) * 3600_000;
  const s = partsIn(start, task.timezone);
  const a = partsIn(after, task.timezone);
  for (let i = 0; i <= 8; i++) {
    const day = new Date(Date.UTC(a.y, a.m - 1, a.d + i));
    const cand = zonedToUtc(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), s.h, s.mi, task.timezone);
    if (cand <= after || cand < start) continue;
    const wd = partsIn(cand, task.timezone).wd;
    if (task.frequency === 'weekdays' && (wd === 0 || wd === 6)) continue;
    if (task.frequency === 'weekly' && wd !== s.wd) continue;
    return cand;
  }
  return null;
}

const FREQ = ['once', 'hourly', 'daily', 'weekdays', 'weekly'];
const TOOLS = ['session_files', 'research_urls', 'artifacts', 'code_repository'];
const taskView = (t, last) => ({ id: t.id, name: t.name, instructions: t.instructions, workspace: t.workspace, project_id: t.project_id, frequency: t.frequency,
  start_at: t.start_at, timezone: t.timezone, enabled: !!t.enabled, tools: JSON.parse(t.tools || '[]'), next_run_at: t.enabled ? t.next_run_at : null,
  last_run_at: t.last_run_at, last_run: last || null, created_at: t.created_at, updated_at: t.updated_at });

/** Executes one scheduled task now: a new Co Approx (or Code / Education) session with the instructions as its first turn. */
export async function executeTask(task, trigger = 'schedule') {
  const user = await one("SELECT * FROM users WHERE id = ? AND status = 'active'", task.user_id);
  if (!user) return null;
  const runId = newId('srn_');
  await run("INSERT INTO scheduled_runs (id,task_id,user_id,trigger,status,started_at) VALUES (?,?,?,?,'running',?)", runId, task.id, user.id, trigger, ts());
  try {
    const w = await ensureWorkspace(user, task.workspace);
    const sid = newId('ses_');
    const when = new Intl.DateTimeFormat('en-GB', { timeZone: task.timezone, dateStyle: 'medium', timeStyle: 'short' }).format(new Date());
    await run('INSERT INTO work_sessions (id,user_id,workspace_id,project_id,kind,title,status,context,created_at,updated_at,last_opened_at) VALUES (?,?,?,?,?,?,?,?,?,?,NULL)',
      sid, user.id, w.id, task.project_id, task.workspace, `${task.name} · ${when}`.slice(0, 120), 'active', `Scheduled task "${task.name}" (${task.frequency}).`, ts(), ts());
    const session = await ownSession(user.id, sid);
    const thread = await createThread(user, session, { title: 'Scheduled run' });
    await run('UPDATE scheduled_runs SET session_id = ? WHERE id = ?', sid, runId);
    const tools = JSON.parse(task.tools || '[]');
    const out = await runTurn(user, thread.id, `${task.instructions}${tools.length ? `\n\n(Tools for this task: ${tools.join(', ')}.)` : ''}`);
    await run("UPDATE scheduled_runs SET status = 'completed', output = ?, finished_at = ? WHERE id = ?", out.text.slice(0, 4000), ts(), runId);
    await run('INSERT INTO tool_executions (id,user_id,session_id,thread_id,tool,input,output,status,created_at) VALUES (?,?,?,?,?,?,?,?,?)',
      newId('tex_'), user.id, sid, thread.id, 'scheduler', task.name, `run ${runId} (${trigger})`, 'ok', ts());
    await notify(user.id, { kind: 'task', title: `Scheduled task finished: ${task.name}`, body: out.text.replace(/\s+/g, ' ').slice(0, 200), link: `#/s/${sid}` });
    return { run_id: runId, session_id: sid, status: 'completed' };
  } catch (e) {
    await run("UPDATE scheduled_runs SET status = 'failed', output = ?, finished_at = ? WHERE id = ?", String(e.message || e).slice(0, 2000), ts(), runId);
    await notify(user.id, { kind: 'task', title: `Scheduled task failed: ${task.name}`, body: String(e.message || e).slice(0, 200), link: '#/scheduled' });
    return { run_id: runId, status: 'failed', error: e.message };
  }
}

/** Runs due tasks (claimed atomically, so two triggers never run the same occurrence twice). */
export async function runDue({ limit = 10, userId = null } = {}) {
  const due = userId
    ? await all('SELECT * FROM scheduled_tasks WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ? AND user_id = ? ORDER BY next_run_at LIMIT ?', ts(), userId, limit)
    : await all('SELECT * FROM scheduled_tasks WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY next_run_at LIMIT ?', ts(), limit);
  const out = [];
  for (const t of due) {
    const after = { ...t, last_run_at: ts() };
    const nxt = nextRun(after, Math.max(ts(), t.next_run_at));
    const claim = await run('UPDATE scheduled_tasks SET next_run_at = ?, last_run_at = ?, enabled = ? WHERE id = ? AND next_run_at = ?',
      nxt, ts(), nxt === null ? 0 : 1, t.id, t.next_run_at);
    if (!claim.changes) continue;   // another trigger took it
    out.push({ task_id: t.id, ...(await executeTask(t, 'schedule')) });
  }
  return out;
}

export function registerHubRoutes(r) {
  // ---------------------------------------------------------------- recents (menu)
  r.get('/api/recents', async (req, res, ctx) => {
    const u = requireUser(ctx);
    await runDue({ limit: 1, userId: u.id }).catch(() => []);   // opportunistic: a due task of yours runs when you open Approx
    const items = [
      ...(await all("SELECT id, title, updated_at at FROM chats WHERE user_id = ? AND session_id IS NULL AND deleted_at IS NULL AND archived = 0 ORDER BY updated_at DESC LIMIT 8", u.id)).map((x) => ({ type: 'chat', ...x })),
      ...(await all("SELECT id, title, kind, COALESCE(last_opened_at, updated_at) at FROM work_sessions WHERE user_id = ? AND status = 'active' ORDER BY at DESC LIMIT 8", u.id)).map((x) => ({ type: x.kind === 'work' ? 'co_approx' : x.kind, id: x.id, title: x.title, at: x.at })),
      ...(await all('SELECT id, title, updated_at at FROM artifacts WHERE user_id = ? ORDER BY updated_at DESC LIMIT 5', u.id)).map((x) => ({ type: 'artifact', ...x })),
      ...(await all('SELECT id, name title, updated_at at FROM scheduled_tasks WHERE user_id = ? ORDER BY updated_at DESC LIMIT 3', u.id)).map((x) => ({ type: 'scheduled', ...x })),
    ].sort((a, b) => b.at - a.at).slice(0, 12);
    sendJson(res, 200, { recents: items });
  });

  // ---------------------------------------------------------------- session history (all workspaces)
  r.get('/api/session-history', async (req, res, ctx, p, url) => {
    const u = requireUser(ctx);
    const view = oneOf(url.searchParams.get('view') || undefined, 'view', ['recent', 'active', 'archived'], 'recent');
    const kind = oneOf(url.searchParams.get('workspace') || undefined, 'workspace', KINDS, null);
    const q = String(url.searchParams.get('q') || '').trim().slice(0, 100);
    const where = ['s.user_id = ?', view === 'archived' ? "s.status = 'archived'" : "s.status = 'active'"];
    const args = [u.id];
    if (kind) { where.push('s.kind = ?'); args.push(kind); }
    if (url.searchParams.get('project_id')) { where.push('s.project_id = ?'); args.push(url.searchParams.get('project_id')); }
    if (q) { where.push('(s.title LIKE ? OR EXISTS (SELECT 1 FROM chats c JOIN messages m ON m.chat_id = c.id WHERE c.session_id = s.id AND m.content LIKE ?))'); args.push(`%${q}%`, `%${q}%`); }
    // Active = something is happening: an agent run in progress, open tasks, or activity in the last 24 hours.
    if (view === 'active') {
      where.push(`(EXISTS (SELECT 1 FROM agent_runs a WHERE a.session_id = s.id AND a.status = 'running') OR EXISTS (SELECT 1 FROM tasks t WHERE t.session_id = s.id AND t.status != 'done') OR s.updated_at > ?)`);
      args.push(ts() - DAY);
    }
    const rows = await all(`SELECT s.*, p.name project_name, d.name device_name,
        (SELECT COUNT(*) FROM chats c WHERE c.session_id = s.id AND c.deleted_at IS NULL) thread_count,
        (SELECT COUNT(*) FROM tasks t WHERE t.session_id = s.id AND t.status != 'done') open_tasks,
        (SELECT status FROM agent_runs a WHERE a.session_id = s.id ORDER BY a.created_at DESC LIMIT 1) last_run_status
      FROM work_sessions s LEFT JOIN projects p ON p.id = s.project_id LEFT JOIN devices d ON d.id = s.device_id
      WHERE ${where.join(' AND ')} ORDER BY COALESCE(s.last_opened_at, s.updated_at) DESC LIMIT 100`, ...args);
    sendJson(res, 200, { sessions: rows.map((s) => ({ id: s.id, kind: s.kind, workspace: s.kind === 'work' ? 'Co Approx' : s.kind === 'code' ? 'Code' : 'Education',
      title: s.title, status: s.last_run_status === 'running' ? 'running' : s.status, project: s.project_id ? { id: s.project_id, name: s.project_name } : null,
      branch: s.branch, device: s.device_id ? { id: s.device_id, name: s.device_name } : null, thread_count: s.thread_count, open_tasks: s.open_tasks,
      created_at: s.created_at, last_activity: Math.max(s.updated_at, s.last_opened_at || 0) })) });
  });

  // ---------------------------------------------------------------- Co Approx: run a task in the session (survives leaving)
  r.post('/api/work-sessions/:id/run', async (req, res, ctx, p) => {
    const u = requireUser(ctx);
    requireVerified(u);
    const s = await ownSession(u.id, p.id);
    await rateLimit(`run:${u.id}`, 60, 3600_000);
    const b = await readJson(req);
    const instruction = str(b.instruction, 'instruction', { min: 2, max: 8000 });
    const thread = b.thread_id ? await one('SELECT id FROM chats WHERE id = ? AND user_id = ? AND session_id = ?', String(b.thread_id), u.id, s.id) : await createThread(u, s, { title: instruction.slice(0, 60) });
    if (!thread) throw notFound('Thread not found in this session');
    const runId = newId('run_');
    await run("INSERT INTO agent_runs (id,user_id,session_id,thread_id,kind,status,input,created_at) VALUES (?,?,?,?,'task','running',?,?)", runId, u.id, s.id, thread.id, instruction, ts());
    // The request keeps running on the server if the person closes the app; the result is stored in the thread and the
    // run is marked completed / failed — the person finds it in the session (and gets a notification).
    try {
      const out = await runTurn(u, thread.id, instruction, ctx.requestId);
      await run("UPDATE agent_runs SET status = 'completed', output = ?, model_id = ?, finished_at = ? WHERE id = ?", out.text.slice(0, 8000), out.model_id, ts(), runId);
      await notify(u.id, { kind: 'task', title: 'Co Approx task finished', body: `${s.title}: ${instruction.slice(0, 120)}`, link: `#/s/${s.id}` });
      sendJson(res, 200, { agent_run: { id: runId, status: 'completed', thread_id: thread.id }, reply: out.text });
    } catch (e) {
      await run("UPDATE agent_runs SET status = 'failed', output = ?, finished_at = ? WHERE id = ?", String(e.message || e).slice(0, 2000), ts(), runId);
      throw e;
    }
  });

  // ---------------------------------------------------------------- devices (Code): pairing + jobs
  r.get('/api/devices', async (req, res, ctx) => {
    const u = requireUser(ctx);
    await run("UPDATE devices SET status = 'revoked' WHERE user_id = ? AND status = 'pending' AND pairing_expires_at < ?", u.id, ts());
    sendJson(res, 200, { devices: (await all("SELECT id, name, status, hostname, platform, last_seen_at, created_at FROM devices WHERE user_id = ? AND status != 'revoked' ORDER BY created_at DESC", u.id))
      .map((d) => ({ ...d, online: d.status === 'connected' && d.last_seen_at && ts() - d.last_seen_at < 90_000 })) });
  });
  // Step 1 (app): a one-time pairing code, valid 10 minutes, shown once.
  r.post('/api/devices', async (req, res, ctx) => {
    const u = requireUser(ctx);
    await rateLimit(`pair:${u.id}`, 20, 3600_000);
    const b = await readJson(req);
    if ((await one("SELECT COUNT(*) n FROM devices WHERE user_id = ? AND status != 'revoked'", u.id)).n >= 10) throw bad('Device limit (10) reached — remove a device first');
    const code = randomToken(6).replace(/[^A-Za-z0-9]/g, 'x').slice(0, 8).toUpperCase();
    const id = newId('dev_');
    await run("INSERT INTO devices (id,user_id,name,status,pairing_code_hash,pairing_expires_at,created_at) VALUES (?,?,?,'pending',?,?,?)",
      id, u.id, str(b.name, 'name', { max: 60, required: false }) || 'My computer', sha256(code), ts() + 10 * 60_000, ts());
    const origin = `https://${req.headers['x-forwarded-host'] || req.headers.host}`;
    sendJson(res, 201, { device: { id, status: 'pending' }, pairing_code: code, expires_in: 600,
      command: `curl -fsSLO ${origin}/tools/approx-device.mjs && node approx-device.mjs pair ${code} --server ${origin}` });
  });
  r.patch('/api/devices/:id', async (req, res, ctx, p) => {
    const u = requireUser(ctx);
    const b = await readJson(req);
    const r2 = await run("UPDATE devices SET name = ? WHERE id = ? AND user_id = ? AND status != 'revoked'", str(b.name, 'name', { min: 1, max: 60 }), p.id, u.id);
    if (!r2.changes) throw notFound('Device not found');
    sendJson(res, 200, { status: 'renamed' });
  });
  r.delete('/api/devices/:id', async (req, res, ctx, p) => {
    const u = requireUser(ctx);
    const r2 = await run("UPDATE devices SET status = 'revoked', token_hash = NULL, pairing_code_hash = NULL WHERE id = ? AND user_id = ?", p.id, u.id);
    if (!r2.changes) throw notFound('Device not found');
    await run("UPDATE device_jobs SET status = 'cancelled' WHERE device_id = ? AND status IN ('queued','running')", p.id);
    await audit(u.id, u.id, 'device.revoked', p.id, clientIp(req));
    sendJson(res, 200, { status: 'revoked' });
  });

  // Step 2 (device agent, no user session): exchange the code for a device token (stored hashed).
  r.post('/api/device/claim', async (req, res) => {
    await rateLimit(`claim:${clientIp(req)}`, 20, 3600_000);
    const b = await readJson(req);
    const d = await one("SELECT * FROM devices WHERE pairing_code_hash = ? AND status = 'pending' AND pairing_expires_at > ?", sha256(String(b.code || '').trim().toUpperCase()), ts());
    if (!d) throw new HttpError(401, 'invalid_code', 'This pairing code is wrong or has expired. Create a new one in Approx → Code → Add device.');
    const token = randomToken(32);
    await run("UPDATE devices SET status = 'connected', token_hash = ?, pairing_code_hash = NULL, hostname = ?, platform = ?, last_seen_at = ? WHERE id = ?",
      sha256(token), String(b.hostname || '').slice(0, 80), String(b.platform || '').slice(0, 40), ts(), d.id);
    await audit(d.user_id, 'device', 'device.connected', d.id, clientIp(req));
    await notify(d.user_id, { kind: 'security', title: 'Device connected', body: `${d.name}${b.hostname ? ` (${String(b.hostname).slice(0, 80)})` : ''} can now run Approx Code commands you start.`, link: '#/code' });
    sendJson(res, 200, { device_id: d.id, device_token: token, name: d.name });
  });
  async function deviceAuth(req) {
    const m = /^Device\s+(\S+)$/.exec(String(req.headers.authorization || ''));
    const d = m ? await one("SELECT * FROM devices WHERE token_hash = ? AND status = 'connected'", sha256(m[1])) : null;
    if (!d) throw new HttpError(401, 'device_unauthorized', 'Unknown or revoked device');
    await run('UPDATE devices SET last_seen_at = ? WHERE id = ?', ts(), d.id);
    return d;
  }
  r.post('/api/device/heartbeat', async (req, res) => { const d = await deviceAuth(req); sendJson(res, 200, { device_id: d.id, name: d.name }); });
  // The agent asks for its next job: the command, and the repository files to run it on.
  r.get('/api/device/jobs/next', async (req, res) => {
    const d = await deviceAuth(req);
    const job = await one("SELECT * FROM device_jobs WHERE device_id = ? AND status = 'queued' ORDER BY created_at LIMIT 1", d.id);
    if (!job) return sendJson(res, 200, { job: null });
    const claim = await run("UPDATE device_jobs SET status = 'running', started_at = ? WHERE id = ? AND status = 'queued'", ts(), job.id);
    if (!claim.changes) return sendJson(res, 200, { job: null });
    const files = await all('SELECT path, content FROM code_files WHERE project_id = ? AND user_id = ? ORDER BY path', job.project_id, d.user_id);
    sendJson(res, 200, { job: { id: job.id, kind: job.kind, command: job.command, project_id: job.project_id, files } });
  });
  r.post('/api/device/jobs/:id/result', async (req, res, ctx, p) => {
    const d = await deviceAuth(req);
    const b = await readJson(req, 512 * 1024);
    const job = await one("SELECT * FROM device_jobs WHERE id = ? AND device_id = ? AND status = 'running'", p.id, d.id);
    if (!job) throw notFound('Job not found');
    const exit = Number.isInteger(b.exit_code) ? b.exit_code : -1;
    const output = String(b.output || '').slice(-64_000);
    await run('UPDATE device_jobs SET status = ?, exit_code = ?, output = ?, finished_at = ? WHERE id = ?', exit === 0 ? 'completed' : 'failed', exit, output, ts(), job.id);
    if (job.tool_execution_id) await run('UPDATE tool_executions SET status = ?, output = ? WHERE id = ?', exit === 0 ? 'ok' : 'error', `exit ${exit} on ${d.name}\n${output.slice(-6000)}`, job.tool_execution_id);
    sendJson(res, 200, { status: 'recorded' });
  });
  r.get('/api/code/jobs/:id', async (req, res, ctx, p) => {
    const u = requireUser(ctx);
    const j = await one('SELECT j.*, d.name device_name FROM device_jobs j JOIN devices d ON d.id = j.device_id WHERE j.id = ? AND j.user_id = ?', p.id, u.id);
    if (!j) throw notFound('Job not found');
    sendJson(res, 200, { job: { id: j.id, kind: j.kind, command: j.command, status: j.status, exit_code: j.exit_code, output: j.output, device: j.device_name,
      created_at: j.created_at, started_at: j.started_at, finished_at: j.finished_at } });
  });

  // ---------------------------------------------------------------- scheduled tasks
  async function ownTask(uid, id) { const t = await one('SELECT * FROM scheduled_tasks WHERE id = ? AND user_id = ?', String(id), uid); if (!t) throw notFound('Scheduled task not found'); return t; }
  async function validTask(u, b, cur = {}) {
    const v = { ...cur };
    if (b.name !== undefined || !cur.id) v.name = str(b.name, 'name', { min: 1, max: 100 });
    if (b.instructions !== undefined || !cur.id) v.instructions = str(b.instructions, 'instructions', { min: 3, max: 8000 });
    if (b.frequency !== undefined || !cur.id) v.frequency = oneOf(b.frequency ?? '', 'frequency', FREQ);
    if (b.timezone !== undefined || !cur.id) { v.timezone = String(b.timezone || 'UTC'); if (!validTimeZone(v.timezone)) throw bad('Unknown time zone'); }
    if (b.start_at !== undefined || !cur.id) {
      // "2026-11-28T09:00" = wall-clock time in the task's time zone (what the person picked), or a timestamp in ms.
      if (Number.isFinite(b.start_at)) v.start_at = Math.floor(b.start_at);
      else { const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(String(b.start_at || '')); if (!m) throw bad('start_at must look like 2026-11-28T09:00'); v.start_at = zonedToUtc(+m[1], +m[2], +m[3], +m[4], +m[5], v.timezone); }
    }
    if (b.workspace !== undefined || !cur.id) v.workspace = oneOf(b.workspace ?? 'work', 'workspace', KINDS);
    if (b.project_id !== undefined) {
      if (b.project_id && !await one('SELECT id FROM projects WHERE id = ? AND user_id = ?', String(b.project_id), u.id)) throw notFound('Project not found');
      v.project_id = b.project_id || null;
    }
    if (b.tools !== undefined) { if (!Array.isArray(b.tools) || b.tools.some((x) => !TOOLS.includes(x))) throw bad(`tools must be a list of: ${TOOLS.join(', ')}`); v.tools = JSON.stringify([...new Set(b.tools)]); }
    if (b.enabled !== undefined) v.enabled = b.enabled ? 1 : 0;
    return v;
  }
  r.get('/api/scheduled', async (req, res, ctx) => {
    const u = requireUser(ctx);
    await runDue({ limit: 2, userId: u.id }).catch(() => []);
    const tasks = await all('SELECT * FROM scheduled_tasks WHERE user_id = ? ORDER BY created_at DESC', u.id);
    sendJson(res, 200, { tasks: await Promise.all(tasks.map(async (t) => taskView(t, await one('SELECT id, status, session_id, started_at, finished_at FROM scheduled_runs WHERE task_id = ? ORDER BY started_at DESC LIMIT 1', t.id)))),
      tools: TOOLS, frequencies: FREQ });
  });
  r.post('/api/scheduled', async (req, res, ctx) => {
    const u = requireUser(ctx);
    await rateLimit(`sched:${u.id}`, 60, 3600_000);
    if ((await one('SELECT COUNT(*) n FROM scheduled_tasks WHERE user_id = ?', u.id)).n >= 50) throw bad('Scheduled task limit (50) reached');
    const v = await validTask(u, await readJson(req));
    const id = newId('sch_');
    const enabled = v.enabled === undefined ? 1 : v.enabled;
    const nxt = enabled ? nextRun({ ...v, last_run_at: null }, ts()) : null;
    await run('INSERT INTO scheduled_tasks (id,user_id,workspace,project_id,name,instructions,frequency,start_at,timezone,enabled,tools,next_run_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      id, u.id, v.workspace, v.project_id || null, v.name, v.instructions, v.frequency, v.start_at, v.timezone, enabled, v.tools || '[]', nxt, ts(), ts());
    sendJson(res, 201, { task: taskView(await ownTask(u.id, id)) });
  });
  r.patch('/api/scheduled/:id', async (req, res, ctx, p) => {
    const u = requireUser(ctx);
    const cur = await ownTask(u.id, p.id);
    const v = await validTask(u, await readJson(req), cur);
    const nxt = v.enabled ? nextRun(v, ts()) : null;
    await run('UPDATE scheduled_tasks SET workspace=?, project_id=?, name=?, instructions=?, frequency=?, start_at=?, timezone=?, enabled=?, tools=?, next_run_at=?, updated_at=? WHERE id = ?',
      v.workspace, v.project_id, v.name, v.instructions, v.frequency, v.start_at, v.timezone, v.enabled, v.tools, nxt, ts(), cur.id);
    sendJson(res, 200, { task: taskView(await ownTask(u.id, cur.id)) });
  });
  r.delete('/api/scheduled/:id', async (req, res, ctx, p) => {
    const u = requireUser(ctx);
    const t = await ownTask(u.id, p.id);
    await run('DELETE FROM scheduled_tasks WHERE id = ?', t.id);   // runs cascade; their sessions stay in Co Approx
    sendJson(res, 200, { status: 'deleted' });
  });
  r.post('/api/scheduled/:id/run', async (req, res, ctx, p) => {
    const u = requireUser(ctx);
    requireVerified(u);
    await rateLimit(`sched-run:${u.id}`, 30, 3600_000);
    const t = await ownTask(u.id, p.id);
    sendJson(res, 200, { run: await executeTask(t, 'manual') });
  });
  r.get('/api/scheduled/:id/runs', async (req, res, ctx, p) => {
    const u = requireUser(ctx);
    const t = await ownTask(u.id, p.id);
    sendJson(res, 200, { runs: await all('SELECT id, trigger, status, session_id, output, started_at, finished_at FROM scheduled_runs WHERE task_id = ? ORDER BY started_at DESC LIMIT 50', t.id) });
  });
  // Scheduler trigger (Vercel Cron or any external cron): Authorization: Bearer $CRON_SECRET.
  const cron = async (req, res) => {
    const secret = process.env.CRON_SECRET || '';
    if (!secret || String(req.headers.authorization || '') !== `Bearer ${secret}`) throw new HttpError(401, 'unauthorized', 'Cron secret required');
    sendJson(res, 200, { ran: await runDue({ limit: 20 }) });
  };
  r.get('/api/cron/scheduled', cron);
  r.post('/api/cron/scheduled', cron);

  // ---------------------------------------------------------------- artifacts: search, rename, share
  r.get('/api/artifacts', async (req, res, ctx, p, url) => {
    const u = requireUser(ctx);
    const q = String(url.searchParams.get('q') || '').trim().slice(0, 100);
    const where = ['a.user_id = ?']; const args = [u.id];
    if (q) { where.push('(a.title LIKE ? OR EXISTS (SELECT 1 FROM artifact_versions v WHERE v.artifact_id = a.id AND v.version = a.current_version AND v.content LIKE ?))'); args.push(`%${q}%`, `%${q}%`); }
    if (url.searchParams.get('kind')) { where.push('a.kind = ?'); args.push(oneOf(url.searchParams.get('kind'), 'kind', ['document', 'code', 'table', 'markdown', 'json', 'html'])); }
    const rows = await all(`SELECT a.id, a.title, a.kind, a.language, a.current_version, a.session_id, a.project_id, a.share_token IS NOT NULL shared, a.created_at, a.updated_at,
      s.title session_title, s.kind session_kind FROM artifacts a LEFT JOIN work_sessions s ON s.id = a.session_id WHERE ${where.join(' AND ')} ORDER BY a.updated_at DESC LIMIT 200`, ...args);
    sendJson(res, 200, { artifacts: rows.map((x) => ({ ...x, shared: !!x.shared })) });
  });
  r.patch('/api/artifacts/:id', async (req, res, ctx, p) => {
    const u = requireUser(ctx);
    const b = await readJson(req);
    const r2 = await run('UPDATE artifacts SET title = ?, updated_at = ? WHERE id = ? AND user_id = ?', str(b.title, 'title', { min: 1, max: 150 }), ts(), p.id, u.id);
    if (!r2.changes) throw notFound('Artifact not found');
    sendJson(res, 200, { status: 'renamed' });
  });
  r.post('/api/artifacts/:id/share', async (req, res, ctx, p) => {
    const u = requireUser(ctx);
    const a = await one('SELECT id, share_token FROM artifacts WHERE id = ? AND user_id = ?', p.id, u.id);
    if (!a) throw notFound('Artifact not found');
    const token = a.share_token || randomToken(18);
    if (!a.share_token) await run('UPDATE artifacts SET share_token = ? WHERE id = ?', token, a.id);
    const origin = `https://${req.headers['x-forwarded-host'] || req.headers.host}`;
    sendJson(res, 200, { url: `${origin}/api/shared/artifacts/${token}`, token });
  });
  r.delete('/api/artifacts/:id/share', async (req, res, ctx, p) => {
    const u = requireUser(ctx);
    const r2 = await run('UPDATE artifacts SET share_token = NULL WHERE id = ? AND user_id = ?', p.id, u.id);
    if (!r2.changes) throw notFound('Artifact not found');
    sendJson(res, 200, { status: 'unshared' });
  });
  // Public, read-only view of a shared artifact (link holders only; revoking the share kills the link).
  r.get('/api/shared/artifacts/:token', async (req, res, ctx, p) => {
    if (!/^[A-Za-z0-9_-]{16,40}$/.test(p.token)) throw notFound('Not found');
    const a = await one('SELECT id, title, kind, language, current_version, updated_at FROM artifacts WHERE share_token = ?', p.token);
    if (!a) throw notFound('This link was turned off or does not exist');
    const v = await one('SELECT content FROM artifact_versions WHERE artifact_id = ? AND version = ?', a.id, a.current_version);
    sendJson(res, 200, { artifact: { title: a.title, kind: a.kind, language: a.language, version: a.current_version, updated_at: a.updated_at, content: v?.content || '' } });
  });

  // ---------------------------------------------------------------- education: practise a saved quiz again
  r.get('/api/work-sessions/:id/quiz/:aid', async (req, res, ctx, p) => {
    const u = requireUser(ctx);
    const s = await ownSession(u.id, p.id);
    const a = await one("SELECT * FROM artifacts WHERE id = ? AND user_id = ? AND session_id = ? AND language = 'quiz'", p.aid, u.id, s.id);
    if (!a) throw notFound('Quiz not found');
    const quiz = JSON.parse((await one('SELECT content FROM artifact_versions WHERE artifact_id = ? AND version = ?', a.id, a.current_version)).content);
    sendJson(res, 200, { quiz: { artifact_id: a.id, title: a.title, questions: quiz.questions.map((q) => ({ question: q.question, options: q.options })) },
      attempts: await all('SELECT score, total, created_at FROM study_attempts WHERE artifact_id = ? AND user_id = ? ORDER BY created_at DESC LIMIT 20', a.id, u.id) });
  });
}
