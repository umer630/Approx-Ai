// Workspace endpoints used by the Approx app shell: chat branching, app feedback, background tasks, usage details and
// the signed-in person's own account activity. Every query is scoped to the caller (user_id = the session's user).
import { one, all, run, now, tx, audit } from '../db.js';
import { readJson, sendJson, bad, notFound, newId, str, clientIp } from '../http.js';
import { requireUser } from '../security.js';
import { usageSummary } from '../quota.js';

const FEEDBACK_CATEGORIES = ['bug', 'idea', 'model_quality', 'billing', 'other'];

export function registerMeRoutes(r) {
  // Copy branch: a new conversation with the same settings and the messages up to (and including) a given message.
  r.post('/api/chats/:id/branch', async (req, res, ctx, p) => {
    const u = requireUser(ctx);
    const c = await one('SELECT * FROM chats WHERE id = ? AND user_id = ? AND deleted_at IS NULL', p.id, u.id);
    if (!c) throw notFound('Chat not found');
    const b = await readJson(req);
    let msgs = await all('SELECT * FROM messages WHERE chat_id = ? AND user_id = ? ORDER BY created_at, id', c.id, u.id);
    if (b.through_message_id) {
      const i = msgs.findIndex((m) => m.id === b.through_message_id);
      if (i < 0) throw notFound('Message not found in this chat');
      msgs = msgs.slice(0, i + 1);
    }
    const id = newId('cht_'); const t = now();
    const title = `${c.title}`.slice(0, 110) + ' (branch)';
    await tx(async () => {
      await run('INSERT INTO chats (id,user_id,project_id,title,model_id,mode,training_eligible,is_fab,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
        id, u.id, c.project_id, title, c.model_id, c.mode, c.training_eligible, c.is_fab, t, t);
      let k = 0;
      for (const m of msgs) {
        await run(`INSERT INTO messages (id,chat_id,user_id,role,content,model_id,model_version,mode,route_reason,attachments,status,tokens_in,tokens_out,created_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, newId('msg_'), id, u.id, m.role, m.content, m.model_id, m.model_version, m.mode, m.route_reason,
        m.attachments, m.status, m.tokens_in, m.tokens_out, t + (k++));
      }
    });
    await audit(u.id, u.id, 'chat.branch', id, clientIp(req), { from: c.id, messages: msgs.length });
    const n = await one('SELECT * FROM chats WHERE id = ?', id);
    sendJson(res, 201, { chat: { id: n.id, title: n.title, model_id: n.model_id, mode: n.mode, project_id: n.project_id, archived: false, deleted: false,
      is_fab: !!n.is_fab, created_at: n.created_at, updated_at: n.updated_at }, copied_messages: msgs.length });
  });

  // General product feedback (separate from the per-message 👍/👎).
  r.post('/api/feedback', async (req, res, ctx) => {
    const u = requireUser(ctx);
    const b = await readJson(req);
    const category = FEEDBACK_CATEGORIES.includes(b.category) ? b.category : 'other';
    const message = str(b.message, 'message', { min: 3, max: 4000 });
    let chatId = null;
    if (b.chat_id) {
      if (!await one('SELECT id FROM chats WHERE id = ? AND user_id = ?', b.chat_id, u.id)) throw notFound('Chat not found');
      chatId = b.chat_id;
    }
    const id = newId('fbk_');
    await run('INSERT INTO app_feedback (id,user_id,category,message,chat_id,user_agent,created_at) VALUES (?,?,?,?,?,?,?)',
      id, u.id, category, message, chatId, String(req.headers['user-agent'] || '').slice(0, 200), now());
    await audit(u.id, u.id, 'feedback.sent', id, clientIp(req), { category });
    sendJson(res, 201, { id, status: 'received' });
  });

  // Background tasks the person can see: Approx Code agent proposals (pending / applied / rejected) and, for
  // administrators, GPU compute jobs. There is no other server-side background work for users.
  r.get('/api/tasks', async (req, res, ctx) => {
    const u = requireUser(ctx);
    const proposals = await all(`SELECT cp.id, cp.project_id, cp.summary, cp.status, cp.created_at, cp.decided_at, p.name project_name
      FROM code_proposals cp JOIN projects p ON p.id = cp.project_id WHERE cp.user_id = ? ORDER BY cp.created_at DESC LIMIT 50`, u.id);
    const tasks = proposals.map((x) => ({ id: x.id, kind: 'code_proposal', title: x.summary, project_id: x.project_id, project_name: x.project_name,
      status: x.status === 'pending' ? 'waiting_for_review' : x.status, created_at: x.created_at, finished_at: x.decided_at }));
    if (['admin', 'superadmin'].includes(u.role)) {
      const jobs = await all('SELECT id, kind, models, status, phase, created_at, finished_at FROM gpu_jobs ORDER BY created_at DESC LIMIT 30');
      for (const j of jobs) {
        let models = j.models; try { models = JSON.parse(j.models).join(', '); } catch { /* plain text */ }
        tasks.push({ id: j.id, kind: 'gpu_job', title: `${j.kind} · ${models}`, status: j.status, phase: j.phase, created_at: j.created_at, finished_at: j.finished_at });
      }
    }
    tasks.sort((a, b) => b.created_at - a.created_at);
    sendJson(res, 200, { tasks, running: tasks.filter((t) => ['waiting_for_review', 'queued', 'running', 'pending'].includes(t.status)).length });
  });

  // Usage details for the Usage page: per-model requests and tokens in the current cycle, and the last 14 days.
  r.get('/api/usage/details', async (req, res, ctx) => {
    const u = requireUser(ctx);
    const summary = await usageSummary(u);
    const since = summary.cycle.started_at;
    const byModel = await all('SELECT model_id, COUNT(*) requests FROM usage_events WHERE user_id = ? AND created_at >= ? GROUP BY model_id ORDER BY requests DESC', u.id, since);
    const tokens = await one("SELECT COALESCE(SUM(tokens_in),0) tokens_in, COALESCE(SUM(tokens_out),0) tokens_out FROM messages WHERE user_id = ? AND role = 'assistant' AND created_at >= ?", u.id, since);
    const day = 86_400_000; const start = Math.floor((now() - 13 * day) / day) * day;
    const daily = await all('SELECT CAST(created_at / 86400000 AS INTEGER) d, COUNT(*) n FROM usage_events WHERE user_id = ? AND created_at >= ? GROUP BY d', u.id, start);
    const counts = Object.fromEntries(daily.map((x) => [x.d, x.n]));
    const days = Array.from({ length: 14 }, (_, i) => { const d = Math.floor(start / day) + i; return { date: new Date(d * day).toISOString().slice(0, 10), requests: counts[d] || 0 }; });
    const totals = await one('SELECT COUNT(*) requests FROM usage_events WHERE user_id = ?', u.id);
    sendJson(res, 200, { ...summary, by_model: byModel, tokens, daily: days, all_time_requests: totals.requests,
      token_note: 'Token counts are recorded by model backends that report them; requests are always counted.' });
  });

  // The person's own account activity (sign-ins, password/email changes…). No IP addresses or internal details.
  r.get('/api/account/activity', async (req, res, ctx) => {
    const u = requireUser(ctx);
    const rows = await all("SELECT action, created_at FROM audit_logs WHERE user_id = ? AND actor IN (?, 'anonymous') ORDER BY id DESC LIMIT 50", u.id, u.id);
    const stats = await one(`SELECT (SELECT COUNT(*) FROM chats WHERE user_id = ? AND deleted_at IS NULL) chats,
      (SELECT COUNT(*) FROM messages WHERE user_id = ? AND role = 'user') messages,
      (SELECT COUNT(*) FROM projects WHERE user_id = ?) projects, (SELECT COUNT(*) FROM files WHERE user_id = ?) files`, u.id, u.id, u.id, u.id);
    sendJson(res, 200, { activity: rows, stats });
  });

  void bad;
}
