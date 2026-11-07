import { one, all, run, now, audit } from '../db.js';
import { readJson, sendJson, notFound, bad, forbidden, newId, startSse, HttpError, str, oneOf, clientIp } from '../http.js';
import { requireUser, requireVerified, rateLimit } from '../security.js';
import { modelsForUser, getModel, canUseModel, MODES } from '../models.js';
import { providerStatus } from '../providers/index.js';
import { complete } from '../engine.js';
import { usageSummary } from '../quota.js';

function ownChat(userId, id) {
  const c = one('SELECT * FROM chats WHERE id = ? AND user_id = ?', id, userId);
  if (!c) throw notFound('Chat not found');
  return c;
}
function chatView(c) {
  return { id: c.id, title: c.title, model_id: c.model_id, mode: c.mode, project_id: c.project_id, archived: !!c.archived,
    deleted: !!c.deleted_at, training_eligible: !!c.training_eligible, is_fab: !!c.is_fab, created_at: c.created_at, updated_at: c.updated_at };
}
function msgView(m) {
  return { id: m.id, role: m.role, content: m.content, model_id: m.model_id, mode: m.mode, route_reason: m.route_reason,
    attachments: JSON.parse(m.attachments || '[]'), status: m.status, created_at: m.created_at };
}

export function registerChatRoutes(r) {
  r.get('/api/models', async (req, res, ctx) => {
    const u = requireUser(ctx);
    sendJson(res, 200, {
      models: modelsForUser(u).map((m) => ({ ...m, backend: providerStatus(m.family) })),
      modes: MODES,
      router: { id: 'auto', name: 'Master Router (Auto)' },
    });
  });

  r.get('/api/usage', async (req, res, ctx) => sendJson(res, 200, usageSummary(requireUser(ctx))));

  // History: search, archived, trash, project filter.
  r.get('/api/chats', async (req, res, ctx, p, url) => {
    const u = requireUser(ctx);
    const q = (url.searchParams.get('q') || '').slice(0, 200);
    const view = url.searchParams.get('view') || 'active'; // active | archived | trash
    const project = url.searchParams.get('project_id');
    const where = ['c.user_id = ?'];
    const args = [u.id];
    if (view === 'trash') where.push('c.deleted_at IS NOT NULL');
    else { where.push('c.deleted_at IS NULL'); where.push(`c.archived = ${view === 'archived' ? 1 : 0}`); }
    if (project) { where.push('c.project_id = ?'); args.push(project); }
    if (q) {
      where.push('(c.title LIKE ? ESCAPE \'\\\' OR EXISTS (SELECT 1 FROM messages m WHERE m.chat_id = c.id AND m.user_id = c.user_id AND m.content LIKE ? ESCAPE \'\\\'))');
      const like = '%' + q.replace(/[\\%_]/g, (x) => '\\' + x) + '%';
      args.push(like, like);
    }
    const rows = all(`SELECT c.* FROM chats c WHERE ${where.join(' AND ')} ORDER BY c.updated_at DESC LIMIT 200`, ...args);
    sendJson(res, 200, { chats: rows.map(chatView) });
  });

  r.post('/api/chats', async (req, res, ctx) => {
    const u = requireUser(ctx);
    const b = await readJson(req);
    const s = one('SELECT * FROM settings WHERE user_id = ?', u.id);
    const modelId = b.model && b.model !== 'auto' ? b.model : (s.default_model || 'nick-4.8');
    const m = getModel(modelId);
    if (!m || !canUseModel(u, m)) throw forbidden('Model not available for this account', 'model_access_denied');
    const mode = oneOf(b.mode, 'mode', MODES, s.default_mode);
    if (b.project_id && !one('SELECT id FROM projects WHERE id = ? AND user_id = ?', b.project_id, u.id)) throw notFound('Project not found');
    const isFab = m.family === 'fab' ? 1 : 0;
    const eligible = !isFab && s.training_opt_in && m.history_training_allowed ? 1 : 0;
    const id = newId('cht_');
    run('INSERT INTO chats (id,user_id,project_id,title,model_id,mode,training_eligible,is_fab,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
      id, u.id, b.project_id || null, str(b.title, 'title', { max: 120, required: false }) || 'New chat', m.id, mode, eligible, isFab, now(), now());
    sendJson(res, 201, { chat: chatView(ownChat(u.id, id)) });
  });

  r.get('/api/chats/:id', async (req, res, ctx, p) => {
    const u = requireUser(ctx);
    const c = ownChat(u.id, p.id);
    const msgs = all('SELECT * FROM messages WHERE chat_id = ? AND user_id = ? ORDER BY created_at', c.id, u.id);
    sendJson(res, 200, { chat: chatView(c), messages: msgs.map(msgView) });
  });

  r.patch('/api/chats/:id', async (req, res, ctx, p) => {
    const u = requireUser(ctx);
    const c = ownChat(u.id, p.id);
    const b = await readJson(req);
    if (b.title !== undefined) run('UPDATE chats SET title = ? WHERE id = ?', str(b.title, 'title', { min: 1, max: 120 }), c.id);
    if (b.archived !== undefined) run('UPDATE chats SET archived = ? WHERE id = ?', b.archived ? 1 : 0, c.id);
    if (b.restore === true) run('UPDATE chats SET deleted_at = NULL WHERE id = ?', c.id);
    if (b.training_eligible !== undefined) {
      if (b.training_eligible && c.is_fab) throw forbidden('FAB conversations can never be used for training', 'fab_training_forbidden');
      const m = getModel(c.model_id);
      if (b.training_eligible && !m?.history_training_allowed) throw forbidden('This model does not use history training');
      run('UPDATE chats SET training_eligible = ? WHERE id = ?', b.training_eligible ? 1 : 0, c.id);
    }
    if (b.project_id !== undefined) {
      if (b.project_id && !one('SELECT id FROM projects WHERE id = ? AND user_id = ?', b.project_id, u.id)) throw notFound('Project not found');
      run('UPDATE chats SET project_id = ? WHERE id = ?', b.project_id || null, c.id);
    }
    sendJson(res, 200, { chat: chatView(ownChat(u.id, c.id)) });
  });

  r.delete('/api/chats/:id', async (req, res, ctx, p, url) => {
    const u = requireUser(ctx);
    const c = ownChat(u.id, p.id);
    if (url.searchParams.get('purge') === '1' || c.deleted_at) {
      run('DELETE FROM chats WHERE id = ? AND user_id = ?', c.id, u.id);
      audit(u.id, u.id, 'chat.purged', c.id, clientIp(req));
      return sendJson(res, 200, { status: 'purged' });
    }
    run('UPDATE chats SET deleted_at = ? WHERE id = ?', now(), c.id);
    sendJson(res, 200, { status: 'trashed' });
  });

  // Send a message; response is an SSE stream: route → delta* → done | error
  r.post('/api/chats/:id/messages', async (req, res, ctx, p) => {
    const u = requireUser(ctx);
    requireVerified(u);
    rateLimit(`chat-burst:${u.id}`, 20, 60_000);
    const c = ownChat(u.id, p.id);
    if (c.deleted_at) throw bad('Chat is in trash; restore it first');
    const b = await readJson(req, 512 * 1024);
    await streamTurn({ req, res, ctx, user: u, chat: c, text: b.content, model: b.model ?? c.model_id, mode: b.mode ?? c.mode, attachments: b.attachments || [] });
  });

  // Regenerate the last assistant reply.
  r.post('/api/chats/:id/regenerate', async (req, res, ctx, p) => {
    const u = requireUser(ctx);
    requireVerified(u);
    const c = ownChat(u.id, p.id);
    const b = await readJson(req);
    const lastUser = one("SELECT * FROM messages WHERE chat_id = ? AND user_id = ? AND role = 'user' ORDER BY created_at DESC LIMIT 1", c.id, u.id);
    if (!lastUser) throw bad('Nothing to regenerate');
    run("DELETE FROM messages WHERE chat_id = ? AND user_id = ? AND created_at >= ?", c.id, u.id, lastUser.created_at);
    await streamTurn({ req, res, ctx, user: u, chat: c, text: lastUser.content, model: b.model ?? c.model_id, mode: b.mode ?? c.mode,
      attachments: JSON.parse(lastUser.attachments).map((a) => a.id) });
  });
}

async function streamTurn({ req, res, ctx, user, chat, text, model, mode, attachments }) {
  const t0 = now();
  const userMsgId = newId('msg_');
  const asstId = newId('msg_');
  let sse = null;
  let routeInfo = null;
  const abort = new AbortController();
  res.on('close', () => { if (!res.writableEnded) abort.abort(); }); // client went away → stop upstream generation
  try {
    const result = await complete({
      signal: abort.signal,
      user, chat, text, requestedModel: model, requestedMode: mode, attachments, source: 'chat', requestId: ctx.requestId,
      onRoute: (r) => {
        if (chat.is_fab !== (r.model.family === 'fab' ? 1 : 0) && r.model.family === 'fab') {
          run('UPDATE chats SET is_fab = 1, training_eligible = 0 WHERE id = ?', chat.id); // FAB taints chat: never trainable
        }
        routeInfo = r;
      },
      onDelta: (d) => {
        if (!sse) {
          sse = startSse(res);
          sse.send('route', { model_id: routeInfo.model.id, model_name: routeInfo.model.name, mode: routeInfo.mode, reason: routeInfo.reason, task: routeInfo.task.primary, request_id: ctx.requestId });
        }
        sse.send('delta', { text: d });
      },
    });
    const t = now();
    run('INSERT INTO messages (id,chat_id,user_id,role,content,attachments,created_at) VALUES (?,?,?,?,?,?,?)',
      userMsgId, chat.id, user.id, 'user', text, JSON.stringify(result.attachments || []), t0);
    run('INSERT INTO messages (id,chat_id,user_id,role,content,model_id,mode,route_reason,status,tokens_in,tokens_out,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
      asstId, chat.id, user.id, 'assistant', result.text, result.route.model.id, result.route.mode, result.route.reason,
      result.refused ? 'refused' : 'complete', result.usage.prompt_tokens || 0, result.usage.completion_tokens || 0, Math.max(t, t0 + 1));
    const title = chat.title === 'New chat' ? text.replace(/\s+/g, ' ').trim().slice(0, 60) || 'New chat' : chat.title;
    run('UPDATE chats SET updated_at = ?, title = ?, model_id = ?, mode = ? WHERE id = ?', t, title, result.route.model.id, result.route.mode, chat.id);
    if (!sse) { sse = startSse(res); }
    sse.send('done', { user_message_id: userMsgId, message_id: asstId, title, refused: result.refused, memory_saved: result.memorySaved, usage: usageSummary(user) });
    sse.end();
  } catch (e) {
    if (!sse) throw e; // nothing streamed yet → normal JSON error response
    const err = e instanceof HttpError ? { code: e.code, message: e.message } : { code: 'internal_error', message: 'The response was interrupted' };
    if (!(e instanceof HttpError)) console.error(e);
    sse.send('error', err);
    sse.end();
  }
}
