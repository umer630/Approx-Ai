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
import { catalog } from './catalog.js';

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

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
}

// The `models` table is seeded and kept in sync from the catalog file (name, tier, description…);
// `enabled` stays under admin control and is never overwritten.
async function syncCatalog(c) {
  await c.batch(catalog.models.map((m) => ({
    sql: `INSERT INTO models (id, name, family, tier, description, history_training_allowed) VALUES (?,?,?,?,?,?)
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
      await c.executeMultiple(SCHEMA);
      await migrate(c);
      await syncCatalog(c);
      return c;
    })().catch((e) => { _initPromise = null; throw e; });
  }
  return _initPromise;
}

export const now = () => Date.now();

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
