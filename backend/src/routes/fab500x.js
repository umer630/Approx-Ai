// FAB 500X Code workspace — a private, admin-granted coding workspace (files, history, checkpoints, search, static
// problems, approval-gated agent edits with diffs, sandbox runner interface).
//
// Authorization (every route): signed-in, verified user + a valid FAB 500X grant (canUseModel on the private model).
// Without a grant every route answers 404 exactly like an unknown path (no existence oracle). Projects and files are
// always selected by (id, user_id) — another user's project id is indistinguishable from a missing one (IDOR-safe).
// Paths are validated (no traversal, no absolute paths, no control/reserved characters). Agent actions, applies,
// reveals and command requests are written to the append-only audit log.
//
// What is NOT claimed: commands are never executed on the Approx server. Execution needs an isolated sandbox runner
// (APPROX_RUNNER_URL); without it /run answers 501 runner_not_configured. Image/video generation are only available
// through connected media pipelines. "Checkpoints" are Approx snapshots, not a real Git repository.
import crypto from 'node:crypto';
import vm from 'node:vm';
import { one, all, run, now, tx, audit } from '../db.js';
import { readJson, sendJson, bad, notFound, newId, str, oneOf, HttpError, clientIp } from '../http.js';
import { requireUser, requireVerified, rateLimit } from '../security.js';
import { complete } from '../engine.js';
import { getModel, canUseModel, modelStatus } from '../models.js';
import { catalog } from '../catalog.js';
import { unifiedDiff, diffStats } from '../diff.js';

const MODEL = 'fab-500x';
const MAX_FILES = 500;
const MAX_FILE = 400_000;
const MAX_PROJECT = 8_000_000;
const MASK = '••••••••';
const sha = (s) => crypto.createHash('sha256').update(s ?? '').digest('hex');

export function cleanPath(pth) {
  const s = str(pth, 'path', { min: 1, max: 240 }).replace(/\\/g, '/').trim();
  if (s.startsWith('/') || /^[A-Za-z]:/.test(s) || s.split('/').some((seg) => seg === '..' || seg === '' || seg === '.' || seg.length > 120)
    || /[\0-\x1f<>:"|?*]/.test(s)) throw bad(`Invalid path: ${s.slice(0, 80)}`, 'invalid_path');
  return s;
}
const isEnvFile = (p) => /(^|\/)\.env(\.|$)/.test(p) || /(^|\/)(secrets?|credentials?)\.(json|ya?ml|env)$/i.test(p);
// KEY=value lines → KEY=•••• (values never leave the server unless the owner explicitly reveals them; audited).
const maskEnv = (text) => text.replace(/^(\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_.-]*\s*[=:]\s*)(.+)$/gm, (m, k, v) => (v.trim() ? k + MASK : m));

// Commands the agent may PROPOSE; even with a runner they never run without the policy check below.
const DANGEROUS = [/\brm\s+-[a-z]*r[a-z]*f?\s+(\/|~|\*|\.\s*$)/i, /\bmkfs\b|\bdd\s+if=/i, /:\(\)\s*\{\s*:\|:&\s*\};:/, /\b(curl|wget)\b[^|]*\|\s*(sh|bash|zsh)\b/i,
  /\bchmod\s+-R\s+777\s+\//, /\b(shutdown|reboot|halt)\b/i, /\bgit\s+push\b.*--force/i, /\bnc\b.*-e\s/i, />\s*\/dev\/sd/i];
export const isDangerous = (cmd) => DANGEROUS.some((re) => re.test(cmd));

export function registerFab500xRoutes(r) {
  // ---------- gate ----------
  async function gate(ctx) {
    const u = requireUser(ctx);
    const m = await getModel(MODEL);
    if (!m || !(await canUseModel(u, m))) throw notFound('Unknown endpoint');
    requireVerified(u);
    return { u, m };
  }
  const ownProject = async (uid, id) => {
    const p = await one("SELECT * FROM projects WHERE id = ? AND user_id = ? AND workspace = 'fab500x'", String(id || ''), uid);
    if (!p) throw notFound('Project not found');
    return p;
  };
  const fileRow = (pid, uid, path) => one('SELECT path, content, updated_at FROM code_files WHERE project_id = ? AND user_id = ? AND path = ?', pid, uid, path);
  async function writeFile(proj, uid, path, content, author) {
    if (typeof content !== 'string') throw bad('content must be a string');
    if (content.length > MAX_FILE) throw bad(`File too large: ${path} (max ${MAX_FILE} characters)`, 'file_too_large');
    const prev = await fileRow(proj.id, uid, path);
    if (prev && prev.content === content) return false;
    const stats = await one('SELECT COUNT(*) n, COALESCE(SUM(length(content)),0) bytes FROM code_files WHERE project_id = ?', proj.id);
    if (!prev && stats.n >= MAX_FILES) throw bad(`File limit (${MAX_FILES}) reached`, 'file_limit');
    if (stats.bytes - (prev?.content.length || 0) + content.length > MAX_PROJECT) throw bad('Project size limit (8 MB) reached', 'project_limit');
    await run('INSERT INTO code_files (project_id,user_id,path,content,updated_at) VALUES (?,?,?,?,?) ON CONFLICT(project_id,path) DO UPDATE SET content=excluded.content, updated_at=excluded.updated_at',
      proj.id, uid, path, content, now());
    await run('INSERT INTO code_file_versions (project_id,user_id,path,content,author,created_at) VALUES (?,?,?,?,?,?)', proj.id, uid, path, content, author, now());
    await run('UPDATE projects SET updated_at = ? WHERE id = ?', now(), proj.id);
    return true;
  }
  async function deleteFile(proj, uid, path, author) {
    const prev = await fileRow(proj.id, uid, path);
    if (!prev) throw notFound(`File not found: ${path}`);
    await run('DELETE FROM code_files WHERE project_id = ? AND user_id = ? AND path = ?', proj.id, uid, path);
    await run('INSERT INTO code_file_versions (project_id,user_id,path,content,author,created_at) VALUES (?,?,?,NULL,?,?)', proj.id, uid, path, author, now());
  }
  async function renameFile(proj, uid, from, to, author) {
    const f = await fileRow(proj.id, uid, from);
    if (!f) throw notFound(`File not found: ${from}`);
    if (await fileRow(proj.id, uid, to)) throw new HttpError(409, 'path_exists', `${to} already exists`);
    await writeFile(proj, uid, to, f.content, author);
    await deleteFile(proj, uid, from, author);
  }

  // ---------- capabilities (honest: what is connected right now) ----------
  r.get('/api/fab500x/capabilities', async (req, res, ctx) => {
    const { m } = await gate(ctx);
    const st = await modelStatus(m);
    const pipe = (id) => { const p = catalog.pipelines.find((x) => x.id === id); return p ? (process.env[p.env_url] ? 'connected' : `not connected (${p.env_url} is not set)`) : 'not configured'; };
    sendJson(res, 200, {
      model: { id: MODEL, status: st.status, reason: st.reason, simulator: !!st.simulator },
      editor: 'available (server-stored projects, tabs, search, find/replace, history, checkpoints)',
      agent: st.status === 'online' ? (st.simulator ? 'available — development simulator, not the trained FAB 500X' : 'available') : `unavailable: FAB 500X is ${st.status} (${st.reason})`,
      problems: 'available: static checks (JSON/JavaScript syntax, hard-coded secrets); no code is executed',
      terminal: process.env.APPROX_RUNNER_URL ? 'connected sandbox runner' : 'unavailable: no isolated sandbox runner is configured (APPROX_RUNNER_URL); commands are never run on the Approx server',
      git: 'Approx checkpoints (snapshot + status + diff); not a Git repository',
      image_generation: pipe('image-generation'), video_generation: pipe('video-generation'),
    });
  });

  // ---------- projects ----------
  r.get('/api/fab500x/projects', async (req, res, ctx) => {
    const { u } = await gate(ctx);
    sendJson(res, 200, { projects: await all(`SELECT p.id, p.name, p.description, p.created_at, p.updated_at, (SELECT COUNT(*) FROM code_files f WHERE f.project_id = p.id) files
      FROM projects p WHERE p.user_id = ? AND p.workspace = 'fab500x' ORDER BY p.updated_at DESC`, u.id) });
  });
  r.post('/api/fab500x/projects', async (req, res, ctx) => {
    const { u } = await gate(ctx);
    const b = await readJson(req);
    const id = newId('prj_');
    const n = (await one("SELECT COUNT(*) n FROM projects WHERE user_id = ? AND workspace = 'fab500x'", u.id)).n;
    if (n >= 50) throw bad('Project limit (50) reached', 'project_limit');
    await run("INSERT INTO projects (id,user_id,name,description,instructions,kind,workspace,created_at,updated_at) VALUES (?,?,?,?,?,'fabbox','fab500x',?,?)",
      id, u.id, str(b.name, 'name', { min: 1, max: 80 }), str(b.description, 'description', { max: 500, required: false }) || '', str(b.instructions, 'instructions', { max: 4000, required: false }) || '', now(), now());
    await audit(u.id, u.id, 'fab500x.project_created', id, clientIp(req));
    sendJson(res, 201, { project: { id, name: b.name } });
  });
  r.delete('/api/fab500x/projects/:pid', async (req, res, ctx, p, url) => {
    const { u } = await gate(ctx);
    const proj = await ownProject(u.id, p.pid);
    if (url.searchParams.get('confirm') !== proj.name) throw bad('Confirm by passing ?confirm=<project name>', 'confirmation_required');
    await run('DELETE FROM projects WHERE id = ? AND user_id = ?', proj.id, u.id);
    await audit(u.id, u.id, 'fab500x.project_deleted', proj.id, clientIp(req));
    sendJson(res, 200, { status: 'deleted' });
  });

  // ---------- files ----------
  r.get('/api/fab500x/projects/:pid/tree', async (req, res, ctx, p) => {
    const { u } = await gate(ctx);
    const proj = await ownProject(u.id, p.pid);
    sendJson(res, 200, { project: { id: proj.id, name: proj.name, instructions: proj.instructions },
      files: await all('SELECT path, length(content) size, updated_at FROM code_files WHERE project_id = ? AND user_id = ? ORDER BY path', proj.id, u.id) });
  });
  r.get('/api/fab500x/projects/:pid/file', async (req, res, ctx, p, url) => {
    const { u } = await gate(ctx);
    const proj = await ownProject(u.id, p.pid);
    const path = cleanPath(url.searchParams.get('path'));
    const f = await fileRow(proj.id, u.id, path);
    if (!f) throw notFound('File not found');
    if (isEnvFile(path) && url.searchParams.get('reveal') !== '1') return sendJson(res, 200, { file: { ...f, content: maskEnv(f.content), masked: true } });
    if (isEnvFile(path)) await audit(u.id, u.id, 'fab500x.secret_revealed', `${proj.id}:${path}`, clientIp(req));
    sendJson(res, 200, { file: { ...f, masked: false } });
  });
  r.put('/api/fab500x/projects/:pid/file', async (req, res, ctx, p) => {
    const { u } = await gate(ctx);
    const proj = await ownProject(u.id, p.pid);
    const b = await readJson(req, 1024 * 1024);
    const path = cleanPath(b.path);
    if (isEnvFile(path) && String(b.content).includes(MASK)) throw new HttpError(409, 'masked_content', 'This file was opened masked; reveal it before editing so secrets are not overwritten');
    const changed = await writeFile(proj, u.id, path, b.content, 'user');
    sendJson(res, 200, { status: changed ? 'saved' : 'unchanged', path });
  });
  r.delete('/api/fab500x/projects/:pid/file', async (req, res, ctx, p, url) => {
    const { u } = await gate(ctx);
    const proj = await ownProject(u.id, p.pid);
    const path = cleanPath(url.searchParams.get('path'));
    if (url.searchParams.get('confirm') !== '1') throw bad('Deleting a file needs confirm=1', 'confirmation_required');
    await deleteFile(proj, u.id, path, 'user');
    await audit(u.id, u.id, 'fab500x.file_deleted', `${proj.id}:${path}`, clientIp(req));
    sendJson(res, 200, { status: 'deleted' });
  });
  // Rename / move a file, or every file under a folder prefix.
  r.post('/api/fab500x/projects/:pid/rename', async (req, res, ctx, p) => {
    const { u } = await gate(ctx);
    const proj = await ownProject(u.id, p.pid);
    const b = await readJson(req);
    const from = cleanPath(b.from); const to = cleanPath(b.to);
    const moved = [];
    await tx(async () => {
      if (await fileRow(proj.id, u.id, from)) { await renameFile(proj, u.id, from, to, 'user'); moved.push([from, to]); return; }
      const under = await all('SELECT path FROM code_files WHERE project_id = ? AND user_id = ? AND substr(path, 1, ?) = ?', proj.id, u.id, from.length + 1, from + '/');
      if (!under.length) throw notFound(`Nothing at ${from}`);
      for (const f of under) { const np = cleanPath(to + f.path.slice(from.length)); await renameFile(proj, u.id, f.path, np, 'user'); moved.push([f.path, np]); }
    });
    sendJson(res, 200, { moved });
  });
  // Upload text files (JSON [{path, content}]) — binary files are refused (no executable uploads).
  r.post('/api/fab500x/projects/:pid/upload', async (req, res, ctx, p) => {
    const { u } = await gate(ctx);
    const proj = await ownProject(u.id, p.pid);
    const b = await readJson(req, 6 * 1024 * 1024);
    if (!Array.isArray(b.files) || !b.files.length || b.files.length > 100) throw bad('files must be an array of 1–100 {path, content}');
    const saved = [];
    await tx(async () => {
      for (const f of b.files) {
        const path = cleanPath(f.path);
        if (typeof f.content !== 'string' || f.content.includes('\0')) throw bad(`${path}: only text files can be uploaded`, 'binary_not_supported');
        await writeFile(proj, u.id, path, f.content, 'upload'); saved.push(path);
      }
    });
    sendJson(res, 200, { saved });
  });
  r.get('/api/fab500x/projects/:pid/search', async (req, res, ctx, p, url) => {
    const { u } = await gate(ctx);
    const proj = await ownProject(u.id, p.pid);
    const q = String(url.searchParams.get('q') || '');
    if (q.length < 2 || q.length > 200) throw bad('q must be 2–200 characters');
    const cs = url.searchParams.get('case') === '1';
    const needle = cs ? q : q.toLowerCase();
    const results = [];
    for (const f of await all('SELECT path, content FROM code_files WHERE project_id = ? AND user_id = ? ORDER BY path', proj.id, u.id)) {
      if (isEnvFile(f.path)) continue;   // never surface secret values through search
      const pathHit = (cs ? f.path : f.path.toLowerCase()).includes(needle);
      const lines = f.content.split('\n'); const hits = [];
      for (let i = 0; i < lines.length && hits.length < 50; i++) if ((cs ? lines[i] : lines[i].toLowerCase()).includes(needle)) hits.push({ line: i + 1, text: lines[i].slice(0, 240) });
      if (hits.length || pathHit) results.push({ path: f.path, matches: hits });
      if (results.length >= 200) break;
    }
    sendJson(res, 200, { query: q, results });
  });
  r.get('/api/fab500x/projects/:pid/history', async (req, res, ctx, p, url) => {
    const { u } = await gate(ctx);
    const proj = await ownProject(u.id, p.pid);
    const path = cleanPath(url.searchParams.get('path'));
    const rows = await all('SELECT id, author, created_at, length(content) size, content IS NULL deleted FROM code_file_versions WHERE project_id = ? AND user_id = ? AND path = ? ORDER BY id DESC LIMIT 100', proj.id, u.id, path);
    sendJson(res, 200, { path, versions: rows.map((x) => ({ ...x, deleted: !!x.deleted })) });
  });
  r.post('/api/fab500x/projects/:pid/history/:vid/restore', async (req, res, ctx, p) => {
    const { u } = await gate(ctx);
    const proj = await ownProject(u.id, p.pid);
    const v = await one('SELECT * FROM code_file_versions WHERE id = ? AND project_id = ? AND user_id = ?', Number(p.vid) || 0, proj.id, u.id);
    if (!v || v.content == null) throw notFound('Version not found');
    await writeFile(proj, u.id, v.path, v.content, 'restore');
    sendJson(res, 200, { status: 'restored', path: v.path });
  });

  // ---------- checkpoints ("source control": snapshot, status, diff) ----------
  const snapshot = async (pid, uid) => Object.fromEntries((await all('SELECT path, content FROM code_files WHERE project_id = ? AND user_id = ?', pid, uid)).map((f) => [f.path, sha(f.content)]));
  r.get('/api/fab500x/projects/:pid/changes', async (req, res, ctx, p) => {
    const { u } = await gate(ctx);
    const proj = await ownProject(u.id, p.pid);
    const last = await one('SELECT id, message, snapshot, created_at FROM code_checkpoints WHERE project_id = ? AND user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1', proj.id, u.id);
    const base = last ? JSON.parse(last.snapshot) : {};
    const cur = await snapshot(proj.id, u.id);
    const changes = [];
    for (const [path, h] of Object.entries(cur)) if (!(path in base)) changes.push({ path, status: 'added' }); else if (base[path] !== h) changes.push({ path, status: 'modified' });
    for (const path of Object.keys(base)) if (!(path in cur)) changes.push({ path, status: 'deleted' });
    sendJson(res, 200, { checkpoint: last ? { id: last.id, message: last.message, created_at: last.created_at } : null, changes: changes.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)) });
  });
  r.post('/api/fab500x/projects/:pid/checkpoints', async (req, res, ctx, p) => {
    const { u } = await gate(ctx);
    const proj = await ownProject(u.id, p.pid);
    const b = await readJson(req);
    const id = newId('ckp_');
    await run('INSERT INTO code_checkpoints (id,project_id,user_id,message,snapshot,created_at) VALUES (?,?,?,?,?,?)', id, proj.id, u.id,
      str(b.message, 'message', { min: 1, max: 300 }), JSON.stringify(await snapshot(proj.id, u.id)), now());
    sendJson(res, 201, { checkpoint: { id } });
  });

  // ---------- problems (static analysis only; nothing is executed) ----------
  r.get('/api/fab500x/projects/:pid/problems', async (req, res, ctx, p) => {
    const { u } = await gate(ctx);
    const proj = await ownProject(u.id, p.pid);
    const problems = [];
    for (const f of await all('SELECT path, content FROM code_files WHERE project_id = ? AND user_id = ? ORDER BY path', proj.id, u.id)) problems.push(...staticProblems(f.path, f.content));
    sendJson(res, 200, { problems, note: 'Static checks only (syntax of JSON/JavaScript, hard-coded secrets). No code was executed.' });
  });

  // ---------- runner (sandbox interface; never executes on this server) ----------
  r.post('/api/fab500x/projects/:pid/run', async (req, res, ctx, p) => {
    const { u } = await gate(ctx);
    const proj = await ownProject(u.id, p.pid);
    const b = await readJson(req);
    const command = str(b.command, 'command', { min: 1, max: 1000 });
    await rateLimit(`fab500x-run:${u.id}`, 30, 60_000);
    if (isDangerous(command)) {
      await audit(u.id, u.id, 'fab500x.command_refused', proj.id, clientIp(req), { reason: 'dangerous', command: command.slice(0, 200) });
      throw new HttpError(403, 'command_refused', 'This command is destructive or unsafe and is never run by the workspace.');
    }
    await audit(u.id, u.id, 'fab500x.command_requested', proj.id, clientIp(req), { command: command.slice(0, 200) });
    if (!process.env.APPROX_RUNNER_URL) {
      throw new HttpError(501, 'runner_not_configured', 'Commands cannot run: no isolated sandbox runner is connected (APPROX_RUNNER_URL). Nothing was executed.');
    }
    // Connected runner contract: POST <runner>/v1/run {project files, command} with a bearer key; output is returned as-is.
    const files = await all('SELECT path, content FROM code_files WHERE project_id = ? AND user_id = ?', proj.id, u.id);
    let out;
    try {
      const rr = await fetch(`${process.env.APPROX_RUNNER_URL.replace(/\/$/, '')}/v1/run`, { method: 'POST', signal: AbortSignal.timeout(120_000),
        headers: { 'content-type': 'application/json', ...(process.env.APPROX_RUNNER_KEY ? { authorization: `Bearer ${process.env.APPROX_RUNNER_KEY}` } : {}) },
        body: JSON.stringify({ project: proj.id, command, files: files.filter((f) => !isEnvFile(f.path)), timeout_s: 110 }) });
      out = await rr.json();
      if (!rr.ok) throw new HttpError(502, 'runner_error', out?.error?.message || `runner answered HTTP ${rr.status}`);
    } catch (e) { if (e instanceof HttpError) throw e; throw new HttpError(502, 'runner_unreachable', `sandbox runner unreachable (${e.name})`); }
    sendJson(res, 200, { command, exit_code: out.exit_code ?? null, stdout: String(out.stdout ?? '').slice(0, 200_000), stderr: String(out.stderr ?? '').slice(0, 200_000), executed_by: 'sandbox-runner' });
  });

  // ---------- agent ----------
  // FAB 500X proposes {summary, plan, changes:[write|delete|rename], commands:[…]}. Manual: everything waits for approval
  // with per-file diffs. Automatic: file writes/renames are applied at once; deletes and commands still need approval.
  r.post('/api/fab500x/projects/:pid/agent', async (req, res, ctx, p) => {
    const { u } = await gate(ctx);
    const proj = await ownProject(u.id, p.pid);
    const b = await readJson(req);
    const instruction = str(b.instruction, 'instruction', { min: 3, max: 12000 });
    await rateLimit(`fab500x-agent:${u.id}`, 20, 60_000);
    const settings = await one('SELECT permissions_mode FROM settings WHERE user_id = ?', u.id) || {};
    const mode = b.permission ? oneOf(b.permission, 'permission', ['manual', 'automatic']) : (settings.permissions_mode === 'automatic' ? 'automatic' : 'manual');
    const files = await all('SELECT path, content FROM code_files WHERE project_id = ? AND user_id = ? ORDER BY path', proj.id, u.id);
    let budget = 60_000;
    const focus = new Set(Array.isArray(b.open_files) ? b.open_files.map(String) : []);
    const ordered = [...files.filter((f) => focus.has(f.path)), ...files.filter((f) => !focus.has(f.path))];
    const bodies = ordered.map((f) => { if (budget <= 0) return ''; const c = (isEnvFile(f.path) ? maskEnv(f.content) : f.content).slice(0, Math.min(budget, 12000)); budget -= c.length; return `--- ${f.path}\n${c}`; }).filter(Boolean).join('\n');
    let text = '';
    const out = await complete({
      user: u, chat: null, text: instruction, requestedModel: MODEL, requestedMode: b.mode || 'high', source: 'fab500x', requestId: ctx.requestId,
      onDelta: (d) => { text += d; }, history: [], skipMemoryCapture: true,
      systemExtra: 'FAB500X_AGENT_PROTOCOL. You are the FAB 500X coding agent working in the user\'s Approx project "' + proj.name + '".\n' +
        'Inspect the files, plan, then respond with ONLY a JSON object: {"summary": string, "plan": [string], "changes": [{"op": "write", "path": string, "content": string} | ' +
        '{"op": "delete", "path": string} | {"op": "rename", "from": string, "to": string}], "commands": [string], "explanation": string}. ' +
        'Write complete file contents. You cannot run commands yourself: list any you need in "commands" (they are shown to the user and only run in a sandbox if one is connected). ' +
        'Never print secret values. Keep security work defensive and authorized.\n' +
        `Project instructions: ${proj.instructions || '(none)'}\n\nFILE TREE:\n${files.map((f) => f.path).join('\n') || '(empty)'}\n\nFILES:\n${bodies}`,
    });
    if (out.refused) { await audit(u.id, u.id, 'fab500x.agent_refused', proj.id, clientIp(req)); return sendJson(res, 200, { refused: true, message: out.text }); }
    let parsed;
    try {
      const raw = out.text || text;
      const m = raw.match(/\{[\s\S]*\}/);
      parsed = JSON.parse(m ? m[0] : raw);
      if (typeof parsed.summary !== 'string' || !Array.isArray(parsed.changes)) throw new Error('shape');
    } catch {
      await audit(u.id, u.id, 'fab500x.agent_bad_output', proj.id, clientIp(req));
      throw new HttpError(502, 'agent_bad_output', 'FAB 500X did not return a valid change proposal. Nothing was changed.', { raw: (out.text || text).slice(0, 2000) });
    }
    const changes = parsed.changes.slice(0, 80).map((c) => (c.op === 'rename' ? { op: 'rename', from: cleanPath(c.from), to: cleanPath(c.to) }
      : c.op === 'delete' ? { op: 'delete', path: cleanPath(c.path) } : { op: 'write', path: cleanPath(c.path), content: String(c.content ?? '') }));
    const commands = (Array.isArray(parsed.commands) ? parsed.commands : []).slice(0, 20).map((c) => String(c).slice(0, 1000)).map((c) => ({ command: c, dangerous: isDangerous(c) }));
    // diffs against the current files
    const cur = Object.fromEntries(files.map((f) => [f.path, f.content]));
    const diffs = changes.map((c) => {
      if (c.op === 'rename') return { ...c, diff: `rename ${c.from} → ${c.to}` };
      const d = unifiedDiff(c.path, cur[c.path] ?? null, c.op === 'delete' ? null : c.content);
      return { op: c.op, path: c.path, diff: isEnvFile(c.path) ? '(secret file — diff hidden)' : d, ...diffStats(d) };
    });
    const autoApply = mode === 'automatic' ? changes.filter((c) => c.op !== 'delete') : [];
    const pending = mode === 'automatic' ? changes.filter((c) => c.op === 'delete') : changes;
    if (autoApply.length) await tx(async () => { for (const c of autoApply) await applyChange(proj, u.id, c); });
    const id = newId('prp_');
    const status = pending.length || commands.length ? 'pending' : 'applied';
    await run('INSERT INTO code_proposals (id,project_id,user_id,summary,changes,status,created_at,decided_at) VALUES (?,?,?,?,?,?,?,?)', id, proj.id, u.id,
      parsed.summary.slice(0, 4000), JSON.stringify({ pending, applied: autoApply, commands, plan: (parsed.plan || []).slice(0, 30).map(String), explanation: String(parsed.explanation || '').slice(0, 8000), diffs, mode }),
      status, now(), status === 'applied' ? now() : null);
    await audit(u.id, u.id, 'fab500x.agent_proposal', proj.id, clientIp(req), { proposal: id, mode, changes: changes.length, auto_applied: autoApply.length, commands: commands.length });
    sendJson(res, 201, { proposal: { id, status, mode, summary: parsed.summary, plan: parsed.plan || [], explanation: parsed.explanation || '', diffs, commands,
      auto_applied: autoApply.map((c) => c.path || c.to), pending_changes: pending.length, model_id: out.route.model.id, model_version: out.route.version || null } });
  });
  async function applyChange(proj, uid, c) {
    if (c.op === 'write') await writeFile(proj, uid, c.path, c.content, 'agent');
    else if (c.op === 'delete') await deleteFile(proj, uid, c.path, 'agent');
    else if (c.op === 'rename') await renameFile(proj, uid, c.from, c.to, 'agent');
  }
  r.get('/api/fab500x/projects/:pid/proposals', async (req, res, ctx, p) => {
    const { u } = await gate(ctx);
    const proj = await ownProject(u.id, p.pid);
    const rows = await all('SELECT id, summary, changes, status, created_at, decided_at FROM code_proposals WHERE project_id = ? AND user_id = ? ORDER BY created_at DESC LIMIT 50', proj.id, u.id);
    sendJson(res, 200, { proposals: rows.map((x) => ({ ...x, changes: undefined, ...JSON.parse(x.changes) })) });
  });
  r.post('/api/fab500x/projects/:pid/proposals/:id/:decision', async (req, res, ctx, p) => {
    const { u } = await gate(ctx);
    const proj = await ownProject(u.id, p.pid);
    if (!['approve', 'reject'].includes(p.decision)) throw notFound();
    const prop = await one("SELECT * FROM code_proposals WHERE id = ? AND project_id = ? AND user_id = ? AND status = 'pending'", p.id, proj.id, u.id);
    if (!prop) throw notFound('Pending proposal not found');
    const body = JSON.parse(prop.changes);
    if (p.decision === 'approve') {
      await tx(async () => {
        for (const c of body.pending || []) await applyChange(proj, u.id, c);
        await run("UPDATE code_proposals SET status = 'applied', decided_at = ? WHERE id = ?", now(), prop.id);
      });
    } else await run("UPDATE code_proposals SET status = 'rejected', decided_at = ? WHERE id = ?", now(), prop.id);
    await audit(u.id, u.id, p.decision === 'approve' ? 'fab500x.proposal_applied' : 'fab500x.proposal_rejected', prop.id, clientIp(req), { changes: (body.pending || []).length });
    sendJson(res, 200, { status: p.decision === 'approve' ? 'applied' : 'rejected', commands: body.commands || [],
      note: (body.commands || []).length ? 'Proposed commands were not run. Run them from the terminal panel when a sandbox runner is connected.' : undefined });
  });
}

// ---------- static checks ----------
const SECRET_PATTERNS = [
  ['aws_access_key', /AKIA[0-9A-Z]{16}/], ['private_key', /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/], ['github_token', /\bgh[pousr]_[A-Za-z0-9]{36,}\b/],
  ['slack_token', /\bxox[baprs]-[A-Za-z0-9-]{10,}/], ['supabase_service_key', /\bsb_secret_[A-Za-z0-9_-]{10,}/], ['openai_key', /\bsk-[A-Za-z0-9]{32,}\b/],
  ['generic_secret_assignment', /\b(api[_-]?key|secret|password|passwd|token)\b\s*[:=]\s*['"][^'"\s]{12,}['"]/i],
];
export function staticProblems(path, content) {
  const out = [];
  const lineOf = (idx) => content.slice(0, idx).split('\n').length;
  if (/\.json$/i.test(path)) {
    try { JSON.parse(content); } catch (e) {
      const m = /position (\d+)/.exec(e.message);
      out.push({ path, line: m ? lineOf(Number(m[1])) : 1, severity: 'error', source: 'json', message: e.message.slice(0, 200) });
    }
  }
  if (/\.(c?js)$/i.test(path)) {
    const isModule = /^\s*(import\s[\s\S]*?from\s|import\s*['"]|export\s)/m.test(content);
    try {
      if (!isModule) new vm.Script(content, { filename: path });   // compiles only; never runs
    } catch (e) {
      const m = /:(\d+)\n/.exec(e.stack || '');
      out.push({ path, line: m ? Number(m[1]) : 1, severity: 'error', source: 'javascript', message: String(e.message).slice(0, 200) });
    }
  }
  if (!isEnvFile(path)) {
    for (const [kind, re] of SECRET_PATTERNS) {
      const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
      let m; let n = 0;
      while ((m = g.exec(content)) && n++ < 5) out.push({ path, line: lineOf(m.index), severity: 'warning', source: 'secrets', message: `Possible hard-coded secret (${kind}). Move it to environment configuration.` });
    }
  }
  return out;
}
