// Inference providers. Each model family maps to an OpenAI-compatible chat-completions endpoint
// (e.g. vLLM / TGI serving Qwen2.5-3B-Instruct + the Nick LoRA adapter, or any compatible
// authorized hosted endpoint). Configured ONLY via environment variables:
//
//   APPROX_MODEL_<FAMILY>_URL   e.g. APPROX_MODEL_NICK_URL=http://inference:8000/v1
//   APPROX_MODEL_<FAMILY>_KEY   optional bearer key (server-side only — never shipped to clients)
//   APPROX_MODEL_<FAMILY>_NAME  upstream model name (e.g. nick-4.8-lora)
//   APPROX_MODEL_DEFAULT_*      fallback for families without their own config
//
// If nothing is configured the provider reports `unavailable` — it never fabricates answers.
// The dev simulator (APPROX_DEV_PROVIDER=1) exists only for local development and automated
// tests, and every reply it produces is explicitly labelled as simulated.
import { config } from '../config.js';
import { lifecycleOf, lifecycleCached, gateServed, LABELS } from '../lifecycle.js';
import { HttpError } from '../http.js';
import { modeParams } from '../catalog.js';
import { getActive, activeProblem, resolveServingVersion, VERSION_RE } from '../registry.js';

// "Managed" upstream = the Approx inference server, which serves ONLY registry-activated adapter versions
// and is addressed as <model-id>@<version>. Setting APPROX_MODEL_<FAMILY>_NAME marks the upstream as an
// external endpoint with its own model name (e.g. vLLM with a manually configured LoRA): unmanaged.
export function upstreamFor(model, version = null) {
  const F = model.family.toUpperCase();
  const e = process.env;
  const url = e[`APPROX_MODEL_${F}_URL`] || e.APPROX_MODEL_DEFAULT_URL;
  if (!url) return null;
  const explicit = e[`APPROX_MODEL_${F}_NAME`] || e.APPROX_MODEL_DEFAULT_NAME || '';
  return {
    url: url.replace(/\/$/, ''),
    key: e[`APPROX_MODEL_${F}_KEY`] || e.APPROX_MODEL_DEFAULT_KEY || '',
    name: explicit || (version ? `${model.id}@${version}` : model.id),
    managed: !explicit,
  };
}

/** unavailable | dev-simulator | configured (external upstream) | active | no_active_version */
export function backendStatus(model) {
  const up = upstreamFor(model);
  if (!up) return config.devProvider ? 'dev-simulator' : 'unavailable';
  if (!up.managed) return 'configured';
  if (config.registry.source === 'inference') {
    // Last known answer from the inference server (refreshed by upstreamHealth / servingVersion).
    const hit = healthCache.get(up.url)?.value;
    if (!hit) return lifecycleCached(model.id) && lifecycleCached(model.id).state !== 'ACTIVE' ? 'no_active_version' : 'configured';
    if (!hit.reachable) return 'unavailable';
    return gateServed(model.id, hit.serving?.[model.id] ?? null) ? 'active' : 'no_active_version';
  }
  return getActive(model.id) ? 'active' : 'no_active_version';
}

/**
 * The version that requests for this model are served with, or null.
 * local: this backend's registry (active.json). inference: what the managed inference server reports serving —
 * it only serves verified, validated releases and refuses adapters that fail its SHA-256 pin.
 */
export async function servingVersion(model, requested) {
  const up = upstreamFor(model);
  if (config.registry.source !== 'inference' || !up || !up.managed) return resolveServingVersion(model.id, requested);
  const h = await upstreamHealth(model);
  await lifecycleOf(model.id);
  // Only the lifecycle-verified ACTIVE version may serve (a model that is merely loaded on the GPU host is not enough).
  const active = gateServed(model.id, h.reachable ? (h.serving?.[model.id] ?? null) : null);
  if (requested === undefined || requested === null || requested === '') return active;
  if (typeof requested !== 'string' || !VERSION_RE.test(requested)) throw new HttpError(400, 'invalid_version', 'version must look like 1.0.0');
  if (active !== requested) {
    throw new HttpError(409, 'model_version_not_active', `${model.id}@${requested} is not the version the inference server is serving`, { active_version: active });
  }
  return requested;
}

export function providerStatus(family) {
  const m = { family, id: family };
  if (upstreamFor(m)) return 'configured';
  if (config.devProvider) return 'dev-simulator';
  return 'unavailable';
}

const healthCache = new Map();
/** Reachability of a model's inference upstream (GET <base>/health, cached 10 s). Never throws. */
export async function upstreamHealth(model) {
  const up = upstreamFor(model);
  if (!up) return { configured: false };
  const hit = healthCache.get(up.url);
  if (hit && Date.now() - hit.at < 10_000) return hit.value;
  let value;
  try {
    const r = await fetch(`${up.url.replace(/\/v1$/, '')}/health`, { signal: AbortSignal.timeout(2500), headers: up.key ? { Authorization: `Bearer ${up.key}` } : {} });
    const body = await r.json().catch(() => null);
    value = { configured: true, managed: up.managed, reachable: r.ok, status: body?.status ?? null, serving: body?.serving ?? null, gpu: body?.gpu ?? null };
  } catch (e) {
    value = { configured: true, managed: up.managed, reachable: false, error: e.name };
  }
  healthCache.set(up.url, { at: Date.now(), value });
  return value;
}

/**
 * Stream a completion. Calls onDelta(text) for each chunk; resolves to { text, usage }.
 * messages: [{role, content}]
 */
export async function streamCompletion({ model, mode, version = null, messages, onDelta, signal }) {
  const up = upstreamFor(model, version);
  const params = modeParams(model.id, mode);
  if (!up) {
    if (config.devProvider) return simulate({ model, mode, version, messages, onDelta });
    throw new HttpError(503, 'model_backend_unavailable',
      `${model.name} inference backend is not configured on this server. An operator must set APPROX_MODEL_${model.family.toUpperCase()}_URL.`);
  }
  if (up.managed && !version) {
    if (config.registry.source === 'inference') {
      const h = healthCache.get(up.url)?.value;
      const lc = lifecycleCached(model.id);
      throw new HttpError(503, 'model_version_not_active', h && !h.reachable
        ? `${model.name} is offline: its inference server is unreachable.`
        : lc && lc.state !== 'ACTIVE'
          ? `${model.name} is not available yet (${LABELS[lc.state] || lc.state}).`
          : `${model.name} is not being served: the inference server reports no verified version for it.`);
    }
    const problem = activeProblem(model.id);
    throw new HttpError(503, 'model_version_not_active', problem
      ? `${model.name} is offline: ${problem}.`
      : `${model.name} has no validated version activated yet. A superadmin must activate a verified release.`);
  }
  let r;
  try {
    r = await fetch(`${up.url}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(up.key ? { Authorization: `Bearer ${up.key}` } : {}) },
      body: JSON.stringify({ model: up.name, messages, stream: true, max_tokens: params.max_tokens, temperature: params.temperature,
        top_p: params.top_p, frequency_penalty: params.frequency_penalty }),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(180_000)]) : AbortSignal.timeout(180_000),
    });
  } catch (e) {
    throw new HttpError(502, 'model_backend_error', `Could not reach the ${model.name} backend`);
  }
  if (!r.ok || !r.body) throw new HttpError(502, 'model_backend_error', `${model.name} backend returned HTTP ${r.status}`);

  let text = '';
  let usage = null;
  const decoder = new TextDecoder();
  let buf = '';
  for await (const chunk of r.body) {
    buf += decoder.decode(chunk, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') continue;
      try {
        const j = JSON.parse(data);
        const d = j.choices?.[0]?.delta?.content;
        if (d) { text += d; onDelta?.(d); }
        if (j.usage) usage = j.usage;
      } catch { /* ignore keep-alives */ }
    }
  }
  return { text, usage: usage || { prompt_tokens: 0, completion_tokens: 0 } };
}

async function simulate({ model, mode, version, messages, onDelta }) {
  const last = [...messages].reverse().find((m) => m.role === 'user')?.content || '';
  if (messages[0]?.content.includes('STORYBOARD_JSON_PROTOCOL')) {
    const json = JSON.stringify({ title: '[Development simulator] Example storyboard — not generated by a real model.',
      scenes: [{ scene: 1, summary: last.slice(0, 120), duration_s: 5, shots: [{ shot: 1, description: 'Simulated wide establishing shot', camera: 'static' }] }] });
    onDelta?.(json);
    return { text: json, usage: { prompt_tokens: 0, completion_tokens: 0 } };
  }
  if (messages[0]?.content.includes('FABBOX_JSON_PROTOCOL')) {
    const json = JSON.stringify({ summary: '[Development simulator] Example proposal — not generated by a real model.', changes: [{ op: 'write', path: 'NOTES.md', content: `# Simulated agent note\n\nInstruction: ${last.slice(0, 200)}\n` }] });
    onDelta?.(json);
    return { text: json, usage: { prompt_tokens: 0, completion_tokens: 0 } };
  }
  const reply = `**[Development simulator — not a real model response]**\n\n` +
    `Model slot: ${model.name}${version ? ` (registry version ${version})` : ''} · Mode: ${mode} (max ${modeParams(model.id, mode).max_tokens} tokens)\n\n` +
    `The Approx AI pipeline (auth → quota → Master Router → context assembly → provider → streaming → history) ran successfully, ` +
    `but no inference backend is configured, so this text is generated by the simulator.\n\n` +
    `Your message (${last.length} chars) began with: "${last.slice(0, 80).replace(/\s+/g, ' ')}"`;
  const parts = reply.match(/.{1,24}/gs) || [];
  for (const p of parts) { onDelta?.(p); await new Promise((r) => setTimeout(r, 5)); }
  return { text: reply, usage: { prompt_tokens: Math.ceil(JSON.stringify(messages).length / 4), completion_tokens: Math.ceil(reply.length / 4) } };
}
