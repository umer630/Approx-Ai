// Workspace sessions (API 1.8): Education (grounded in an uploaded PDF), Approx Code and Approx Work.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { req, makeUser, close, parseSse } from './helpers.js';
import { buildMessages, selectPassages } from '../src/engine.js';
import { getModel } from '../src/models.js';
import { one } from '../src/db.js';
after(() => close());

const PDF = fs.readFileSync(new URL('./fixtures/physics-chapter-3.pdf', import.meta.url));
const upload = (token, name, body) => req('POST', '/api/files', { token, raw: true, body, headers: { 'x-filename': name } });

let u, other, edu, chatId;
test('a real textbook-style PDF (embedded fonts, 4 pages) is read completely', async () => {
  u = await makeUser(); other = await makeUser();
  const f = await upload(u.token, 'Physics Chapter 3.pdf', PDF);
  assert.equal(f.status, 201, JSON.stringify(f.data));
  const row = await one('SELECT extracted_text FROM files WHERE id = ?', f.data.file.id);
  assert.match(row.extracted_text, /\[Page 1\][\s\S]*Fluids and Pressure/);
  assert.match(row.extracted_text, /\[Page 4\][\s\S]*Bernoulli's principle/);
  const s = await req('POST', '/api/sessions', { token: u.token, body: { purpose: 'education', file_id: f.data.file.id } });
  assert.equal(s.status, 201, JSON.stringify(s.data));
  edu = s.data.session;
  assert.equal(edu.purpose, 'education');
  assert.equal(edu.name, 'Study · Physics Chapter 3');
  assert.deepEqual(edu.files.map((x) => [x.filename, x.has_text]), [['Physics Chapter 3.pdf', true]]);
});

test('education needs a readable document; other people cannot use your file', async () => {
  assert.equal((await req('POST', '/api/sessions', { token: u.token, body: { purpose: 'education' } })).data.error.code, 'file_required');
  const img = await upload(u.token, 'scan.pdf', Buffer.from('%PDF-1.4\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF'));
  const r = await req('POST', '/api/sessions', { token: u.token, body: { purpose: 'education', file_id: img.data.file.id } });
  assert.equal(r.status, 422); assert.equal(r.data.error.code, 'no_text');
  const mine = await upload(u.token, 'notes.txt', 'Photosynthesis converts light energy into chemical energy stored in glucose.');
  assert.equal((await req('POST', '/api/sessions', { token: other.token, body: { purpose: 'education', file_id: mine.data.file.id } })).status, 404);
  assert.equal((await req('POST', '/api/sessions', { token: u.token, body: { purpose: 'party' } })).status, 400);
  assert.equal((await req('POST', '/api/sessions', { body: { purpose: 'code' } })).status, 401);
});

test('a conversation in the session is grounded in the whole document, not just page 1', async () => {
  const c = await req('POST', '/api/chats', { token: u.token, body: { project_id: edu.id, title: 'Physics Chapter 3', model: 'auto' } });
  assert.equal(c.status, 201, JSON.stringify(c.data));
  chatId = c.data.chat.id;
  const user = await one('SELECT * FROM users WHERE id = (SELECT user_id FROM chats WHERE id = ?)', chatId);
  const chat = await one('SELECT * FROM chats WHERE id = ?', chatId);
  const model = await getModel('nick-4.8');
  const sys = (text) => buildMessages({ user, model, mode: 'medium', chat, text }).then((m) => m[0].content);
  const test = await sys('Mujhe is chapter ka test banao.');   // a broad request: coverage of every page
  for (const p of ['Fluids and Pressure', 'Pressure in liquids', 'Buoyancy', 'Bernoulli']) assert.ok(test.includes(p), `test prompt covers "${p}"`);
  assert.match(test, /Approx's teacher for the study material "Physics Chapter 3\.pdf"/);
  assert.match(test, /answer key/);
  const r = await req('POST', `/api/chats/${chatId}/messages`, { token: u.token, body: { content: 'Explain Bernoulli like a teacher', model: 'auto' } });
  assert.equal(r.status, 200);
  assert.ok(parseSse(r.data).some((e) => e.event === 'done'));
});

test('passage selection: specific questions pull the matching passage; budget is respected', () => {
  const text = Array.from({ length: 40 }, (_, i) => `Section ${i}. ` + (i === 33 ? 'Mitochondria are the powerhouse of the cell and make ATP. '.repeat(10) : 'General filler text about other topics. '.repeat(30))).join('\n');
  const got = selectPassages([{ filename: 'bio.pdf', extracted_text: text }], 'What do mitochondria make? ATP?', 6000).get('bio.pdf');
  assert.ok(got.some((p) => /Mitochondria/.test(p)), 'matching passage selected');
  assert.ok(got.join('').length <= 6000 + 200);
});

test('Approx Code and Approx Work: clean new sessions, listed per workspace, never mixed', async () => {
  const code1 = (await req('POST', '/api/sessions', { token: u.token, body: { purpose: 'code' } })).data.session;
  const code2 = (await req('POST', '/api/sessions', { token: u.token, body: { purpose: 'code' } })).data.session;
  const work = (await req('POST', '/api/sessions', { token: u.token, body: { purpose: 'work' } })).data.session;
  assert.notEqual(code1.id, code2.id);
  assert.match(code1.name, /^Code session · /); assert.match(work.name, /^Work session · /);
  const listed = (p) => req('GET', `/api/sessions?purpose=${p}`, { token: u.token }).then((r) => r.data.sessions.map((s) => s.id));
  assert.deepEqual(new Set(await listed('code')), new Set([code1.id, code2.id]));
  assert.deepEqual(await listed('work'), [work.id]);
  assert.deepEqual(await listed('education'), [edu.id]);
  const eduListed = (await req('GET', '/api/sessions?purpose=education', { token: u.token })).data.sessions[0];
  assert.equal(eduListed.chat.id, chatId, 'the session reopens its conversation');
  assert.deepEqual((await req('GET', '/api/sessions?purpose=code', { token: other.token })).data.sessions, []);
  const c = await req('POST', '/api/chats', { token: u.token, body: { project_id: code1.id, title: 'Code session' } });
  const sysCode = (await buildMessages({ user: await one('SELECT * FROM users WHERE id = (SELECT user_id FROM chats WHERE id = ?)', c.data.chat.id),
    model: await getModel('nick-4.8'), mode: 'medium', chat: await one('SELECT * FROM chats WHERE id = ?', c.data.chat.id), text: 'hi' }))[0].content;
  assert.match(sysCode, /Approx Code session/);
  assert.doesNotMatch(sysCode, /Bernoulli/, 'no state from another session');
});
