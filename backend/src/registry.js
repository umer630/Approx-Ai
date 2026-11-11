// Model registry: discovers versioned release artifacts produced by the training pipeline, verifies
// them, and controls which version of each model is live.
//
//   <modelsDir>/<model-id>/versions/<x.y.z>/
//       adapter/adapter_model.safetensors, adapter_config.json, tokenizer files
//       release.json      machine-readable release manifest (status, production_ready, blockers, hashes)
//       metadata.json     model / dataset / training metadata
//       evaluation.json   unseen-suite results (base vs adapter), quality gate
//       training.json     training metrics, schedule, checkpoints
//       SHA256SUMS        every file above (sha256, relative path)
//       SIGNATURE         optional HMAC-SHA256 of SHA256SUMS (required when APPROX_RELEASE_SIGNING_KEY is set)
//   <modelsDir>/active.json   which version of each model is live — read by the inference server too
//
// Rules enforced here (and independently by the Python inference server):
//   * only an allow-list of file types may exist in an artifact (no pickle / code files);
//   * every file must be listed in SHA256SUMS and match; nothing unlisted may exist;
//   * only releases with status "validated" can be activated; smoke-test artifacts never in production;
//   * a release that is not production_ready needs an explicit superadmin override to go live;
//   * versions are immutable — importing a different artifact under an existing version is refused.
// Weights never go into the database; `model_releases` only mirrors metadata.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { config } from './config.js';
import { catalog, catalogModel, MODEL_KINDS } from './catalog.js';
import { run, now, audit, securityEvent } from './db.js';
import { HttpError, bad } from './http.js';

export const VERSION_RE = /^\d{1,4}\.\d{1,4}\.\d{1,4}(?:-[a-z0-9][a-z0-9.]{0,30})?$/;
const ALLOWED_EXT = new Set(['.safetensors', '.json', '.txt', '.model', '.jinja', '.md']);
const ALLOWED_BARE = new Set(['SHA256SUMS', 'SIGNATURE']);
const REQUIRED_FILES = ['release.json', 'metadata.json', 'adapter/adapter_model.safetensors', 'adapter/adapter_config.json'];
const STATUSES = ['validated', 'failed', 'smoke_test'];
const MAX_FILES = 200;

const dir = () => config.registry.dir;
const activeFile = () => path.join(dir(), 'active.json');

// ---------------------------------------------------------------- helpers
const hashCache = new Map();
export function sha256File(file) {
  const st = fs.statSync(file);
  const key = `${file}|${st.size}|${st.mtimeMs}`;
  const hit = hashCache.get(key);
  if (hit) return hit;
  const h = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.allocUnsafe(1 << 20);
    let n;
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, n));
  } finally { fs.closeSync(fd); }
  const hex = h.digest('hex');
  if (hashCache.size > 2000) hashCache.clear();
  hashCache.set(key, hex);
  return hex;
}

function allowedFile(rel) {
  const base = path.posix.basename(rel);
  if (ALLOWED_BARE.has(rel)) return true;
  if (base.startsWith('.')) return false;
  return ALLOWED_EXT.has(path.posix.extname(base).toLowerCase());
}

function safeRel(rel) {
  return typeof rel === 'string' && rel.length > 0 && rel.length < 300 && !rel.startsWith('/') && !rel.includes('\\') && !rel.includes('\0') &&
    rel.split('/').every((seg) => seg && seg !== '.' && seg !== '..');
}

/** All regular files below `root` as posix relative paths. Symlinks and special files are errors. */
function walk(root, errors) {
  const out = [];
  const rec = (abs, rel) => {
    for (const name of fs.readdirSync(abs).sort()) {
      const a = path.join(abs, name);
      const r = rel ? `${rel}/${name}` : name;
      const st = fs.lstatSync(a);
      if (st.isSymbolicLink()) errors.push(`symlink not allowed: ${r}`);
      else if (st.isDirectory()) rec(a, r);
      else if (st.isFile()) out.push(r);
      else errors.push(`special file not allowed: ${r}`);
      if (out.length > MAX_FILES) { errors.push(`too many files (> ${MAX_FILES})`); return; }
    }
  };
  rec(root, '');
  return out;
}

export function compareVersions(a, b) {
  const pa = a.split('-')[0].split('.').map(Number);
  const pb = b.split('-')[0].split('.').map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  const sa = a.includes('-'); const sb = b.includes('-');
  if (sa !== sb) return sa ? -1 : 1;           // 1.0.0 > 1.0.0-rc1
  return a < b ? -1 : a > b ? 1 : 0;
}

// ---------------------------------------------------------------- verification
/**
 * Verify one release directory. Returns { ok, errors[], release, summary }.
 * `expect` = { modelId, version } taken from the directory names.
 */
export function verifyReleaseDir(releaseDir, expect) {
  const errors = [];
  const result = { ok: false, errors, release: null, files: 0, bytes: 0, adapter_sha256: null, signed: false };
  let st;
  try { st = fs.lstatSync(releaseDir); } catch { errors.push('release directory does not exist'); return result; }
  if (!st.isDirectory()) { errors.push('release path is not a directory'); return result; }

  const files = walk(releaseDir, errors);
  result.files = files.length;
  for (const f of files) if (!allowedFile(f)) errors.push(`disallowed file type: ${f}`);

  // SHA256SUMS: complete and exact
  const sums = new Map();
  if (!files.includes('SHA256SUMS')) errors.push('SHA256SUMS is missing');
  else {
    for (const line of fs.readFileSync(path.join(releaseDir, 'SHA256SUMS'), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      const m = /^([a-f0-9]{64}) {2}(.+)$/.exec(line);
      if (!m || !safeRel(m[2])) { errors.push(`malformed SHA256SUMS line: ${line.slice(0, 80)}`); continue; }
      if (sums.has(m[2])) errors.push(`duplicate SHA256SUMS entry: ${m[2]}`);
      sums.set(m[2], m[1]);
    }
    for (const f of files) if (!ALLOWED_BARE.has(f) && !sums.has(f)) errors.push(`file not listed in SHA256SUMS: ${f}`);
    for (const [f, expected] of sums) {
      if (!files.includes(f)) { errors.push(`listed file is missing: ${f}`); continue; }
      const abs = path.join(releaseDir, f);
      result.bytes += fs.statSync(abs).size;
      if (sha256File(abs) !== expected) errors.push(`SHA-256 mismatch: ${f}`);
    }
  }
  for (const f of REQUIRED_FILES) if (!files.includes(f)) errors.push(`required file is missing: ${f}`);

  // Optional authenticity: HMAC over SHA256SUMS with a key shared with the training pipeline.
  if (files.includes('SIGNATURE') && files.includes('SHA256SUMS')) {
    const sig = fs.readFileSync(path.join(releaseDir, 'SIGNATURE'), 'utf8').trim();
    if (config.registry.signingKey) {
      const want = crypto.createHmac('sha256', config.registry.signingKey).update(fs.readFileSync(path.join(releaseDir, 'SHA256SUMS'))).digest('hex');
      if (sig.length === want.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want))) result.signed = true;
      else errors.push('SIGNATURE does not match (wrong signing key or modified artifact)');
    }
  }
  if (config.registry.signingKey && !result.signed && !errors.some((e) => e.startsWith('SIGNATURE'))) errors.push('release is not signed but APPROX_RELEASE_SIGNING_KEY is configured');

  // release.json
  let rel = null;
  if (files.includes('release.json')) {
    try { rel = JSON.parse(fs.readFileSync(path.join(releaseDir, 'release.json'), 'utf8')); } catch { errors.push('release.json is not valid JSON'); }
  }
  if (rel && (typeof rel !== 'object' || Array.isArray(rel))) { errors.push('release.json must be an object'); rel = null; }
  if (rel) {
    const cat = catalogModel(expect.modelId);
    if (rel.schema !== 'approx.release/v1') errors.push('release.json: schema must be approx.release/v1');
    if (rel.model_id !== expect.modelId) errors.push(`release.json: model_id '${rel.model_id}' does not match directory '${expect.modelId}'`);
    if (rel.version !== expect.version) errors.push(`release.json: version '${rel.version}' does not match directory '${expect.version}'`);
    if (!STATUSES.includes(rel.status)) errors.push(`release.json: status must be one of ${STATUSES.join(', ')}`);
    if (typeof rel.production_ready !== 'boolean') errors.push('release.json: production_ready must be a boolean');
    if (!Array.isArray(rel.blockers)) errors.push('release.json: blockers must be an array');
    if (typeof rel.base_model !== 'string' || !rel.base_model) errors.push('release.json: base_model is required');
    if (!MODEL_KINDS.includes(rel.kind)) errors.push(`release.json: kind must be one of ${MODEL_KINDS.join(', ')}`);
    if (!cat) errors.push(`model '${expect.modelId}' is not in the model catalog`);
    else {
      if (rel.kind && rel.kind !== cat.kind) errors.push(`release.json: kind '${rel.kind}' does not match catalog kind '${cat.kind}'`);
      if (rel.smoke_test !== true && cat.base_model && rel.base_model !== cat.base_model) {
        errors.push(`base model mismatch: release was trained on '${rel.base_model}' but ${cat.name} is defined on '${cat.base_model}'`);
      }
    }
    const weightsSha = sums.get('adapter/adapter_model.safetensors');
    result.adapter_sha256 = weightsSha || null;
    if (!/^[a-f0-9]{64}$/.test(String(rel.adapter_sha256))) errors.push('release.json: adapter_sha256 must be a SHA-256 hex digest');
    else if (weightsSha && rel.adapter_sha256 !== weightsSha) errors.push('release.json: adapter_sha256 does not match adapter/adapter_model.safetensors');
    if (rel.smoke_test === true && rel.status !== 'smoke_test') errors.push('release.json: a smoke-test artifact must have status smoke_test');
    if (rel.status === 'smoke_test' && rel.smoke_test !== true) errors.push('release.json: status smoke_test requires smoke_test=true');
    if (rel.production_ready === true) {
      const why = [];
      if (rel.status !== 'validated') why.push('status is not validated');
      if (rel.smoke_test === true) why.push('smoke test');
      if (Array.isArray(rel.blockers) && rel.blockers.length) why.push('blockers are listed');
      if (rel.verification?.passed !== true) why.push('verification did not pass');
      if (rel.evaluation?.gate_passed !== true) why.push('quality gate did not pass');
      if (rel.dataset?.production_ready !== true) why.push('dataset is not production-ready');
      if (why.length) errors.push(`release.json: production_ready=true contradicts the release evidence (${why.join('; ')})`);
    }
    if (rel.status === 'validated' && rel.verification?.passed !== true) errors.push('release.json: status validated requires verification.passed=true');
  }
  result.release = rel;
  result.ok = errors.length === 0;
  return result;
}

function summarize(modelId, version, releaseDir, v) {
  const rel = v.release || {};
  const reasons = [];
  if (!v.ok) reasons.push('artifact failed verification');
  if (rel.status === 'failed') reasons.push('release status is failed (training verification did not pass)');
  if (rel.status === 'smoke_test' || rel.smoke_test === true) {
    if (!config.registry.allowSmoke) reasons.push('smoke-test artifact (pipeline test only — never a real model)');
  }
  const activatable = v.ok && (rel.status === 'validated' || (rel.status === 'smoke_test' && config.registry.allowSmoke));
  return {
    model_id: modelId, version, dir: releaseDir,
    verified: v.ok, errors: v.errors, signed: v.signed,
    status: v.ok ? rel.status : 'invalid',
    production_ready: v.ok && rel.production_ready === true,
    blockers: Array.isArray(rel.blockers) ? rel.blockers : [],
    smoke_test: rel.smoke_test === true,
    kind: rel.kind || catalogModel(modelId)?.kind || null,
    base_model: rel.base_model || null,
    base_model_revision: rel.base_model_revision || null,
    adapter_sha256: v.adapter_sha256,
    adapter_bytes: rel.adapter_bytes ?? null,
    dataset: rel.dataset || null,
    evaluation: rel.evaluation || null,
    verification: rel.verification ? { passed: rel.verification.passed === true, safety_passed: rel.verification.safety_passed === true } : null,
    training: rel.training || null,
    created_at: rel.created_at || null,
    files: v.files, bytes: v.bytes,
    activatable, not_activatable_reasons: activatable ? [] : reasons,
  };
}

// ---------------------------------------------------------------- scan
let lastScan = { at: 0, models: new Map(), ignored: [] };

export function scan({ force = false } = {}) {
  if (!force && now() - lastScan.at < 5000) return lastScan;
  const models = new Map();
  const ignored = [];
  if (fs.existsSync(dir())) {
    for (const modelId of fs.readdirSync(dir()).sort()) {
      const mdir = path.join(dir(), modelId);
      if (modelId.startsWith('.') || !fs.lstatSync(mdir).isDirectory()) continue;
      if (!catalogModel(modelId)) { ignored.push(`${modelId}: not in the model catalog`); continue; }
      const vroot = path.join(mdir, 'versions');
      if (!fs.existsSync(vroot)) continue;
      const list = [];
      for (const version of fs.readdirSync(vroot)) {
        if (!VERSION_RE.test(version)) { ignored.push(`${modelId}/${version}: not a valid version name`); continue; }
        const rdir = path.join(vroot, version);
        if (!fs.lstatSync(rdir).isDirectory()) continue;
        list.push(summarize(modelId, version, rdir, verifyReleaseDir(rdir, { modelId, version })));
      }
      list.sort((a, b) => compareVersions(b.version, a.version));
      models.set(modelId, list);
    }
  }
  lastScan = { at: now(), models, ignored };
  mirrorToDb(models);
  checkActiveIntegrity();
  autoActivate();
  return lastScan;
}

function mirrorToDb(models) {
  const t = now();
  for (const [modelId, list] of models) {
    for (const v of list) {
      run(`INSERT INTO model_releases (model_id, version, kind, status, production_ready, verified, adapter_sha256, base_model, base_model_revision,
             dataset_version, dataset_fingerprint, evaluation_score, artifact_uri, source, detail, first_seen_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT(model_id, version) DO UPDATE SET kind = excluded.kind, status = excluded.status, production_ready = excluded.production_ready,
             verified = excluded.verified, adapter_sha256 = excluded.adapter_sha256, base_model = excluded.base_model,
             base_model_revision = excluded.base_model_revision, dataset_version = excluded.dataset_version,
             dataset_fingerprint = excluded.dataset_fingerprint, evaluation_score = excluded.evaluation_score,
             artifact_uri = excluded.artifact_uri, detail = excluded.detail, updated_at = excluded.updated_at`,
      modelId, v.version, v.kind || 'language_model', v.status, v.production_ready ? 1 : 0, v.verified ? 1 : 0, v.adapter_sha256, v.base_model,
      v.base_model_revision, v.dataset?.version ?? null, v.dataset?.fingerprint ?? null, typeof v.evaluation?.score === 'number' ? v.evaluation.score : null,
      `${modelId}/versions/${v.version}/`, 'scan', JSON.stringify({ errors: v.errors.slice(0, 20), blockers: v.blockers.slice(0, 20), signed: v.signed }), t, t);
    }
  }
}

export function listVersions(modelId) { return scan().models.get(modelId) || []; }
export function findVersion(modelId, version) { return listVersions(modelId).find((v) => v.version === version) || null; }

// ---------------------------------------------------------------- active state
let activeCache = { mtime: -1, data: { active: {} } };

export function readActive() {
  let st;
  try { st = fs.statSync(activeFile()); } catch { activeCache = { mtime: -1, data: { active: {} } }; return activeCache.data; }
  if (st.mtimeMs === activeCache.mtime) return activeCache.data;
  let data = { active: {} };
  try {
    const raw = JSON.parse(fs.readFileSync(activeFile(), 'utf8'));
    if (raw && typeof raw.active === 'object' && raw.active && !Array.isArray(raw.active)) {
      for (const [id, a] of Object.entries(raw.active)) {
        if (catalogModel(id) && a && VERSION_RE.test(String(a.version))) data.active[id] = a;
      }
    }
  } catch { /* unreadable → treated as nothing active (fail closed) */ }
  activeCache = { mtime: st.mtimeMs, data };
  return data;
}

function writeActive(data) {
  fs.mkdirSync(dir(), { recursive: true });
  const body = JSON.stringify({ schema: 'approx.active/v1', updated_at: new Date().toISOString(), active: data.active }, null, 2) + '\n';
  const tmp = `${activeFile()}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, body, { mode: 0o644 });
  fs.renameSync(tmp, activeFile());
  activeCache = { mtime: -1, data: { active: {} } };
}

const invalidActive = new Map(); // modelId → reason (active entry points at a missing / tampered artifact)

/** The live version entry for a model, or null. An active entry whose artifact no longer verifies is never served. */
export function getActive(modelId) {
  const a = readActive().active[modelId];
  if (!a) return null;
  if (invalidActive.has(modelId)) return null;
  return a;
}
export function activeProblem(modelId) { return invalidActive.get(modelId) || null; }

function checkActiveIntegrity() {
  const active = readActive().active;
  for (const [modelId, a] of Object.entries(active)) {
    const v = (lastScan.models.get(modelId) || []).find((x) => x.version === a.version);
    let reason = null;
    if (!v) reason = `active version ${a.version} is missing from the registry directory`;
    else if (!v.verified) reason = `active version ${a.version} failed verification: ${v.errors[0] || 'unknown'}`;
    else if (!v.activatable) reason = `active version ${a.version} is no longer activatable`;
    else if (a.adapter_sha256 && v.adapter_sha256 !== a.adapter_sha256) reason = `active version ${a.version} adapter hash changed since activation`;
    if (reason && invalidActive.get(modelId) !== reason) securityEvent(null, 'registry_active_invalid', 'high', null, { model_id: modelId, reason });
    if (reason) invalidActive.set(modelId, reason); else invalidActive.delete(modelId);
  }
  for (const id of [...invalidActive.keys()]) if (!active[id]) invalidActive.delete(id);
}

// ---------------------------------------------------------------- activation
async function notifyInference() {
  const url = config.registry.inferenceAdminUrl;
  if (!url) return { status: 'not_configured', note: 'APPROX_INFERENCE_ADMIN_URL is not set; the inference server picks the change up on its next registry poll' };
  try {
    const r = await fetch(`${url}/admin/reload`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(config.registry.inferenceAdminKey ? { Authorization: `Bearer ${config.registry.inferenceAdminKey}` } : {}) },
      body: '{}', signal: AbortSignal.timeout(120_000),
    });
    const body = await r.json().catch(() => ({}));
    return r.ok ? { status: 'reloaded', serving: body.serving ?? null, errors: body.errors ?? null } : { status: 'failed', http: r.status, error: body.error?.message || null };
  } catch (e) {
    return { status: 'failed', error: `${e.name}: ${e.message}`.slice(0, 200) };
  }
}

function setActive(modelId, v, actor, { reason = '', source = 'manual' } = {}) {
  const data = { active: { ...readActive().active } };
  const previous = data.active[modelId]?.version || null;
  data.active[modelId] = {
    version: v.version, adapter_sha256: v.adapter_sha256, base_model: v.base_model, base_model_revision: v.base_model_revision,
    production_ready: v.production_ready, activated_at: new Date().toISOString(), activated_by: actor, source,
  };
  writeActive(data);
  invalidActive.delete(modelId);
  const t = now();
  if (previous && previous !== v.version) run('UPDATE model_releases SET deactivated_at = ? WHERE model_id = ? AND version = ?', t, modelId, previous);
  run('UPDATE model_releases SET activated_at = ?, activated_by = ?, deactivated_at = NULL WHERE model_id = ? AND version = ?', t, actor, modelId, v.version);
  audit(null, actor, 'registry.activated', `${modelId}@${v.version}`, null,
    { previous, production_ready: v.production_ready, adapter_sha256: v.adapter_sha256, reason: String(reason).slice(0, 300), source });
  return previous;
}

/** Make `version` the live version of `modelId`. Only verified, validated artifacts qualify. */
export async function activate(modelId, version, { actor, allowNonProduction = false, reason = '' }) {
  if (!catalogModel(modelId)) throw bad(`Unknown model '${modelId}'`, 'unknown_model');
  if (!VERSION_RE.test(String(version))) throw bad('version must look like 1.0.0', 'invalid_version');
  scan({ force: true });
  const v = findVersion(modelId, version);
  if (!v) throw new HttpError(404, 'unknown_model_version', `${modelId} has no version ${version} in the registry`);
  if (!v.activatable) {
    throw new HttpError(409, 'version_not_activatable', `${modelId}@${version} cannot be activated: ${v.not_activatable_reasons.join('; ') || 'not validated'}`,
      { reasons: v.not_activatable_reasons, errors: v.errors.slice(0, 10) });
  }
  if (!v.production_ready && !allowNonProduction) {
    throw new HttpError(409, 'not_production_ready', `${modelId}@${version} is validated but not production-ready. Activation needs an explicit override.`,
      { blockers: v.blockers });
  }
  const previous = setActive(modelId, v, actor, { reason });
  const inference = await notifyInference();
  return { model_id: modelId, version, previous_version: previous, production_ready: v.production_ready, inference };
}

export async function deactivate(modelId, { actor, reason = '' }) {
  if (!catalogModel(modelId)) throw bad(`Unknown model '${modelId}'`, 'unknown_model');
  const data = { active: { ...readActive().active } };
  const previous = data.active[modelId]?.version || null;
  if (!previous) throw new HttpError(409, 'no_active_version', `${modelId} has no active version`);
  delete data.active[modelId];
  writeActive(data);
  invalidActive.delete(modelId);
  run('UPDATE model_releases SET deactivated_at = ? WHERE model_id = ? AND version = ?', now(), modelId, previous);
  audit(null, actor, 'registry.deactivated', `${modelId}@${previous}`, null, { reason: String(reason).slice(0, 300) });
  const inference = await notifyInference();
  return { model_id: modelId, previous_version: previous, inference };
}

/** Automatic activation policy (APPROX_AUTO_ACTIVATE). Never downgrades, never activates unverified or smoke artifacts. */
function autoActivate() {
  const policy = config.registry.autoActivate;
  if (policy === 'off') return;
  for (const [modelId, list] of lastScan.models) {
    const candidate = list.find((v) => v.activatable && !v.smoke_test && v.status === 'validated' && (policy === 'validated' || v.production_ready));
    if (!candidate) continue;
    const current = readActive().active[modelId];
    if (current && compareVersions(candidate.version, current.version) <= 0) continue;
    setActive(modelId, candidate, 'auto-policy', { reason: `APPROX_AUTO_ACTIVATE=${policy}`, source: 'auto' });
    notifyInference().catch(() => {});
  }
}

// ---------------------------------------------------------------- serving resolution
/**
 * Which version should serve a request. `requested` is an optional explicit version from the API caller.
 * Only the active version is ever served; asking for another existing version is a clear 409.
 */
export function resolveServingVersion(modelId, requested) {
  scan();
  const active = getActive(modelId);
  if (requested === undefined || requested === null || requested === '') return active?.version ?? null;
  if (typeof requested !== 'string' || !VERSION_RE.test(requested)) throw bad('version must look like 1.0.0', 'invalid_version');
  const v = findVersion(modelId, requested);
  if (!v) throw new HttpError(404, 'unknown_model_version', `${modelId} has no version ${requested}`);
  if (!active || active.version !== requested) {
    throw new HttpError(409, 'model_version_not_active', `${modelId}@${requested} exists but is not the active version`, { active_version: active?.version ?? null });
  }
  return requested;
}

export function publicModelState(modelId) {
  scan();
  const active = getActive(modelId);
  const list = listVersions(modelId);
  const av = active ? list.find((v) => v.version === active.version) : null;
  return {
    active_version: active?.version ?? null,
    release_status: av?.status ?? (active ? 'unknown' : null),
    production_ready: av?.production_ready ?? false,
    activated_at: active?.activated_at ?? null,
    problem: activeProblem(modelId),
    validated_versions: list.filter((v) => v.activatable && !v.smoke_test).map((v) => v.version),
  };
}

// ---------------------------------------------------------------- import
function tarAvailable() {
  try { execFileSync('tar', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; }
}

function listArchive(file) {
  const out = execFileSync('tar', ['-tvzf', file], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' } });
  const entries = [];
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    // -rw-r--r-- 0/0   1234 1970-01-01 00:00 path
    const m = /^([-dlhcbps])([rwxsStT-]{9})[+.]?\s+\S+\s+(\d+)\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}(?::\d{2})?\s+(.+)$/.exec(line);
    if (!m) throw new HttpError(422, 'invalid_artifact', `archive listing could not be parsed: ${line.slice(0, 80)}`);
    entries.push({ type: m[1], size: Number(m[3]), name: m[4] });
  }
  return entries;
}

function validateEntries(entries) {
  if (!entries.length) throw new HttpError(422, 'invalid_artifact', 'archive is empty');
  if (entries.length > MAX_FILES + 50) throw new HttpError(422, 'invalid_artifact', 'archive has too many entries');
  let prefix = null; let total = 0;
  for (const e of entries) {
    if (e.type !== '-' && e.type !== 'd') throw new HttpError(422, 'invalid_artifact', `archive contains a non-regular entry (${e.type}): ${e.name.slice(0, 80)}`);
    const name = e.name.replace(/\/$/, '');
    if (!safeRel(name)) throw new HttpError(422, 'invalid_artifact', `unsafe path in archive: ${e.name.slice(0, 80)}`);
    const parts = name.split('/');
    // every entry must live under <model-id>/versions/<version>/ (parent directory entries are allowed)
    const under = parts.length >= 3 && parts[1] === 'versions' ? parts.slice(0, 3).join('/') : null;
    if (parts.length >= 3) {
      if (!under) throw new HttpError(422, 'invalid_artifact', `unexpected path in archive: ${name.slice(0, 80)}`);
      if (prefix && prefix !== under) throw new HttpError(422, 'invalid_artifact', 'archive must contain exactly one model version');
      prefix = under;
    } else if (e.type !== 'd') {
      throw new HttpError(422, 'invalid_artifact', `unexpected file at the top of the archive: ${name.slice(0, 80)}`);
    }
    if (e.type === '-') {
      total += e.size;
      const rel = parts.slice(3).join('/');
      if (!rel || !allowedFile(rel)) throw new HttpError(422, 'invalid_artifact', `disallowed file in archive: ${name.slice(0, 80)}`);
    }
  }
  if (!prefix) throw new HttpError(422, 'invalid_artifact', 'archive does not contain <model-id>/versions/<version>/');
  if (total > config.registry.maxArtifactBytes * 2) throw new HttpError(413, 'payload_too_large', 'archive expands beyond the artifact size limit');
  const [modelId, , version] = prefix.split('/');
  if (!catalogModel(modelId)) throw new HttpError(422, 'invalid_artifact', `archive is for unknown model '${modelId}'`);
  if (!VERSION_RE.test(version)) throw new HttpError(422, 'invalid_artifact', `archive has an invalid version '${version}'`);
  return { modelId, version };
}

function rmrf(p) { fs.rmSync(p, { recursive: true, force: true }); }

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const name of fs.readdirSync(src)) {
    const a = path.join(src, name); const b = path.join(dest, name);
    const st = fs.lstatSync(a);
    if (st.isSymbolicLink()) throw new HttpError(422, 'invalid_artifact', `symlink not allowed: ${name}`);
    if (st.isDirectory()) copyDir(a, b);
    else if (st.isFile()) fs.copyFileSync(a, b);
    else throw new HttpError(422, 'invalid_artifact', `special file not allowed: ${name}`);
  }
}

function installVerified(stagedDir, modelId, version, actor, source) {
  const v = verifyReleaseDir(stagedDir, { modelId, version });
  if (!v.ok) throw new HttpError(422, 'invalid_artifact', `artifact failed verification: ${v.errors[0]}`, { errors: v.errors.slice(0, 20) });
  const dest = path.join(dir(), modelId, 'versions', version);
  if (fs.existsSync(dest)) {
    const cur = verifyReleaseDir(dest, { modelId, version });
    const same = cur.ok && cur.adapter_sha256 === v.adapter_sha256 &&
      fs.readFileSync(path.join(dest, 'SHA256SUMS'), 'utf8') === fs.readFileSync(path.join(stagedDir, 'SHA256SUMS'), 'utf8');
    if (same) return { model_id: modelId, version, status: 'already_imported', release: summarize(modelId, version, dest, cur) };
    throw new HttpError(409, 'version_exists', `${modelId}@${version} already exists with different content. Versions are immutable — publish a new version number.`);
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.renameSync(stagedDir, dest);
  audit(null, actor, 'registry.imported', `${modelId}@${version}`, null, { adapter_sha256: v.adapter_sha256, status: v.release.status, production_ready: v.release.production_ready, source });
  scan({ force: true });
  return { model_id: modelId, version, status: 'imported', release: findVersion(modelId, version) };
}

/** Import a release archive (.tar.gz laid out as <model-id>/versions/<version>/…). Nothing is activated here. */
export function importArchive(file, { actor, expectedSha256 = null, source = 'upload' }) {
  if (!tarAvailable()) throw new HttpError(501, 'tar_unavailable', 'The `tar` program is required on the API server to import artifacts');
  if (expectedSha256 && sha256File(file) !== String(expectedSha256).toLowerCase()) {
    throw new HttpError(422, 'sha256_mismatch', 'Uploaded archive does not match the declared SHA-256');
  }
  let entries;
  try { entries = listArchive(file); } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(422, 'invalid_artifact', 'file is not a readable .tar.gz archive');
  }
  const { modelId, version } = validateEntries(entries);
  const staging = path.join(dir(), '.incoming', crypto.randomBytes(8).toString('hex'));
  fs.mkdirSync(staging, { recursive: true });
  try {
    execFileSync('tar', ['-xzf', file, '-C', staging, '--no-same-owner', '--no-same-permissions'], { stdio: 'ignore' });
    return installVerified(path.join(staging, modelId, 'versions', version), modelId, version, actor, source);
  } finally { rmrf(staging); }
}

/** Import a release directory (a version directory, or a tree containing <model-id>/versions/<version>/). CLI use. */
export function importDirectory(src, { actor, source = 'cli' }) {
  const abs = path.resolve(src);
  let relFile = path.join(abs, 'release.json');
  if (!fs.existsSync(relFile)) throw new HttpError(422, 'invalid_artifact', `${abs} does not contain release.json`);
  let rel;
  try { rel = JSON.parse(fs.readFileSync(relFile, 'utf8')); } catch { throw new HttpError(422, 'invalid_artifact', 'release.json is not valid JSON'); }
  if (!catalogModel(rel.model_id) || !VERSION_RE.test(String(rel.version))) throw new HttpError(422, 'invalid_artifact', 'release.json has an unknown model_id or invalid version');
  const staging = path.join(dir(), '.incoming', crypto.randomBytes(8).toString('hex'));
  try {
    copyDir(abs, path.join(staging, 'v'));
    return installVerified(path.join(staging, 'v'), rel.model_id, rel.version, actor, source);
  } finally { rmrf(staging); }
}

// ---------------------------------------------------------------- views
export function registryOverview() {
  const s = scan({ force: true });
  const active = readActive().active;
  return {
    models_dir: dir(),
    auto_activate: config.registry.autoActivate,
    signing_required: !!config.registry.signingKey,
    scanned_at: s.at,
    ignored: s.ignored,
    models: catalog.models.map((m) => ({
      id: m.id, name: m.name, kind: m.kind, base_model: m.base_model,
      active_version: getActive(m.id)?.version ?? null,
      active: active[m.id] || null,
      active_problem: activeProblem(m.id),
      versions: (s.models.get(m.id) || []).map(({ dir: _d, ...v }) => v),
    })),
  };
}

export function releaseDetail(modelId, version) {
  if (!catalogModel(modelId) || !VERSION_RE.test(String(version))) return null;
  const v = findVersion(modelId, version);
  if (!v) return null;
  const read = (name) => {
    try { return JSON.parse(fs.readFileSync(path.join(v.dir, name), 'utf8')); } catch { return null; }
  };
  const { dir: _d, ...summary } = v;
  return { summary, release: read('release.json'), metadata: read('metadata.json'), evaluation: read('evaluation.json'), training: read('training.json') };
}

let watcher = null;
export function startRegistryWatcher() {
  if (watcher) return;
  const tick = () => { try { scan({ force: true }); } catch (e) { console.error('[registry] scan failed:', e.message); } };
  tick();
  watcher = setInterval(tick, Math.max(10, config.registry.scanSeconds) * 1000);
  watcher.unref();
}

