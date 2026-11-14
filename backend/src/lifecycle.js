// Model lifecycle: REGISTERED → TRAINING → TRAINING_COMPLETE → EVALUATING → VERIFIED → DEPLOYING → ACTIVE (+ FAILED).
//
// A model is only ever ACTIVE after the backend itself verified the deployment against the live inference server:
//   1. the server's /health reports this model serving exactly the registered version,
//   2. with exactly the registered adapter SHA-256 (and, for pinned models, the pinned SHA),
//   3. the release is production-ready (never a smoke-test artifact),
//   4. a real generation request returns text.
// Anything else records FAILED with the failing stage; nothing is activated because a training job "completed".
import { one, all, run, now, tx, audit } from './db.js';
import { HttpError } from './http.js';
import { catalog } from './catalog.js';

export const STATES = ['TRAINING_REQUIRED', 'REGISTERED', 'TRAINING', 'TRAINING_COMPLETE', 'EVALUATING', 'VERIFIED', 'DEPLOYING', 'ACTIVE', 'FAILED'];
// Allowed manual/worker transitions. ACTIVE is never set directly: only verifyDeployment() reaches it.
const NEXT = {
  TRAINING_REQUIRED: ['TRAINING'],
  REGISTERED: ['TRAINING', 'TRAINING_COMPLETE', 'DEPLOYING'],
  TRAINING: ['TRAINING_COMPLETE', 'FAILED'],
  TRAINING_COMPLETE: ['EVALUATING', 'FAILED'],
  EVALUATING: ['VERIFIED', 'FAILED'],
  VERIFIED: ['DEPLOYING', 'FAILED'],
  DEPLOYING: ['FAILED'],
  ACTIVE: ['DEPLOYING', 'REGISTERED'],
  FAILED: ['TRAINING', 'TRAINING_COMPLETE', 'REGISTERED'],
};
export const LABELS = {
  TRAINING_REQUIRED: 'Training required', REGISTERED: 'Registered — not deployed', TRAINING: 'Training',
  TRAINING_COMPLETE: 'Training complete — awaiting evaluation', EVALUATING: 'Evaluating', VERIFIED: 'Verified — awaiting deployment',
  DEPLOYING: 'Deploying', ACTIVE: 'Active', FAILED: 'Failed',
};
const VERSION_RE = /^\d+\.\d+\.\d+$/;
const SHA_RE = /^[a-f0-9]{64}$/;

// Hashes the owner pinned for a model (APPROX_PIN_SHA256="nick-4.8=<hex>,…"); a deployed adapter must match it.
export function pinnedSha(modelId) {
  const fromCatalog = catalog.models.find((m) => m.id === modelId)?.pinned_adapter_sha256;
  if (fromCatalog && SHA_RE.test(fromCatalog)) return fromCatalog;
  for (const item of String(process.env.APPROX_PIN_SHA256 || process.env.INFERENCE_PIN_SHA256 || '').split(',')) {
    const [k, v] = item.split('=');
    if (k?.trim() === modelId && SHA_RE.test(String(v || '').trim().toLowerCase())) return v.trim().toLowerCase();
  }
  return null;
}

let cache = { at: 0, rows: new Map() };
export function invalidateLifecycleCache() { cache = { at: 0, rows: new Map() }; }
/** Lifecycle row for a model (cached 5 s), or null when the model is not lifecycle-managed. */
export async function lifecycleOf(modelId) {
  if (Date.now() - cache.at > 5000) {
    const rows = await all('SELECT * FROM model_lifecycle');
    cache = { at: Date.now(), rows: new Map(rows.map((r) => [r.model_id, r])) };
  }
  return cache.rows.get(modelId) || null;
}

/** Last loaded lifecycle row (synchronous; callers that need fresh data await lifecycleOf first). */
export function lifecycleCached(modelId) { return cache.rows.get(modelId) || null; }

/** In inference mode, the version a lifecycle-managed model may serve: only its ACTIVE, verified version. */
export function gateServed(modelId, served) {
  const lc = lifecycleCached(modelId);
  if (!lc) return served;
  return lc.state === 'ACTIVE' && served && served === lc.version ? served : null;
}

export function lifecycleView(r) {
  if (!r) return null;
  return { state: r.state, label: LABELS[r.state] || r.state, version: r.version || null, adapter_sha256: r.adapter_sha256 || null,
    base_model: r.base_model || null, base_model_revision: r.base_revision || null, artifact_uri: r.artifact_uri || null,
    failed_stage: r.failed_stage || null, detail: r.detail || '', verified_at: r.verified_at || null, updated_at: r.updated_at };
}

async function record(modelId, from, to, actor, detail) {
  await run('INSERT INTO model_lifecycle_events (model_id, from_state, to_state, actor, detail, created_at) VALUES (?,?,?,?,?,?)',
    modelId, from, to, actor, String(detail || '').slice(0, 2000), now());
}

const catalogBase = (modelId) => catalog.models.find((m) => m.id === modelId)?.base_model || null;

function checkEvaluation(ev, sha, base) {
  if (!ev || ev.verification_passed !== true) throw new HttpError(400, 'evaluation_failed', 'An evaluation report with verification_passed=true is required');
  if (ev.smoke_test) throw new HttpError(400, 'smoke_adapter', 'Smoke-test adapters can never be verified as a model');
  if (ev.safety_passed !== true) throw new HttpError(400, 'safety_failed', 'The adapter did not pass safety evaluation');
  const REQUIRED = ['files_exist', 'hashes_match', 'weights_nonempty', 'adapter_trained', 'adapter_loads', 'generation_works', 'malformed_input_handled'];
  const missing = REQUIRED.filter((k) => ev.checks?.[k] !== true);
  if (missing.length) throw new HttpError(400, 'verification_incomplete', `Evaluation checks not passed: ${missing.join(', ')}`);
  if (ev.adapter_model_safetensors?.sha256 !== sha) throw new HttpError(400, 'sha256_mismatch', 'The evaluated adapter SHA-256 differs from the registered artifact');
  if (ev.base_model && ev.base_model !== base) throw new HttpError(400, 'base_model_mismatch', 'The evaluated base model differs from the registered artifact');
}

/**
 * Move a model through its lifecycle (superadmin or a GPU worker). `body`: { to, version?, artifact?: { uri, sha256,
 * base_model, base_revision }, evaluation?, reason? }. DEPLOYING immediately runs verifyDeployment().
 */
export async function transition(modelId, body, actor, { verify } = {}) {
  const cur = await one('SELECT * FROM model_lifecycle WHERE model_id = ?', modelId);
  if (!cur) throw new HttpError(404, 'not_lifecycle_managed', 'This model has no lifecycle (no training configuration)');
  const to = String(body?.to || '');
  if (to === 'ACTIVE') throw new HttpError(400, 'activation_requires_verification', 'Models become ACTIVE only through deployment verification (move to DEPLOYING)');
  if (!STATES.includes(to)) throw new HttpError(400, 'invalid_state', `to must be one of ${STATES.join(', ')}`);
  if (!(NEXT[cur.state] || []).includes(to)) throw new HttpError(409, 'invalid_transition', `${cur.state} → ${to} is not allowed`);
  const patch = {};
  // Register the trained artifact: on TRAINING_COMPLETE, or when an already-trained, pinned model deploys from REGISTERED.
  if (to === 'TRAINING_COMPLETE' || (to === 'DEPLOYING' && cur.state === 'REGISTERED' && body.artifact)) {
    const a = body.artifact || {};
    const version = String(body.version || '');
    if (!VERSION_RE.test(version)) throw new HttpError(400, 'invalid_version', 'version must look like 1.0.0');
    const sha = String(a.sha256 || '').toLowerCase();
    if (!SHA_RE.test(sha)) throw new HttpError(400, 'invalid_sha256', 'artifact.sha256 must be the 64-hex SHA-256 of adapter_model.safetensors');
    const uri = String(a.uri || '');
    if (!/^(gs|s3|https|hf|registry):\/\/\S{3,500}$/.test(uri)) throw new HttpError(400, 'invalid_artifact_uri', 'artifact.uri must point to persistent storage (gs://, s3://, https://, hf://, registry://)');
    const base = catalogBase(modelId);
    if (a.base_model !== base) throw new HttpError(400, 'base_model_mismatch', `${modelId} must use base ${base}`);
    if (!/^[A-Za-z0-9._-]{7,80}$/.test(String(a.base_revision || ''))) throw new HttpError(400, 'base_revision_required', 'artifact.base_revision (exact base model revision) is required');
    const pin = pinnedSha(modelId);
    if (pin && pin !== sha) throw new HttpError(400, 'sha256_not_pinned', `${modelId} is pinned to a different adapter SHA-256`);
    Object.assign(patch, { version, adapter_sha256: sha, artifact_uri: uri, base_model: base, base_revision: a.base_revision });
  }
  if (to === 'VERIFIED') checkEvaluation(body.evaluation, cur.adapter_sha256, cur.base_model);
  if (to === 'DEPLOYING' && !(patch.version || cur.version) ) throw new HttpError(409, 'artifact_required', 'Register a trained artifact (version + SHA-256) before deploying');
  if (to === 'DEPLOYING' && cur.state === 'REGISTERED' && !pinnedSha(modelId)) {
    throw new HttpError(409, 'verification_required', 'Only a pinned, already-trained adapter may deploy directly from REGISTERED; otherwise evaluate it first');
  }
  const detail = String(body.reason || body.detail || '').slice(0, 1000);
  await tx(async () => {
    await run(`UPDATE model_lifecycle SET state = ?, version = COALESCE(?, version), adapter_sha256 = COALESCE(?, adapter_sha256),
      artifact_uri = COALESCE(?, artifact_uri), base_model = COALESCE(?, base_model), base_revision = COALESCE(?, base_revision),
      failed_stage = ?, detail = ?, updated_at = ? WHERE model_id = ?`,
    to, patch.version ?? null, patch.adapter_sha256 ?? null, patch.artifact_uri ?? null, patch.base_model ?? null, patch.base_revision ?? null,
    to === 'FAILED' ? String(body.failed_stage || cur.state).slice(0, 40) : null, detail, now(), modelId);
    await record(modelId, cur.state, to, actor, detail);
  });
  invalidateLifecycleCache();
  if (to === 'DEPLOYING' && verify) return verify(modelId, actor);
  return lifecycleView(await one('SELECT * FROM model_lifecycle WHERE model_id = ?', modelId));
}

/**
 * Real deployment check against the inference server (health + exact version/SHA + production release + generation).
 * `upstream` = { url (…/v1), key }. Success → ACTIVE; failure → FAILED(stage) and an error with the reason.
 */
export async function verifyDeployment(modelId, actor, upstream, { timeoutMs = 45_000 } = {}) {
  const cur = await one('SELECT * FROM model_lifecycle WHERE model_id = ?', modelId);
  if (!cur) throw new HttpError(404, 'not_lifecycle_managed', 'This model has no lifecycle');
  if (!['DEPLOYING', 'ACTIVE'].includes(cur.state)) throw new HttpError(409, 'not_deploying', `Model is ${cur.state}; move it to DEPLOYING first`);
  const fail = async (stage, why) => {
    await tx(async () => {
      await run("UPDATE model_lifecycle SET state = 'FAILED', failed_stage = ?, detail = ?, updated_at = ? WHERE model_id = ?", stage, why, now(), modelId);
      await record(modelId, cur.state, 'FAILED', actor, `${stage}: ${why}`);
    });
    invalidateLifecycleCache();
    await audit(null, actor, 'model.activation_failed', modelId, null, { stage, why });
    throw new HttpError(409, 'deployment_verification_failed', `${modelId} was not activated — ${stage}: ${why}`, { stage });
  };
  if (!upstream) return fail('inference_endpoint', 'no inference server is configured for this model family');
  const headers = upstream.key ? { Authorization: `Bearer ${upstream.key}` } : {};
  const base = upstream.url.replace(/\/v1$/, '');
  let health;
  try {
    const r = await fetch(`${base}/health`, { headers, signal: AbortSignal.timeout(10_000) });
    if (!r.ok) return fail('health', `inference server answered HTTP ${r.status}`);
    health = await r.json();
  } catch (e) { return fail('health', `inference server unreachable (${e.name})`); }
  const d = health?.details?.[modelId];
  if (!d) return fail('health', 'the inference server is not serving this model');
  if (d.version !== cur.version) return fail('version', `server serves ${d.version}, registered ${cur.version}`);
  if (String(d.adapter_sha256 || '').toLowerCase() !== cur.adapter_sha256) return fail('sha256', 'the loaded adapter SHA-256 differs from the registered artifact');
  const pin = pinnedSha(modelId);
  if (pin && pin !== cur.adapter_sha256) return fail('sha256', 'the registered adapter does not match the pinned SHA-256');
  if (d.smoke_test || d.production_ready !== true) return fail('release', 'the served release is not production-ready');
  const started = Date.now();
  let text = '';
  try {
    const r = await fetch(`${upstream.url}/chat/completions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, signal: AbortSignal.timeout(timeoutMs),
      body: JSON.stringify({ model: `${modelId}@${cur.version}`, stream: false, max_tokens: 24, temperature: 0,
        messages: [{ role: 'user', content: 'Reply with one short sentence confirming you are ready.' }] }),
    });
    if (!r.ok) return fail('generation', `generation returned HTTP ${r.status}`);
    const j = await r.json();
    text = String(j?.choices?.[0]?.message?.content || '').trim();
  } catch (e) { return fail('generation', `generation failed (${e.name})`); }
  if (!text) return fail('generation', 'generation returned no text');
  const latency = Date.now() - started;
  await tx(async () => {
    await run("UPDATE model_lifecycle SET state = 'ACTIVE', failed_stage = NULL, verified_at = ?, detail = ?, updated_at = ? WHERE model_id = ?",
      now(), `verified: ${cur.version}, sha256 ${cur.adapter_sha256.slice(0, 12)}…, generation ${latency} ms`, now(), modelId);
    await record(modelId, cur.state, 'ACTIVE', actor, `health+sha256+generation verified (${latency} ms)`);
  });
  invalidateLifecycleCache();
  await audit(null, actor, 'model.activated', modelId, null, { version: cur.version, sha256: cur.adapter_sha256, latency_ms: latency });
  return { ...lifecycleView(await one('SELECT * FROM model_lifecycle WHERE model_id = ?', modelId)), generation_sample: text.slice(0, 200), latency_ms: latency };
}

/** Initial lifecycle rows (idempotent): models with a training configuration. Nick 4.8 is trained (pinned adapter). */
export async function seedLifecycle(c) {
  const t = Date.now();
  const stmts = catalog.models.filter((m) => m.training_config).map((m) => {
    const trained = m.id === 'nick-4.8';
    return { sql: `INSERT INTO model_lifecycle (model_id, state, base_model, adapter_sha256, detail, updated_at) VALUES (?,?,?,?,?,?)
      ON CONFLICT(model_id) DO NOTHING`,
    args: [m.id, trained ? 'REGISTERED' : 'TRAINING_REQUIRED', m.base_model || null, trained ? pinnedSha(m.id) : null,
      trained ? 'Trained adapter exists (owner-pinned SHA-256). Register its artifact location + base revision, then deploy.' : 'Not trained yet.', t] };
  });
  if (stmts.length) await c.batch(stmts, 'write');
}
