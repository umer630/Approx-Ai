// Settings, profile, memory, projects, notifications, data export.
import { one, all, run, now, audit } from '../db.js';
import { readJson, sendJson, bad, notFound, newId, str, oneOf, clientIp } from '../http.js';
import { requireUser } from '../security.js';
import { getModel, canUseModel, MODES } from '../models.js';
import { publicUser } from './auth.js';

export function registerAccountRoutes(r) {
  // ---------- settings & profile ----------
  r.get('/api/settings', async (req, res, ctx) => {
    const u = requireUser(ctx);
    const s = one('SELECT * FROM settings WHERE user_id = ?', u.id);
    sendJson(res, 200, { user: publicUser(u), settings: {
      default_model: s.default_model, default_mode: s.default_mode, memory_enabled: !!s.memory_enabled,
      training_opt_in: !!s.training_opt_in, notifications_email: !!s.notifications_email, personalization: s.personalization, theme: s.theme,
    } });
  });

  r.patch('/api/settings', async (req, res, ctx) => {
    const u = requireUser(ctx);
    const b = await readJson(req);
    const sets = [];
    const args = [];
    if (b.default_model !== undefined) {
      const m = getModel(b.default_model);
      if (!m || !canUseModel(u, m)) throw bad('Model not available for this account');
      sets.push('default_model = ?'); args.push(m.id);
    }
    if (b.default_mode !== undefined) { sets.push('default_mode = ?'); args.push(oneOf(b.default_mode, 'default_mode', MODES)); }
    for (const k of ['memory_enabled', 'training_opt_in', 'notifications_email']) {
      if (b[k] !== undefined) { sets.push(`${k} = ?`); args.push(b[k] ? 1 : 0); }
    }
    if (b.personalization !== undefined) { sets.push('personalization = ?'); args.push(str(b.personalization, 'personalization', { max: 1500, required: false }) || ''); }
    if (b.theme !== undefined) { sets.push('theme = ?'); args.push(oneOf(b.theme, 'theme', ['dark', 'light', 'system'])); }
    if (sets.length) run(`UPDATE settings SET ${sets.join(', ')} WHERE user_id = ?`, ...args, u.id);
    if (b.training_opt_in === false) {
      // Withdrawing consent removes every chat from training eligibility immediately.
      run('UPDATE chats SET training_eligible = 0 WHERE user_id = ?', u.id);
    }
    if (b.training_opt_in !== undefined) audit(u.id, u.id, b.training_opt_in ? 'consent.training_granted' : 'consent.training_withdrawn', u.id, clientIp(req));
    if (b.display_name !== undefined) run('UPDATE profiles SET display_name = ? WHERE user_id = ?', str(b.display_name, 'display_name', { max: 80, required: false }) || '', u.id);
    if (b.language !== undefined) run('UPDATE profiles SET language = ? WHERE user_id = ?', oneOf(b.language, 'language', ['auto', 'en', 'ur', 'roman-ur']), u.id);
    res.statusCode = 200;
    const s = one('SELECT * FROM settings WHERE user_id = ?', u.id);
    sendJson(res, 200, { status: 'saved', settings: { ...s, memory_enabled: !!s.memory_enabled, training_opt_in: !!s.training_opt_in, notifications_email: !!s.notifications_email } });
  });

  // Data export (privacy / portability)
  r.get('/api/account/export', async (req, res, ctx) => {
    const u = requireUser(ctx);
    const data = {
      user: publicUser(u),
      settings: one('SELECT * FROM settings WHERE user_id = ?', u.id),
      memories: all('SELECT id, content, created_at FROM memories WHERE user_id = ?', u.id),
      projects: all('SELECT id, name, description, instructions, kind, created_at FROM projects WHERE user_id = ?', u.id),
      chats: all('SELECT id, title, model_id, mode, created_at FROM chats WHERE user_id = ?', u.id).map((c) => ({
        ...c, messages: all('SELECT role, content, model_id, created_at FROM messages WHERE chat_id = ? AND user_id = ? ORDER BY created_at', c.id, u.id),
      })),
      files: all('SELECT id, filename, size, sha256, created_at FROM files WHERE user_id = ?', u.id),
    };
    res.setHeader('Content-Disposition', 'attachment; filename="approx-ai-export.json"');
    sendJson(res, 200, data);
  });

  // ---------- memory (spec §17) ----------
  r.get('/api/memory', async (req, res, ctx) => {
    const u = requireUser(ctx);
    const s = one('SELECT memory_enabled FROM settings WHERE user_id = ?', u.id);
    sendJson(res, 200, { enabled: !!s.memory_enabled, memories: all('SELECT id, content, source, created_at, updated_at FROM memories WHERE user_id = ? ORDER BY updated_at DESC', u.id) });
  });
  r.post('/api/memory', async (req, res, ctx) => {
    const u = requireUser(ctx);
    const b = await readJson(req);
    if (one('SELECT COUNT(*) c FROM memories WHERE user_id = ?', u.id).c >= 200) throw bad('Memory limit (200 items) reached');
    const id = newId('mem_');
    run('INSERT INTO memories (id,user_id,content,source,created_at,updated_at) VALUES (?,?,?,?,?,?)', id, u.id, str(b.content, 'content', { min: 2, max: 500 }), 'user', now(), now());
    sendJson(res, 201, { memory: one('SELECT id, content, source, created_at, updated_at FROM memories WHERE id = ?', id) });
  });
  r.patch('/api/memory/:id', async (req, res, ctx, p) => {
    const u = requireUser(ctx);
    const b = await readJson(req);
    const c = run('UPDATE memories SET content = ?, updated_at = ? WHERE id = ? AND user_id = ?', str(b.content, 'content', { min: 2, max: 500 }), now(), p.id, u.id);
    if (!c.changes) throw notFound('Memory not found');
    sendJson(res, 200, { status: 'updated' });
  });
  r.delete('/api/memory/:id', async (req, res, ctx, p) => {
    const u = requireUser(ctx);
    if (!run('DELETE FROM memories WHERE id = ? AND user_id = ?', p.id, u.id).changes) throw notFound('Memory not found');
    sendJson(res, 200, { status: 'deleted' });
  });
  r.delete('/api/memory', async (req, res, ctx) => {
    const u = requireUser(ctx);
    run('DELETE FROM memories WHERE user_id = ?', u.id);
    audit(u.id, u.id, 'memory.cleared', u.id, clientIp(req));
    sendJson(res, 200, { status: 'cleared' });
  });

  // ---------- projects / knowledge spaces (spec §16) ----------
  const projView = (p) => ({ ...p,
    chat_count: one('SELECT COUNT(*) c FROM chats WHERE project_id = ? AND user_id = ? AND deleted_at IS NULL', p.id, p.user_id).c,
    file_count: one('SELECT COUNT(*) c FROM files WHERE project_id = ? AND user_id = ?', p.id, p.user_id).c,
    user_id: undefined });
  const ownProject = (uid, id) => { const p = one('SELECT * FROM projects WHERE id = ? AND user_id = ?', id, uid); if (!p) throw notFound('Project not found'); return p; };

  r.get('/api/projects', async (req, res, ctx, p, url) => {
    const u = requireUser(ctx);
    const kind = url.searchParams.get('kind');
    const rows = kind ? all('SELECT * FROM projects WHERE user_id = ? AND kind = ? ORDER BY updated_at DESC', u.id, kind)
      : all('SELECT * FROM projects WHERE user_id = ? ORDER BY updated_at DESC', u.id);
    sendJson(res, 200, { projects: rows.map(projView) });
  });
  r.post('/api/projects', async (req, res, ctx) => {
    const u = requireUser(ctx);
    const b = await readJson(req);
    if (one('SELECT COUNT(*) c FROM projects WHERE user_id = ?', u.id).c >= 100) throw bad('Project limit reached');
    const id = newId('prj_');
    run('INSERT INTO projects (id,user_id,name,description,instructions,kind,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)',
      id, u.id, str(b.name, 'name', { min: 1, max: 100 }), str(b.description, 'description', { max: 1000, required: false }) || '',
      str(b.instructions, 'instructions', { max: 8000, required: false }) || '', oneOf(b.kind, 'kind', ['knowledge', 'fabbox', 'coeprox'], 'knowledge'), now(), now());
    sendJson(res, 201, { project: projView(ownProject(u.id, id)) });
  });
  r.get('/api/projects/:id', async (req, res, ctx, p) => {
    const u = requireUser(ctx);
    const pr = ownProject(u.id, p.id);
    sendJson(res, 200, {
      project: projView(pr),
      chats: all('SELECT id, title, model_id, updated_at FROM chats WHERE project_id = ? AND user_id = ? AND deleted_at IS NULL ORDER BY updated_at DESC', pr.id, u.id),
      files: all('SELECT id, filename, kind, size, scan_status, created_at FROM files WHERE project_id = ? AND user_id = ?', pr.id, u.id),
    });
  });
  r.patch('/api/projects/:id', async (req, res, ctx, p) => {
    const u = requireUser(ctx);
    const pr = ownProject(u.id, p.id);
    const b = await readJson(req);
    run('UPDATE projects SET name = ?, description = ?, instructions = ?, updated_at = ? WHERE id = ?',
      b.name !== undefined ? str(b.name, 'name', { min: 1, max: 100 }) : pr.name,
      b.description !== undefined ? str(b.description, 'description', { max: 1000, required: false }) || '' : pr.description,
      b.instructions !== undefined ? str(b.instructions, 'instructions', { max: 8000, required: false }) || '' : pr.instructions,
      now(), pr.id);
    sendJson(res, 200, { project: projView(ownProject(u.id, pr.id)) });
  });
  r.delete('/api/projects/:id', async (req, res, ctx, p) => {
    const u = requireUser(ctx);
    ownProject(u.id, p.id);
    const { removeFileBlobs } = await import('./files.js');
    removeFileBlobs(all('SELECT storage_key FROM files WHERE project_id = ? AND user_id = ?', p.id, u.id));
    run('DELETE FROM projects WHERE id = ? AND user_id = ?', p.id, u.id);
    sendJson(res, 200, { status: 'deleted' });
  });

  // ---------- notifications ----------
  r.get('/api/notifications', async (req, res, ctx) => {
    const u = requireUser(ctx);
    sendJson(res, 200, { notifications: all('SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 50', u.id) });
  });
  r.post('/api/notifications/:id/read', async (req, res, ctx, p) => {
    const u = requireUser(ctx);
    run('UPDATE notifications SET read_at = ? WHERE id = ? AND user_id = ?', now(), p.id, u.id);
    sendJson(res, 200, { status: 'ok' });
  });
}
