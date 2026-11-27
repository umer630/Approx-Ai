-- Approx AI core schema for Supabase Postgres (project uyatvhgngzrrvelahebi).
--
-- Mirrors the tables the Approx backend uses today (libSQL/Turso), with the same IDs (text, e.g. usr_…, ses_…) and
-- millisecond timestamps, so existing production rows can be copied 1:1 without changing identity.
-- Identity: public.users.supabase_uid = auth.users.id. Every row belongs to one Approx user (user_id); organizations /
-- workspaces add membership.
--
-- Security model:
--  * The Approx backend connects with a privileged server-side credential (never in the web app or APK) and enforces
--    ownership on every API route.
--  * Row Level Security is ENABLED on every table as defence in depth: a client holding only the publishable key can
--    never read or change another account's rows through the Data API, whatever ID it sends. The anon role gets no
--    policies at all.
--
-- Idempotent: safe to run more than once; it never drops tables or deletes data.


-- ------------------------------------------------------------------ identity
create table if not exists public.users (
  id text primary key,
  email text not null,
  supabase_uid uuid unique references auth.users(id) on delete set null,
  email_verified boolean not null default false,
  mfa_enabled boolean not null default false,
  role text not null default 'user' check (role in ('user','admin','superadmin')),
  plan text not null default 'free',
  status text not null default 'active',
  approval_status text not null default 'approved',
  created_at bigint not null,
  updated_at bigint not null
);
create unique index if not exists users_email_lower on public.users (lower(email));   -- one account per normalized email

create table if not exists public.profiles (
  user_id text primary key references public.users(id) on delete cascade,
  display_name text not null default '',
  language text not null default 'auto' check (language in ('auto','en','ur','roman-ur'))
);

create table if not exists public.settings (
  user_id text primary key references public.users(id) on delete cascade,
  default_model text not null default 'nick-4.8',
  default_mode text not null default 'medium' check (default_mode in ('low','medium','high')),
  memory_enabled boolean not null default true,
  training_opt_in boolean not null default false,
  notifications_email boolean not null default true,
  notify_task_updates boolean not null default true,
  personalization text not null default '',
  theme text not null default 'light' check (theme in ('light','dark','system')),
  permissions_mode text not null default 'manual' check (permissions_mode in ('manual','automatic')),
  chat_retention_days integer not null default 0 check (chat_retention_days in (0,7,30,90,365)),
  text_size text not null default 'medium' check (text_size in ('small','medium','large')),
  default_workspace text not null default 'home' check (default_workspace in ('home','work','code','education')),
  workspace_prefs jsonb not null default '{}'::jsonb
);

-- The Approx user id of the signed-in Supabase user (null for anon / unknown). SECURITY DEFINER so policies can use it
-- without granting read access to public.users.
create or replace function public.approx_uid() returns text
language sql stable security definer set search_path = public, auth as $$
  select id from public.users where supabase_uid = auth.uid() and status = 'active'
$$;

-- ------------------------------------------------------------------ organizations / workspaces
create table if not exists public.organizations (
  id text primary key,
  name text not null,
  owner_user_id text not null references public.users(id) on delete cascade,
  created_at bigint not null
);
create table if not exists public.org_members (
  org_id text not null references public.organizations(id) on delete cascade,
  user_id text not null references public.users(id) on delete cascade,
  role text not null default 'member' check (role in ('owner','admin','member')),
  created_at bigint not null,
  primary key (org_id, user_id)
);
create or replace function public.approx_is_member(org text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.org_members where org_id = org and user_id = public.approx_uid())
$$;

create table if not exists public.workspaces (
  id text primary key,
  org_id text not null references public.organizations(id) on delete cascade,
  user_id text not null references public.users(id) on delete cascade,
  kind text not null check (kind in ('work','code','education')),
  name text not null,
  created_at bigint not null,
  unique (user_id, kind)
);

create table if not exists public.projects (
  id text primary key,
  user_id text not null references public.users(id) on delete cascade,
  workspace_id text references public.workspaces(id) on delete set null,
  name text not null,
  description text not null default '',
  instructions text not null default '',
  kind text not null default 'knowledge' check (kind in ('knowledge','fabbox','coeprox')),
  purpose text check (purpose in ('work','code','education')),   -- code project / education course / work project
  current_branch text,
  created_at bigint not null,
  updated_at bigint not null
);
create index if not exists projects_user on public.projects (user_id, updated_at desc);

-- ------------------------------------------------------------------ sessions → threads → messages
create table if not exists public.work_sessions (
  id text primary key,
  user_id text not null references public.users(id) on delete cascade,
  workspace_id text not null references public.workspaces(id) on delete cascade,
  project_id text references public.projects(id) on delete set null,
  kind text not null check (kind in ('work','code','education')),   -- education = study session
  title text not null,
  status text not null default 'active' check (status in ('active','archived')),
  context text not null default '',
  created_at bigint not null,
  updated_at bigint not null,
  last_opened_at bigint
);
create index if not exists work_sessions_user on public.work_sessions (user_id, kind, status, updated_at desc);

create table if not exists public.chats (            -- a thread; session_id null = a plain chat
  id text primary key,
  user_id text not null references public.users(id) on delete cascade,
  project_id text references public.projects(id) on delete set null,
  session_id text references public.work_sessions(id) on delete cascade,
  title text not null default 'New chat',
  model_id text not null,
  mode text not null default 'medium',
  archived boolean not null default false,
  deleted_at bigint,
  training_eligible boolean not null default false,
  is_fab boolean not null default false,
  created_at bigint not null,
  updated_at bigint not null,
  check (not (is_fab and training_eligible))
);
create index if not exists chats_user on public.chats (user_id, updated_at desc);
create index if not exists chats_session on public.chats (session_id, updated_at desc);
create or replace view public.threads with (security_invoker = on) as
  select * from public.chats where session_id is not null;

create table if not exists public.messages (
  id text primary key,
  chat_id text not null references public.chats(id) on delete cascade,
  user_id text not null references public.users(id) on delete cascade,
  role text not null check (role in ('user','assistant','system')),
  content text not null,
  model_id text, model_version text, mode text, route_reason text,
  attachments jsonb not null default '[]'::jsonb,
  status text not null default 'complete',
  tokens_in integer not null default 0,
  tokens_out integer not null default 0,
  created_at bigint not null
);
create index if not exists messages_chat on public.messages (chat_id, created_at);

create table if not exists public.tasks (
  id text primary key,
  user_id text not null references public.users(id) on delete cascade,
  session_id text not null references public.work_sessions(id) on delete cascade,
  thread_id text references public.chats(id) on delete set null,
  title text not null,
  detail text not null default '',
  kind text not null default 'task' check (kind in ('task','assignment')),
  status text not null default 'todo' check (status in ('todo','in_progress','done','blocked')),
  due_at bigint,
  position integer not null default 0,
  created_by text not null default 'user' check (created_by in ('user','agent')),
  created_at bigint not null,
  updated_at bigint not null
);
create index if not exists tasks_session on public.tasks (session_id, position);

-- ------------------------------------------------------------------ files / artifacts / agent activity
create table if not exists public.files (
  id text primary key,
  user_id text not null references public.users(id) on delete cascade,
  project_id text references public.projects(id) on delete cascade,
  session_id text references public.work_sessions(id) on delete set null,
  filename text not null, mime text not null, kind text not null, size bigint not null,
  sha256 text not null, storage_key text not null,
  scan_status text not null, scan_detail text not null default '',
  extracted_text text,
  created_at bigint not null
);
create index if not exists files_user on public.files (user_id, created_at desc);
create index if not exists files_session on public.files (session_id);

create table if not exists public.artifacts (
  id text primary key,
  user_id text not null references public.users(id) on delete cascade,
  project_id text references public.projects(id) on delete set null,
  session_id text references public.work_sessions(id) on delete set null,
  chat_id text,
  title text not null,
  kind text not null check (kind in ('document','code','table','markdown','json','html')),
  language text not null default '',
  current_version integer not null default 1,
  created_at bigint not null,
  updated_at bigint not null
);
create table if not exists public.artifact_versions (
  artifact_id text not null references public.artifacts(id) on delete cascade,
  version integer not null,
  content text not null,
  note text not null default '',
  created_at bigint not null,
  primary key (artifact_id, version)
);

create table if not exists public.agent_runs (
  id text primary key,
  user_id text not null references public.users(id) on delete cascade,
  session_id text not null references public.work_sessions(id) on delete cascade,
  thread_id text, kind text not null,
  status text not null check (status in ('running','completed','failed')),
  input text not null default '', output text not null default '', model_id text,
  created_at bigint not null, finished_at bigint
);
create table if not exists public.tool_executions (
  id text primary key,
  user_id text not null references public.users(id) on delete cascade,
  session_id text not null references public.work_sessions(id) on delete cascade,
  thread_id text, agent_run_id text, tool text not null,
  input text not null default '', output text not null default '',
  status text not null check (status in ('ok','error','unavailable')),
  created_at bigint not null
);
create index if not exists tool_exec_session on public.tool_executions (session_id, created_at);

-- Connected services: provider + status only. OAuth tokens are never stored in a client-readable table.
create table if not exists public.connectors (
  id text primary key,
  user_id text not null references public.users(id) on delete cascade,
  workspace_id text references public.workspaces(id) on delete cascade,
  provider text not null,
  status text not null default 'connected',
  created_at bigint not null
);

-- ------------------------------------------------------------------ code / education
create table if not exists public.code_files (
  project_id text not null references public.projects(id) on delete cascade,
  user_id text not null references public.users(id) on delete cascade,
  path text not null, content text not null, updated_at bigint not null,
  primary key (project_id, path)
);
create table if not exists public.code_commits (
  id text primary key,
  project_id text not null references public.projects(id) on delete cascade,
  user_id text not null references public.users(id) on delete cascade,
  session_id text, branch text not null, parent_id text, message text not null,
  snapshot jsonb not null, created_at bigint not null
);
create table if not exists public.code_branches (
  project_id text not null references public.projects(id) on delete cascade,
  name text not null, head_commit_id text, created_at bigint not null,
  primary key (project_id, name)
);
create table if not exists public.code_proposals (
  id text primary key,
  project_id text not null references public.projects(id) on delete cascade,
  user_id text not null references public.users(id) on delete cascade,
  session_id text, summary text not null, changes jsonb not null,
  status text not null default 'pending' check (status in ('pending','applied','rejected')),
  created_at bigint not null, decided_at bigint
);
create table if not exists public.study_attempts (
  id text primary key,
  user_id text not null references public.users(id) on delete cascade,
  session_id text not null references public.work_sessions(id) on delete cascade,
  artifact_id text not null, score integer not null, total integer not null,
  answers jsonb not null default '[]'::jsonb, created_at bigint not null
);

-- ------------------------------------------------------------------ personal data
create table if not exists public.memories (
  id text primary key,
  user_id text not null references public.users(id) on delete cascade,
  content text not null, source text not null default 'user',
  created_at bigint not null, updated_at bigint not null
);
create table if not exists public.notifications (
  id text primary key,
  user_id text not null references public.users(id) on delete cascade,
  title text not null, body text not null,
  kind text not null default 'system', link text,
  read_at bigint, created_at bigint not null
);
create index if not exists notifications_user on public.notifications (user_id, created_at desc);

-- ------------------------------------------------------------------ Row Level Security
-- Grants: only the authenticated role; anon gets nothing. RLS below narrows every grant to the caller's own rows.
revoke all on all tables in schema public from anon;
grant select, insert, update, delete on all tables in schema public to authenticated;

do $$
declare t text;
begin
  foreach t in array array['users','profiles','settings','organizations','org_members','workspaces','projects','work_sessions','chats',
    'messages','tasks','files','artifacts','artifact_versions','agent_runs','tool_executions','connectors','code_files','code_commits',
    'code_branches','code_proposals','study_attempts','memories','notifications']
  loop
    execute format('alter table public.%I enable row level security', t);
  end loop;
end $$;

-- users: read and update only yourself; accounts are created/removed by the server.
drop policy if exists users_self_select on public.users;
create policy users_self_select on public.users for select to authenticated using (id = public.approx_uid());
drop policy if exists users_self_update on public.users;
create policy users_self_update on public.users for update to authenticated using (id = public.approx_uid()) with check (id = public.approx_uid());

-- Tables owned directly through user_id: full CRUD on your own rows only; inserts must claim yourself.
do $$
declare t text;
begin
  foreach t in array array['profiles','settings','projects','work_sessions','chats','messages','tasks','files','artifacts','agent_runs',
    'tool_executions','connectors','code_files','code_commits','code_proposals','study_attempts','memories','notifications']
  loop
    execute format('drop policy if exists %I on public.%I', t || '_owner', t);
    execute format('create policy %I on public.%I for all to authenticated using (user_id = public.approx_uid()) with check (user_id = public.approx_uid())', t || '_owner', t);
  end loop;
end $$;

-- A child row must also point at a parent you own (sending someone else's session / chat / project ID fails).
drop policy if exists messages_parent on public.messages;
create policy messages_parent on public.messages as restrictive for all to authenticated
  using (exists (select 1 from public.chats c where c.id = chat_id and c.user_id = public.approx_uid()))
  with check (exists (select 1 from public.chats c where c.id = chat_id and c.user_id = public.approx_uid()));
drop policy if exists chats_parent on public.chats;
create policy chats_parent on public.chats as restrictive for all to authenticated
  using (session_id is null or exists (select 1 from public.work_sessions s where s.id = session_id and s.user_id = public.approx_uid()))
  with check ((session_id is null or exists (select 1 from public.work_sessions s where s.id = session_id and s.user_id = public.approx_uid()))
    and (project_id is null or exists (select 1 from public.projects p where p.id = project_id and p.user_id = public.approx_uid())));
drop policy if exists tasks_parent on public.tasks;
create policy tasks_parent on public.tasks as restrictive for all to authenticated
  using (exists (select 1 from public.work_sessions s where s.id = session_id and s.user_id = public.approx_uid()))
  with check (exists (select 1 from public.work_sessions s where s.id = session_id and s.user_id = public.approx_uid()));
drop policy if exists work_sessions_parent on public.work_sessions;
create policy work_sessions_parent on public.work_sessions as restrictive for all to authenticated
  using (true)
  with check (exists (select 1 from public.workspaces w where w.id = workspace_id and w.user_id = public.approx_uid())
    and (project_id is null or exists (select 1 from public.projects p where p.id = project_id and p.user_id = public.approx_uid())));
drop policy if exists files_parent on public.files;
create policy files_parent on public.files as restrictive for all to authenticated
  using (true)
  with check (session_id is null or exists (select 1 from public.work_sessions s where s.id = session_id and s.user_id = public.approx_uid()));
drop policy if exists artifacts_parent on public.artifacts;
create policy artifacts_parent on public.artifacts as restrictive for all to authenticated
  using (true)
  with check (session_id is null or exists (select 1 from public.work_sessions s where s.id = session_id and s.user_id = public.approx_uid()));
drop policy if exists code_files_parent on public.code_files;
create policy code_files_parent on public.code_files as restrictive for all to authenticated
  using (exists (select 1 from public.projects p where p.id = project_id and p.user_id = public.approx_uid()))
  with check (exists (select 1 from public.projects p where p.id = project_id and p.user_id = public.approx_uid()));

-- artifact versions / branches have no user_id: ownership comes from the parent.
drop policy if exists artifact_versions_owner on public.artifact_versions;
create policy artifact_versions_owner on public.artifact_versions for all to authenticated
  using (exists (select 1 from public.artifacts a where a.id = artifact_id and a.user_id = public.approx_uid()))
  with check (exists (select 1 from public.artifacts a where a.id = artifact_id and a.user_id = public.approx_uid()));
drop policy if exists code_branches_owner on public.code_branches;
create policy code_branches_owner on public.code_branches for all to authenticated
  using (exists (select 1 from public.projects p where p.id = project_id and p.user_id = public.approx_uid()))
  with check (exists (select 1 from public.projects p where p.id = project_id and p.user_id = public.approx_uid()));

-- organizations / members / workspaces: members can read; only owners change membership.
drop policy if exists organizations_member_select on public.organizations;
create policy organizations_member_select on public.organizations for select to authenticated using (public.approx_is_member(id));
drop policy if exists organizations_owner_write on public.organizations;
create policy organizations_owner_write on public.organizations for all to authenticated
  using (owner_user_id = public.approx_uid()) with check (owner_user_id = public.approx_uid());
drop policy if exists org_members_member_select on public.org_members;
create policy org_members_member_select on public.org_members for select to authenticated using (public.approx_is_member(org_id));
drop policy if exists org_members_owner_write on public.org_members;
create policy org_members_owner_write on public.org_members for all to authenticated
  using (exists (select 1 from public.organizations o where o.id = org_id and o.owner_user_id = public.approx_uid()))
  with check (exists (select 1 from public.organizations o where o.id = org_id and o.owner_user_id = public.approx_uid()));
drop policy if exists workspaces_select on public.workspaces;
create policy workspaces_select on public.workspaces for select to authenticated using (user_id = public.approx_uid() or public.approx_is_member(org_id));
drop policy if exists workspaces_owner_write on public.workspaces;
create policy workspaces_owner_write on public.workspaces for all to authenticated
  using (user_id = public.approx_uid()) with check (user_id = public.approx_uid() and public.approx_is_member(org_id));
