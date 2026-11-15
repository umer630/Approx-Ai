// FAB 500X Code workspace: grant gate, project isolation (IDOR), path validation, files/rename/upload/search/history,
// checkpoints, static problems, secret masking, runner honesty, agent manual/automatic flows with diffs, audit.
import test from 'node:test';
import assert from 'node:assert/strict';
import { req, makeUser, db, close, asAdmin } from './helpers.js';

test.after(close);
let sa, owner, other, outsider, pid;
const B = '/api/fab500x';
const grant = async (u) => assert.equal((await req('PUT', `/api/admin/clients/${u.id}/models/fab-500x`, {
  headers: { cookie: sa.admin.cookie, 'x-admin-csrf': sa.admin.csrf }, body: { access: 'enabled', reason: 'test' } })).status, 200);

test('setup: superadmin grants FAB 500X to two users; a third has no grant', async () => {
  sa = await asAdmin(await makeUser(), 'superadmin');
  owner = await makeUser(); other = await makeUser(); outsider = await makeUser();
  await grant(owner); await grant(other);
});

test('no grant → every workspace route is a 404 (no existence oracle); unauthenticated → 401', async () => {
  for (const p of [`${B}/capabilities`, `${B}/projects`]) {
    assert.equal((await req('GET', p, { token: outsider.token })).status, 404, p);
    assert.equal((await req('GET', p)).status, 401, p);
  }
  assert.equal((await req('POST', `${B}/projects`, { token: outsider.token, body: { name: 'x' } })).status, 404);
});

test('capabilities are honest about what is connected', async () => {
  const c = (await req('GET', `${B}/capabilities`, { token: owner.token })).data;
  assert.match(c.terminal, /^unavailable/);
  assert.match(c.image_generation, /not connected/);
  assert.match(c.video_generation, /not connected/);
  assert.match(c.agent, /simulator/, 'the dev simulator is labelled as such');
  assert.match(c.git, /not a Git repository/);
});

test('projects + files: create, write, read, rename folder, upload, search, history, restore', async () => {
  const p = await req('POST', `${B}/projects`, { token: owner.token, body: { name: 'shop', instructions: 'Use ES modules' } });
  assert.equal(p.status, 201); pid = p.data.project.id;
  const put = (path, content) => req('PUT', `${B}/projects/${pid}/file`, { token: owner.token, body: { path, content } });
  assert.equal((await put('src/app.js', 'const a = 1;\nconsole.log(a)\n')).data.status, 'saved');
  assert.equal((await put('src/app.js', 'const a = 1;\nconsole.log(a)\n')).data.status, 'unchanged');
  assert.equal((await put('src/app.js', 'const a = 2;\nconsole.log(a)\n')).data.status, 'saved');
  assert.equal((await put('package.json', '{"name":"shop"}')).status, 200);
  for (const bad of ['../etc/passwd', '/abs.js', 'a/../../b', 'C:/x.js', 'a//b', 'x\u0000y']) assert.equal((await put(bad, 'x')).status, 400, bad);
  const up = await req('POST', `${B}/projects/${pid}/upload`, { token: owner.token, body: { files: [{ path: 'docs/README.md', content: '# Shop\nTODO: payments' }] } });
  assert.deepEqual(up.data.saved, ['docs/README.md']);
  assert.equal((await req('POST', `${B}/projects/${pid}/upload`, { token: owner.token, body: { files: [{ path: 'bin.exe', content: 'MZ\u0000\u0000' }] } })).data.error.code, 'binary_not_supported');
  const mv = await req('POST', `${B}/projects/${pid}/rename`, { token: owner.token, body: { from: 'src', to: 'lib' } });
  assert.deepEqual(mv.data.moved, [['src/app.js', 'lib/app.js']]);
  const tree = (await req('GET', `${B}/projects/${pid}/tree`, { token: owner.token })).data.files.map((f) => f.path);
  assert.deepEqual(tree, ['docs/README.md', 'lib/app.js', 'package.json']);
  const s = (await req('GET', `${B}/projects/${pid}/search?q=todo`, { token: owner.token })).data.results;
  assert.deepEqual(s.map((r) => [r.path, r.matches[0].line]), [['docs/README.md', 2]]);
  const h = (await req('GET', `${B}/projects/${pid}/history?path=lib/app.js`, { token: owner.token })).data.versions;
  assert.equal(h.length, 1);
  const hsrc = (await req('GET', `${B}/projects/${pid}/history?path=src/app.js`, { token: owner.token })).data.versions;
  assert.ok(hsrc[0].deleted && hsrc.length === 3, 'src/app.js: 2 edits + moved away');
  assert.equal((await req('POST', `${B}/projects/${pid}/history/${hsrc[2].id}/restore`, { token: owner.token })).data.status, 'restored');
  assert.equal((await req('GET', `${B}/projects/${pid}/file?path=src/app.js`, { token: owner.token })).data.file.content, 'const a = 1;\nconsole.log(a)\n');
  assert.equal((await req('DELETE', `${B}/projects/${pid}/file?path=src/app.js`, { token: owner.token })).data.error.code, 'confirmation_required');
  assert.equal((await req('DELETE', `${B}/projects/${pid}/file?path=src/app.js&confirm=1`, { token: owner.token })).status, 200);
});

test('isolation: another granted user cannot read, write, list or act on this project (IDOR)', async () => {
  for (const [m, p, body] of [['GET', `${B}/projects/${pid}/tree`], ['GET', `${B}/projects/${pid}/file?path=package.json`], ['PUT', `${B}/projects/${pid}/file`, { path: 'x.js', content: '1' }],
    ['POST', `${B}/projects/${pid}/agent`, { instruction: 'read everything' }], ['GET', `${B}/projects/${pid}/search?q=shop`], ['DELETE', `${B}/projects/${pid}?confirm=shop`]]) {
    assert.equal((await req(m, p, { token: other.token, body })).status, 404, `${m} ${p}`);
  }
  assert.equal((await req('GET', `${B}/projects`, { token: other.token })).data.projects.length, 0);
  // The generic project/FABBOX APIs do not expose FAB 500X projects either.
  assert.equal((await req('GET', `/api/fabbox/${pid}/files`, { token: owner.token })).status, 404);
  assert.ok(!(await req('GET', '/api/projects?kind=fabbox', { token: owner.token })).data.projects.some((x) => x.id === pid));
});

test('secrets: .env values are masked, never searchable, reveal is audited, masked saves are refused; problems flag secrets', async () => {
  await req('PUT', `${B}/projects/${pid}/file`, { token: owner.token, body: { path: '.env', content: 'DB_URL=postgres://u:supersecret@h/db\nEMPTY=\n' } });
  const f = (await req('GET', `${B}/projects/${pid}/file?path=.env`, { token: owner.token })).data.file;
  assert.equal(f.masked, true); assert.ok(!f.content.includes('supersecret')); assert.match(f.content, /DB_URL=•+/);
  assert.equal((await req('PUT', `${B}/projects/${pid}/file`, { token: owner.token, body: { path: '.env', content: f.content } })).data.error.code, 'masked_content');
  assert.equal((await req('GET', `${B}/projects/${pid}/search?q=supersecret`, { token: owner.token })).data.results.length, 0);
  assert.ok((await req('GET', `${B}/projects/${pid}/file?path=.env&reveal=1`, { token: owner.token })).data.file.content.includes('supersecret'));
  assert.ok(await db.one("SELECT 1 FROM audit_logs WHERE action = 'fab500x.secret_revealed' AND user_id = ?", owner.id));
  await req('PUT', `${B}/projects/${pid}/file`, { token: owner.token, body: { path: 'lib/config.js', content: 'const api_key = "abcdefghijklmnopqrstuvwxyz";\nfunction (' } });
  await req('PUT', `${B}/projects/${pid}/file`, { token: owner.token, body: { path: 'bad.json', content: '{"a": 1,,}' } });
  const pr = (await req('GET', `${B}/projects/${pid}/problems`, { token: owner.token })).data;
  assert.ok(pr.problems.some((x) => x.path === 'lib/config.js' && x.source === 'secrets'));
  assert.ok(pr.problems.some((x) => x.path === 'lib/config.js' && x.source === 'javascript' && x.severity === 'error'));
  assert.ok(pr.problems.some((x) => x.path === 'bad.json' && x.source === 'json'));
  assert.ok(!pr.problems.some((x) => x.path === '.env'));
});

test('terminal: never executes on the server; dangerous commands refused; requests audited', async () => {
  const r = await req('POST', `${B}/projects/${pid}/run`, { token: owner.token, body: { command: 'npm test' } });
  assert.deepEqual([r.status, r.data.error.code], [501, 'runner_not_configured']);
  const d = await req('POST', `${B}/projects/${pid}/run`, { token: owner.token, body: { command: 'rm -rf / --no-preserve-root' } });
  assert.deepEqual([d.status, d.data.error.code], [403, 'command_refused']);
  assert.ok(await db.one("SELECT 1 FROM audit_logs WHERE action = 'fab500x.command_refused' AND user_id = ?", owner.id));
});

test('agent (manual): proposes diffs + commands, writes nothing until approved; approve applies; audited', async () => {
  const before = (await req('GET', `${B}/projects/${pid}/tree`, { token: owner.token })).data.files.length;
  const a = await req('POST', `${B}/projects/${pid}/agent`, { token: owner.token, body: { instruction: 'Document the project and delete bad.json', permission: 'manual' } });
  assert.equal(a.status, 201);
  const pr = a.data.proposal;
  assert.equal(pr.status, 'pending'); assert.equal(pr.mode, 'manual'); assert.equal(pr.model_id, 'fab-500x');
  assert.deepEqual(pr.diffs.map((d) => [d.op, d.path]), [['write', 'NOTES.md'], ['delete', 'bad.json']]);
  assert.match(pr.diffs[0].diff, /^--- \/dev\/null\n\+\+\+ b\/NOTES\.md\n@@ -1,0 \+1,4 @@/);
  assert.deepEqual(pr.commands, [{ command: 'npm test', dangerous: false }]);
  assert.equal((await req('GET', `${B}/projects/${pid}/tree`, { token: owner.token })).data.files.length, before, 'nothing written yet');
  const ap = await req('POST', `${B}/projects/${pid}/proposals/${pr.id}/approve`, { token: owner.token });
  assert.equal(ap.data.status, 'applied'); assert.match(ap.data.note, /were not run/);
  const tree = (await req('GET', `${B}/projects/${pid}/tree`, { token: owner.token })).data.files.map((f) => f.path);
  assert.ok(tree.includes('NOTES.md') && !tree.includes('bad.json'));
  assert.equal((await req('GET', `${B}/projects/${pid}/history?path=NOTES.md`, { token: owner.token })).data.versions[0].author, 'agent');
  assert.equal((await req('POST', `${B}/projects/${pid}/proposals/${pr.id}/approve`, { token: owner.token })).status, 404, 'no double apply');
  for (const act of ['fab500x.agent_proposal', 'fab500x.proposal_applied']) assert.ok(await db.one('SELECT 1 FROM audit_logs WHERE action = ? AND user_id = ?', act, owner.id), act);
});

test('agent (automatic): writes apply at once, deletes still wait for approval', async () => {
  await req('PUT', `${B}/projects/${pid}/file`, { token: owner.token, body: { path: 'old.txt', content: 'x' } });
  const a = (await req('POST', `${B}/projects/${pid}/agent`, { token: owner.token, body: { instruction: 'Update notes and delete old.txt', permission: 'automatic' } })).data.proposal;
  assert.deepEqual([a.mode, a.status, a.auto_applied, a.pending_changes], ['automatic', 'pending', ['NOTES.md'], 1]);
  assert.match((await req('GET', `${B}/projects/${pid}/file?path=NOTES.md`, { token: owner.token })).data.file.content, /Update notes/);
  assert.ok((await req('GET', `${B}/projects/${pid}/tree`, { token: owner.token })).data.files.some((f) => f.path === 'old.txt'), 'delete waits');
  assert.equal((await req('POST', `${B}/projects/${pid}/proposals/${a.id}/reject`, { token: owner.token })).data.status, 'rejected');
  assert.ok((await req('GET', `${B}/projects/${pid}/tree`, { token: owner.token })).data.files.some((f) => f.path === 'old.txt'));
});

test('checkpoints: status lists added/modified/deleted since the last checkpoint', async () => {
  assert.equal((await req('POST', `${B}/projects/${pid}/checkpoints`, { token: owner.token, body: { message: 'baseline' } })).status, 201);
  assert.deepEqual((await req('GET', `${B}/projects/${pid}/changes`, { token: owner.token })).data.changes, []);
  await req('PUT', `${B}/projects/${pid}/file`, { token: owner.token, body: { path: 'NOTES.md', content: 'changed' } });
  await req('PUT', `${B}/projects/${pid}/file`, { token: owner.token, body: { path: 'new.md', content: 'n' } });
  await req('DELETE', `${B}/projects/${pid}/file?path=old.txt&confirm=1`, { token: owner.token });
  const ch = (await req('GET', `${B}/projects/${pid}/changes`, { token: owner.token })).data;
  assert.equal(ch.checkpoint.message, 'baseline');
  assert.deepEqual(ch.changes, [{ path: 'NOTES.md', status: 'modified' }, { path: 'new.md', status: 'added' }, { path: 'old.txt', status: 'deleted' }]);
});

test('revoking the grant closes the workspace immediately (data kept, routes 404)', async () => {
  await req('PUT', `/api/admin/clients/${owner.id}/models/fab-500x`, { headers: { cookie: sa.admin.cookie, 'x-admin-csrf': sa.admin.csrf }, body: { access: 'default' } });
  assert.equal((await req('GET', `${B}/projects/${pid}/tree`, { token: owner.token })).status, 404);
  assert.ok(await db.one('SELECT 1 FROM projects WHERE id = ?', pid));
  await grant(owner);
  assert.equal((await req('DELETE', `${B}/projects/${pid}?confirm=wrong`, { token: owner.token })).data.error.code, 'confirmation_required');
  assert.equal((await req('DELETE', `${B}/projects/${pid}?confirm=shop`, { token: owner.token })).status, 200);
});
