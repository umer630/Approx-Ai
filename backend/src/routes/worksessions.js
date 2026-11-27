// One session architecture for Approx Work, Approx Code and Approx Education (API 1.9).
//
//   User → Organization → Workspace (work | code | education) → Project (course / repository / project)
//        → Session (persistent server-side identity, own context) → Threads (= chats, each with its own messages)
//        → Tasks / Assignments · Artifacts · Files · AgentRuns · ToolExecutions
//
// A new session is a new row with a new ID and a first thread; it inherits its project's instructions and files but
// never another session's messages. Every query is scoped to the signed-in user: someone else's ID answers 404.
import { one, all, run, now, tx, audit } from '../db.js';
import { readJson, sendJson, bad, notFound, newId, str, oneOf, HttpError, clientIp } from '../http.js';
import { requireUser, requireVerified, rateLimit } from '../security.js';
import { getModel, canUseModel, MODES } from '../models.js';
import { complete, selectPassages } from '../engine.js';
import { unifiedDiff, diffStats } from '../diff.js';
import { notify, workspacePrefs, enforceRetention } from '../notify.js';

export const KINDS = ['work', 'code', 'education'];
const NAMES = { work: 'Approx Work', code: 'Approx Code', education: 'Approx Education' };
const SESSION_TITLES = { work: 'Work session', code: 'Code session', education: 'Study session' };
// Connected apps a workspace can use. None is configured on this server yet; listed honestly as not configured.
const CONNECTOR_CATALOG = [
  { provider: 'github', name: 'GitHub', workspaces: ['code'] },
  { provider: 'google_drive', name: 'Google Drive', workspaces: ['work', 'education'] },
  { provider: 'gmail', name: 'Gmail', workspaces: ['work'] },
  { provider: 'google_calendar', name: 'Google Calendar', workspaces: ['work', 'education'] },
];

async function collect(fn) { let text = ''; const r = await fn((d) => { text += d; }); return { ...r, text: r.text ?? text }; }
const ts = () => now();

/** The person's personal organization and the workspace of this kind (created on first use, idempotent). */
export async function ensureWorkspace(user, kind) {
  let w = await one('SELECT * FROM workspaces WHERE user_id = ? AND kind = ?', user.id, kind);
  if (w) return w;
  await tx(async () => {
    let org = await one("SELECT o.* FROM organizations o JOIN org_members m ON m.org_id = o.id WHERE m.user_id = ? AND m.role = 'owner' ORDER BY o.created_at LIMIT 1", user.id);
    if (!org) {
      const oid = newId('org_');
      await run('INSERT INTO organizations (id,name,owner_user_id,created_at) VALUES (?,?,?,?)', oid, 'Personal', user.id, ts());
      await run("INSERT INTO org_members (org_id,user_id,role,created_at) VALUES (?,?,'owner',?)", oid, user.id, ts());
      org = { id: oid };
    }
    await run('INSERT OR IGNORE INTO workspaces (id,org_id,user_id,kind,name,created_at) VALUES (?,?,?,?,?,?)', newId('wsp_'), org.id, user.id, kind, NAMES[kind], ts());
  });
  return await one('SELECT * FROM workspaces WHERE user_id = ? AND kind = ?', user.id, kind);
}

export async function ownSession(uid, id) {
  const s = await one('SELECT * FROM work_sessions WHERE id = ? AND user_id = ?', String(id), uid);
  if (!s) throw notFound('Session not found');
  return s;
}
async function ownTask(uid, id) {
  const t = await one('SELECT * FROM tasks WHERE id = ? AND user_id = ?', String(id), uid);
  if (!t) throw notFound('Task not found');
  return t;
}
async function ownProjectIn(uid, workspace, id) {
  const p = await one('SELECT * FROM projects WHERE id = ? AND user_id = ? AND (workspace_id = ? OR workspace_id IS NULL)', String(id), uid, workspace.id);
  if (!p) throw notFound('Project not found');
  return p;
}
async function ownCodeProject(uid, id) {
  const p = await one("SELECT * FROM projects WHERE id = ? AND user_id = ? AND kind IN ('fabbox','coeprox') AND (workspace IS NULL OR workspace != 'fab500x')", String(id), uid);
  if (!p) throw notFound('Code project not found');
  return p;
}

/** A thread is a chat that belongs to a session; it inherits the session's project. */
export async function createThread(user, session, { title, model, mode } = {}) {
  const s = await one('SELECT * FROM settings WHERE user_id = ?', user.id);
  const modelId = model && model !== 'auto' ? model : (s.default_model || 'nick-4.8');
  const m = await getModel(modelId);
  if (!m || !await canUseModel(user, m)) throw new HttpError(403, 'model_access_denied', 'Model not available for this account');
  const md = oneOf(mode, 'mode', MODES, s.default_mode);
  const isFab = m.family === 'fab' ? 1 : 0;
  const eligible = !isFab && s.training_opt_in && m.history_training_allowed ? 1 : 0;
  const id = newId('cht_');
  await run('INSERT INTO chats (id,user_id,project_id,session_id,title,model_id,mode,training_eligible,is_fab,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
    id, user.id, session.project_id || null, session.id, String(title || 'Main thread').slice(0, 120), m.id, md, eligible, isFab, ts(), ts());
  await run('UPDATE work_sessions SET updated_at = ? WHERE id = ?', ts(), session.id);
  return await one('SELECT id, title, model_id, mode, created_at, updated_at FROM chats WHERE id = ?', id);
}

async function logTool(user, session, tool, input, output, status, extra = {}) {
  const id = newId('tex_');
  await run('INSERT INTO tool_executions (id,user_id,session_id,thread_id,agent_run_id,tool,input,output,status,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
    id, user.id, session.id, extra.thread_id || null, extra.agent_run_id || null, tool, String(input).slice(0, 4000), String(output).slice(0, 8000), status, ts());
  return id;
}

const taskView = (t) => ({ id: t.id, session_id: t.session_id, thread_id: t.thread_id, title: t.title, detail: t.detail, kind: t.kind, status: t.status,
  due_at: t.due_at, overdue: !!(t.due_at && t.status !== 'done' && t.due_at < Date.now()), created_by: t.created_by, created_at: t.created_at, updated_at: t.updated_at });
const dueAt = (v) => { if (v === null) return null; if (!Number.isFinite(v) || v < 0 || v > 4102444800000) throw bad('due_at must be a timestamp in milliseconds, or null'); return Math.floor(v); };

async function sessionSummary(s) {
  const threads = (await one('SELECT COUNT(*) n FROM chats WHERE session_id = ? AND user_id = ? AND deleted_at IS NULL', s.id, s.user_id)).n;
  const open = (await one("SELECT COUNT(*) n FROM tasks WHERE session_id = ? AND status != 'done'", s.id)).n;
  const project = s.project_id ? await one('SELECT id, name FROM projects WHERE id = ?', s.project_id) : null;
  const device = s.device_id ? await one('SELECT id, name, status, last_seen_at FROM devices WHERE id = ?', s.device_id) : null;
  return { id: s.id, kind: s.kind, title: s.title, status: s.status, project, branch: s.branch || null, device, thread_count: threads, open_tasks: open,
    created_at: s.created_at, updated_at: s.updated_at, last_opened_at: s.last_opened_at };
}

async function sessionDetail(s) {
  return {
    ...(await sessionSummary(s)), context: s.context, workspace_id: s.workspace_id,
    threads: await all('SELECT id, title, model_id, mode, created_at, updated_at, (SELECT COUNT(*) FROM messages m WHERE m.chat_id = chats.id) AS message_count FROM chats WHERE session_id = ? AND user_id = ? AND deleted_at IS NULL ORDER BY created_at', s.id, s.user_id),
    tasks: (await all('SELECT * FROM tasks WHERE session_id = ? AND user_id = ? ORDER BY position, created_at', s.id, s.user_id)).map(taskView),
    files: await all('SELECT id, filename, kind, size, extracted_text IS NOT NULL AS has_text, created_at FROM files WHERE session_id = ? AND user_id = ? ORDER BY created_at', s.id, s.user_id),
    artifacts: await all('SELECT id, title, kind, language, current_version, updated_at FROM artifacts WHERE session_id = ? AND user_id = ? ORDER BY updated_at DESC', s.id, s.user_id),
    agent_runs: await all('SELECT id, kind, status, model_id, created_at, finished_at FROM agent_runs WHERE session_id = ? AND user_id = ? ORDER BY created_at DESC LIMIT 20', s.id, s.user_id),
    logs: await all('SELECT id, tool, status, input, output, thread_id, created_at FROM tool_executions WHERE session_id = ? AND user_id = ? ORDER BY created_at DESC LIMIT 50', s.id, s.user_id),
    // Code sessions: the agent's change proposals for this repository (pending ones wait for review).
    proposals: s.kind === 'code' && s.project_id ? (await all("SELECT id, summary, status, changes, session_id, created_at FROM code_proposals WHERE project_id = ? AND user_id = ? ORDER BY created_at DESC LIMIT 20", s.project_id, s.user_id))
      .map((x) => ({ id: x.id, summary: x.summary, status: x.status, session_id: x.session_id, created_at: x.created_at, files: JSON.parse(x.changes).map((c) => `${c.op === 'delete' ? '−' : '+'} ${c.path}`) })) : [],
  };
}

/** Context every thread of a session shares: the session's own notes, its documents and its task list. */
export async function sessionContext(userId, sessionId, query, selectPassages) {
  const s = await one('SELECT * FROM work_sessions WHERE id = ? AND user_id = ?', sessionId, userId);
  if (!s) return '';
  let out = `\n\n# ${NAMES[s.kind]} session: ${s.title}\nThis conversation is one thread of this session. Use only this session's material and messages; other sessions are separate.`;
  if (s.kind === 'education') {
    out += '\nYou are the student\'s teacher: explain step by step, ground answers, quizzes and exercises in the session documents and say when the material does not cover something. Reply in the student\'s language (English, اردو or Roman Urdu).';
    const style = (await workspacePrefs(userId)).education.explanation_style;
    out += { simple: '\nExplanation style: simple — everyday words, short steps, one example each.', detailed: '\nExplanation style: detailed — full derivations, definitions and several examples.',
      exam: '\nExplanation style: exam-focused — key points, definitions and formulas to memorise, typical exam questions with model answers.' }[style] || '';
  }
  if (s.kind === 'code') out += '\nThis is a coding session: give complete, runnable code with the file path above each block. You cannot run commands; say when something must be run by the user.';
  if (s.context) out += `\nSession notes:\n${s.context.slice(0, 4000)}`;
  const tasks = await all('SELECT title, status, kind FROM tasks WHERE session_id = ? ORDER BY position, created_at LIMIT 40', s.id);
  if (tasks.length) out += '\nSession tasks:\n' + tasks.map((t) => `- [${t.status}] ${t.kind === 'assignment' ? '(assignment) ' : ''}${t.title}`).join('\n');
  const files = await all("SELECT filename, extracted_text FROM files WHERE session_id = ? AND user_id = ? AND extracted_text IS NOT NULL AND scan_status = 'clean'", s.id, userId);
  if (files.length) for (const [name, parts] of selectPassages(files, query, s.kind === 'education' ? 14000 : 8000)) out += `\n## Session document: ${name}\n${parts.join('\n…\n')}\n`;
  if (s.kind === 'code' && s.project_id) {
    const tree = await all('SELECT path, length(content) size FROM code_files WHERE project_id = ? AND user_id = ? ORDER BY path LIMIT 300', s.project_id, userId);
    if (tree.length) out += `\n## Repository files\n${tree.map((f) => `${f.path} (${f.size} B)`).join('\n')}\n`;
  }
  return out;
}

// ---------------------------------------------------------------- code: commits / branches (virtual git over code_files)
async function snapshotOf(pid, uid) {
  const files = await all('SELECT path, content FROM code_files WHERE project_id = ? AND user_id = ? ORDER BY path', pid, uid);
  return Object.fromEntries(files.map((f) => [f.path, f.content]));
}
async function currentBranch(p) {
  const name = p.current_branch || 'main';
  let b = await one('SELECT * FROM code_branches WHERE project_id = ? AND name = ?', p.id, name);
  if (!b) { await run('INSERT OR IGNORE INTO code_branches (project_id,name,head_commit_id,created_at) VALUES (?,?,NULL,?)', p.id, name, ts()); b = { name, head_commit_id: null }; }
  return b;
}
async function headSnapshot(b) {
  if (!b.head_commit_id) return {};
  return JSON.parse((await one('SELECT snapshot FROM code_commits WHERE id = ?', b.head_commit_id)).snapshot);
}
function changes(head, work) {
  const out = [];
  for (const p of new Set([...Object.keys(head), ...Object.keys(work)])) {
    if (!(p in head)) out.push({ path: p, status: 'added' });
    else if (!(p in work)) out.push({ path: p, status: 'deleted' });
    else if (head[p] !== work[p]) out.push({ path: p, status: 'modified' });
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}
const BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,59}$/;

function parseJson(text) { const m = String(text).match(/\{[\s\S]*\}/); return JSON.parse(m ? m[0] : text); }

export function registerWorkSessionRoutes(r) {
  // ---------------------------------------------------------------- workspaces
  r.get('/api/workspaces', async (req, res, ctx) => {
    const u = requireUser(ctx);
    const out = [];
    for (const k of KINDS) {
      const w = await ensureWorkspace(u, k);
      out.push({ id: w.id, kind: k, name: w.name, org_id: w.org_id,
        sessions: (await one("SELECT COUNT(*) n FROM work_sessions WHERE workspace_id = ? AND status = 'active'", w.id)).n,
        open_tasks: (await one("SELECT COUNT(*) n FROM tasks t JOIN work_sessions s ON s.id = t.session_id WHERE s.workspace_id = ? AND t.status != 'done'", w.id)).n });
    }
    sendJson(res, 200, { workspaces: out });
  });

  // Overview of one workspace: everything its home screen shows, from the server.
  r.get('/api/workspaces/:kind', async (req, res, ctx, p) => {
    const u = requireUser(ctx);
    const kind = oneOf(p.kind, 'workspace', KINDS);
    const w = await ensureWorkspace(u, kind);
    const sessions = await all("SELECT * FROM work_sessions WHERE workspace_id = ? AND user_id = ? AND status = 'active' ORDER BY COALESCE(last_opened_at, updated_at) DESC LIMIT 20", w.id, u.id);
    const projects = await all('SELECT id, name, description, kind, created_at, updated_at, (SELECT COUNT(*) FROM work_sessions s WHERE s.project_id = projects.id) AS session_count FROM projects WHERE workspace_id = ? AND user_id = ? ORDER BY updated_at DESC', w.id, u.id);
    const tasks = await all(`SELECT t.* FROM tasks t JOIN work_sessions s ON s.id = t.session_id WHERE s.workspace_id = ? AND t.user_id = ? AND t.status != 'done'
      ORDER BY COALESCE(t.due_at, 9e15), t.created_at LIMIT 30`, w.id, u.id);
    const files = await all(`SELECT f.id, f.filename, f.kind, f.size, f.session_id, f.created_at FROM files f JOIN work_sessions s ON s.id = f.session_id
      WHERE s.workspace_id = ? AND f.user_id = ? ORDER BY f.created_at DESC LIMIT 20`, w.id, u.id);
    const artifacts = await all(`SELECT a.id, a.title, a.kind, a.session_id, a.updated_at FROM artifacts a JOIN work_sessions s ON s.id = a.session_id
      WHERE s.workspace_id = ? AND a.user_id = ? ORDER BY a.updated_at DESC LIMIT 20`, w.id, u.id);
    const connected = await all('SELECT provider, status, created_at FROM connectors WHERE user_id = ? AND (workspace_id = ? OR workspace_id IS NULL)', u.id, w.id);
    const body = { workspace: { id: w.id, kind, name: w.name, org_id: w.org_id },
      sessions: await Promise.all(sessions.map(sessionSummary)), projects, active_tasks: tasks.map(taskView), files, artifacts,
      connectors: CONNECTOR_CATALOG.filter((c) => c.workspaces.includes(kind)).map((c) => ({ provider: c.provider, name: c.name,
        status: connected.find((x) => x.provider === c.provider)?.status || 'not_configured' })) };
    if (kind === 'education') {
      const rows = await all(`SELECT s.project_id, COUNT(a.id) attempts, COALESCE(SUM(a.score),0) score, COALESCE(SUM(a.total),0) total FROM study_attempts a
        JOIN work_sessions s ON s.id = a.session_id WHERE a.user_id = ? GROUP BY s.project_id`, u.id);
      const done = await all(`SELECT s.project_id, SUM(t.status = 'done') done, COUNT(t.id) total FROM tasks t JOIN work_sessions s ON s.id = t.session_id
        WHERE t.user_id = ? AND s.workspace_id = ? GROUP BY s.project_id`, u.id, w.id);
      body.progress = { quiz_attempts: rows.reduce((n, x) => n + x.attempts, 0),
        average_percent: rows.reduce((n, x) => n + x.total, 0) ? Math.round(100 * rows.reduce((n, x) => n + x.score, 0) / rows.reduce((n, x) => n + x.total, 0)) : null,
        by_course: projects.map((pr) => { const q = rows.find((x) => x.project_id === pr.id); const t = done.find((x) => x.project_id === pr.id);
          return { project_id: pr.id, name: pr.name, quiz_attempts: q?.attempts || 0, average_percent: q?.total ? Math.round(100 * q.score / q.total) : null,
            assignments_done: t?.done || 0, assignments_total: t?.total || 0 }; }) };
    }
    sendJson(res, 200, body);
  });

  // Projects of a workspace: Work projects, Code repositories, Education courses/subjects.
  r.post('/api/workspaces/:kind/projects', async (req, res, ctx, p) => {
    const u = requireUser(ctx);
    const kind = oneOf(p.kind, 'workspace', KINDS);
    const w = await ensureWorkspace(u, kind);
    const b = await readJson(req);
    if ((await one('SELECT COUNT(*) c FROM projects WHERE user_id = ?', u.id)).c >= 300) throw bad('Project limit reached');
    const id = newId('prj_');
    const branch = (await workspacePrefs(u.id)).code.default_branch;
    await run('INSERT INTO projects (id,user_id,name,description,instructions,kind,purpose,workspace_id,current_branch,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      id, u.id, str(b.name, 'name', { min: 1, max: 100 }), str(b.description, 'description', { max: 1000, required: false }) || '',
      str(b.instructions, 'instructions', { max: 8000, required: false }) || '', kind === 'code' ? 'fabbox' : 'knowledge', kind, w.id, kind === 'code' ? branch : null, ts(), ts());
    if (kind === 'code') await run('INSERT INTO code_branches (project_id,name,head_commit_id,created_at) VALUES (?,?,NULL,?)', id, branch, ts());
    sendJson(res, 201, { project: await one('SELECT id, name, description, instructions, kind, purpose, workspace_id, current_branch, created_at FROM projects WHERE id = ?', id) });
  });

  // ---------------------------------------------------------------- sessions
  r.get('/api/work-sessions', async (req, res, ctx, p, url) => {
    const u = requireUser(ctx);
    await enforceRetention(u.id);
    const kind = oneOf(url.searchParams.get('workspace') || undefined, 'workspace', KINDS, null);
    const status = oneOf(url.searchParams.get('status') || undefined, 'status', ['active', 'archived'], 'active');
    const q = String(url.searchParams.get('q') || '').trim().slice(0, 100);
    const where = ['s.user_id = ?', 's.status = ?']; const args = [u.id, status];
    if (kind) { where.push('s.kind = ?'); args.push(kind); }
    if (url.searchParams.get('project_id')) { where.push('s.project_id = ?'); args.push(url.searchParams.get('project_id')); }
    if (q) { where.push(`(s.title LIKE ? OR EXISTS (SELECT 1 FROM chats c JOIN messages m ON m.chat_id = c.id WHERE c.session_id = s.id AND m.content LIKE ?))`); args.push(`%${q}%`, `%${q}%`); }
    const rows = await all(`SELECT s.* FROM work_sessions s WHERE ${where.join(' AND ')} ORDER BY COALESCE(s.last_opened_at, s.updated_at) DESC LIMIT 100`, ...args);
    sendJson(res, 200, { sessions: await Promise.all(rows.map(sessionSummary)) });
  });

  r.post('/api/work-sessions', async (req, res, ctx) => {
    const u = requireUser(ctx);
    await rateLimit(`worksession:${u.id}`, 120, 3600_000);
    const b = await readJson(req);
    const kind = oneOf(b.workspace ?? '', 'workspace', KINDS);
    const w = await ensureWorkspace(u, kind);
    const project = b.project_id ? await ownProjectIn(u.id, w, b.project_id) : null;
    let file = null;
    if (b.file_id) {
      file = await one('SELECT * FROM files WHERE id = ? AND user_id = ?', String(b.file_id), u.id);
      if (!file) throw notFound('File not found');
      if (file.scan_status !== 'clean') throw new HttpError(403, 'attachment_blocked', `${file.filename} did not pass the security scan`);
      if (kind === 'education' && (!file.extracted_text || file.extracted_text.trim().length < 40)) {
        throw new HttpError(422, 'no_text', `Approx couldn't read any text in ${file.filename}. Scanned (photo) PDFs have no text layer — export it as a text PDF and upload again.`);
      }
    }
    if ((await one('SELECT COUNT(*) c FROM work_sessions WHERE user_id = ?', u.id)).c >= 2000) throw bad('Session limit reached — delete old sessions first', 'session_limit');
    const label = file ? file.filename.replace(/\.[^.]+$/, '') : project ? project.name : new Date().toISOString().slice(0, 16).replace('T', ' ');
    const title = str(b.title, 'title', { max: 120, required: false }) || `${SESSION_TITLES[kind]} · ${label}`;
    // Code sessions: the repository branch to work on (switched now if the working tree is clean) and, optionally, the
    // person's paired device that runs Terminal / Run / Test / Build for this session.
    let branch = null, deviceId = null;
    if (kind === 'code' && project) {
      branch = project.current_branch || 'main';
      if (b.branch && b.branch !== branch) {
        if (!await one('SELECT 1 FROM code_branches WHERE project_id = ? AND name = ?', project.id, String(b.branch))) throw notFound('Branch not found');
        const head = await headSnapshot(await currentBranch(project));
        if (changes(head, await snapshotOf(project.id, u.id)).length) throw new HttpError(409, 'uncommitted_changes', 'Commit the repository changes before starting a session on another branch.');
        const target = await one('SELECT * FROM code_branches WHERE project_id = ? AND name = ?', project.id, String(b.branch));
        const snap = await headSnapshot(target);
        await tx(async () => {
          await run('DELETE FROM code_files WHERE project_id = ? AND user_id = ?', project.id, u.id);
          for (const [path, content] of Object.entries(snap)) await run('INSERT INTO code_files (project_id,user_id,path,content,updated_at) VALUES (?,?,?,?,?)', project.id, u.id, path, content, ts());
          await run('UPDATE projects SET current_branch = ? WHERE id = ?', target.name, project.id);
        });
        branch = target.name;
      }
    }
    if (b.device_id) {
      if (!await one("SELECT id FROM devices WHERE id = ? AND user_id = ? AND status = 'connected'", String(b.device_id), u.id)) throw notFound('Device not found or not connected');
      deviceId = String(b.device_id);
    }
    const id = newId('ses_');
    await run('INSERT INTO work_sessions (id,user_id,workspace_id,project_id,kind,title,status,context,branch,device_id,created_at,updated_at,last_opened_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
      id, u.id, w.id, project?.id || null, kind, title, 'active', str(b.context, 'context', { max: 8000, required: false }) || '', branch, deviceId, ts(), ts(), ts());
    const s = await ownSession(u.id, id);
    if (file) await run('UPDATE files SET session_id = ? WHERE id = ? AND user_id = ?', id, file.id, u.id);
    const thread = await createThread(u, s, { title: 'Main thread', model: b.model, mode: b.mode });
    await audit(u.id, u.id, 'session.created', id, clientIp(req), { kind });
    sendJson(res, 201, { session: await sessionDetail(await ownSession(u.id, id)), thread });
  });

  r.get('/api/work-sessions/:id', async (req, res, ctx, p) => {
    const u = requireUser(ctx);
    const s = await ownSession(u.id, p.id);
    await run('UPDATE work_sessions SET last_opened_at = ? WHERE id = ?', ts(), s.id);   // "continue where I left off"
    sendJson(res, 200, { session: await sessionDetail(await ownSession(u.id, p.id)) });
  });

  r.patch('/api/work-sessions/:id', async (req, res, ctx, p) => {
    const u = requireUser(ctx);
    const s = await ownSession(u.id, p.id);
    const b = await readJson(req);
    if (b.title !== undefined) await run('UPDATE work_sessions SET title = ? WHERE id = ?', str(b.title, 'title', { min: 1, max: 120 }), s.id);
    if (b.status !== undefined) await run('UPDATE work_sessions SET status = ? WHERE id = ?', oneOf(b.status, 'status', ['active', 'archived']), s.id);
    if (b.context !== undefined) await run('UPDATE work_sessions SET context = ? WHERE id = ?', str(b.context, 'context', { max: 8000, required: false }) || '', s.id);
    await run('UPDATE work_sessions SET updated_at = ? WHERE id = ?', ts(), s.id);
    sendJson(res, 200, { session: await sessionDetail(await ownSession(u.id, s.id)) });
  });

  r.delete('/api/work-sessions/:id', async (req, res, ctx, p) => {
    const u = requireUser(ctx);
    const s = await ownSession(u.id, p.id);
    await tx(async () => {
      await run('DELETE FROM chats WHERE session_id = ? AND user_id = ?', s.id, u.id);       // threads + their messages
      await run('UPDATE files SET session_id = NULL WHERE session_id = ? AND user_id = ?', s.id, u.id);   // files stay in Files
      await run('UPDATE artifacts SET session_id = NULL WHERE session_id = ? AND user_id = ?', s.id, u.id);
      await run('DELETE FROM work_sessions WHERE id = ? AND user_id = ?', s.id, u.id);       // tasks, runs, logs cascade
    });
    await audit(u.id, u.id, 'session.deleted', s.id, clientIp(req));
    sendJson(res, 200, { status: 'deleted' });
  });

  // Duplicate: a new, independent session (new ID) with the same project, notes, tasks and a copy of each thread.
  r.post('/api/work-sessions/:id/duplicate', async (req, res, ctx, p) => {
    const u = requireUser(ctx);
    const s = await ownSession(u.id, p.id);
    const id = newId('ses_');
    await tx(async () => {
      await run('INSERT INTO work_sessions (id,user_id,workspace_id,project_id,kind,title,status,context,created_at,updated_at,last_opened_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
        id, u.id, s.workspace_id, s.project_id, s.kind, `${s.title} (copy)`.slice(0, 120), 'active', s.context, ts(), ts(), ts());
      for (const c of await all('SELECT * FROM chats WHERE session_id = ? AND user_id = ? AND deleted_at IS NULL ORDER BY created_at', s.id, u.id)) {
        const cid = newId('cht_');
        await run('INSERT INTO chats (id,user_id,project_id,session_id,title,model_id,mode,training_eligible,is_fab,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
          cid, u.id, c.project_id, id, c.title, c.model_id, c.mode, c.training_eligible, c.is_fab, ts(), ts());
        for (const m of await all("SELECT * FROM messages WHERE chat_id = ? AND user_id = ? AND status = 'complete' ORDER BY created_at", c.id, u.id)) {
          await run('INSERT INTO messages (id,chat_id,user_id,role,content,model_id,model_version,mode,route_reason,attachments,status,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
            newId('msg_'), cid, u.id, m.role, m.content, m.model_id, m.model_version, m.mode, m.route_reason, m.attachments, 'complete', m.created_at);
        }
      }
      for (const t of await all('SELECT * FROM tasks WHERE session_id = ? AND user_id = ?', s.id, u.id)) {
        await run('INSERT INTO tasks (id,user_id,session_id,thread_id,title,detail,kind,status,due_at,position,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
          newId('tsk_'), u.id, id, null, t.title, t.detail, t.kind, t.status, t.due_at, t.position, t.created_by, ts(), ts());
      }
    });
    sendJson(res, 201, { session: await sessionDetail(await ownSession(u.id, id)) });
  });

  // ---------------------------------------------------------------- threads
  r.post('/api/work-sessions/:id/threads', async (req, res, ctx, p) => {
    const u = requireUser(ctx);
    const s = await ownSession(u.id, p.id);
    if ((await one('SELECT COUNT(*) n FROM chats WHERE session_id = ?', s.id)).n >= 100) throw bad('Thread limit (100) reached for this session');
    const b = await readJson(req);
    sendJson(res, 201, { thread: await createThread(u, s, { title: str(b.title, 'title', { max: 120, required: false }) || 'New thread', model: b.model, mode: b.mode }) });
  });

  // ---------------------------------------------------------------- tasks / assignments
  r.post('/api/work-sessions/:id/tasks', async (req, res, ctx, p) => {
    const u = requireUser(ctx);
    const s = await ownSession(u.id, p.id);
    const b = await readJson(req);
    if ((await one('SELECT COUNT(*) n FROM tasks WHERE session_id = ?', s.id)).n >= 200) throw bad('Task limit (200) reached for this session');
    const title = str(b.title, 'title', { min: 1, max: 200 });
    const thread = b.thread === true ? await createThread(u, s, { title }) : null;
    const id = newId('tsk_');
    const pos = (await one('SELECT COALESCE(MAX(position),0)+1 n FROM tasks WHERE session_id = ?', s.id)).n;
    await run('INSERT INTO tasks (id,user_id,session_id,thread_id,title,detail,kind,status,due_at,position,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
      id, u.id, s.id, thread?.id || null, title, str(b.detail, 'detail', { max: 4000, required: false }) || '', oneOf(b.kind, 'kind', ['task', 'assignment'], 'task'),
      'todo', b.due_at === undefined ? null : dueAt(b.due_at), pos, 'user', ts(), ts());
    sendJson(res, 201, { task: taskView(await ownTask(u.id, id)), thread });
  });
  r.patch('/api/tasks/:id', async (req, res, ctx, p) => {
    const u = requireUser(ctx);
    const t = await ownTask(u.id, p.id);
    const b = await readJson(req);
    if (b.status !== undefined) await run('UPDATE tasks SET status = ? WHERE id = ?', oneOf(b.status, 'status', ['todo', 'in_progress', 'done', 'blocked']), t.id);
    if (b.title !== undefined) await run('UPDATE tasks SET title = ? WHERE id = ?', str(b.title, 'title', { min: 1, max: 200 }), t.id);
    if (b.detail !== undefined) await run('UPDATE tasks SET detail = ? WHERE id = ?', str(b.detail, 'detail', { max: 4000, required: false }) || '', t.id);
    if (b.due_at !== undefined) await run('UPDATE tasks SET due_at = ? WHERE id = ?', dueAt(b.due_at), t.id);
    await run('UPDATE tasks SET updated_at = ? WHERE id = ?', ts(), t.id);
    sendJson(res, 200, { task: taskView(await ownTask(u.id, t.id)) });
  });
  r.delete('/api/tasks/:id', async (req, res, ctx, p) => {
    const u = requireUser(ctx);
    const t = await ownTask(u.id, p.id);
    await run('DELETE FROM tasks WHERE id = ? AND user_id = ?', t.id, u.id);
    sendJson(res, 200, { status: 'deleted' });
  });

  // Agent: break a goal into tasks, each with its own thread (logical units instead of one giant chat).
  r.post('/api/work-sessions/:id/plan', async (req, res, ctx, p) => {
    const u = requireUser(ctx);
    requireVerified(u);
    const s = await ownSession(u.id, p.id);
    await rateLimit(`plan:${u.id}`, 30, 3600_000);
    const b = await readJson(req);
    const goal = str(b.goal, 'goal', { min: 3, max: 4000 });
    const runId = newId('run_');
    await run("INSERT INTO agent_runs (id,user_id,session_id,kind,status,input,created_at) VALUES (?,?,?,'plan','running',?,?)", runId, u.id, s.id, goal, ts());
    let parsed, out;
    try {
      out = await collect(async (onDelta) => await complete({ user: u, chat: null, text: goal, requestedModel: b.model || 'auto', requestedMode: 'high', source: 'work-plan',
        requestId: ctx.requestId, onDelta, history: [], skipMemoryCapture: true,
        systemExtra: `TASKPLAN_JSON_PROTOCOL. Break the user's goal for the ${NAMES[s.kind]} session "${s.title}" into 2–8 concrete tasks. ` +
          'Respond with ONLY a JSON object: {"tasks": [{"title": string, "detail": string}]}.' }));
      if (out.refused) throw new HttpError(422, 'refused', out.text);
      parsed = parseJson(out.text);
      if (!Array.isArray(parsed.tasks) || !parsed.tasks.length) throw new Error('no tasks');
    } catch (e) {
      await run("UPDATE agent_runs SET status = 'failed', output = ?, finished_at = ? WHERE id = ?", String(out?.text || e.message).slice(0, 8000), ts(), runId);
      await logTool(u, s, 'task_planner', goal, out?.text || e.message, 'error', { agent_run_id: runId });
      if (e instanceof HttpError) throw e;
      throw new HttpError(502, 'agent_bad_output', 'The model did not return a task plan. Try again or rephrase the goal.');
    }
    const created = [];
    const planThreads = (await workspacePrefs(u.id)).work.plan_threads;
    let pos = (await one('SELECT COALESCE(MAX(position),0) n FROM tasks WHERE session_id = ?', s.id)).n;
    for (const t of parsed.tasks.slice(0, 8)) {
      const title = String(t.title || '').trim().slice(0, 200);
      if (!title) continue;
      const thread = planThreads ? await createThread(u, s, { title }) : null;
      const id = newId('tsk_');
      await run("INSERT INTO tasks (id,user_id,session_id,thread_id,title,detail,kind,status,position,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,'task','todo',?,'agent',?,?)",
        id, u.id, s.id, thread?.id || null, title, String(t.detail || '').slice(0, 4000), ++pos, ts(), ts());
      created.push(taskView(await ownTask(u.id, id)));
    }
    await run("UPDATE agent_runs SET status = 'completed', output = ?, model_id = ?, finished_at = ? WHERE id = ?", JSON.stringify(parsed).slice(0, 8000), out.route?.model?.id || null, ts(), runId);
    await logTool(u, s, 'task_planner', goal, `${created.length} tasks${planThreads ? ', each with its own thread' : ''}`, 'ok', { agent_run_id: runId });
    await notify(u.id, { kind: 'task', title: 'Plan ready', body: `${s.title}: ${created.length} tasks planned for "${goal.slice(0, 120)}"`, link: `#/s/${s.id}/Tasks` });
    sendJson(res, 201, { agent_run: { id: runId, status: 'completed' }, tasks: created });
  });

  // Remove a file from a session (it stays in Files; DELETE /api/files/:id deletes it everywhere).
  r.delete('/api/work-sessions/:id/files/:fid', async (req, res, ctx, p) => {
    const u = requireUser(ctx);
    const s = await ownSession(u.id, p.id);
    const r2 = await run('UPDATE files SET session_id = NULL WHERE id = ? AND user_id = ? AND session_id = ?', p.fid, u.id, s.id);
    if (!r2.changes) throw notFound('File not found in this session');
    sendJson(res, 200, { status: 'removed' });
  });

  // ---------------------------------------------------------------- education: flashcards + study plan
  async function generate(u, s, kind, protocol, text, b, ctx) {
    const topic = str(b.topic, 'topic', { max: 300, required: false }) || 'the whole material';
    const ctxText = await sessionContext(u.id, s.id, topic, selectPassages);
    const runId = newId('run_');
    await run("INSERT INTO agent_runs (id,user_id,session_id,kind,status,input,created_at) VALUES (?,?,?,?,'running',?,?)", runId, u.id, s.id, kind, text, ts());
    let out, parsed;
    try {
      out = await collect(async (onDelta) => await complete({ user: u, chat: null, text, requestedModel: b.model || 'auto', requestedMode: 'high', source: `education-${kind}`,
        requestId: ctx.requestId, onDelta, history: [], skipMemoryCapture: true, systemExtra: `${protocol}${ctxText}` }));
      parsed = parseJson(out.text);
    } catch {
      await run("UPDATE agent_runs SET status = 'failed', output = ?, finished_at = ? WHERE id = ?", String(out?.text || '').slice(0, 8000), ts(), runId);
      await logTool(u, s, `${kind}_generator`, topic, out?.text || 'no output', 'error', { agent_run_id: runId });
      throw new HttpError(502, 'agent_bad_output', `The model did not return valid ${kind === 'flashcards' ? 'flashcards' : 'study plan'}. Try again.`);
    }
    return { parsed, runId, out, topic };
  }

  r.post('/api/work-sessions/:id/flashcards', async (req, res, ctx, p) => {
    const u = requireUser(ctx);
    requireVerified(u);
    const s = await ownSession(u.id, p.id);
    await rateLimit(`quiz:${u.id}`, 30, 3600_000);
    const b = await readJson(req);
    const count = Math.max(4, Math.min(40, Number(b.count) || 12));
    const { parsed, runId, out, topic } = await generate(u, s, 'flashcards',
      `FLASHCARDS_JSON_PROTOCOL. Make ${count} flashcards from ONLY the session material below. Respond with ONLY a JSON object: {"title": string, "cards": [{"front": string, "back": string}]}.`,
      `Make ${count} flashcards.`, b, ctx);
    const cards = (parsed.cards || []).filter((c) => c && typeof c.front === 'string' && typeof c.back === 'string').slice(0, count).map((c) => ({ front: c.front.slice(0, 500), back: c.back.slice(0, 1500) }));
    if (!cards.length) throw new HttpError(502, 'agent_bad_output', 'The model did not return flashcards. Try again.');
    const aid = newId('art_');
    const title = String(parsed.title || `Flashcards: ${topic}`).slice(0, 150);
    await tx(async () => {
      await run("INSERT INTO artifacts (id,user_id,project_id,chat_id,session_id,title,kind,language,created_at,updated_at) VALUES (?,?,?,?,?,?,'json','flashcards',?,?)", aid, u.id, s.project_id, null, s.id, title, ts(), ts());
      await run('INSERT INTO artifact_versions (artifact_id,version,content,note,created_at) VALUES (?,?,?,?,?)', aid, 1, JSON.stringify({ title, cards }), 'generated', ts());
    });
    await run("UPDATE agent_runs SET status = 'completed', output = ?, model_id = ?, finished_at = ? WHERE id = ?", `artifact ${aid}`, out.route?.model?.id || null, ts(), runId);
    await logTool(u, s, 'flashcards_generator', topic, `${cards.length} cards → artifact ${aid}`, 'ok', { agent_run_id: runId });
    sendJson(res, 201, { flashcards: { artifact_id: aid, title, cards } });
  });

  // Study plan: N days of goals → a plan document + one dated assignment per day (tracked in Progress).
  r.post('/api/work-sessions/:id/study-plan', async (req, res, ctx, p) => {
    const u = requireUser(ctx);
    requireVerified(u);
    const s = await ownSession(u.id, p.id);
    await rateLimit(`quiz:${u.id}`, 30, 3600_000);
    const b = await readJson(req);
    const days = Math.max(1, Math.min(30, Number(b.days) || 7));
    const { parsed, runId, out, topic } = await generate(u, s, 'study_plan',
      `STUDYPLAN_JSON_PROTOCOL. Plan ${days} study days from ONLY the session material below. Respond with ONLY a JSON object: {"title": string, "days": [{"day": number, "title": string, "goals": [string]}]}.`,
      `Make a ${days}-day study plan.`, b, ctx);
    const plan = (parsed.days || []).filter((d) => d && typeof d.title === 'string').slice(0, days);
    if (!plan.length) throw new HttpError(502, 'agent_bad_output', 'The model did not return a study plan. Try again.');
    const title = String(parsed.title || `${days}-day study plan`).slice(0, 150);
    const md = `# ${title}\n\n` + plan.map((d, i) => `## Day ${d.day || i + 1}: ${d.title}\n${(Array.isArray(d.goals) ? d.goals : []).map((g) => `- ${g}`).join('\n')}`).join('\n\n');
    const aid = newId('art_');
    const start = new Date(); start.setHours(23, 59, 0, 0);
    let pos = (await one('SELECT COALESCE(MAX(position),0) n FROM tasks WHERE session_id = ?', s.id)).n;
    await tx(async () => {
      await run("INSERT INTO artifacts (id,user_id,project_id,chat_id,session_id,title,kind,language,created_at,updated_at) VALUES (?,?,?,?,?,?,'markdown','study-plan',?,?)", aid, u.id, s.project_id, null, s.id, title, ts(), ts());
      await run('INSERT INTO artifact_versions (artifact_id,version,content,note,created_at) VALUES (?,?,?,?,?)', aid, 1, md, 'generated', ts());
      for (let i = 0; i < plan.length; i++) {
        await run("INSERT INTO tasks (id,user_id,session_id,thread_id,title,detail,kind,status,due_at,position,created_by,created_at,updated_at) VALUES (?,?,?,NULL,?,?,'assignment','todo',?,?,'agent',?,?)",
          newId('tsk_'), u.id, s.id, `Day ${i + 1}: ${plan[i].title}`.slice(0, 200), (Array.isArray(plan[i].goals) ? plan[i].goals.join('\n') : '').slice(0, 4000), start.getTime() + i * 86400_000, ++pos, ts(), ts());
      }
    });
    await run("UPDATE agent_runs SET status = 'completed', output = ?, model_id = ?, finished_at = ? WHERE id = ?", `artifact ${aid}, ${plan.length} assignments`, out.route?.model?.id || null, ts(), runId);
    await logTool(u, s, 'study_plan_generator', topic, `${plan.length} days → artifact ${aid} + ${plan.length} dated assignments`, 'ok', { agent_run_id: runId });
    await notify(u.id, { kind: 'task', title: 'Study plan ready', body: `${s.title}: ${plan.length} days, one assignment per day`, link: `#/s/${s.id}/Assignments` });
    sendJson(res, 201, { plan: { artifact_id: aid, title, days: plan, assignments: plan.length } });
  });

  // ---------------------------------------------------------------- education: quiz + practice + progress
  r.post('/api/work-sessions/:id/quiz', async (req, res, ctx, p) => {
    const u = requireUser(ctx);
    requireVerified(u);
    const s = await ownSession(u.id, p.id);
    await rateLimit(`quiz:${u.id}`, 30, 3600_000);
    const b = await readJson(req);
    const ep = (await workspacePrefs(u.id)).education;
    const count = Math.max(3, Math.min(20, Number(b.count) || ep.quiz_count));
    const difficulty = ['easy', 'mixed', 'hard'].includes(b.difficulty) ? b.difficulty : ep.difficulty;
    const topic = str(b.topic, 'topic', { max: 300, required: false }) || 'the whole material';
    const ctxText = await sessionContext(u.id, s.id, topic, selectPassages);
    const runId = newId('run_');
    await run("INSERT INTO agent_runs (id,user_id,session_id,kind,status,input,created_at) VALUES (?,?,?,'quiz','running',?,?)", runId, u.id, s.id, `${count} questions: ${topic}`, ts());
    let quiz, out;
    try {
      out = await collect(async (onDelta) => await complete({ user: u, chat: null, text: `Create ${count} multiple-choice questions about ${topic}.`, requestedModel: b.model || 'auto',
        requestedMode: 'high', source: 'education-quiz', requestId: ctx.requestId, onDelta, history: [], skipMemoryCapture: true,
        systemExtra: `QUIZ_JSON_PROTOCOL. Difficulty: ${difficulty}. Use ONLY the session material below. Respond with ONLY a JSON object: {"title": string, "questions": [{"question": string, ` +
          `"options": [4 strings], "answer": index 0-3, "explanation": string}]}.${ctxText}` }));
      quiz = parseJson(out.text);
      quiz.questions = (quiz.questions || []).filter((q) => q && typeof q.question === 'string' && Array.isArray(q.options) && q.options.length >= 2
        && Number.isInteger(q.answer) && q.answer >= 0 && q.answer < q.options.length).slice(0, count);
      if (!quiz.questions.length) throw new Error('no questions');
    } catch {
      await run("UPDATE agent_runs SET status = 'failed', output = ?, finished_at = ? WHERE id = ?", String(out?.text || '').slice(0, 8000), ts(), runId);
      await logTool(u, s, 'quiz_generator', topic, out?.text || 'no output', 'error', { agent_run_id: runId });
      throw new HttpError(502, 'agent_bad_output', 'The model did not return a valid quiz. Try again.');
    }
    const aid = newId('art_');
    const title = String(quiz.title || `Quiz: ${topic}`).slice(0, 150);
    await tx(async () => {
      await run("INSERT INTO artifacts (id,user_id,project_id,chat_id,session_id,title,kind,language,created_at,updated_at) VALUES (?,?,?,?,?,?,'json','quiz',?,?)",
        aid, u.id, s.project_id, null, s.id, title, ts(), ts());
      await run('INSERT INTO artifact_versions (artifact_id,version,content,note,created_at) VALUES (?,?,?,?,?)', aid, 1, JSON.stringify(quiz), 'generated', ts());
    });
    await run("UPDATE agent_runs SET status = 'completed', output = ?, model_id = ?, finished_at = ? WHERE id = ?", `artifact ${aid}`, out.route?.model?.id || null, ts(), runId);
    await logTool(u, s, 'quiz_generator', topic, `${quiz.questions.length} ${difficulty} questions → artifact ${aid}`, 'ok', { agent_run_id: runId });
    await notify(u.id, { kind: 'task', title: 'Quiz ready', body: `${s.title}: ${quiz.questions.length} questions on ${topic}`, link: `#/s/${s.id}/Quiz` });
    // The answer key stays on the server: the practice view gets questions and options only.
    sendJson(res, 201, { quiz: { artifact_id: aid, title, difficulty, questions: quiz.questions.map((q) => ({ question: q.question, options: q.options })) } });
  });

  r.post('/api/work-sessions/:id/quiz/:aid/attempt', async (req, res, ctx, p) => {
    const u = requireUser(ctx);
    const s = await ownSession(u.id, p.id);
    const a = await one("SELECT * FROM artifacts WHERE id = ? AND user_id = ? AND session_id = ? AND language = 'quiz'", p.aid, u.id, s.id);
    if (!a) throw notFound('Quiz not found');
    const quiz = JSON.parse((await one('SELECT content FROM artifact_versions WHERE artifact_id = ? AND version = ?', a.id, a.current_version)).content);
    const b = await readJson(req);
    if (!Array.isArray(b.answers) || b.answers.length !== quiz.questions.length) throw bad(`answers must be an array of ${quiz.questions.length} option indexes`);
    const results = quiz.questions.map((q, i) => ({ correct: Number(b.answers[i]) === q.answer, answer: q.answer, explanation: q.explanation || '' }));
    const score = results.filter((x) => x.correct).length;
    await run('INSERT INTO study_attempts (id,user_id,session_id,artifact_id,score,total,answers,created_at) VALUES (?,?,?,?,?,?,?,?)',
      newId('att_'), u.id, s.id, a.id, score, results.length, JSON.stringify(b.answers), ts());
    sendJson(res, 200, { score, total: results.length, percent: Math.round(100 * score / results.length), results });
  });

  // ---------------------------------------------------------------- code: status, diff, commit, log, branches, run
  r.get('/api/code/:pid/status', async (req, res, ctx, p) => {
    const u = requireUser(ctx);
    const pr = await ownCodeProject(u.id, p.pid);
    const b = await currentBranch(pr);
    const head = await headSnapshot(b);
    sendJson(res, 200, { branch: b.name, head: b.head_commit_id, changes: changes(head, await snapshotOf(pr.id, u.id)),
      runner: { available: false, reason: 'Commands (terminal, run, test, build) need an isolated sandbox runner, which is not configured on this server.' } });
  });
  r.get('/api/code/:pid/diff', async (req, res, ctx, p, url) => {
    const u = requireUser(ctx);
    const pr = await ownCodeProject(u.id, p.pid);
    const head = await headSnapshot(await currentBranch(pr));
    const work = await snapshotOf(pr.id, u.id);
    const only = url.searchParams.get('path');
    const diffs = changes(head, work).filter((c) => !only || c.path === only).map((c) => {
      const d = unifiedDiff(c.path, head[c.path] ?? '', work[c.path] ?? '');
      return { ...c, diff: d, ...diffStats(d) };
    });
    sendJson(res, 200, { diffs });
  });
  r.post('/api/code/:pid/commit', async (req, res, ctx, p) => {
    const u = requireUser(ctx);
    const pr = await ownCodeProject(u.id, p.pid);
    const b = await readJson(req);
    const message = str(b.message, 'message', { min: 1, max: 500 });
    const session = b.session_id ? await ownSession(u.id, b.session_id) : null;
    const br = await currentBranch(pr);
    const work = await snapshotOf(pr.id, u.id);
    const ch = changes(await headSnapshot(br), work);
    if (!ch.length) throw new HttpError(409, 'nothing_to_commit', 'Nothing to commit — no changes since the last commit.');
    const id = newId('cmt_');
    await tx(async () => {
      await run('INSERT INTO code_commits (id,project_id,user_id,session_id,branch,parent_id,message,snapshot,created_at) VALUES (?,?,?,?,?,?,?,?,?)',
        id, pr.id, u.id, session?.id || null, br.name, br.head_commit_id, message, JSON.stringify(work), ts());
      await run('UPDATE code_branches SET head_commit_id = ? WHERE project_id = ? AND name = ?', id, pr.id, br.name);
    });
    if (session) await logTool(u, session, 'git.commit', message, `${id} on ${br.name}: ${ch.length} file(s)`, 'ok');
    sendJson(res, 201, { commit: { id, branch: br.name, parent_id: br.head_commit_id, message, files: ch } });
  });
  r.get('/api/code/:pid/log', async (req, res, ctx, p) => {
    const u = requireUser(ctx);
    const pr = await ownCodeProject(u.id, p.pid);
    const br = await currentBranch(pr);
    const out = [];
    for (let id = br.head_commit_id; id && out.length < 100;) {
      const c = await one('SELECT id, branch, parent_id, message, session_id, created_at FROM code_commits WHERE id = ? AND project_id = ?', id, pr.id);
      if (!c) break; out.push(c); id = c.parent_id;
    }
    sendJson(res, 200, { branch: br.name, commits: out });
  });
  r.get('/api/code/:pid/branches', async (req, res, ctx, p) => {
    const u = requireUser(ctx);
    const pr = await ownCodeProject(u.id, p.pid);
    const cur = await currentBranch(pr);
    sendJson(res, 200, { current: cur.name, branches: await all('SELECT name, head_commit_id, created_at FROM code_branches WHERE project_id = ? ORDER BY name', pr.id) });
  });
  r.post('/api/code/:pid/branches', async (req, res, ctx, p) => {
    const u = requireUser(ctx);
    const pr = await ownCodeProject(u.id, p.pid);
    const b = await readJson(req);
    const name = String(b.name || '');
    if (!BRANCH_RE.test(name) || name.includes('..')) throw bad('Branch names use letters, digits, . _ / - (max 60)');
    if (await one('SELECT 1 FROM code_branches WHERE project_id = ? AND name = ?', pr.id, name)) throw new HttpError(409, 'branch_exists', 'A branch with this name exists');
    const from = await currentBranch(pr);
    await run('INSERT INTO code_branches (project_id,name,head_commit_id,created_at) VALUES (?,?,?,?)', pr.id, name, from.head_commit_id, ts());
    sendJson(res, 201, { branch: { name, head_commit_id: from.head_commit_id, from: from.name } });
  });
  r.post('/api/code/:pid/checkout', async (req, res, ctx, p) => {
    const u = requireUser(ctx);
    const pr = await ownCodeProject(u.id, p.pid);
    const b = await readJson(req);
    const target = await one('SELECT * FROM code_branches WHERE project_id = ? AND name = ?', pr.id, String(b.branch || ''));
    if (!target) throw notFound('Branch not found');
    const cur = await currentBranch(pr);
    if (changes(await headSnapshot(cur), await snapshotOf(pr.id, u.id)).length && b.force !== true) {
      throw new HttpError(409, 'uncommitted_changes', 'Commit your changes first (or switch with force to discard them).');
    }
    const snap = await headSnapshot(target);
    await tx(async () => {
      await run('DELETE FROM code_files WHERE project_id = ? AND user_id = ?', pr.id, u.id);
      for (const [path, content] of Object.entries(snap)) await run('INSERT INTO code_files (project_id,user_id,path,content,updated_at) VALUES (?,?,?,?,?)', pr.id, u.id, path, content, ts());
      await run('UPDATE projects SET current_branch = ?, updated_at = ? WHERE id = ?', target.name, ts(), pr.id);
    });
    sendJson(res, 200, { branch: target.name, files: Object.keys(snap).length });
  });
  // Terminal / Run / Test / Build: recorded in the session log; honest "unavailable" until a sandbox runner exists.
  r.post('/api/code/:pid/run', async (req, res, ctx, p) => {
    const u = requireUser(ctx);
    const pr = await ownCodeProject(u.id, p.pid);
    const b = await readJson(req);
    const command = str(b.command, 'command', { min: 1, max: 500 });
    const session = b.session_id ? await ownSession(u.id, b.session_id) : null;
    if (session && session.project_id !== pr.id) throw bad('This session belongs to another project');
    const kindRun = oneOf(b.kind, 'kind', ['terminal', 'run', 'test', 'build'], 'terminal');
    // A paired device (the person's own computer running approx-device) executes the command on a copy of the repository.
    const devId = b.device_id || session?.device_id;
    const device = devId ? await one("SELECT * FROM devices WHERE id = ? AND user_id = ? AND status = 'connected'", String(devId), u.id) : null;
    if (devId && !device) throw notFound('Device not found or not connected');
    if (device) {
      const jobId = newId('job_');
      const texId = session ? await logTool(u, session, `run:${kindRun}`, command, `queued on ${device.name}`, 'ok') : null;
      await run("INSERT INTO device_jobs (id,user_id,device_id,project_id,session_id,tool_execution_id,kind,command,status,created_at) VALUES (?,?,?,?,?,?,?,?,'queued',?)",
        jobId, u.id, device.id, pr.id, session?.id || null, texId, kindRun, command, ts());
      return sendJson(res, 202, { job: { id: jobId, status: 'queued', device: device.name } });
    }
    const msg = 'No device is connected to this session and no sandbox runner is configured on this server, so the command was not executed. Add a device in Approx → Code to run commands on your own computer.';
    if (session) await logTool(u, session, `run:${kindRun}`, command, msg, 'unavailable');
    throw new HttpError(501, 'runner_not_configured', msg);
  });
}
