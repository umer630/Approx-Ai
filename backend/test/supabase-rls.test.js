// Supabase Postgres schema + Row Level Security, executed in real Postgres (PGlite = Postgres compiled to WASM).
// Supabase's auth schema is stubbed exactly as Supabase exposes it to policies: auth.users and auth.uid() reading the
// JWT "sub" claim. Every check runs as the `authenticated` / `anon` role, like a client using the publishable key.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

const SQL = fs.readFileSync(new URL('../../supabase/migrations/20261127000000_approx_core.sql', import.meta.url), 'utf8');
const db = new PGlite();
const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222';
const t = 1795300000000;
const as = async (sub, fn) => {      // run fn as a client: role authenticated with JWT sub, or anon
  await db.exec(`reset role; select set_config('request.jwt.claim.sub', '${sub || ''}', false); set role ${sub ? 'authenticated' : 'anon'};`);
  try { return await fn(); } finally { await db.exec('reset role;'); }
};
const rows = async (q, p) => (await db.query(q, p)).rows;

test('migration applies cleanly and is idempotent (runs twice, keeps data)', async () => {
  await db.exec(`create schema auth; create table auth.users (id uuid primary key, email text);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    create role anon; create role authenticated; grant usage on schema public, auth to anon, authenticated; grant execute on function auth.uid() to anon, authenticated;`);
  await db.exec(SQL);
  for (const [uid, id, email] of [[A, 'usr_a', 'a@example.com'], [B, 'usr_b', 'b@example.com']]) {
    const k = id.slice(-1);
    await db.exec(`insert into auth.users values ('${uid}', '${email}');
      insert into public.users (id,email,supabase_uid,email_verified,created_at,updated_at) values ('${id}','${email}','${uid}',true,${t},${t});
      insert into public.profiles (user_id, display_name) values ('${id}', 'User ${k}');
      insert into public.settings (user_id) values ('${id}');
      insert into public.organizations values ('org_${k}','Personal','${id}',${t});
      insert into public.org_members values ('org_${k}','${id}','owner',${t});
      insert into public.workspaces values ('wsp_${k}','org_${k}','${id}','work','Approx Work',${t});
      insert into public.projects (id,user_id,workspace_id,name,kind,purpose,created_at,updated_at) values ('prj_${k}','${id}','wsp_${k}','P ${k}','fabbox','code',${t},${t});
      insert into public.work_sessions (id,user_id,workspace_id,project_id,kind,title,created_at,updated_at) values ('ses_${k}','${id}','wsp_${k}','prj_${k}','work','S ${k}',${t},${t});
      insert into public.chats (id,user_id,session_id,model_id,created_at,updated_at) values ('cht_${k}','${id}','ses_${k}','nick-4.8',${t},${t});
      insert into public.messages (id,chat_id,user_id,role,content,created_at) values ('msg_${k}','cht_${k}','${id}','user','secret of ${k}',${t});
      insert into public.tasks (id,user_id,session_id,title,created_at,updated_at) values ('tsk_${k}','${id}','ses_${k}','T ${k}',${t},${t});
      insert into public.files (id,user_id,session_id,filename,mime,kind,size,sha256,storage_key,scan_status,created_at) values ('fil_${k}','${id}','ses_${k}','f${k}.txt','text/plain','text',1,'x','k','clean',${t});
      insert into public.artifacts (id,user_id,session_id,title,kind,created_at,updated_at) values ('art_${k}','${id}','ses_${k}','A ${k}','markdown',${t},${t});
      insert into public.artifact_versions values ('art_${k}',1,'v1 ${k}','',${t});
      insert into public.code_files values ('prj_${k}','${id}','main.js','// ${k}',${t});
      insert into public.code_branches values ('prj_${k}','main',null,${t});
      insert into public.study_attempts values ('att_${k}','${id}','ses_${k}','art_${k}',3,5,'[]',${t});
      insert into public.notifications (id,user_id,title,body,created_at) values ('ntf_${k}','${id}','N','n',${t});`);
  }
  await db.exec(SQL);   // second run: no error, nothing dropped
  assert.equal((await rows('select count(*)::int n from public.messages'))[0].n, 2);
  const noRls = await rows(`select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity`);
  assert.deepEqual(noRls, [], 'RLS enabled on every table');
});

const TABLES = ['users', 'profiles', 'settings', 'organizations', 'org_members', 'workspaces', 'projects', 'work_sessions', 'chats', 'threads', 'messages', 'tasks',
  'files', 'artifacts', 'artifact_versions', 'code_files', 'code_branches', 'study_attempts', 'notifications'];

test('SELECT: each user sees exactly their own rows in every table; anon sees nothing', async () => {
  for (const tb of TABLES) {
    const a = await as(A, () => rows(`select * from public.${tb}`));
    assert.equal(a.length, 1, `${tb}: A sees one row`);
    assert.ok(!JSON.stringify(a).includes('usr_b') && !JSON.stringify(a).includes('_b"'), `${tb}: nothing of B`);
    const anon = await as(null, () => rows(`select * from public.${tb}`).catch((e) => e));
    assert.ok(anon instanceof Error ? /permission denied/.test(anon.message) : anon.length === 0, `${tb}: anon gets nothing`);
  }
  assert.deepEqual(await as(A, () => rows("select content from public.messages where id = 'msg_b'")), [], 'asking for B\'s message by ID returns nothing');
});

test('UPDATE / DELETE of another user\'s rows by ID change nothing', async () => {
  for (const [tb, id] of [['work_sessions', 'ses_b'], ['messages', 'msg_b'], ['files', 'fil_b'], ['artifacts', 'art_b'], ['tasks', 'tsk_b'], ['projects', 'prj_b'], ['notifications', 'ntf_b']]) {
    const col = tb === 'messages' ? 'content' : tb === 'files' ? 'filename' : tb === 'notifications' ? 'title' : 'title';
    const tcol = tb === 'projects' ? 'name' : col;
    const up = await as(A, () => db.query(`update public.${tb} set ${tcol} = 'hacked' where id = $1`, [id]));
    assert.equal(up.affectedRows, 0, `${tb}: update`);
    const del = await as(A, () => db.query(`delete from public.${tb} where id = $1`, [id]));
    assert.equal(del.affectedRows, 0, `${tb}: delete`);
  }
  assert.equal((await rows("select count(*)::int n from public.messages where id = 'msg_b' and content = 'secret of b'"))[0].n, 1, 'B untouched');
  assert.equal((await as(A, () => db.query("update public.settings set theme = 'dark' where user_id = 'usr_b'"))).affectedRows, 0);
  assert.equal((await as(A, () => db.query("update public.settings set theme = 'dark' where user_id = 'usr_a'"))).affectedRows, 1, 'own settings persist');
});

test('INSERT: rows must belong to you AND point at parents you own (ID swapping is rejected)', async () => {
  const deny = async (sql) => { const r = await as(A, () => db.query(sql).then(() => 'ok', (e) => e.message)); assert.match(r, /row-level security|violates/, sql); };
  await deny(`insert into public.messages (id,chat_id,user_id,role,content,created_at) values ('m1','cht_b','usr_a','user','x',${t})`);          // into B's thread
  await deny(`insert into public.messages (id,chat_id,user_id,role,content,created_at) values ('m2','cht_a','usr_b','user','x',${t})`);          // as B
  await deny(`insert into public.tasks (id,user_id,session_id,title,created_at,updated_at) values ('t1','usr_a','ses_b','x',${t},${t})`);         // B's session
  await deny(`insert into public.work_sessions (id,user_id,workspace_id,kind,title,created_at,updated_at) values ('s1','usr_a','wsp_b','work','x',${t},${t})`); // B's workspace
  await deny(`insert into public.work_sessions (id,user_id,workspace_id,project_id,kind,title,created_at,updated_at) values ('s2','usr_a','wsp_a','prj_b','work','x',${t},${t})`); // B's project
  await deny(`insert into public.chats (id,user_id,session_id,model_id,created_at,updated_at) values ('c1','usr_a','ses_b','nick-4.8',${t},${t})`);
  await deny(`insert into public.files (id,user_id,session_id,filename,mime,kind,size,sha256,storage_key,scan_status,created_at) values ('f1','usr_a','ses_b','x','t','text',1,'x','k','clean',${t})`);
  await deny(`insert into public.code_files values ('prj_b','usr_a','evil.js','x',${t})`);
  await deny(`insert into public.artifact_versions values ('art_b',2,'x','',${t})`);
  await deny(`insert into public.org_members values ('org_b','usr_a','admin',${t})`);                                                            // join B's organization
  // …while the same operations on your own parents work.
  const ok = await as(A, () => db.query(`insert into public.messages (id,chat_id,user_id,role,content,created_at) values ('m3','cht_a','usr_a','user','mine',${t})`).then(() => 'ok', (e) => e.message));
  assert.equal(ok, 'ok');
  const own = await as(A, () => db.query(`insert into public.work_sessions (id,user_id,workspace_id,project_id,kind,title,created_at,updated_at) values ('s3','usr_a','wsp_a','prj_a','work','New',${t},${t})`).then(() => 'ok', (e) => e.message));
  assert.equal(own, 'ok', 'a new session in your own workspace');
});

test('one account per normalized email; Supabase user maps to exactly one Approx user', async () => {
  const dup = await db.query(`insert into public.users (id,email,created_at,updated_at) values ('usr_dup','A@Example.com',${t},${t})`).then(() => 'ok', (e) => e.message);
  assert.match(dup, /duplicate key|unique/);
  const dupUid = await db.query(`insert into public.users (id,email,supabase_uid,created_at,updated_at) values ('usr_dup2','c@example.com','${A}',${t},${t})`).then(() => 'ok', (e) => e.message);
  assert.match(dupUid, /duplicate key|unique/);
});
