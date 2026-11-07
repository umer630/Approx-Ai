// Shared completion engine used by the web/mobile chat and the public API.
import { one, all, run, now } from './db.js';
import { HttpError, forbidden, bad } from './http.js';
import { route, identityPrompt } from './models.js';
import { consumeQuota } from './quota.js';
import { streamCompletion } from './providers/index.js';

const MAX_CONTEXT_CHARS = 24_000;

function settingsOf(userId) { return one('SELECT * FROM settings WHERE user_id = ?', userId) || {}; }

function projectContext(userId, projectId, query) {
  if (!projectId) return '';
  const p = one('SELECT * FROM projects WHERE id = ? AND user_id = ?', projectId, userId);
  if (!p) return '';
  let out = `\n\n# Project: ${p.name}\n${p.instructions ? 'Project instructions:\n' + p.instructions + '\n' : ''}`;
  // Lightweight keyword retrieval over project knowledge files (same-user, same-project only).
  const files = all("SELECT filename, extracted_text FROM files WHERE user_id = ? AND project_id = ? AND extracted_text IS NOT NULL AND scan_status = 'clean'", userId, projectId);
  const terms = new Set(String(query).toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) || []);
  const scored = files.map((f) => {
    const words = f.extracted_text.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) || [];
    let score = 0; for (const w of words) if (terms.has(w)) score++;
    return { ...f, score };
  }).sort((a, b) => b.score - a.score).slice(0, 4);
  let budget = 8000;
  for (const f of scored) {
    const excerpt = f.extracted_text.slice(0, Math.min(budget, 3000));
    budget -= excerpt.length;
    out += `\n## Knowledge file: ${f.filename}\n${excerpt}\n`;
    if (budget <= 0) break;
  }
  return out;
}

function attachmentContext(userId, ids) {
  if (!ids?.length) return { text: '', meta: [] };
  if (!Array.isArray(ids) || ids.length > 10) throw bad('attachments must be an array of up to 10 file ids');
  let text = '';
  const meta = [];
  for (const id of ids) {
    const f = one('SELECT id, filename, kind, mime, size, scan_status, extracted_text FROM files WHERE id = ? AND user_id = ?', String(id), userId);
    if (!f) throw bad(`Attachment ${id} not found`, 'attachment_not_found');
    if (f.scan_status !== 'clean') throw forbidden(`Attachment ${f.filename} did not pass the security scan`, 'attachment_blocked');
    meta.push({ id: f.id, filename: f.filename, kind: f.kind, size: f.size });
    if (f.extracted_text) text += `\n\n<attachment name="${f.filename.replace(/"/g, '')}">\n${f.extracted_text.slice(0, 12000)}\n</attachment>`;
    else text += `\n\n[Attachment ${f.filename} (${f.kind}) is attached; its content cannot be read by the current text model backend.]`;
  }
  return { text, meta };
}

export function buildMessages({ user, model, mode, chat, text, attachText, history: given, systemExtra }) {
  const s = settingsOf(user.id);
  let system = identityPrompt(model, mode);
  if (s.personalization) system += `\n\nUser personalization preferences: ${s.personalization.slice(0, 1500)}`;
  // Memory is never injected into FAB (spec §12: no cross-session memory for FAB).
  if (model.family !== 'fab' && s.memory_enabled) {
    const mem = all('SELECT content FROM memories WHERE user_id = ? ORDER BY updated_at DESC LIMIT 30', user.id);
    if (mem.length) system += '\n\nThings the user asked you to remember:\n' + mem.map((m) => `- ${m.content}`).join('\n');
  }
  if (chat?.project_id) system += projectContext(user.id, chat.project_id, text);

  if (systemExtra) system += `\n\n${systemExtra}`;
  const history = given ? given : chat ? all("SELECT role, content FROM messages WHERE chat_id = ? AND user_id = ? AND status = 'complete' ORDER BY created_at", chat.id, user.id) : [];
  const trimmed = [];
  let size = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    size += history[i].content.length;
    if (size > MAX_CONTEXT_CHARS) break;
    trimmed.unshift({ role: history[i].role, content: history[i].content });
  }
  return [{ role: 'system', content: system }, ...trimmed, { role: 'user', content: text + (attachText || '') }];
}

const REMEMBER = /^\s*(remember( that)?|yaad rakho( ke)?|یاد رکھو)\s*[:,]?\s*(.{3,500})$/is;

/**
 * Run one completion with full policy enforcement.
 * Returns { route, text, usage, refused, memorySaved }.
 */
export async function complete({ user, chat, text, requestedModel, requestedMode, attachments, source, requestId, onRoute, onDelta, history, systemExtra, skipMemoryCapture }) {
  if (typeof text !== 'string' || !text.trim()) throw bad('content is required');
  if (text.length > 100_000) throw bad('content is too long (max 100,000 characters)');
  const s = settingsOf(user.id);
  const r = route(user, { requestedModel, requestedMode: requestedMode ?? s.default_mode, text, defaultModel: s.default_model || 'nick-4.8' });
  onRoute?.(r);

  // Explicit, consented memory capture: "remember that …"
  let memorySaved = null;
  const mm = REMEMBER.exec(text);
  if (mm && !skipMemoryCapture && r.model.family !== 'fab' && s.memory_enabled) {
    const id = 'mem_' + crypto.randomUUID().slice(0, 18);
    run('INSERT INTO memories (id,user_id,content,source,created_at,updated_at) VALUES (?,?,?,?,?,?)', id, user.id, mm[4].trim(), 'chat', now(), now());
    memorySaved = { id, content: mm[4].trim() };
  }

  if (!r.safety.allowed) {
    const msg = `I can't help with that. ${r.safety.reason}`;
    onDelta?.(msg);
    return { route: r, text: msg, usage: { prompt_tokens: 0, completion_tokens: 0 }, refused: true, memorySaved };
  }

  consumeQuota(user, { source, modelId: r.model.id, mode: r.mode, requestId });
  const { text: attachText, meta } = attachmentContext(user.id, attachments);
  const messages = buildMessages({ user, model: r.model, mode: r.mode, chat, text, attachText, history, systemExtra });
  const out = await streamCompletion({ model: r.model, mode: r.mode, messages, onDelta });
  return { route: r, text: out.text, usage: out.usage, refused: false, attachments: meta, memorySaved };
}

export { HttpError };
