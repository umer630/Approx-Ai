// Every setting is stored, validated and has a real effect on the server (Settings v2, API 1.9).
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { req, makeUser, close, db } from './helpers.js';
import { buildMessages } from '../src/engine.js';
import { getModel } from '../src/models.js';
after(() => close());

let u;
const set = (body, token = u.token) => req('PATCH', '/api/settings', { token, body });
const sys = async (chatId, text = 'hi') => {
  const chat = await db.one('SELECT * FROM chats WHERE id = ?', chatId);
  const user = await db.one('SELECT * FROM users WHERE id = ?', chat.user_id);
  return (await buildMessages({ user, model: await getModel('nick-4.8'), mode: 'medium', chat, text }))[0].content;
};
const mails = (email) => db.all('SELECT subject FROM mail_outbox WHERE to_email = ? ORDER BY created_at', email);

test('GET /api/settings returns every setting with defaults', async () => {
  u = await makeUser();
  const s = (await req('GET', '/api/settings', { token: u.token })).data.settings;
  assert.deepEqual([s.notifications_email, s.notify_task_updates, s.chat_retention_days, s.text_size, s.default_workspace, s.permissions_mode],
    [true, true, 0, 'medium', 'home', 'manual']);
  assert.deepEqual(s.workspace_prefs, { education: { quiz_count: 5, difficulty: 'mixed', explanation_style: 'simple' }, code: { default_branch: 'main' }, work: { plan_threads: true } });
});

test('validation: bad values are refused and nothing is saved', async () => {
  for (const body of [{ text_size: 'huge' }, { default_workspace: 'games' }, { chat_retention_days: 12 }, { default_mode: 'turbo' }, { theme: 'neon' },
    { language: 'fr' }, { workspace_prefs: { education: { quiz_count: 50 } } }, { workspace_prefs: { code: { default_branch: '../x' } } },
    { workspace_prefs: { work: { plan_threads: 'yes' } } }, { workspace_prefs: { games: {} } }, { workspace_prefs: { education: { color: 'red' } } }, { default_model: 'fab-500x' }]) {
    assert.equal((await set(body)).status, 400, JSON.stringify(body));
  }
  const s = (await req('GET', '/api/settings', { token: u.token })).data.settings;
  assert.equal(s.text_size, 'medium'); assert.equal(s.workspace_prefs.education.quiz_count, 5);
});

test('appearance + start screen + model defaults persist across sign-ins', async () => {
  assert.equal((await set({ text_size: 'large', default_workspace: 'education', theme: 'system', default_mode: 'low' })).status, 200);
  const again = await req('POST', '/api/auth/login', { body: { email: u.email, password: u.password, client: 'mobile' } });
  const s = (await req('GET', '/api/settings', { token: again.data.token })).data.settings;
  assert.deepEqual([s.text_size, s.default_workspace, s.theme, s.default_mode], ['large', 'education', 'system', 'low']);
  const c = await req('POST', '/api/chats', { token: u.token, body: {} });
  assert.equal(c.data.chat.mode, 'low', 'new conversations use the default mode');
});

test('preferred language reaches the model', async () => {
  const c = (await req('POST', '/api/chats', { token: u.token, body: {} })).data.chat.id;
  assert.doesNotMatch(await sys(c), /Reply language:/, 'auto = follow each message');
  await set({ language: 'roman-ur' });
  assert.match(await sys(c), /Reply language: Always reply in Roman Urdu/);
  await set({ language: 'en' });
  assert.match(await sys(c), /Always reply in English/);
  await set({ language: 'auto' });
});

test('notifications: security events always arrive (inbox + email); task updates follow the toggles', async () => {
  // New device → security notification + email.
  await req('POST', '/api/auth/login', { body: { email: u.email, password: u.password }, headers: { 'user-agent': 'NewBrowser/99' } });
  let n = (await req('GET', '/api/notifications', { token: u.token })).data;
  assert.ok(n.notifications.some((x) => x.kind === 'security' && x.title === 'New sign-in'));
  assert.ok(n.unread >= 1);
  assert.ok((await mails(u.email)).some((m) => /New sign-in/.test(m.subject)), 'security email sent');
  // Task notification: inbox yes; email only when "email copies" is on.
  await set({ notifications_email: false });
  const s = (await req('POST', '/api/work-sessions', { token: u.token, body: { workspace: 'work', title: 'N' } })).data.session;
  await req('POST', `/api/work-sessions/${s.id}/plan`, { token: u.token, body: { goal: 'Prepare a report' } });
  n = (await req('GET', '/api/notifications', { token: u.token })).data;
  assert.ok(n.notifications.some((x) => x.kind === 'task' && x.title === 'Plan ready' && x.link === `#/s/${s.id}/Tasks`));
  assert.ok(!(await mails(u.email)).some((m) => /Plan ready/.test(m.subject)), 'no email copy when switched off');
  await set({ notifications_email: true });
  await req('POST', `/api/work-sessions/${s.id}/plan`, { token: u.token, body: { goal: 'Second plan' } });
  assert.ok((await mails(u.email)).some((m) => /Plan ready/.test(m.subject)), 'email copy when switched on');
  await set({ notify_task_updates: false });
  const before = (await req('GET', '/api/notifications', { token: u.token })).data.notifications.length;
  await req('POST', `/api/work-sessions/${s.id}/plan`, { token: u.token, body: { goal: 'Third plan' } });
  assert.equal((await req('GET', '/api/notifications', { token: u.token })).data.notifications.length, before, 'task updates off → no inbox entry');
  // Inbox actions.
  const id = n.notifications[0].id;
  assert.equal((await req('DELETE', `/api/notifications/${id}`, { token: (await makeUser()).token })).status, 404, 'cannot delete someone else\'s');
  await req('POST', '/api/notifications/read-all', { token: u.token });
  assert.equal((await req('GET', '/api/notifications', { token: u.token })).data.unread, 0);
  assert.equal((await req('DELETE', `/api/notifications/${id}`, { token: u.token })).status, 200);
  await req('DELETE', '/api/notifications', { token: u.token });
  assert.equal((await req('GET', '/api/notifications', { token: u.token })).data.notifications.length, 0);
  await set({ notify_task_updates: true });
});

test('Approx Code permissions: Manual waits for review (and notifies); Automatic applies the change', async () => {
  const pr = (await req('POST', '/api/workspaces/code/projects', { token: u.token, body: { name: 'perm-repo' } })).data.project;
  const m = await req('POST', `/api/fabbox/${pr.id}/agent`, { token: u.token, body: { instruction: 'add notes' } });
  assert.equal(m.data.proposal.status, 'pending'); assert.equal(m.data.proposal.permission, 'manual');
  assert.equal((await req('GET', `/api/fabbox/${pr.id}/files`, { token: u.token })).data.files.length, 0, 'nothing written yet');
  assert.ok((await req('GET', '/api/notifications', { token: u.token })).data.notifications.some((x) => x.kind === 'code'));
  await set({ permissions_mode: 'automatic' });
  const a = await req('POST', `/api/fabbox/${pr.id}/agent`, { token: u.token, body: { instruction: 'add notes' } });
  assert.equal(a.data.proposal.status, 'applied');
  assert.deepEqual((await req('GET', `/api/fabbox/${pr.id}/files`, { token: u.token })).data.files.map((f) => f.path), ['NOTES.md']);
  await set({ permissions_mode: 'manual' });
});

test('workspace settings: default branch, quiz length/difficulty, explanation style, planning threads', async () => {
  await set({ workspace_prefs: { code: { default_branch: 'trunk' }, education: { quiz_count: 3, difficulty: 'hard', explanation_style: 'exam' }, work: { plan_threads: false } } });
  const s = (await req('GET', '/api/settings', { token: u.token })).data.settings.workspace_prefs;
  assert.deepEqual(s, { education: { quiz_count: 3, difficulty: 'hard', explanation_style: 'exam' }, code: { default_branch: 'trunk' }, work: { plan_threads: false } });
  const pr = (await req('POST', '/api/workspaces/code/projects', { token: u.token, body: { name: 'trunk-repo' } })).data.project;
  assert.equal(pr.current_branch, 'trunk');
  assert.equal((await req('GET', `/api/code/${pr.id}/branches`, { token: u.token })).data.current, 'trunk');
  const ed = (await req('POST', '/api/work-sessions', { token: u.token, body: { workspace: 'education', title: 'Prefs' } })).data;
  assert.match(await sys(ed.thread.id), /Explanation style: exam-focused/);
  await req('POST', '/api/files', { token: u.token, raw: true, body: 'Newton\'s second law: force equals mass times acceleration, F = m a.', headers: { 'x-filename': 'n.txt', 'x-session-id': ed.session.id } });
  const q = await req('POST', `/api/work-sessions/${ed.session.id}/quiz`, { token: u.token, body: {} });
  assert.equal(q.data.quiz.difficulty, 'hard');
  const run = await db.one("SELECT input FROM agent_runs WHERE session_id = ? AND kind = 'quiz'", ed.session.id);
  assert.match(run.input, /^3 questions/, 'default quiz length from settings');
  const w = (await req('POST', '/api/work-sessions', { token: u.token, body: { workspace: 'work' } })).data.session;
  const plan = await req('POST', `/api/work-sessions/${w.id}/plan`, { token: u.token, body: { goal: 'Organise a launch' } });
  assert.ok(plan.data.tasks.every((t) => t.thread_id === null), 'planning without threads when switched off');
});

test('data controls: archive all, retention deletes old conversations, delete all needs typed confirmation', async () => {
  const v = await makeUser();
  const c1 = (await req('POST', '/api/chats', { token: v.token, body: { title: 'old' } })).data.chat.id;
  const c2 = (await req('POST', '/api/chats', { token: v.token, body: { title: 'new' } })).data.chat.id;
  assert.equal((await req('POST', '/api/account/data/archive-chats', { token: v.token })).data.count, 2);
  assert.equal((await req('GET', '/api/chats', { token: v.token })).data.chats.length, 0);
  assert.equal((await req('GET', '/api/chats?view=archived', { token: v.token })).data.chats.length, 2);
  await db.run('UPDATE chats SET updated_at = ? WHERE id = ?', Date.now() - 40 * 86400_000, c1);
  await req('PATCH', '/api/settings', { token: v.token, body: { chat_retention_days: 30 } });
  assert.equal((await req('GET', `/api/chats/${c1}`, { token: v.token })).status, 404, '40-day-old conversation deleted by 30-day retention');
  assert.equal((await req('GET', `/api/chats/${c2}`, { token: v.token })).status, 200, 'recent conversation kept');
  assert.equal((await req('POST', '/api/account/data/delete-chats', { token: v.token, body: { confirm: 'yes' } })).data.error.code, 'confirmation_required');
  assert.equal((await req('POST', '/api/account/data/delete-chats', { token: v.token, body: { confirm: 'DELETE' } })).data.count, 1);
  assert.equal((await req('GET', `/api/chats/${c2}`, { token: v.token })).status, 404);
  assert.equal((await req('GET', `/api/chats/${(await req('POST', '/api/chats', { token: u.token, body: {} })).data.chat.id}`, { token: u.token })).status, 200, 'other accounts untouched');
});
