// Approx Work / Code / Education: one server-side session architecture (API 1.9).
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { req, makeUser, close, parseSse, db } from './helpers.js';
import { buildMessages } from '../src/engine.js';
import { getModel } from '../src/models.js';
after(() => close());

let u, other, A, B;
const say = (token, chatId, content) => req('POST', `/api/chats/${chatId}/messages`, { token, body: { content, model: 'auto' } });
const messages = async (token, chatId) => (await req('GET', `/api/chats/${chatId}`, { token })).data.messages.map((m) => m.content);
const systemFor = async (chatId, text) => {
  const chat = await db.one('SELECT * FROM chats WHERE id = ?', chatId);
  const user = await db.one('SELECT * FROM users WHERE id = ?', chat.user_id);
  return (await buildMessages({ user, model: await getModel('nick-4.8'), mode: 'medium', chat, text }))[0].content;
};

test('1–3. two New Sessions are two server-side sessions with different IDs and their own first thread', async () => {
  u = await makeUser(); other = await makeUser();
  const ws = await req('GET', '/api/workspaces', { token: u.token });
  assert.deepEqual(ws.data.workspaces.map((w) => w.kind), ['work', 'code', 'education']);
  assert.ok(ws.data.workspaces.every((w) => w.org_id && w.org_id === ws.data.workspaces[0].org_id), 'one personal organization');
  const r1 = await req('POST', '/api/work-sessions', { token: u.token, body: { workspace: 'work', title: 'Launch plan' } });
  const r2 = await req('POST', '/api/work-sessions', { token: u.token, body: { workspace: 'work', title: 'Budget review' } });
  assert.deepEqual([r1.status, r2.status], [201, 201]);
  A = r1.data; B = r2.data;
  assert.match(A.session.id, /^ses_/); assert.notEqual(A.session.id, B.session.id);
  assert.notEqual(A.thread.id, B.thread.id);
  assert.deepEqual(A.session.threads.map((t) => t.id), [A.thread.id]);
});

test('4. messages stay in their own session; the other session never sees them', async () => {
  const s = await say(u.token, A.thread.id, 'Our launch codename is BLUEHERON.');
  assert.equal(s.status, 200); assert.ok(parseSse(s.data).some((e) => e.event === 'done'));
  assert.equal((await messages(u.token, A.thread.id)).length, 2);
  assert.deepEqual(await messages(u.token, B.thread.id), [], 'session B has no messages from A');
  const sysB = await systemFor(B.thread.id, 'What is the codename?');
  assert.doesNotMatch(sysB, /BLUEHERON/);
  assert.match(sysB, /Approx Work session: Budget review/);
  assert.match(await systemFor(A.thread.id, 'x'), /Approx Work session: Launch plan/);
});

test('5–7. close the app, sign in again on another device, resume exactly that session', async () => {
  const again = await req('POST', '/api/auth/login', { body: { email: u.email, password: u.password, client: 'mobile' } });
  const t2 = again.data.token;
  assert.notEqual(t2, u.token);
  const list = await req('GET', '/api/work-sessions?workspace=work', { token: t2 });
  assert.deepEqual(new Set(list.data.sessions.map((s) => s.id)), new Set([A.session.id, B.session.id]));
  const resumed = await req('GET', `/api/work-sessions/${A.session.id}`, { token: t2 });
  assert.equal(resumed.data.session.title, 'Launch plan');
  assert.equal(resumed.data.session.threads[0].id, A.thread.id);
  assert.equal(resumed.data.session.threads[0].message_count, 2);
  assert.match((await messages(t2, A.thread.id))[0], /BLUEHERON/);
  const top = (await req('GET', '/api/work-sessions?workspace=work', { token: t2 })).data.sessions[0];
  assert.equal(top.id, A.session.id, 'the last opened session is first');
});

test('8–9. New Thread: a full thread of the same session, with its own messages', async () => {
  const t = await req('POST', `/api/work-sessions/${A.session.id}/threads`, { token: u.token, body: { title: 'Press release' } });
  assert.equal(t.status, 201);
  assert.notEqual(t.data.thread.id, A.thread.id);
  assert.deepEqual(await messages(u.token, t.data.thread.id), [], 'a new thread starts empty');
  await say(u.token, t.data.thread.id, 'Draft a headline about TIDEPOOL.');
  assert.ok(!(await messages(u.token, A.thread.id)).some((m) => /TIDEPOOL/.test(m)), 'thread messages are isolated');
  assert.match(await systemFor(t.data.thread.id, 'x'), /Approx Work session: Launch plan/, 'but the thread keeps its session context');
  const d = await req('GET', `/api/work-sessions/${A.session.id}`, { token: u.token });
  assert.deepEqual(d.data.session.threads.map((x) => x.title), ['Main thread', 'Press release']);
});

test('10. authorization: another account cannot read or change any of it by ID', async () => {
  const sid = A.session.id;
  const ups = [
    ['GET', `/api/work-sessions/${sid}`], ['PATCH', `/api/work-sessions/${sid}`, { title: 'x' }], ['DELETE', `/api/work-sessions/${sid}`],
    ['POST', `/api/work-sessions/${sid}/threads`, {}], ['POST', `/api/work-sessions/${sid}/tasks`, { title: 'x' }], ['POST', `/api/work-sessions/${sid}/duplicate`, {}],
    ['GET', `/api/chats/${A.thread.id}`], ['POST', `/api/chats/${A.thread.id}/messages`, { content: 'hi' }],
  ];
  for (const [m, path, body] of ups) assert.equal((await req(m, path, { token: other.token, body })).status, 404, `${m} ${path}`);
  assert.deepEqual((await req('GET', '/api/work-sessions?workspace=work', { token: other.token })).data.sessions, []);
  const f = await req('POST', '/api/files', { token: other.token, raw: true, body: 'x', headers: { 'x-filename': 'a.txt', 'x-session-id': sid } });
  assert.equal(f.status, 404, 'cannot upload into someone else\'s session');
  const art = await req('POST', '/api/workspace/artifacts', { token: other.token, body: { title: 't', session_id: sid, content: 'x' } });
  assert.equal(art.status, 404, 'cannot attach an artifact to someone else\'s session');
  assert.equal((await req('GET', `/api/work-sessions/${sid}`)).status, 401, 'no session cookie/token → 401');
});

test('tasks, agent plan (one thread per task), files, artifacts, rename, archive, search, duplicate, delete', async () => {
  const sid = B.session.id;
  const t = await req('POST', `/api/work-sessions/${sid}/tasks`, { token: u.token, body: { title: 'Collect Q3 invoices' } });
  assert.equal(t.status, 201);
  assert.equal((await req('PATCH', `/api/tasks/${t.data.task.id}`, { token: u.token, body: { status: 'in_progress' } })).data.task.status, 'in_progress');
  assert.equal((await req('PATCH', `/api/tasks/${t.data.task.id}`, { token: other.token, body: { status: 'done' } })).status, 404);
  const plan = await req('POST', `/api/work-sessions/${sid}/plan`, { token: u.token, body: { goal: 'Prepare the annual budget presentation' } });
  assert.equal(plan.status, 201, JSON.stringify(plan.data));
  assert.equal(plan.data.tasks.length, 2);
  assert.ok(plan.data.tasks.every((x) => x.thread_id && x.created_by === 'agent'), 'each planned task has its own thread');
  const f = await req('POST', '/api/files', { token: u.token, raw: true, body: 'Budget cap is 42,000 USD for marketing.', headers: { 'x-filename': 'budget.txt', 'x-session-id': sid } });
  assert.equal(f.status, 201);
  const a = await req('POST', '/api/workspace/artifacts', { token: u.token, body: { title: 'Budget summary', kind: 'markdown', content: '# Summary', session_id: sid } });
  assert.equal(a.status, 201);
  const d = (await req('GET', `/api/work-sessions/${sid}`, { token: u.token })).data.session;
  assert.equal(d.tasks.length, 3); assert.equal(d.threads.length, 3);
  assert.deepEqual(d.files.map((x) => x.filename), ['budget.txt']);
  assert.deepEqual(d.artifacts.map((x) => x.title), ['Budget summary']);
  assert.ok(d.agent_runs.some((x) => x.kind === 'plan' && x.status === 'completed'));
  assert.ok(d.logs.some((x) => x.tool === 'task_planner' && x.status === 'ok'));
  assert.match(await systemFor(B.thread.id, 'What is the marketing budget cap?'), /42,000 USD/, 'session documents reach every thread of the session');
  assert.doesNotMatch(await systemFor(A.thread.id, 'What is the marketing budget cap?'), /42,000/, '…and no other session');
  const ov = (await req('GET', '/api/workspaces/work', { token: u.token })).data;
  assert.ok(ov.active_tasks.length >= 3); assert.ok(ov.files.some((x) => x.filename === 'budget.txt')); assert.ok(ov.artifacts.length >= 1);
  assert.ok(ov.connectors.every((c) => c.status === 'not_configured'), 'connected apps are listed honestly');
  assert.equal((await req('PATCH', `/api/work-sessions/${sid}`, { token: u.token, body: { title: 'Budget 2027' } })).data.session.title, 'Budget 2027');
  assert.deepEqual((await req('GET', '/api/work-sessions?workspace=work&q=BLUEHERON', { token: u.token })).data.sessions.map((s) => s.id), [A.session.id], 'search finds message text');
  const dup = await req('POST', `/api/work-sessions/${A.session.id}/duplicate`, { token: u.token });
  assert.equal(dup.status, 201);
  assert.notEqual(dup.data.session.id, A.session.id);
  assert.equal(dup.data.session.threads.length, 2);
  await say(u.token, dup.data.session.threads[0].id, 'Only in the copy: OSPREY');
  assert.ok(!(await messages(u.token, A.thread.id)).some((m) => /OSPREY/.test(m)), 'the duplicate is independent');
  await req('PATCH', `/api/work-sessions/${dup.data.session.id}`, { token: u.token, body: { status: 'archived' } });
  assert.ok(!(await req('GET', '/api/work-sessions?workspace=work', { token: u.token })).data.sessions.some((s) => s.id === dup.data.session.id));
  assert.ok((await req('GET', '/api/work-sessions?workspace=work&status=archived', { token: u.token })).data.sessions.some((s) => s.id === dup.data.session.id));
  assert.equal((await req('DELETE', `/api/work-sessions/${dup.data.session.id}`, { token: u.token })).status, 200);
  assert.equal((await req('GET', `/api/work-sessions/${dup.data.session.id}`, { token: u.token })).status, 404);
  assert.equal((await req('GET', `/api/chats/${dup.data.session.threads[0].id}`, { token: u.token })).status, 404, 'its threads are gone');
});

test('Approx Code: repository project → code sessions (own threads, shared repo) → status, diff, commit, log, branch, checkout, runner', async () => {
  const pr = (await req('POST', '/api/workspaces/code/projects', { token: u.token, body: { name: 'approx-api' } })).data.project;
  assert.equal(pr.current_branch, 'main');
  const s1 = (await req('POST', '/api/work-sessions', { token: u.token, body: { workspace: 'code', project_id: pr.id } })).data;
  const s2 = (await req('POST', '/api/work-sessions', { token: u.token, body: { workspace: 'code', project_id: pr.id } })).data;
  assert.notEqual(s1.session.id, s2.session.id);
  assert.equal(s1.session.project.id, pr.id);
  await req('PUT', `/api/fabbox/${pr.id}/file`, { token: u.token, body: { path: 'src/app.js', content: 'console.log(1)\n' } });
  const st = (await req('GET', `/api/code/${pr.id}/status`, { token: u.token })).data;
  assert.deepEqual(st.changes, [{ path: 'src/app.js', status: 'added' }]);
  assert.equal(st.runner.available, false);
  assert.match(await systemFor(s2.thread.id, 'x'), /src\/app\.js/, 'every code session inherits the repository');
  await say(u.token, s1.thread.id, 'Refactor plan ALBATROSS');
  assert.ok(!(await messages(u.token, s2.thread.id)).some((m) => /ALBATROSS/.test(m)), 'code sessions keep their own conversation');
  const c1 = await req('POST', `/api/code/${pr.id}/commit`, { token: u.token, body: { message: 'Initial commit', session_id: s1.session.id } });
  assert.equal(c1.status, 201);
  assert.equal((await req('POST', `/api/code/${pr.id}/commit`, { token: u.token, body: { message: 'again' } })).data.error.code, 'nothing_to_commit');
  await req('PUT', `/api/fabbox/${pr.id}/file`, { token: u.token, body: { path: 'src/app.js', content: 'console.log(2)\n' } });
  const diff = (await req('GET', `/api/code/${pr.id}/diff`, { token: u.token })).data.diffs[0];
  assert.equal(diff.status, 'modified'); assert.match(diff.diff, /-console\.log\(1\)/); assert.match(diff.diff, /\+console\.log\(2\)/);
  assert.equal((await req('POST', `/api/code/${pr.id}/branches`, { token: u.token, body: { name: 'feature/x' } })).status, 201);
  assert.equal((await req('POST', `/api/code/${pr.id}/checkout`, { token: u.token, body: { branch: 'feature/x' } })).data.error.code, 'uncommitted_changes');
  await req('POST', `/api/code/${pr.id}/commit`, { token: u.token, body: { message: 'Second' } });
  const co = await req('POST', `/api/code/${pr.id}/checkout`, { token: u.token, body: { branch: 'feature/x' } });
  assert.equal(co.status, 200);
  assert.equal((await req('GET', `/api/fabbox/${pr.id}/file?path=src/app.js`, { token: u.token })).data.file.content, 'console.log(1)\n', 'branch content restored');
  assert.equal((await req('GET', `/api/code/${pr.id}/log`, { token: u.token })).data.commits.length, 1);
  await req('POST', `/api/code/${pr.id}/checkout`, { token: u.token, body: { branch: 'main' } });
  assert.deepEqual((await req('GET', `/api/code/${pr.id}/log`, { token: u.token })).data.commits.map((c) => c.message), ['Second', 'Initial commit']);
  const runr = await req('POST', `/api/code/${pr.id}/run`, { token: u.token, body: { command: 'npm test', kind: 'test', session_id: s1.session.id } });
  assert.equal(runr.status, 501); assert.equal(runr.data.error.code, 'runner_not_configured');
  const logs = (await req('GET', `/api/work-sessions/${s1.session.id}`, { token: u.token })).data.session.logs;
  assert.deepEqual(logs.map((l) => `${l.tool}:${l.status}`).sort(), ['git.commit:ok', 'run:test:unavailable']);
  for (const path of [`/api/code/${pr.id}/status`, `/api/code/${pr.id}/diff`, `/api/code/${pr.id}/log`, `/api/code/${pr.id}/branches`]) {
    assert.equal((await req('GET', path, { token: other.token })).status, 404, path);
  }
  assert.equal((await req('POST', '/api/work-sessions', { token: other.token, body: { workspace: 'code', project_id: pr.id } })).status, 404, 'cannot open a session on someone else\'s repository');
});

test('Approx Education: course → study sessions → document, quiz (answer key server-side), practice score, assignments, progress', async () => {
  const course = (await req('POST', '/api/workspaces/education/projects', { token: u.token, body: { name: 'Class 11 Physics' } })).data.project;
  const pdf = fs.readFileSync(new URL('./fixtures/physics-chapter-3.pdf', import.meta.url));
  const f = await req('POST', '/api/files', { token: u.token, raw: true, body: pdf, headers: { 'x-filename': 'Chapter 3.pdf' } });
  const s1 = (await req('POST', '/api/work-sessions', { token: u.token, body: { workspace: 'education', project_id: course.id, file_id: f.data.file.id, title: 'Class 11 Physics — Chapter 3' } })).data;
  const s2 = (await req('POST', '/api/work-sessions', { token: u.token, body: { workspace: 'education', project_id: course.id, title: 'Chapter 4' } })).data;
  assert.deepEqual(s1.session.files.map((x) => x.filename), ['Chapter 3.pdf']);
  const sys1 = await systemFor(s1.thread.id, 'Make a test on this chapter');
  assert.match(sys1, /Bernoulli/); assert.match(sys1, /teacher/);
  assert.doesNotMatch(await systemFor(s2.thread.id, 'Make a test on this chapter'), /Bernoulli/, 'Chapter 4 does not see Chapter 3 unless shared');
  const q = await req('POST', `/api/work-sessions/${s1.session.id}/quiz`, { token: u.token, body: { count: 3, topic: 'pressure' } });
  assert.equal(q.status, 201, JSON.stringify(q.data));
  assert.ok(q.data.quiz.questions.every((x) => !('answer' in x)), 'answers are not sent to the client');
  const att = await req('POST', `/api/work-sessions/${s1.session.id}/quiz/${q.data.quiz.artifact_id}/attempt`, { token: u.token, body: { answers: [1, 0, 0] } });
  assert.deepEqual([att.data.score, att.data.total, att.data.percent], [2, 3, 67]);
  assert.equal((await req('POST', `/api/work-sessions/${s1.session.id}/quiz/${q.data.quiz.artifact_id}/attempt`, { token: other.token, body: { answers: [1, 0, 0] } })).status, 404);
  const a = await req('POST', `/api/work-sessions/${s1.session.id}/tasks`, { token: u.token, body: { title: 'Exercise 3.2', kind: 'assignment' } });
  await req('PATCH', `/api/tasks/${a.data.task.id}`, { token: u.token, body: { status: 'done' } });
  const ov = (await req('GET', '/api/workspaces/education', { token: u.token })).data;
  const prog = ov.progress.by_course.find((c) => c.project_id === course.id);
  assert.deepEqual([prog.quiz_attempts, prog.average_percent, prog.assignments_done, prog.assignments_total], [1, 67, 1, 1]);
  assert.equal(ov.projects[0].session_count, 2);
});
