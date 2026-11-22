// libSQL persistence (SQLite-compatible, async). Works with a local file (file:...) for Docker/Render/local
// and a remote Turso database (libsql://...) for serverless (Vercel). Every user-owned table carries user_id and
// every query in the route layer filters on it — that is the tenant-isolation boundary.
//   APPROX_DB_URL        libsql://<db>.turso.io  (serverless)  OR  file:/data/approx.db  (default, local/persistent)
//   APPROX_DB_AUTH_TOKEN Turso auth token (only for a remote libsql:// URL)
import { createClient } from '@libsql/client';
import { AsyncLocalStorage } from 'node:async_hooks';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { HttpError } from './http.js';
import { seedLifecycle } from './lifecycle.js';
import { catalog } from './catalog.js';

const SCHEMA = `
-- Blob storage for uploads / training exports when APPROX_FILE_STORAGE=db (serverless deployments).
CREATE TABLE IF NOT EXISTS file_blobs (
  storage_key TEXT PRIMARY KEY,
  data BLOB NOT NULL,
  size INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  email_verified INTEGER NOT NULL DEFAULT 0,
  role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user','admin','superadmin')),
  plan TEXT NOT NULL DEFAULT 'free' CHECK (plan IN ('free','pro','enterprise')),
  failed_logins INTEGER NOT NULL DEFAULT 0,
  locked_until INTEGER,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','deleted','suspended')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS model_lifecycle (
  model_id TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  version TEXT,
  adapter_sha256 TEXT,
  artifact_uri TEXT,
  base_model TEXT,
  base_revision TEXT,
  failed_stage TEXT,
  detail TEXT NOT NULL DEFAULT '',
  verified_at INTEGER,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS model_lifecycle_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  model_id TEXT NOT NULL,
  from_state TEXT,
  to_state TEXT NOT NULL,
  actor TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS message_feedback (
  message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  rating TEXT CHECK (rating IN ('up','down')),
  reported INTEGER NOT NULL DEFAULT 0,
  reason TEXT,
  comment TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- One-time codes that hand a browser Google sign-in back to the Android app (PKCE-style challenge).
CREATE TABLE IF NOT EXISTS auth_handoffs (
  code_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  challenge TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);

CREATE TABLE IF NOT EXISTS profiles (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  display_name TEXT NOT NULL DEFAULT '',
  avatar_url TEXT NOT NULL DEFAULT '',
  language TEXT NOT NULL DEFAULT 'auto'
);

CREATE TABLE IF NOT EXISTS settings (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  default_model TEXT NOT NULL DEFAULT 'nick-4.8',
  default_mode TEXT NOT NULL DEFAULT 'medium' CHECK (default_mode IN ('low','medium','high')),
  memory_enabled INTEGER NOT NULL DEFAULT 1,
  training_opt_in INTEGER NOT NULL DEFAULT 0,
  notifications_email INTEGER NOT NULL DEFAULT 1,
  personalization TEXT NOT NULL DEFAULT '',
  theme TEXT NOT NULL DEFAULT 'dark'
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  csrf_token TEXT NOT NULL,
  client TEXT NOT NULL DEFAULT 'web',
  ip TEXT, user_agent TEXT,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS email_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose TEXT NOT NULL CHECK (purpose IN ('verify','reset','email_change')),
  token_hash TEXT NOT NULL UNIQUE,
  payload TEXT,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS subscriptions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan TEXT NOT NULL,
  status TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT 'manual',
  started_at INTEGER NOT NULL,
  ends_at INTEGER
);

CREATE TABLE IF NOT EXISTS models (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  family TEXT NOT NULL,
  tier TEXT NOT NULL CHECK (tier IN ('default','advanced','premium','restricted')),
  description TEXT NOT NULL,
  history_training_allowed INTEGER NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS model_access (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  model_id TEXT NOT NULL REFERENCES models(id),
  granted_by TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  expires_at INTEGER,
  PRIMARY KEY (user_id, model_id)
);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  instructions TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT 'knowledge' CHECK (kind IN ('knowledge','fabbox','coeprox')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_projects_user ON projects(user_id);

CREATE TABLE IF NOT EXISTS chats (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  title TEXT NOT NULL DEFAULT 'New chat',
  model_id TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'medium',
  archived INTEGER NOT NULL DEFAULT 0,
  deleted_at INTEGER,
  -- training eligibility is recorded per chat; FAB chats can never be eligible (enforced by CHECK)
  training_eligible INTEGER NOT NULL DEFAULT 0,
  is_fab INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (NOT (is_fab = 1 AND training_eligible = 1))
);
CREATE INDEX IF NOT EXISTS idx_chats_user ON chats(user_id, updated_at);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user','assistant','system')),
  content TEXT NOT NULL,
  model_id TEXT,
  model_version TEXT,
  mode TEXT,
  route_reason TEXT,
  attachments TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'complete',
  tokens_in INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id, created_at);

CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  mime TEXT NOT NULL,
  kind TEXT NOT NULL,
  size INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  storage_key TEXT NOT NULL,
  scan_status TEXT NOT NULL,
  scan_detail TEXT NOT NULL DEFAULT '',
  extracted_text TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_files_user ON files(user_id);

CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'user',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS usage_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source TEXT NOT NULL,
  model_id TEXT NOT NULL,
  mode TEXT NOT NULL,
  request_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_usage_user ON usage_events(user_id, created_at);

CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  prefix TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  scopes TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at INTEGER,
  rotated_from TEXT
);

CREATE TABLE IF NOT EXISTS api_requests (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  api_key_id TEXT,
  endpoint TEXT NOT NULL,
  model_id TEXT,
  model_version TEXT,
  mode TEXT,
  status INTEGER NOT NULL,
  latency_ms INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_api_requests_user ON api_requests(user_id, created_at);

CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  chat_id TEXT,
  title TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('document','code','table','markdown','json','html')),
  language TEXT NOT NULL DEFAULT '',
  current_version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS artifact_versions (
  artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  content TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  PRIMARY KEY (artifact_id, version)
);

-- Fabbox Code / Coeprox: per-project virtual file tree + agent change proposals
CREATE TABLE IF NOT EXISTS code_files (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  content TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (project_id, path)
);
CREATE TABLE IF NOT EXISTS code_proposals (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  summary TEXT NOT NULL,
  changes TEXT NOT NULL,           -- JSON [{op, path, content}]
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','applied','rejected')),
  created_at INTEGER NOT NULL,
  decided_at INTEGER
);

-- Training system (spec §13, §30–34)
CREATE TABLE IF NOT EXISTS training_datasets (
  id TEXT PRIMARY KEY,
  version TEXT NOT NULL UNIQUE,
  target_model TEXT NOT NULL,
  source TEXT NOT NULL,
  record_count INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  manifest TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS training_jobs (
  id TEXT PRIMARY KEY,
  dataset_id TEXT NOT NULL REFERENCES training_datasets(id),
  target_model TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued','running','succeeded','failed','blocked')),
  environment TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS model_versions (
  id TEXT PRIMARY KEY,
  model_id TEXT NOT NULL REFERENCES models(id),
  version TEXT NOT NULL,
  base_model TEXT NOT NULL,
  adapter_id TEXT,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS adapters (
  id TEXT PRIMARY KEY,
  model_id TEXT NOT NULL REFERENCES models(id),
  job_id TEXT REFERENCES training_jobs(id),
  path TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  eval_report TEXT NOT NULL DEFAULT '{}',
  safety_passed INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT,
  ip TEXT,
  detail TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS security_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT,
  kind TEXT NOT NULL,
  severity TEXT NOT NULL,
  ip TEXT,
  detail TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  read_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS mail_outbox (
  id TEXT PRIMARY KEY,
  to_email TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS rate_buckets (
  key TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  reset_at INTEGER NOT NULL
);

-- Model releases: METADATA mirror of the artifact registry (APPROX_MODELS_DIR). Weights are never
-- stored in the database — artifact_uri points at a directory / object-storage prefix.
CREATE TABLE IF NOT EXISTS model_releases (
  model_id TEXT NOT NULL,
  version TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'language_model',
  status TEXT NOT NULL,
  production_ready INTEGER NOT NULL DEFAULT 0,
  verified INTEGER NOT NULL DEFAULT 0,
  adapter_sha256 TEXT,
  base_model TEXT,
  base_model_revision TEXT,
  dataset_version TEXT,
  dataset_fingerprint TEXT,
  evaluation_score REAL,
  artifact_uri TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'scan',
  detail TEXT NOT NULL DEFAULT '{}',
  first_seen_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  activated_at INTEGER,
  activated_by TEXT,
  deactivated_at INTEGER,
  PRIMARY KEY (model_id, version)
);

-- GPU compute control plane: jobs requested by admins, executed by GPU workers (e.g. a Colab runtime
-- running run_all_training.py --worker). The API server itself never trains.
CREATE TABLE IF NOT EXISTS gpu_jobs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL DEFAULT 'training',
  models TEXT NOT NULL,
  options TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL CHECK (status IN ('queued','running','stop_requested','succeeded','failed','stopped','blocked')),
  requested_by TEXT NOT NULL,
  worker_id TEXT,
  phase TEXT,
  progress TEXT NOT NULL DEFAULT '{}',
  results TEXT NOT NULL DEFAULT '{}',
  log_tail TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  updated_at INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_gpu_jobs_status ON gpu_jobs(status, created_at);
CREATE TABLE IF NOT EXISTS gpu_workers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  api_key_id TEXT,
  gpu TEXT NOT NULL DEFAULT '{}',
  runtime TEXT NOT NULL DEFAULT '{}',
  current_job_id TEXT,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS schema_migrations (
  id TEXT PRIMARY KEY,
  applied_at INTEGER NOT NULL
);
`;

// ---- migrations for databases created by earlier releases (fresh databases already match SCHEMA) ----
async function hasColumn(c, table, column) {
  const r = await c.execute(`PRAGMA table_info(${table})`);
  return r.rows.some((col) => col.name === column);
}

async function migrate(c) {
  const appliedRows = await c.execute('SELECT id FROM schema_migrations');
  const applied = new Set(appliedRows.rows.map((r) => r.id));
  const apply = async (id, stmts) => {
    if (applied.has(id)) return;
    // libSQL runs a batch atomically (BEGIN/COMMIT/ROLLBACK implied).
    await c.batch([...stmts, { sql: 'INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)', args: [id, Date.now()] }], 'write');
  };

  // 1.1.0 — efficiency mode "low": the old CHECK only allowed ('medium','high'); SQLite cannot alter a
  // CHECK constraint, so the table is rebuilt with identical data.
  if (!applied.has('2026-11-settings-low-mode')) {
    const row = (await c.execute("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'settings'")).rows[0];
    if (row && !row.sql.includes("'low'")) {
      await apply('2026-11-settings-low-mode', [
        { sql: `CREATE TABLE settings_new (
            user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
            default_model TEXT NOT NULL DEFAULT 'nick-4.8',
            default_mode TEXT NOT NULL DEFAULT 'medium' CHECK (default_mode IN ('low','medium','high')),
            memory_enabled INTEGER NOT NULL DEFAULT 1,
            training_opt_in INTEGER NOT NULL DEFAULT 0,
            notifications_email INTEGER NOT NULL DEFAULT 1,
            personalization TEXT NOT NULL DEFAULT '',
            theme TEXT NOT NULL DEFAULT 'dark'
          )` },
        { sql: `INSERT INTO settings_new (user_id, default_model, default_mode, memory_enabled, training_opt_in, notifications_email, personalization, theme)
            SELECT user_id, default_model, default_mode, memory_enabled, training_opt_in, notifications_email, personalization, theme FROM settings` },
        { sql: 'DROP TABLE settings' },
        { sql: 'ALTER TABLE settings_new RENAME TO settings' },
      ]);
    } else {
      await apply('2026-11-settings-low-mode', []);
    }
  }

  // 1.1.0 — record which adapter version produced a message / served an API request.
  if (!applied.has('2026-11-model-version-columns')) {
    const stmts = [];
    if (!(await hasColumn(c, 'messages', 'model_version'))) stmts.push({ sql: 'ALTER TABLE messages ADD COLUMN model_version TEXT' });
    if (!(await hasColumn(c, 'api_requests', 'model_version'))) stmts.push({ sql: 'ALTER TABLE api_requests ADD COLUMN model_version TEXT' });
    await apply('2026-11-model-version-columns', stmts);
  }

  // 1.2.0 — the product's default theme is now the green + white (light) theme. Accounts still on the previous
  // default move to it once; anyone can switch back to Dark in Settings afterwards.
  if (!applied.has('2026-11-light-theme-default')) {
    await apply('2026-11-light-theme-default', [{ sql: "UPDATE settings SET theme = 'light' WHERE theme = 'dark'" }]);
  }

  // 1.3.0 — Google Sign-In: the Google account (stable `sub`) linked to an Approx account.
  if (!applied.has('2026-11-google-sub')) {
    const stmts = [];
    if (!(await hasColumn(c, 'users', 'google_sub'))) {
      stmts.push({ sql: 'ALTER TABLE users ADD COLUMN google_sub TEXT' });
      stmts.push({ sql: 'CREATE UNIQUE INDEX IF NOT EXISTS users_google_sub ON users(google_sub) WHERE google_sub IS NOT NULL' });
    }
    await apply('2026-11-google-sub', stmts);
  }

  // 1.4.0 — Supabase Auth is the identity provider: each Approx account is linked to its Supabase user id.
  if (!applied.has('2026-11-supabase-uid')) {
    const stmts = [];
    if (!(await hasColumn(c, 'users', 'supabase_uid'))) {
      stmts.push({ sql: 'ALTER TABLE users ADD COLUMN supabase_uid TEXT' });
      stmts.push({ sql: 'CREATE UNIQUE INDEX IF NOT EXISTS users_supabase_uid ON users(supabase_uid) WHERE supabase_uid IS NOT NULL' });
    }
    await apply('2026-11-supabase-uid', stmts);
  }

  // 1.5.0 — app shell: per-user tool permission mode (manual | automatic) and general product feedback.
  if (!applied.has('2026-11-workspace-shell')) {
    const stmts = [{ sql: `CREATE TABLE IF NOT EXISTS app_feedback (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      category TEXT NOT NULL, message TEXT NOT NULL, chat_id TEXT, user_agent TEXT, created_at INTEGER NOT NULL)` }];
    if (!(await hasColumn(c, 'settings', 'permissions_mode'))) {
      stmts.push({ sql: "ALTER TABLE settings ADD COLUMN permissions_mode TEXT NOT NULL DEFAULT 'manual'" });
    }
    await apply('2026-11-workspace-shell', stmts);
  }

  // 1.6.0 — secure admin panel: client approval status, country/last login, admin sessions, per-client limits and model
  // allow/deny overrides, platform settings, and an append-only audit log (UPDATE/DELETE refused by triggers).
  if (!applied.has('2026-11-admin-panel')) {
    const stmts = [];
    const addCol = async (table, col, ddl) => { if (!(await hasColumn(c, table, col))) stmts.push({ sql: `ALTER TABLE ${table} ADD COLUMN ${ddl}` }); };
    await addCol('users', 'approval_status', "approval_status TEXT NOT NULL DEFAULT 'approved'");   // existing accounts stay usable
    await addCol('users', 'approval_reason', 'approval_reason TEXT');
    await addCol('users', 'approval_updated_at', 'approval_updated_at INTEGER');
    await addCol('users', 'country', 'country TEXT');
    await addCol('users', 'last_login_at', 'last_login_at INTEGER');
    await addCol('model_access', 'access', "access TEXT NOT NULL DEFAULT 'grant'");
    stmts.push(
      { sql: `CREATE TABLE IF NOT EXISTS admin_sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token_hash TEXT NOT NULL UNIQUE, csrf_token TEXT NOT NULL, ip TEXT, user_agent TEXT, created_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL, revoked_at INTEGER)` },
      { sql: `CREATE TABLE IF NOT EXISTS user_limits (user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, window_limit INTEGER,
        cycle_limit INTEGER, model_limits TEXT NOT NULL DEFAULT '{}', updated_by TEXT NOT NULL, updated_at INTEGER NOT NULL)` },
      { sql: 'CREATE TABLE IF NOT EXISTS platform_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_by TEXT NOT NULL, updated_at INTEGER NOT NULL)' },
      { sql: 'CREATE INDEX IF NOT EXISTS idx_users_created ON users(created_at)' },
      { sql: 'CREATE INDEX IF NOT EXISTS idx_usage_created ON usage_events(created_at)' },
      { sql: "CREATE TRIGGER IF NOT EXISTS audit_logs_no_update BEFORE UPDATE ON audit_logs BEGIN SELECT RAISE(ABORT, 'audit_logs is append-only'); END" },
      { sql: "CREATE TRIGGER IF NOT EXISTS audit_logs_no_delete BEFORE DELETE ON audit_logs BEGIN SELECT RAISE(ABORT, 'audit_logs is append-only'); END" },
    );
    await apply('2026-11-admin-panel', stmts);
  }
  if (!applied.has('2026-11-model-control')) {
    // Model availability (admin on/off), visibility (private = admin-granted only) and a failed-request log.
    const stmts = [];
    if (!(await hasColumn(c, 'models', 'available'))) stmts.push({ sql: 'ALTER TABLE models ADD COLUMN available INTEGER NOT NULL DEFAULT 1' });
    if (!(await hasColumn(c, 'models', 'visibility'))) stmts.push({ sql: "ALTER TABLE models ADD COLUMN visibility TEXT NOT NULL DEFAULT 'public'" });
    stmts.push({ sql: "UPDATE models SET visibility = 'private' WHERE id = 'fab-500x'" });
    stmts.push({ sql: `CREATE TABLE IF NOT EXISTS model_failures (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, model_id TEXT NOT NULL, code TEXT NOT NULL, status INTEGER, source TEXT, created_at INTEGER NOT NULL)` });
    stmts.push({ sql: 'CREATE INDEX IF NOT EXISTS idx_model_failures_model ON model_failures(model_id, created_at)' });
    await apply('2026-11-model-control', stmts);
  }
  if (!applied.has('2026-11-fab500x-workspace')) {
    // FAB 500X Code workspace: projects flagged workspace='fab500x', per-file version history and checkpoints.
    const stmts = [];
    if (!(await hasColumn(c, 'projects', 'workspace'))) stmts.push({ sql: 'ALTER TABLE projects ADD COLUMN workspace TEXT' });
    stmts.push({ sql: `CREATE TABLE IF NOT EXISTS code_file_versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, path TEXT NOT NULL, content TEXT, author TEXT NOT NULL, created_at INTEGER NOT NULL)` });
    stmts.push({ sql: 'CREATE INDEX IF NOT EXISTS idx_code_versions ON code_file_versions(project_id, path, id)' });
    stmts.push({ sql: `CREATE TABLE IF NOT EXISTS code_checkpoints (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      message TEXT NOT NULL, snapshot TEXT NOT NULL, created_at INTEGER NOT NULL)` });
    await apply('2026-11-fab500x-workspace', stmts);
  }
  if (!applied.has('2026-11-sessions')) {
    // Workspace sessions (Education / Approx Code / Approx Work): a project with a purpose.
    const stmts = [];
    if (!(await hasColumn(c, 'projects', 'purpose'))) stmts.push({ sql: 'ALTER TABLE projects ADD COLUMN purpose TEXT' });
    stmts.push({ sql: 'CREATE INDEX IF NOT EXISTS idx_projects_purpose ON projects(user_id, purpose, updated_at)' });
    await apply('2026-11-sessions', stmts);
  }
  if (!applied.has('2026-11-workspace-sessions')) {
    // One session/thread architecture for Approx Work, Approx Code and Approx Education:
    // User → Organization → Workspace (work|code|education) → Project → Session → Thread (= chat) → Messages,
    // with Tasks, Artifacts, Files, AgentRuns and ToolExecutions attached to the session. Every row carries user_id;
    // every route checks ownership server-side (the database is libSQL — Supabase is used for Auth only).
    const stmts = [
      { sql: `CREATE TABLE IF NOT EXISTS organizations (id TEXT PRIMARY KEY, name TEXT NOT NULL, owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at INTEGER NOT NULL)` },
      { sql: `CREATE TABLE IF NOT EXISTS org_members (org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        role TEXT NOT NULL DEFAULT 'owner' CHECK (role IN ('owner','admin','member')), created_at INTEGER NOT NULL, PRIMARY KEY (org_id, user_id))` },
      { sql: `CREATE TABLE IF NOT EXISTS workspaces (id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, kind TEXT NOT NULL CHECK (kind IN ('work','code','education')), name TEXT NOT NULL,
        created_at INTEGER NOT NULL, UNIQUE (user_id, kind))` },
      { sql: `CREATE TABLE IF NOT EXISTS work_sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
        kind TEXT NOT NULL CHECK (kind IN ('work','code','education')), title TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
        context TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, last_opened_at INTEGER)` },
      { sql: 'CREATE INDEX IF NOT EXISTS idx_work_sessions_user ON work_sessions(user_id, kind, status, updated_at)' },
      { sql: `CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        session_id TEXT NOT NULL REFERENCES work_sessions(id) ON DELETE CASCADE, thread_id TEXT REFERENCES chats(id) ON DELETE SET NULL,
        title TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '', kind TEXT NOT NULL DEFAULT 'task' CHECK (kind IN ('task','assignment')),
        status TEXT NOT NULL DEFAULT 'todo' CHECK (status IN ('todo','in_progress','done','blocked')), due_at INTEGER, position INTEGER NOT NULL DEFAULT 0,
        created_by TEXT NOT NULL DEFAULT 'user' CHECK (created_by IN ('user','agent')), created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)` },
      { sql: 'CREATE INDEX IF NOT EXISTS idx_tasks_session ON tasks(session_id, position)' },
      { sql: `CREATE TABLE IF NOT EXISTS agent_runs (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        session_id TEXT NOT NULL REFERENCES work_sessions(id) ON DELETE CASCADE, thread_id TEXT, kind TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('running','completed','failed')), input TEXT NOT NULL DEFAULT '', output TEXT NOT NULL DEFAULT '',
        model_id TEXT, created_at INTEGER NOT NULL, finished_at INTEGER)` },
      { sql: `CREATE TABLE IF NOT EXISTS tool_executions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        session_id TEXT NOT NULL REFERENCES work_sessions(id) ON DELETE CASCADE, thread_id TEXT, agent_run_id TEXT, tool TEXT NOT NULL,
        input TEXT NOT NULL DEFAULT '', output TEXT NOT NULL DEFAULT '', status TEXT NOT NULL CHECK (status IN ('ok','error','unavailable')), created_at INTEGER NOT NULL)` },
      { sql: 'CREATE INDEX IF NOT EXISTS idx_tool_exec_session ON tool_executions(session_id, created_at)' },
      { sql: `CREATE TABLE IF NOT EXISTS connectors (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE, provider TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'connected', created_at INTEGER NOT NULL)` },
      { sql: `CREATE TABLE IF NOT EXISTS code_commits (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, session_id TEXT, branch TEXT NOT NULL, parent_id TEXT, message TEXT NOT NULL,
        snapshot TEXT NOT NULL, created_at INTEGER NOT NULL)` },
      { sql: `CREATE TABLE IF NOT EXISTS code_branches (project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, name TEXT NOT NULL,
        head_commit_id TEXT, created_at INTEGER NOT NULL, PRIMARY KEY (project_id, name))` },
      { sql: `CREATE TABLE IF NOT EXISTS study_attempts (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        session_id TEXT NOT NULL REFERENCES work_sessions(id) ON DELETE CASCADE, artifact_id TEXT NOT NULL, score INTEGER NOT NULL, total INTEGER NOT NULL,
        answers TEXT NOT NULL DEFAULT '[]', created_at INTEGER NOT NULL)` },
    ];
    for (const [table, col, type] of [['projects', 'workspace_id', 'TEXT'], ['projects', 'current_branch', "TEXT"], ['chats', 'session_id', 'TEXT'],
      ['files', 'session_id', 'TEXT'], ['artifacts', 'session_id', 'TEXT'], ['code_proposals', 'session_id', 'TEXT']]) {
      if (!(await hasColumn(c, table, col))) stmts.push({ sql: `ALTER TABLE ${table} ADD COLUMN ${col} ${type}` });
    }
    stmts.push({ sql: 'CREATE INDEX IF NOT EXISTS idx_chats_session ON chats(session_id, updated_at)' });
    stmts.push({ sql: 'CREATE INDEX IF NOT EXISTS idx_files_session ON files(session_id)' });
    await apply('2026-11-workspace-sessions', stmts);
  }
}

// The `models` table is seeded and kept in sync from the catalog file (name, tier, description…);
// `enabled` stays under admin control and is never overwritten.
async function syncCatalog(c) {
  await c.batch(catalog.models.map((m) => ({
    sql: `INSERT INTO models (id, name, family, tier, description, history_training_allowed${m.visibility === 'private' ? ", visibility" : ''}) VALUES (?,?,?,?,?,?${m.visibility === 'private' ? ",'private'" : ''})
      ON CONFLICT(id) DO UPDATE SET name = excluded.name, family = excluded.family, tier = excluded.tier,
        description = excluded.description, history_training_allowed = excluded.history_training_allowed`,
    args: [m.id, m.name, m.family, m.tier, m.description, m.history_training_allowed ? 1 : 0],
  })), 'write');
}

let _client;
let _initPromise;
let _local = false;
function rawClient() {
  if (_client) return _client;
  let url = process.env.APPROX_DB_URL;
  // APPROX_TEST_EPHEMERAL_DB lets the serverless test suite run against a scratch file; it is ignored in production.
  const testHatch = process.env.APPROX_TEST_EPHEMERAL_DB === '1' && config.env !== 'production' && url?.startsWith('file:');
  if (config.serverless && !testHatch && (!url || url.startsWith('file:'))) {
    // Fail closed: a serverless filesystem is ephemeral and per-instance, so a local file database would silently
    // lose every account and chat. Persistent storage must be a remote libSQL database (Turso).
    throw new HttpError(503, 'database_not_configured',
      'Persistent database is not configured: set APPROX_DB_URL to a libsql:// Turso URL and APPROX_DB_AUTH_TOKEN.');
  }
  if (!url) {
    fs.mkdirSync(config.dataDir, { recursive: true });
    url = `file:${process.env.APPROX_DB_FILE || path.join(config.dataDir, 'approx.db')}`;
  }
  // Local file: in-process writes are serialized by `localLock` below; `timeout` only guards against another
  // process (e.g. the operator CLI) holding the file lock. Remote libsql:// (Turso) handles concurrency itself.
  _local = url.startsWith('file:');
  _client = createClient({ url, authToken: process.env.APPROX_DB_AUTH_TOKEN || undefined, intMode: 'number',
    ...(_local ? { timeout: 15_000 } : {}) });
  return _client;
}

/** Returns a ready libSQL client (schema applied, migrations + catalog sync run once). */
export function getDb() {
  if (!_initPromise) {
    _initPromise = (async () => {
      const c = rawClient();
      if (_local) {
        // Local-file settings. A remote libSQL server (Turso) manages its own journal and rejects journal_mode.
        await c.execute('PRAGMA journal_mode = WAL');
        await c.execute('PRAGMA foreign_keys = ON');
      }
      await c.executeMultiple(SCHEMA);
      await migrate(c);
      await syncCatalog(c);
      await seedLifecycle(c);
      return c;
    })().catch((e) => { _initPromise = null; throw e; });
  }
  return _initPromise;
}

export const now = () => Date.now();

/**
 * Short, non-secret description of a database failure for /api/health: the driver's error code plus its message
 * with any URL or token-like string removed. Full details go to the server log only.
 */
export function describeDbError(e) {
  const msg = String(e?.message || e || '')
    .replace(/(libsql|https?|wss?|file):\/\/\S+/gi, '<url>')
    .replace(/eyJ[\w-]{10,}(\.[\w-]+){0,2}/g, '<token>')
    .replace(/[A-Za-z0-9_-]{40,}/g, '<redacted>')
    .slice(0, 200);
  return { code: String(e?.code || e?.name || 'unknown').slice(0, 60), message: msg };
}

// libSQL args must be null (not undefined); booleans are stored as 0/1.
function norm(p) { return p.map((a) => (a === undefined ? null : typeof a === 'boolean' ? (a ? 1 : 0) : a)); }

// Transaction context is per async call chain (AsyncLocalStorage), so concurrent requests never share a
// transaction: one/all/run inside tx(fn) use that request's transaction; everything else uses the client.
const txStore = new AsyncLocalStorage();

// Local SQLite file: SQLite allows one writer at a time and its busy-wait is synchronous native code, which would
// block the event loop and deadlock against a transaction held by another request in this same process. So in
// local mode an async FIFO lock serializes access: a transaction holds it for its whole duration and a statement
// outside a transaction holds it for that one statement. (Remote Turso does not need or use this lock.)
let lockTail = Promise.resolve();
function localLock() {
  let release;
  const held = new Promise((r) => { release = r; });
  const prev = lockTail;
  lockTail = prev.then(() => held);
  return prev.then(() => release);
}

async function exec(sql, p) {
  const t = txStore.getStore();
  if (t) return t.execute({ sql, args: norm(p) });
  const c = await getDb();
  if (!_local) return c.execute({ sql, args: norm(p) });
  const release = await localLock();
  try { return await c.execute({ sql, args: norm(p) }); } finally { release(); }
}

// Small async helpers to keep route code terse. SQL is unchanged (SQLite dialect).
export async function one(sql, ...p) { return (await exec(sql, p)).rows[0]; }
export async function all(sql, ...p) { return (await exec(sql, p)).rows; }
export async function run(sql, ...p) {
  const r = await exec(sql, p);
  return { changes: r.rowsAffected, lastInsertRowid: r.lastInsertRowid };
}

/** Atomic transaction scoped to the calling request. A nested tx() joins the outer transaction. */
export async function tx(fn) {
  if (txStore.getStore()) return fn();
  const c = await getDb();
  const release = _local ? await localLock() : null;
  try {
    const t = await c.transaction('write');
    try {
      const r = await txStore.run(t, fn);
      await t.commit();
      return r;
    } catch (e) {
      try { await t.rollback(); } catch { /* already closed */ }
      throw e;
    } finally {
      t.close();
    }
  } finally {
    if (release) release();
  }
}

export async function audit(userId, actor, action, target = null, ip = null, detail = {}) {
  await run('INSERT INTO audit_logs (user_id,actor,action,target,ip,detail,created_at) VALUES (?,?,?,?,?,?,?)',
    userId, actor, action, target, ip, JSON.stringify(detail), now());
}
export async function securityEvent(userId, kind, severity, ip, detail = {}) {
  await run('INSERT INTO security_events (user_id,kind,severity,ip,detail,created_at) VALUES (?,?,?,?,?,?)',
    userId, kind, severity, ip, JSON.stringify(detail), now());
}

/** For tests / graceful shutdown. */
export function close() { if (_client) { try { _client.close(); } catch { /* ignore */ } _client = null; _initPromise = null; } }
