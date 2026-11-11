// Model registry, access control, and the Master Router / Orchestrator (spec §7–15).
import { one, all, now } from './db.js';
import { forbidden, bad } from './http.js';
import { MODES, DEFAULT_MODE, modeParams, catalogModel } from './catalog.js';
import { resolveServingVersion, publicModelState } from './registry.js';

// Efficiency modes (low / medium / high) are a separate control from the model: they come from the
// catalog and change real inference parameters (token budget, temperature, context size, guidance).
export { MODES, DEFAULT_MODE, modeParams };

export function listModels() { return all('SELECT * FROM models WHERE enabled = 1 ORDER BY rowid'); }
export function getModel(id) { return one('SELECT * FROM models WHERE id = ? AND enabled = 1', id); }

/** Server-side access decision. The router may never widen this. */
export function canUseModel(user, model) {
  if (!model) return false;
  if (user.role === 'superadmin') return true;
  const grant = one('SELECT * FROM model_access WHERE user_id = ? AND model_id = ? AND (expires_at IS NULL OR expires_at > ?)', user.id, model.id, now());
  switch (model.tier) {
    case 'default': case 'advanced': return true;
    case 'premium': return user.plan !== 'free' || user.role === 'admin' || !!grant;
    case 'restricted': return !!grant; // FAB: explicit grant only
    default: return false;
  }
}

export function modelsForUser(user) {
  return listModels().map((m) => {
    const c = catalogModel(m.id) || {};
    return {
      id: m.id, name: m.name, family: m.family, tier: m.tier, description: m.description,
      kind: c.kind || 'language_model', capabilities: c.capabilities || [], modalities: c.modalities || { input: ['text'], output: ['text'] },
      languages: c.languages || [], pipelines: c.pipelines || [],
      available: canUseModel(user, m),
      history_training: !!m.history_training_allowed,
      ...publicModelState(m.id),
    };
  });
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
  urdu: /[؀-ۿ]|\b(kya|hai|kaise|mujhe|aap|nahi|kyun|batao)\b/i,
};
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
export function route(user, { requestedModel = 'auto', requestedMode, requestedVersion, text, defaultModel = 'nick-4.8' }) {
  const mode = requestedMode ?? DEFAULT_MODE;
  if (!MODES.includes(mode)) throw bad(`mode must be one of: ${MODES.join(', ')} (modes are not models)`);
  const task = classify(text);
  const safety = safetyCheck(text);

  if (requestedModel && requestedModel !== 'auto') {
    const m = getModel(requestedModel);
    if (!m) throw bad(`Unknown model '${requestedModel}'`, 'unknown_model');
    if (!canUseModel(user, m)) throw forbidden(`Your account does not have access to ${m.name}`, 'model_access_denied');
    return { model: m, mode, version: resolveServingVersion(m.id, requestedVersion), task, safety, reason: 'user-selected' };
  }

  // Automatic routing — choose the most suitable model the user is permitted to use.
  const want = [];
  if (task.primary === 'security' && task.complexity >= 2) want.push('fab-100x');
  if (task.complexity >= 4) want.push('sona-9.0');
  if (task.complexity >= 2 || ['code', 'math'].includes(task.primary) && task.complexity >= 1) want.push('hike-6.5');
  want.push(defaultModel, 'nick-4.8');
  for (const id of want) {
    const m = getModel(id);
    if (m && canUseModel(user, m)) {
      const reason = id === want[0] ? `auto: ${task.primary} task, complexity ${task.complexity}` : `auto: best permitted model for ${task.primary} task (complexity ${task.complexity})`;
      return { model: m, mode, version: resolveServingVersion(m.id, requestedVersion), task, safety, reason };
    }
  }
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
