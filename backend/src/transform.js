// Model transformation + emergency fallback (API 1.11).
//
// Lala 3.5 is the product's TEMPORARY default model. Its inference engine is Ollama on the owner's computer, reached
// through the authenticated Approx device agent (outbound HTTPS only: the Ollama port is never exposed), or directly via
// APPROX_OLLAMA_URL when the backend itself runs on that computer.
//
// State machine (one row in model_transform):
//   TEMPORARY_LALA_ACTIVE → TRAINING_IN_PROGRESS → TRAINING_COMPLETED → ADAPTER_VERIFICATION → INFERENCE_TEST
//   → PRODUCTION_DEPLOYMENT → NICK_4_8_ACTIVE → LALA_3_5_HIDDEN
// Every step past TRAINING_COMPLETED is gated on evidence (Nick's lifecycle row, the inference server, a real
// generation); a training process merely reporting "done" never activates Nick 4.8.
//
// Fallback: while Nick 4.8 is the default, consecutive provider failures mark it DEGRADED and — only if Lala 3.5's own
// health check passes — route ordinary traffic to Lala 3.5, record an incident and notify administrators. Recovery needs
// a cooldown AND consecutive successful checks, and switches are spaced by a minimum dwell time (no flapping).
import { one, all, run, now } from './db.js';
import { HttpError } from './http.js';
import { notify } from './notify.js';
import { lifecycleOf } from './lifecycle.js';

export const LALA = 'lala-3.5';
export const NICK = 'nick-4.8';
export const STATES = ['TEMPORARY_LALA_ACTIVE', 'TRAINING_IN_PROGRESS', 'TRAINING_COMPLETED', 'ADAPTER_VERIFICATION', 'INFERENCE_TEST',
  'PRODUCTION_DEPLOYMENT', 'NICK_4_8_ACTIVE', 'LALA_3_5_HIDDEN'];
const NICK_LIVE = new Set(['NICK_4_8_ACTIVE', 'LALA_3_5_HIDDEN']);

/** Recovery policy (env-configurable, read on every call so tests and operators can change it). */
export function policy() {
  const n = (k, d) => { const v = Number(process.env[k]); return Number.isFinite(v) && v >= 0 ? v : d; };
  return {
    failure_threshold: n('APPROX_FALLBACK_FAILURES', 3),        // consecutive Nick failures before degrading
    recovery_successes: n('APPROX_RECOVERY_SUCCESSES', 2),      // consecutive good checks before switching back
    recovery_cooldown_ms: n('APPROX_RECOVERY_COOLDOWN_MS', 5 * 60_000),  // no recovery check sooner than this after degrading
    min_dwell_ms: n('APPROX_SWITCH_MIN_DWELL_MS', 2 * 60_000),  // minimum time between two switches
  };
}

// ------------------------------------------------------------------ hooks (real implementations; tests may override)
// lalaHealth(): { ok, detail, model_tag? }   nickEvidence(): see below   nickInfer(): { ok, detail, version? }
export const hooks = {
  lalaHealth: async () => (await import('./providers/ollama.js')).lalaHealth(),
  nickLifecycle: async () => lifecycleOf(NICK),
  nickServing: async () => {
    const { servingVersion, upstreamHealth } = await import('./providers/index.js');
    const { getModel } = await import('./models.js');
    const m = await getModel(NICK);
    if (!m) return { reachable: false, version: null };
    const h = await upstreamHealth(m);
    return { reachable: !!h.reachable, version: await servingVersion(m).catch(() => null) };
  },
  nickInfer: async () => {
    const { streamCompletion, servingVersion } = await import('./providers/index.js');
    const { getModel } = await import('./models.js');
    const m = await getModel(NICK);
    const version = m ? await servingVersion(m).catch(() => null) : null;
    if (!version) return { ok: false, detail: 'no verified version is being served' };
    try {
      const out = await streamCompletion({ model: m, mode: 'low', version, messages: [{ role: 'user', content: 'Reply with the single word: ready' }] });
      return out.text.trim() ? { ok: true, version, detail: `generated ${out.text.trim().length} chars` } : { ok: false, detail: 'empty generation' };
    } catch (e) { return { ok: false, detail: e.message }; }
  },
};

// ------------------------------------------------------------------ state
export async function state() {
  let s = await one('SELECT * FROM model_transform WHERE id = 1');
  if (!s) {
    await run("INSERT OR IGNORE INTO model_transform (id, state, nick_health, updated_at) VALUES (1, 'TEMPORARY_LALA_ACTIVE', 'inactive', ?)", now());
    s = await one('SELECT * FROM model_transform WHERE id = 1');
  }
  return s;
}
async function setState(from, to, patch = {}, reason = '') {
  const cols = Object.keys(patch);
  // Atomic: only moves if nobody else moved it first (WHERE state = from).
  const r = await run(`UPDATE model_transform SET state = ?, ${cols.map((c) => `${c} = ?`).join(', ')}${cols.length ? ', ' : ''}gate_error = NULL, updated_at = ? WHERE id = 1 AND state = ?`,
    to, ...cols.map((c) => patch[c]), now(), from);
  if (r.changes) await run('INSERT INTO model_transform_log (from_state, to_state, reason, created_at) VALUES (?,?,?,?)', from, to, String(reason).slice(0, 500), now());
  return r.changes > 0;
}
const gateFail = async (msg) => { await run('UPDATE model_transform SET gate_error = ?, updated_at = ? WHERE id = 1', String(msg).slice(0, 500), now()); return msg; };

/** Model id that ordinary (auto-routed / default) traffic goes to right now. */
export async function effectiveDefault() {
  const s = await state();
  if (!NICK_LIVE.has(s.state)) return LALA;
  return s.fallback_active ? LALA : NICK;
}
/** Lala 3.5 appears in the normal model selector only until Nick 4.8 is live (and again while it covers for Nick). */
export async function lalaVisible() { const s = await state(); return !NICK_LIVE.has(s.state) || !!s.fallback_active; }

// ------------------------------------------------------------------ registry rows (server-side model registry)
export async function registryUpsert(modelId, patch) {
  const cur = await one('SELECT * FROM model_registry WHERE model_id = ?', modelId);
  if (!cur) {
    await run(`INSERT INTO model_registry (model_id, display_name, provider, model_tag, status, priority, activation_state, health_status, deployment_version,
      activated_at, last_health_check, fallback_enabled, gateway_device_id, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    modelId, patch.display_name || modelId, patch.provider || 'unknown', patch.model_tag ?? null, patch.status || 'configured', patch.priority ?? 100,
    patch.activation_state || 'inactive', patch.health_status || 'unknown', patch.deployment_version ?? null, patch.activated_at ?? null,
    patch.last_health_check ?? null, patch.fallback_enabled ? 1 : 0, patch.gateway_device_id ?? null, now());
    return;
  }
  const cols = Object.keys(patch);
  if (cols.length) await run(`UPDATE model_registry SET ${cols.map((c) => `${c} = ?`).join(', ')}, updated_at = ? WHERE model_id = ?`, ...cols.map((c) => patch[c]), now(), modelId);
}
export async function registry() { return await all('SELECT * FROM model_registry ORDER BY priority, model_id'); }

async function syncActivation() {
  const s = await state();
  const def = await effectiveDefault();
  await registryUpsert(LALA, { activation_state: def === LALA ? (NICK_LIVE.has(s.state) ? 'fallback_active' : 'active_default') : 'standby_hidden' });
  await registryUpsert(NICK, { activation_state: NICK_LIVE.has(s.state) ? (s.fallback_active ? 'degraded' : 'active_default') : 'not_deployed' });
}

// ------------------------------------------------------------------ advancing (evidence-gated)
/**
 * Moves the machine forward as far as the evidence allows (one call may advance several steps). Never moves backwards,
 * never skips a gate. Returns the resulting row. Safe to call often (health cron, admin view).
 */
export async function advance(actor = 'system') {
  for (let i = 0; i < STATES.length; i++) {
    const s = await state();
    const lc = await hooks.nickLifecycle();
    const ls = lc?.state || 'TRAINING_REQUIRED';
    let moved = false;
    switch (s.state) {
      case 'TEMPORARY_LALA_ACTIVE':
        if (ls === 'TRAINING') moved = await setState(s.state, 'TRAINING_IN_PROGRESS', {}, 'Nick 4.8 lifecycle reports TRAINING');
        else if (['TRAINING_COMPLETE', 'EVALUATING', 'VERIFIED', 'DEPLOYING', 'ACTIVE'].includes(ls)) moved = await setState(s.state, 'TRAINING_IN_PROGRESS', {}, `Nick 4.8 lifecycle already at ${ls}`);
        break;
      case 'TRAINING_IN_PROGRESS':
        // Training completion = a registered artifact (version + adapter SHA-256) in Nick's lifecycle, not a log line.
        if (['TRAINING_COMPLETE', 'EVALUATING', 'VERIFIED', 'DEPLOYING', 'ACTIVE'].includes(ls) && lc.version && lc.adapter_sha256) {
          moved = await setState(s.state, 'TRAINING_COMPLETED', {}, `artifact ${lc.version} sha256 ${lc.adapter_sha256.slice(0, 12)}…`);
        } else if (ls === 'FAILED') await gateFail(`Nick 4.8 training failed: ${lc.detail || lc.failed_stage || 'unknown'}`);
        break;
      case 'TRAINING_COMPLETED':
        // Adapter files + manifest + SHA-256 + evaluation are verified by the lifecycle's VERIFIED transition.
        if (['VERIFIED', 'DEPLOYING', 'ACTIVE'].includes(ls)) moved = await setState(s.state, 'ADAPTER_VERIFICATION', {}, 'adapter manifest, SHA-256 and evaluation verified');
        else await gateFail(`waiting for adapter verification (lifecycle ${ls})`);
        break;
      case 'ADAPTER_VERIFICATION': {
        const sv = await hooks.nickServing();
        if (!sv.reachable) { await gateFail('Nick 4.8 inference server unreachable (model load not confirmed)'); break; }
        if (!sv.version) { await gateFail('inference server does not serve a verified Nick 4.8 version yet'); break; }
        moved = await setState(s.state, 'INFERENCE_TEST', { nick_version: sv.version }, `model loaded: ${sv.version}`);
        break;
      }
      case 'INFERENCE_TEST': {
        const t = await hooks.nickInfer();
        if (!t.ok) { await gateFail(`real inference test failed: ${t.detail}`); break; }
        moved = await setState(s.state, 'PRODUCTION_DEPLOYMENT', {}, `real inference test passed (${t.detail})`);
        break;
      }
      case 'PRODUCTION_DEPLOYMENT': {
        const sv = await hooks.nickServing();
        const lala = await one('SELECT * FROM model_registry WHERE model_id = ?', LALA);
        const problems = [];
        if (ls !== 'ACTIVE') problems.push(`lifecycle is ${ls}, not ACTIVE (deployment verification not passed)`);
        if (!sv.reachable) problems.push('health endpoint failed');
        if (!sv.version) problems.push('no model version recorded');
        if (!lala || !lala.fallback_enabled) problems.push('rollback target (Lala 3.5 fallback configuration) missing');
        if (problems.length) { await gateFail(problems.join('; ')); break; }
        const t = now();
        moved = await setState(s.state, 'NICK_4_8_ACTIVE', { nick_version: sv.version, nick_activated_at: t, nick_health: 'healthy', last_switch_at: t },
          `Nick 4.8 ${sv.version} activated (all gates passed) by ${actor}`);
        if (moved) await registryUpsert(NICK, { status: 'active', deployment_version: sv.version, activated_at: t, health_status: 'healthy', last_health_check: t });
        break;
      }
      case 'NICK_4_8_ACTIVE':
        // Lala keeps its configuration (fallback_enabled, gateway, tag) — it is only removed from the normal selector.
        moved = await setState(s.state, 'LALA_3_5_HIDDEN', {}, 'Lala 3.5 hidden from the model selector; kept as emergency fallback');
        break;
      default: break;
    }
    if (!moved) break;
  }
  await syncActivation();
  return await state();
}

// ------------------------------------------------------------------ fallback + recovery
/** Called by the provider layer after every Nick 4.8 request. */
export async function reportNick(ok, err) {
  const s = await state();
  if (!NICK_LIVE.has(s.state)) return;
  if (ok) {
    await run('UPDATE model_transform SET consecutive_failures = 0 WHERE id = 1');
    return;
  }
  // Only provider-side failures count (unreachable / 5xx / timeout), never a user's bad request.
  if (err && err.status && err.status < 500) return;
  await run('UPDATE model_transform SET consecutive_failures = consecutive_failures + 1, consecutive_successes = 0 WHERE id = 1');
  const cur = await state();
  if (!cur.fallback_active && cur.consecutive_failures >= policy().failure_threshold) await degrade(`${cur.consecutive_failures} consecutive provider errors (last: ${err?.code || err?.message || 'error'})`);
}

async function degrade(reason) {
  const s = await state();
  const p = policy();
  await run("UPDATE model_transform SET nick_health = 'degraded', degraded_at = ?, updated_at = ? WHERE id = 1", now(), now());
  await registryUpsert(NICK, { health_status: 'degraded', status: 'degraded', last_health_check: now() });
  const lh = await hooks.lalaHealth();
  let action;
  if (s.last_switch_at && now() - s.last_switch_at < p.min_dwell_ms) action = 'switch_suppressed_dwell';
  else if (!lh.ok) action = 'no_fallback_lala_unhealthy';
  else {
    await run('UPDATE model_transform SET fallback_active = 1, last_switch_at = ?, consecutive_successes = 0 WHERE id = 1', now());
    action = 'fallback_to_lala';
  }
  await incident('nick_degraded', reason, action, lh.ok ? null : lh.detail);
  await syncActivation();
  return action;
}

/**
 * Health tick (cron / admin view / opportunistic): advances the machine, checks Nick while live, and switches back
 * after the cooldown once enough consecutive checks pass. Returns the state row.
 */
export async function healthTick() {
  const s0 = await advance();
  if (!NICK_LIVE.has(s0.state)) return s0;
  const p = policy();
  const sv = await hooks.nickServing();
  const healthy = sv.reachable && !!sv.version;
  await registryUpsert(NICK, { last_health_check: now(), health_status: healthy ? (s0.fallback_active ? 'recovering' : 'healthy') : 'unhealthy' });
  if (!s0.fallback_active) {
    if (!healthy) await reportNick(false, { status: 503, code: 'health_check_failed' });
    return await state();
  }
  if (s0.degraded_at && now() - s0.degraded_at < p.recovery_cooldown_ms) return s0;   // cooldown
  if (!healthy) { await run('UPDATE model_transform SET consecutive_successes = 0 WHERE id = 1'); return await state(); }
  const t = await hooks.nickInfer();       // recovery requires a real generation, not only a reachable health endpoint
  if (!t.ok) { await run('UPDATE model_transform SET consecutive_successes = 0 WHERE id = 1'); return await state(); }
  await run('UPDATE model_transform SET consecutive_successes = consecutive_successes + 1 WHERE id = 1');
  const s = await state();
  if (s.consecutive_successes >= p.recovery_successes && (!s.last_switch_at || now() - s.last_switch_at >= p.min_dwell_ms)) {
    await run("UPDATE model_transform SET fallback_active = 0, nick_health = 'healthy', consecutive_failures = 0, consecutive_successes = 0, last_switch_at = ?, degraded_at = NULL WHERE id = 1", now());
    await registryUpsert(NICK, { health_status: 'healthy', status: 'active' });
    await incident('nick_recovered', `${s.consecutive_successes} consecutive successful checks with real generation`, 'switch_back_to_nick');
    await syncActivation();
  }
  return await state();
}

async function incident(kind, reason, action, detail = null) {
  await run('INSERT INTO model_incidents (kind, reason, action, detail, created_at) VALUES (?,?,?,?,?)', kind, String(reason).slice(0, 500), action, detail ? String(detail).slice(0, 500) : null, now());
  const admins = await all("SELECT id FROM users WHERE role IN ('admin','superadmin') AND status = 'active'");
  const title = kind === 'nick_recovered' ? 'Nick 4.8 recovered' : action === 'fallback_to_lala' ? 'Nick 4.8 degraded — switched to Lala 3.5' : 'Nick 4.8 degraded — no fallback';
  for (const a of admins) await notify(a.id, { kind: 'system', title, body: `${reason}. Action: ${action}${detail ? ` (${detail})` : ''}.`, link: '#/admin' }).catch(() => {});
}

export async function overview() {
  const s = await state();
  return {
    state: s.state, states: STATES, gate_error: s.gate_error, effective_default: await effectiveDefault(), lala_visible: await lalaVisible(),
    nick: { version: s.nick_version, activated_at: s.nick_activated_at, health: s.nick_health, fallback_active: !!s.fallback_active,
      consecutive_failures: s.consecutive_failures, consecutive_successes: s.consecutive_successes, degraded_at: s.degraded_at, last_switch_at: s.last_switch_at },
    policy: policy(),
    registry: await registry(),
    incidents: await all('SELECT * FROM model_incidents ORDER BY id DESC LIMIT 20'),
    log: await all('SELECT * FROM model_transform_log ORDER BY id DESC LIMIT 20'),
  };
}

export function assertState(st) { if (!STATES.includes(st)) throw new HttpError(400, 'invalid_state', `state must be one of ${STATES.join(', ')}`); }
