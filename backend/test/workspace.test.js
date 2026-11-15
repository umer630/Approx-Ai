import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { req, makeUser, db, close } from './helpers.js';

after(close);

async function chatWith(u, n = 2) {
  const c = (await req('POST', '/api/chats', { token: u.token, body: {} })).data.chat;
  for (let i = 0; i < n; i++) await req('POST', `/api/chats/${c.id}/messages`, { token: u.token, body: { content: `question ${i}` } });
  return c;
}

test('copy branch: duplicates the conversation (optionally up to a message), owner only', async () => {
  const u = await makeUser(); const other = await makeUser();
  const c = await chatWith(u, 2);
  const full = await req('GET', `/api/chats/${c.id}`, { token: u.token });
  assert.equal(full.data.messages.length, 4);
  const b = await req('POST', `/api/chats/${c.id}/branch`, { token: u.token, body: {} });
  assert.equal(b.status, 201);
  assert.equal(b.data.copied_messages, 4);
  assert.match(b.data.chat.title, /\(branch\)$/);
  const copy = await req('GET', `/api/chats/${b.data.chat.id}`, { token: u.token });
  assert.deepEqual(copy.data.messages.map((m) => m.content), full.data.messages.map((m) => m.content));
  const upto = await req('POST', `/api/chats/${c.id}/branch`, { token: u.token, body: { through_message_id: full.data.messages[1].id } });
  assert.equal(upto.data.copied_messages, 2);
  assert.equal((await req('POST', `/api/chats/${c.id}/branch`, { token: other.token, body: {} })).status, 404, 'not someone else’s chat');
});

test('feedback is stored for admins; validation and ownership enforced', async () => {
  const u = await makeUser(); const c = await chatWith(u, 1);
  const r = await req('POST', '/api/feedback', { token: u.token, body: { category: 'idea', message: 'Dark mode toggle in the drawer please', chat_id: c.id } });
  assert.equal(r.status, 201);
  assert.equal((await db.one('SELECT category FROM app_feedback WHERE id = ?', r.data.id)).category, 'idea');
  assert.equal((await req('POST', '/api/feedback', { token: u.token, body: { message: 'x' } })).status, 400);
  const other = await makeUser();
  assert.equal((await req('POST', '/api/feedback', { token: other.token, body: { message: 'hello there', chat_id: c.id } })).status, 404);
});

test('tasks, usage details and account activity are real and scoped to the caller', async () => {
  const u = await makeUser(); await chatWith(u, 3);
  const t = await req('GET', '/api/tasks', { token: u.token });
  assert.equal(t.status, 200);
  assert.ok(Array.isArray(t.data.tasks));
  const d = await req('GET', '/api/usage/details', { token: u.token });
  assert.equal(d.status, 200);
  assert.equal(d.data.by_model.reduce((s, x) => s + x.requests, 0), 3);
  assert.equal(d.data.daily.length, 14);
  assert.equal(d.data.daily.at(-1).requests, 3);
  const a = await req('GET', '/api/account/activity', { token: u.token });
  assert.ok(a.data.activity.some((x) => x.action === 'auth.login'));
  assert.equal(a.data.stats.messages, 3);
  assert.ok(!JSON.stringify(a.data).includes('127.0.0.1'), 'no IPs');
});

test('permissions mode setting and paginated history', async () => {
  const u = await makeUser();
  assert.equal((await req('GET', '/api/settings', { token: u.token })).data.settings.permissions_mode, 'manual');
  assert.equal((await req('PATCH', '/api/settings', { token: u.token, body: { permissions_mode: 'automatic' } })).status, 200);
  assert.equal((await req('GET', '/api/settings', { token: u.token })).data.settings.permissions_mode, 'automatic');
  assert.equal((await req('PATCH', '/api/settings', { token: u.token, body: { permissions_mode: 'yolo' } })).status, 400);
  for (let i = 0; i < 5; i++) { await req('POST', '/api/chats', { token: u.token, body: { title: `c${i}` } }); await new Promise((r) => setTimeout(r, 3)); }
  const p1 = await req('GET', '/api/chats?limit=2', { token: u.token });
  assert.equal(p1.data.chats.length, 2); assert.equal(p1.data.has_more, true);
  const p2 = await req('GET', `/api/chats?limit=2&before=${p1.data.chats.at(-1).updated_at}`, { token: u.token });
  assert.equal(p2.data.chats.length, 2);
  assert.ok(p2.data.chats.every((c) => !p1.data.chats.some((x) => x.id === c.id)), 'no overlap');
});
