// Notifications and per-user preferences that the server enforces.
//
// notify(): one place that writes the in-app inbox and, when the person asked for it, an email copy.
//   kind 'security' (new sign-in, password changed): always in the inbox and always emailed — these cannot be
//   switched off. Other kinds ('task', 'code', 'access'): in the inbox when notify_task_updates is on (access grants
//   always), emailed only when notifications_email is on.
import { one, run, now } from './db.js';
import { newId, bad } from './http.js';
import { sendMail } from './mail.js';

export const KINDS = ['security', 'task', 'code', 'access', 'system'];

export async function notify(userId, { kind = 'system', title, body, link = null }) {
  const s = await one('SELECT notifications_email, notify_task_updates FROM settings WHERE user_id = ?', userId) || {};
  const u = await one("SELECT email FROM users WHERE id = ? AND status = 'active'", userId);
  if (!u) return null;
  const inbox = kind === 'security' || kind === 'access' || kind === 'system' || s.notify_task_updates !== 0;
  let id = null;
  if (inbox) {
    id = newId('ntf_');
    await run('INSERT INTO notifications (id,user_id,title,body,kind,link,created_at) VALUES (?,?,?,?,?,?,?)', id, userId, String(title).slice(0, 200), String(body).slice(0, 2000), kind, link, now());
  }
  if (kind === 'security' || (s.notifications_email && inbox)) {
    try { await sendMail(u.email, `Approx AI: ${title}`, `${body}\n\n— Approx AI${kind === 'security' ? '\nIf this was not you, reset your password immediately.' : ''}`); } catch { /* mail never blocks the action */ }
  }
  return id;
}

// ---------------------------------------------------------------- workspace preferences (validated, merged)
export const WORKSPACE_PREF_DEFAULTS = {
  education: { quiz_count: 5, difficulty: 'mixed', explanation_style: 'simple' },
  code: { default_branch: 'main' },
  work: { plan_threads: true },
};
const BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,59}$/;

export function readWorkspacePrefs(raw) {
  let p = {};
  try { p = JSON.parse(raw || '{}') || {}; } catch { p = {}; }
  const out = {};
  for (const [k, d] of Object.entries(WORKSPACE_PREF_DEFAULTS)) out[k] = { ...d, ...(p[k] && typeof p[k] === 'object' ? p[k] : {}) };
  return out;
}

/** Validates a partial update ({education:{quiz_count:8}}) and returns the merged JSON to store. */
export function mergeWorkspacePrefs(raw, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw bad('workspace_prefs must be an object');
  const cur = readWorkspacePrefs(raw);
  for (const [ws, vals] of Object.entries(patch)) {
    if (!WORKSPACE_PREF_DEFAULTS[ws]) throw bad(`Unknown workspace: ${ws}`);
    if (!vals || typeof vals !== 'object') throw bad(`workspace_prefs.${ws} must be an object`);
    for (const [k, v] of Object.entries(vals)) {
      const key = `${ws}.${k}`;
      if (key === 'education.quiz_count') { if (!Number.isInteger(v) || v < 3 || v > 20) throw bad('Quiz length must be 3–20 questions'); }
      else if (key === 'education.difficulty') { if (!['easy', 'mixed', 'hard'].includes(v)) throw bad('Difficulty must be easy, mixed or hard'); }
      else if (key === 'education.explanation_style') { if (!['simple', 'detailed', 'exam'].includes(v)) throw bad('Explanation style must be simple, detailed or exam'); }
      else if (key === 'code.default_branch') { if (typeof v !== 'string' || !BRANCH_RE.test(v) || v.includes('..')) throw bad('Default branch: letters, digits, . _ / - (max 60)'); }
      else if (key === 'work.plan_threads') { if (typeof v !== 'boolean') throw bad('plan_threads must be true or false'); }
      else throw bad(`Unknown setting: ${key}`);
      cur[ws][k] = v;
    }
  }
  return JSON.stringify(cur);
}

export async function workspacePrefs(userId) {
  return readWorkspacePrefs((await one('SELECT workspace_prefs FROM settings WHERE user_id = ?', userId))?.workspace_prefs);
}

// ---------------------------------------------------------------- data retention
export const RETENTION_DAYS = [0, 7, 30, 90, 365];
/** Deletes conversations (and empty work sessions) untouched for longer than the person's retention period. */
export async function enforceRetention(userId) {
  const s = await one('SELECT chat_retention_days FROM settings WHERE user_id = ?', userId);
  const days = s?.chat_retention_days || 0;
  if (!days) return 0;
  const cutoff = now() - days * 86400_000;
  const r = await run('DELETE FROM chats WHERE user_id = ? AND updated_at < ?', userId, cutoff);
  await run('DELETE FROM work_sessions WHERE user_id = ? AND updated_at < ? AND NOT EXISTS (SELECT 1 FROM chats c WHERE c.session_id = work_sessions.id)', userId, cutoff);
  return r?.changes || 0;
}
