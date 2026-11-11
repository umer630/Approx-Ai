// SQLite (node:sqlite) persistence. Every user-owned table carries user_id and every query
// in the route layer filters on it — that is the tenant-isolation boundary.
import { DatabaseSync } from 'node:sqlite';
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
function hasColumn(d, table, column) {
  return d.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
}

function migrate(d) {
  const applied = new Set(d.prepare('SELECT id FROM schema_migrations').all().map((r) => r.id));
  const apply = (id, fn) => {
    if (applied.has(id)) return;
    d.exec('BEGIN');
    try {
      fn();
      d.prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)').run(id, Date.now());
      d.exec('COMMIT');
    } catch (e) { d.exec('ROLLBACK'); throw e; }
  };

  // 1.1.0 — efficiency mode "low": the old CHECK only allowed ('medium','high'); SQLite cannot alter a
  // CHECK constraint, so the table is rebuilt with identical data.
  apply('2026-11-settings-low-mode', () => {
    const row = d.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'settings'").get();
    if (!row || row.sql.includes("'low'")) return;
    d.exec(`
      CREATE TABLE settings_new (
        user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        default_model TEXT NOT NULL DEFAULT 'nick-4.8',
        default_mode TEXT NOT NULL DEFAULT 'medium' CHECK (default_mode IN ('low','medium','high')),
        memory_enabled INTEGER NOT NULL DEFAULT 1,
        training_opt_in INTEGER NOT NULL DEFAULT 0,
        notifications_email INTEGER NOT NULL DEFAULT 1,
        personalization TEXT NOT NULL DEFAULT '',
        theme TEXT NOT NULL DEFAULT 'dark'
      );
      INSERT INTO settings_new (user_id, default_model, default_mode, memory_enabled, training_opt_in, notifications_email, personalization, theme)
        SELECT user_id, default_model, default_mode, memory_enabled, training_opt_in, notifications_email, personalization, theme FROM settings;
      DROP TABLE settings;
      ALTER TABLE settings_new RENAME TO settings;
    `);
  });

  // 1.1.0 — record which adapter version produced a message / served an API request.
  apply('2026-11-model-version-columns', () => {
    if (!hasColumn(d, 'messages', 'model_version')) d.exec('ALTER TABLE messages ADD COLUMN model_version TEXT');
    if (!hasColumn(d, 'api_requests', 'model_version')) d.exec('ALTER TABLE api_requests ADD COLUMN model_version TEXT');
  });
}

// The `models` table is seeded and kept in sync from the catalog file (name, tier, description…);
// `enabled` stays under admin control and is never overwritten.
function syncCatalog(d) {
  const up = d.prepare(`INSERT INTO models (id, name, family, tier, description, history_training_allowed) VALUES (?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET name = excluded.name, family = excluded.family, tier = excluded.tier,
      description = excluded.description, history_training_allowed = excluded.history_training_allowed`);
  for (const m of catalog.models) up.run(m.id, m.name, m.family, m.tier, m.description, m.history_training_allowed ? 1 : 0);
}

let db;
export function getDb() {
  if (db) return db;
  fs.mkdirSync(config.dataDir, { recursive: true });
  const file = process.env.APPROX_DB_FILE || path.join(config.dataDir, 'approx.db');
  db = new DatabaseSync(file);
  db.exec(SCHEMA);
  migrate(db);
  syncCatalog(db);
  return db;
}

export const now = () => Date.now();

// Small helpers to keep route code terse.
export const one = (sql, ...p) => getDb().prepare(sql).get(...p);
export const all = (sql, ...p) => getDb().prepare(sql).all(...p);
export const run = (sql, ...p) => getDb().prepare(sql).run(...p);
export function tx(fn) {
  const d = getDb();
  d.exec('BEGIN');
  try { const r = fn(); d.exec('COMMIT'); return r; } catch (e) { d.exec('ROLLBACK'); throw e; }
}

export function audit(userId, actor, action, target = null, ip = null, detail = {}) {
  run('INSERT INTO audit_logs (user_id,actor,action,target,ip,detail,created_at) VALUES (?,?,?,?,?,?,?)',
    userId, actor, action, target, ip, JSON.stringify(detail), now());
}
export function securityEvent(userId, kind, severity, ip, detail = {}) {
  run('INSERT INTO security_events (user_id,kind,severity,ip,detail,created_at) VALUES (?,?,?,?,?,?)',
    userId, kind, severity, ip, JSON.stringify(detail), now());
}
