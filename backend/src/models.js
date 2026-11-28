// Model registry, access control, and the Master Router / Orchestrator (spec §7–15).
import { one, all, run, now } from './db.js';
import { forbidden, bad, HttpError } from './http.js';
import { MODES, DEFAULT_MODE, modeParams, catalogModel, catalog } from './catalog.js';
import { publicModelState } from './registry.js';
import { servingVersion, upstreamHealth, backendStatus, upstreamFor } from './providers/index.js';
import { config } from './config.js';
import { lifecycleOf, lifecycleView, gateServed } from './lifecycle.js';
import { effectiveDefault, lalaVisible, nickLive, LALA, NICK } from './transform.js';

/** Lala 3.5 when it is the temporary default (or covering for a degraded Nick 4.8) AND actually healthy, else null. */
async function lalaStandIn() {
  if (await effectiveDefault() !== LALA) return null;
  const m = await getModel(LALA);
  return m && m.available !== 0 && await servingVersion(m) ? m : null;
}

// Efficiency modes (low / medium / high) are a separate control from the model: they come from the
// catalog and change real inference parameters (token budget, temperature, context size, guidance).
export { MODES, DEFAULT_MODE, modeParams };

export async function listModels() { return await all('SELECT * FROM models WHERE enabled = 1 ORDER BY rowid'); }
export async function getModel(id) { return await one('SELECT * FROM models WHERE id = ? AND enabled = 1', id); }

/** Private (admin-granted) models: catalog access 'admin-granted' or an administrator set visibility to private. */
export const isPrivateModel = (model) => model?.visibility === 'private' || catalogModel(model?.id)?.access === 'admin-granted';

/** Server-side access decision. The router may never widen this. */
export async function canUseModel(user, model) {
  if (!model) return false;
  const grant = await one('SELECT * FROM model_access WHERE user_id = ? AND model_id = ? AND (expires_at IS NULL OR expires_at > ?)', user.id, model.id, now());
  // An administrator's explicit restriction wins over plan, tier and role.
  if (grant && grant.access === 'deny') return false;
  // Private models (FAB 500X): ONLY an explicit, unexpired, administrator-issued grant — no role, plan or tier bypass,
  // not even for administrators themselves (they grant themselves through the audited admin API like anyone else).
  if (isPrivateModel(model)) return !!grant && grant.access === 'grant';
  if (user.role === 'superadmin') return true;
  switch (model.tier) {
    case 'default': case 'advanced': return true;
    case 'premium': return user.plan !== 'free' || user.role === 'admin' || !!grant;
    case 'restricted': return !!grant; // FAB: explicit grant only (deny rows returned false above)
    default: return false;
  }
}

// Lifecycle state → public model status. ACTIVE only becomes "online" when the serving backend confirms it.
const LIFECYCLE_STATUS = { TRAINING_REQUIRED: 'configured', REGISTERED: 'trained', TRAINING: 'training', TRAINING_COMPLETE: 'trained',
  EVALUATING: 'trained', VERIFIED: 'packaged', DEPLOYING: 'deploying', ACTIVE: 'offline', FAILED: 'failed' };
export const MODEL_STATUSES = ['configured', 'training', 'trained', 'packaged', 'deploying', 'online', 'offline', 'failed'];

/**
 * { status, reason, simulator? } — status is one of MODEL_STATUSES. "online" requires live evidence: the managed
 * inference server serving the lifecycle-verified version, a local registry activation, or a reachable configured
 * upstream. A catalog entry alone is never online. The development simulator reports online with simulator: true.
 */
export async function modelStatus(m) {
  if (m.available === 0) return { status: 'offline', reason: 'disabled by an administrator' };
  const up = upstreamFor(m);
  if (up && (up.managed ? config.registry.source === 'inference' : true)) await upstreamHealth(m);
  if (up && up.managed && config.registry.source === 'inference') await servingVersion(m).catch(() => null);
  const bs = backendStatus(m);
  if (bs === 'dev-simulator') return { status: 'online', reason: 'development simulator (not a trained model)', simulator: true };
  if (bs === 'active') return { status: 'online', reason: 'serving a verified release' };
  if (bs === 'configured') {
    const hh = await upstreamHealth(m);
    return hh.reachable ? { status: 'online', reason: 'configured upstream is reachable' } : { status: 'offline', reason: 'configured upstream is unreachable' };
  }
  const lc = await lifecycleOf(m.id);
  const st = LIFECYCLE_STATUS[lc?.state] || 'configured';
  const reason = bs === 'unavailable' && up ? 'inference server unreachable' : !up ? 'no inference server configured' : 'no verified version is being served';
  return { status: st, reason: lc?.state === 'FAILED' ? (lc.detail || 'failed') : reason };
}

export async function modelsForUser(user) {
  const out = await Promise.all((await listModels()).map(async (m) => {
    const c = catalogModel(m.id) || {};
    const available = await canUseModel(user, m);
    if (isPrivateModel(m) && !available) return null;   // private models are invisible without a grant
    if (m.id === LALA && !(await lalaVisible()) && user.role !== 'superadmin') return null;   // kept only as internal fallback
    const st = await modelStatus(m);
    return {
      id: m.id, name: m.name, family: m.family, tier: m.tier, description: m.description,
      role: c.role || null, access: c.access || null, private: isPrivateModel(m), workspace: c.workspace || null,
      kind: c.kind || 'language_model', capabilities: c.capabilities || [], modalities: c.modalities || { input: ['text'], output: ['text'] },
      languages: c.languages || [], pipelines: c.pipelines || [],
      available, status: st.status, status_reason: st.reason, simulator: !!st.simulator,
      selectable: available && st.status === 'online',
      // Normal model picker: Nick 4.8 only once it is live (verified + not in fallback); until then Lala 3.5 answers for it.
      in_selector: m.id === NICK ? await nickLive() : true,
      history_training: !!m.history_training_allowed,
      ...(await modelState(m)),
    };
  }));
  return out.filter(Boolean);
}

/** Record a failed model request (admin "failed requests" view). Never throws. */
export async function recordModelFailure(userId, modelId, err, source) {
  try {
    await run('INSERT INTO model_failures (user_id, model_id, code, status, source, created_at) VALUES (?,?,?,?,?,?)',
      userId || null, String(modelId).slice(0, 40), String(err?.code || err?.name || 'error').slice(0, 60), err?.status || null, source ? String(source).slice(0, 30) : null, now());
  } catch { /* never mask the original error */ }
}

// Live-version state for the model list. In inference-registry mode (serverless) the inference server is the
// source of truth: it reports which verified, SHA-pinned version it serves; nothing is assumed when unreachable.
async function modelState(m) {
  const lifecycle = lifecycleView(await lifecycleOf(m.id));
  if (config.registry.source !== 'inference') return { ...(await publicModelState(m.id)), lifecycle };
  const h = await upstreamHealth(m);
  const v = gateServed(m.id, h.reachable ? (h.serving?.[m.id] ?? null) : null);
  return {
    lifecycle,
    active_version: v, release_status: v ? 'served' : null, production_ready: false, activated_at: null,
    problem: h.configured && !h.reachable ? 'inference server unreachable' : null, validated_versions: v ? [v] : [],
    registry_source: 'inference',
  };
}

// ---------------- Safety policy ----------------
// Hard-blocked intents regardless of model (FAB is defensive-only per spec §11).
const BLOCKED = [
  /\b(write|create|build|make|develop|generate)\b.{0,40}\b(ransomware|keylogger|botnet|rootkit|credential[- ]?stealer|info[- ]?stealer|cryptojacker|worm)\b/i,
  /\b(steal|harvest|exfiltrate|dump)\b.{0,30}\b(passwords?|credentials?|cookies|session tokens?)\b.{0,40}\b(victim|someone|other people|users?)\b/i,
  /\b(phishing (kit|page|site)|clone .{0,20}login page)\b.{0,40}\b(collect|capture|steal)/i,
  /\b(ddos|dos attack)\b.{0,30}\b(launch|run|perform|against)\b/i,
  /\b(bypass|evade)\b.{0,30}\b(antivirus|edr|av detection)\b/i,
  /\b(synthes[iy]ze|make|build)\b.{0,30}\b(nerve agent|sarin|bioweapon|pipe bomb|explosive device)\b/i,
];
export function safetyCheck(text) {
  for (const re of BLOCKED) if (re.test(text)) {
    return { allowed: false, reason: 'This request falls under Approx AI\'s prohibited-use policy (harmful or unauthorized offensive capability). Defensive analysis, detection, hardening and authorized audits are supported.' };
  }
  return { allowed: true };
}

// ---------------- Task classification ----------------
const SIGNALS = {
  security: /\b(vulnerab|cve-|owasp|pentest|penetration test|xss|csrf|sql injection|ssrf|threat model|malware analysis|phishing|security audit|hardening|exploit|siem|ioc|yara|sast|dast)\w*/i,
  code: /```|\b(function|class|bug|stack ?trace|compile|refactor|python|javascript|typescript|kotlin|java|rust|golang|sql|api|regex|dockerfile|git)\b/i,
  math: /\b(prove|integral|derivative|equation|matrix|probability|theorem|calculate|solve)\b|[0-9]\s*[\^*/]\s*[0-9]/i,
  research: /\b(research|compare|literature|sources|citations?|survey|market analysis|report on)\b/i,
  creative: /\b(story|poem|storyboard|script|video|lyrics|creative|ghazal|nazm)\b/i,
  webdev: /\b(website|web app|frontend|backend|react|vue|next\.?js|node\.?js|express|html|css|tailwind|rest api|graphql|full[- ]?stack)\b/i,
  analytics: /\b(analytics|google analytics|ga4|conversion rate|funnel|bounce rate|kpi|dashboard metrics|seo audit|traffic analysis)\b/i,
  urdu: /[؀-ۿ]|\b(kya|hai|kaise|mujhe|aap|nahi|kyun|batao)\b/i,
};
const byRole = (role) => catalog.models.filter((m) => m.role === role).map((m) => m.id);
const DEEP = /\b(step[- ]by[- ]step|in depth|deep(ly)?|thorough|architecture|design a|trade-?offs?|multi-step|optimi[sz]e|analy[sz]e|strategy|plan)\b/i;

export function classify(text) {
  const types = Object.entries(SIGNALS).filter(([, re]) => re.test(text)).map(([k]) => k);
  let complexity = 0;
  complexity += Math.min(3, Math.floor(text.length / 600));
  if (DEEP.test(text)) complexity += 2;
  if (types.includes('math')) complexity += 1;
  if (types.includes('code') && text.length > 400) complexity += 1;
  if (types.includes('research')) complexity += 1;
  const primary = types.find((t) => t !== 'urdu') || 'general';
  return { types, primary, complexity, language: types.includes('urdu') ? 'ur/roman-ur' : 'auto' };
}

/**
 * Master Router. Inputs: user, requested model ('auto' or id), requested mode, text.
 * Returns the model+mode to use and a human-readable reason. Never bypasses access.
 */
export async function route(user, { requestedModel = 'auto', requestedMode, requestedVersion, text, defaultModel = 'nick-4.8' }) {
  const mode = requestedMode ?? DEFAULT_MODE;
  if (!MODES.includes(mode)) throw bad(`mode must be one of: ${MODES.join(', ')} (modes are not models)`);
  const task = classify(text);
  const safety = safetyCheck(text);

  if (requestedModel && requestedModel !== 'auto') {
    const m = await getModel(requestedModel);
    // A private model the caller may not use is reported exactly like a model that does not exist (no oracle).
    if (!m || (isPrivateModel(m) && !await canUseModel(user, m))) throw bad(`Unknown model '${requestedModel}'`, 'unknown_model');
    if (!await canUseModel(user, m)) throw forbidden(`Your account does not have access to ${m.name}`, 'model_access_denied');
    if (m.available === 0) throw new HttpError(503, 'model_disabled', `${m.name} is currently disabled by an administrator`);
    // Nick 4.8 not deployed yet (or degraded): the temporary default answers, and the reply says which model it was.
    if (m.id === NICK && !requestedVersion) {
      const lala = await lalaStandIn();
      if (lala && await canUseModel(user, lala)) return { model: lala, mode, version: await servingVersion(lala), task, safety, reason: 'temporary default: Nick 4.8 is not active yet — answered by Lala 3.5' };
    }
    return { model: m, mode, version: await servingVersion(m, requestedVersion), task, safety, reason: 'user-selected' };
  }

  // Automatic routing — choose the most suitable model the user is permitted to use.
  const want = [];
  // Role-based routing (catalog roles): web/security/analytics → Sona 9.0; complex → Hike 6.5; very advanced
  // security/architecture → FAB 100X (only if permitted); everyday → the user's default (Nick 4.8).
  if (task.types.includes('security') && task.complexity >= 3) want.push(...byRole('advanced-general'));
  if (task.types.some((t) => ['security', 'webdev', 'analytics'].includes(t))) want.push(...byRole('web-security-analytics'));
  if (task.complexity >= 2 || ['code', 'math'].includes(task.primary) && task.complexity >= 1) want.push(...byRole('complex'));
  const stand = await lalaStandIn();
  if (stand) want.push(stand.id);
  want.push(defaultModel, ...byRole('everyday'));
  // Pick the most suitable permitted model that can answer right now (an untrained / not-yet-active model is
  // skipped). If none can, return the first permitted one so the caller gets that model's honest "unavailable" error.
  let fallback = null;
  for (const id of [...new Set(want)]) {
    const m = await getModel(id);
    if (!m || m.available === 0 || isPrivateModel(m) || !await canUseModel(user, m)) continue;   // private models are never auto-routed
    const version = await servingVersion(m, requestedVersion);
    const reason = id === want[0] ? `auto: ${task.primary} task, complexity ${task.complexity}` : `auto: best available model for ${task.primary} task (complexity ${task.complexity})`;
    const pick = { model: m, mode, version, task, safety, reason };
    if (version || ['dev-simulator', 'configured'].includes(backendStatus(m))) return pick;
    fallback ||= pick;
  }
  if (fallback) return fallback;
  throw forbidden('No model available for this account', 'no_model');
}

export function identityPrompt(model, mode) {
  const base = `You are ${model.name}, an AI model in the Approx AI product by Approx Technology. ` +
    'You are helpful, accurate and concise. You understand and reply in English, Urdu (اردو) and Roman Urdu, matching the user\'s language. ' +
    'If you are unsure, say so. Never claim to have browsed the web unless sources are provided in the context. Use Markdown for structure and fenced code blocks for code.';
  const fab = model.family === 'fab'
    ? ' You are a restricted specialist model for defensive cybersecurity, application audits, advanced development and professional reporting. Only assist with authorized, defensive work; refuse to create malware, credential theft, or unauthorized exploitation tooling.'
    : '';
  return `${base}${fab}\nMode: ${mode.toUpperCase()}. ${modeParams(model.id, mode).guidance}`;
}
