// Shared completion engine used by the web/mobile chat and the public API.
import { one, all, run, now } from './db.js';
import { HttpError, forbidden, bad } from './http.js';
import { route, identityPrompt, modeParams, recordModelFailure } from './models.js';
import { consumeQuota } from './quota.js';
import { streamCompletion } from './providers/index.js';


async function settingsOf(userId) { return await one('SELECT * FROM settings WHERE user_id = ?', userId) || {}; }

async function projectContext(userId, projectId, query) {
  if (!projectId) return '';
  const p = await one('SELECT * FROM projects WHERE id = ? AND user_id = ?', projectId, userId);
  if (!p) return '';
  let out = `\n\n# Project: ${p.name}\n${p.instructions ? 'Project instructions:\n' + p.instructions + '\n' : ''}`;
  // Keyword retrieval over project knowledge files (same-user, same-project only), passage by passage so that the
  // whole document is reachable — not just its first pages. Education sessions get a larger budget.
  const files = await all("SELECT filename, extracted_text FROM files WHERE user_id = ? AND project_id = ? AND extracted_text IS NOT NULL AND scan_status = 'clean'", userId, projectId);
  const passages = selectPassages(files, query, p.purpose === 'education' ? 14000 : 8000);
  for (const [filename, parts] of passages) out += `\n## ${p.purpose === 'education' ? 'Study material' : 'Knowledge file'}: ${filename}\n${parts.join('\n…\n')}\n`;
  return out;
}

const PASSAGE = 1500;
/** Splits each file into ~1.5k-character passages and picks the ones that best match the query, in document order.
 *  A broad request ("summarize", "make a test", "teach this chapter") matches little specifically, so the remaining
 *  budget is filled with passages spread evenly over the document: the model sees the whole material, not page 1. */
export function selectPassages(files, query, budget) {
  const terms = new Set(String(query).toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) || []);
  const all = [];
  for (const f of files) {
    const t = f.extracted_text;
    for (let i = 0, k = 0; i < t.length; i += PASSAGE, k++) {
      const text = t.slice(i, i + PASSAGE).trim();
      if (!text) continue;
      let score = 0;
      for (const w of text.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) || []) if (terms.has(w)) score++;
      all.push({ filename: f.filename, k, text, score });
    }
  }
  const maxN = Math.max(1, Math.floor(budget / PASSAGE));
  const chosen = new Set(all.filter((x) => x.score >= 2).sort((a, b) => b.score - a.score).slice(0, Math.ceil(maxN / 2)));
  const rest = all.filter((x) => !chosen.has(x));
  const room = maxN - chosen.size;
  for (let i = 0; i < room && rest.length; i++) chosen.add(rest[Math.floor((i * rest.length) / room)]);
  const byFile = new Map();
  for (const x of all) if (chosen.has(x)) { if (!byFile.has(x.filename)) byFile.set(x.filename, []); byFile.get(x.filename).push(x.text); }
  return byFile;
}

async function attachmentContext(userId, ids) {
  if (!ids?.length) return { text: '', meta: [] };
  if (!Array.isArray(ids) || ids.length > 10) throw bad('attachments must be an array of up to 10 file ids');
  let text = '';
  const meta = [];
  for (const id of ids) {
    const f = await one('SELECT id, filename, kind, mime, size, scan_status, extracted_text FROM files WHERE id = ? AND user_id = ?', String(id), userId);
    if (!f) throw bad(`Attachment ${id} not found`, 'attachment_not_found');
    if (f.scan_status !== 'clean') throw forbidden(`Attachment ${f.filename} did not pass the security scan`, 'attachment_blocked');
    meta.push({ id: f.id, filename: f.filename, kind: f.kind, size: f.size });
    if (f.extracted_text) text += `\n\n<attachment name="${f.filename.replace(/"/g, '')}">\n${f.extracted_text.slice(0, 12000)}\n</attachment>`;
    else text += `\n\n[Attachment ${f.filename} (${f.kind}) is attached; its content cannot be read by the current text model backend.]`;
  }
  return { text, meta };
}

export async function buildMessages({ user, model, mode, chat, text, attachText, history: given, systemExtra }) {
  const s = await settingsOf(user.id);
  let system = identityPrompt(model, mode);
  if (s.personalization) system += `\n\nUser personalization preferences: ${s.personalization.slice(0, 1500)}`;
  // Preferred reply language (Settings → Profile). "auto" keeps matching the language of each message.
  const lang = (await one('SELECT language FROM profiles WHERE user_id = ?', user.id))?.language;
  const LANG = { en: 'Always reply in English, even when the user writes in Urdu or Roman Urdu.', ur: 'Always reply in Urdu written in Urdu script (اردو).', 'roman-ur': 'Always reply in Roman Urdu (Urdu written with Latin letters).' };
  if (LANG[lang]) system += `\n\nReply language: ${LANG[lang]}`;
  // Memory is never injected into FAB (spec §12: no cross-session memory for FAB).
  if (model.family !== 'fab' && s.memory_enabled) {
    const mem = await all('SELECT content FROM memories WHERE user_id = ? ORDER BY updated_at DESC LIMIT 30', user.id);
    if (mem.length) system += '\n\nThings the user asked you to remember:\n' + mem.map((m) => `- ${m.content}`).join('\n');
  }
  if (chat?.project_id) system += await projectContext(user.id, chat.project_id, text);
  // A thread of a Work / Code / Education session: the session's notes, documents and tasks (never other sessions').
  if (chat?.session_id) { const { sessionContext } = await import('./routes/worksessions.js'); system += await sessionContext(user.id, chat.session_id, text, selectPassages); }

  if (systemExtra) system += `\n\n${systemExtra}`;
  const history = given ? given : chat ? await all("SELECT role, content FROM messages WHERE chat_id = ? AND user_id = ? AND status = 'complete' ORDER BY created_at", chat.id, user.id) : [];
  const maxContext = modeParams(model.id, mode).context_chars; // efficiency mode sets the context budget
  const trimmed = [];
  let size = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    size += history[i].content.length;
    if (size > maxContext) break;
    trimmed.unshift({ role: history[i].role, content: history[i].content });
  }
  return [{ role: 'system', content: system }, ...trimmed, { role: 'user', content: text + (attachText || '') }];
}

const REMEMBER = /^\s*(remember( that)?|yaad rakho( ke)?|یاد رکھو)\s*[:,]?\s*(.{3,500})$/is;

/**
 * Run one completion with full policy enforcement.
 * Returns { route, text, usage, refused, memorySaved }.
 */
export async function complete({ user, chat, text, requestedModel, requestedMode, requestedVersion, attachments, source, requestId, onRoute, onDelta, history, systemExtra, skipMemoryCapture, signal }) {
  if (typeof text !== 'string' || !text.trim()) throw bad('content is required');
  if (text.length > 100_000) throw bad('content is too long (max 100,000 characters)');
  const s = await settingsOf(user.id);
  const r = await route(user, { requestedModel, requestedMode: requestedMode ?? s.default_mode, requestedVersion, text, defaultModel: s.default_model || 'nick-4.8' });
  onRoute?.(r);

  // Explicit, consented memory capture: "remember that …"
  let memorySaved = null;
  const mm = REMEMBER.exec(text);
  if (mm && !skipMemoryCapture && r.model.family !== 'fab' && s.memory_enabled) {
    const id = 'mem_' + crypto.randomUUID().slice(0, 18);
    await run('INSERT INTO memories (id,user_id,content,source,created_at,updated_at) VALUES (?,?,?,?,?,?)', id, user.id, mm[4].trim(), 'chat', now(), now());
    memorySaved = { id, content: mm[4].trim() };
  }

  if (!r.safety.allowed) {
    const msg = `I can't help with that. ${r.safety.reason}`;
    onDelta?.(msg);
    return { route: r, text: msg, usage: { prompt_tokens: 0, completion_tokens: 0 }, refused: true, memorySaved };
  }

  await consumeQuota(user, { source, modelId: r.model.id, mode: r.mode, requestId });
  const { text: attachText, meta } = await attachmentContext(user.id, attachments);
  const messages = await buildMessages({ user, model: r.model, mode: r.mode, chat, text, attachText, history, systemExtra });
  let out;
  try {
    out = await streamCompletion({ model: r.model, mode: r.mode, version: r.version, messages, onDelta, signal });
  } catch (e) {
    if (e?.name !== 'AbortError') await recordModelFailure(user.id, r.model.id, e, source);
    throw e;
  }
  return { route: r, text: out.text, usage: out.usage, refused: false, attachments: meta, memorySaved };
}

export { HttpError };
