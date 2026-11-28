// Lala 3.5 inference through Ollama.
//
//  * Gateway mode (production): Ollama runs on the owner's computer. The paired Approx device agent there polls the
//    backend over HTTPS (outbound only), runs the request against its local Ollama (127.0.0.1:11434) and posts the
//    streamed text back. The cloud never connects to the computer and the Ollama port is never exposed.
//  * Direct mode: APPROX_OLLAMA_URL=http://127.0.0.1:11434 when this backend runs on the same computer as Ollama.
//
// The model tag is never assumed: it must be one the Ollama instance itself reports (GET /api/tags).
import { one, all, run, now } from '../db.js';
import { HttpError, newId } from '../http.js';

const GATEWAY_FRESH_MS = 45_000;          // a gateway that has not checked in for this long is offline
const directUrl = () => (process.env.APPROX_OLLAMA_URL || '').replace(/\/+$/, '');
const timeoutMs = () => Number(process.env.APPROX_LALA_TIMEOUT_MS) || 50_000;   // < Vercel's 60 s function limit

export async function lalaConfig() {
  const row = await one("SELECT * FROM model_registry WHERE model_id = 'lala-3.5'");
  const device = row?.gateway_device_id ? await one('SELECT * FROM devices WHERE id = ?', row.gateway_device_id) : null;
  let report = null;
  try { report = device?.ollama_status ? JSON.parse(device.ollama_status) : null; } catch { report = null; }
  return { row, device, report, direct: directUrl(), model_tag: row?.model_tag || process.env.APPROX_LALA_MODEL_TAG || null };
}

async function directTags(url) {
  const r = await fetch(`${url}/api/tags`, { signal: AbortSignal.timeout(4000) });
  if (!r.ok) throw new Error(`Ollama /api/tags HTTP ${r.status}`);
  return ((await r.json()).models || []).map((m) => m.name);
}

let last = { at: 0, value: null };
/** Last health result (sync; null if never checked). */
export const lastLalaHealth = () => last.value;
/** Health with a short cache (default 10 s) — routing calls this on every request. */
export async function lalaHealthCached(maxAgeMs = 10_000) {
  if (last.value && Date.now() - last.at < maxAgeMs) return last.value;
  return lalaHealth();
}
export function resetLalaHealthCache() { last = { at: 0, value: null }; }

/** { ok, mode, detail, model_tag, tags, reachable, gateway_online } — honest, never cached as "ok" without evidence. */
export async function lalaHealth() {
  const c = await lalaConfig();
  let out;
  if (c.direct) {
    try {
      const tags = await directTags(c.direct);
      const installed = !!c.model_tag && tags.includes(c.model_tag);
      out = { ok: installed, mode: 'direct', reachable: true, tags, model_tag: c.model_tag,
        detail: !c.model_tag ? 'no Ollama model tag mapped to Lala 3.5' : installed ? `Ollama reachable, ${c.model_tag} installed` : `${c.model_tag} is not installed in Ollama` };
    } catch (e) { out = { ok: false, mode: 'direct', reachable: false, model_tag: c.model_tag, detail: `Ollama not reachable at ${c.direct}: ${e.message}` }; }
  } else if (!c.device) {
    out = { ok: false, mode: 'gateway', reachable: false, model_tag: c.model_tag, detail: 'no Ollama gateway device assigned (Admin → Models → Lala 3.5)' };
  } else {
    const online = c.device.status === 'connected' && c.device.last_seen_at && now() - c.device.last_seen_at < GATEWAY_FRESH_MS;
    const tags = (c.report?.tags || []).map((t) => t.name || t);
    const fresh = c.device.ollama_checked_at && now() - c.device.ollama_checked_at < GATEWAY_FRESH_MS;
    const installed = !!c.model_tag && tags.includes(c.model_tag);
    const detail = !online ? `gateway ${c.device.name} is offline (agent not running)`
      : !fresh || !c.report ? 'gateway has not reported Ollama status yet'
        : !c.report.reachable ? `Ollama is not running on ${c.device.name}${c.report.error ? `: ${c.report.error}` : ''}`
          : !c.model_tag ? 'no Ollama model tag mapped to Lala 3.5'
            : !installed ? `${c.model_tag} is not installed on ${c.device.name}` : `Ollama ${c.report.version || ''} on ${c.device.name}, ${c.model_tag} installed`.replace('  ', ' ');
    out = { ok: online && fresh && !!c.report?.reachable && installed, mode: 'gateway', reachable: !!(online && c.report?.reachable), gateway_online: !!online,
      tags, model_tag: c.model_tag, loaded: c.report?.loaded || [], ollama_version: c.report?.version || null, device: c.device.name, detail };
  }
  // Lala health state from real evidence: reachable Ollama with the tag installed, plus the outcome of recent real
  // requests through the gateway (a reachable Ollama whose generations fail is NOT "ready").
  const recent = c.device ? await all("SELECT status FROM inference_jobs WHERE device_id = ? AND op = 'chat' AND status IN ('completed','failed','cancelled') ORDER BY created_at DESC LIMIT 5", c.device.id) : [];
  // READY needs evidence that a generation really came back through the gateway (the exact-reply check, or a completed
  // request since the last failure). Reachable + installed but never generated = LALA_REACHABLE_NOT_TESTED.
  const proven = !!(c.row?.verified_at && now() - c.row.verified_at < 24 * 3600_000) || recent.some((j) => j.status === 'completed');
  out.state = !out.ok ? 'LALA_UNAVAILABLE' : recent[0] && recent[0].status !== 'completed' ? 'LALA_INFERENCE_FAILED'
    : recent.some((j) => j.status !== 'completed') ? 'LALA_DEGRADED' : proven ? 'LALA_READY' : 'LALA_REACHABLE_NOT_TESTED';
  out.verified_by_real_inference = proven;
  out.verified_at = c.row?.verified_at || null;
  out.verified_detail = c.row?.verified_detail || null;
  // Training and inference availability are separate: Lala 3.5 is served as-is by Ollama (no Approx training).
  out.training = 'NOT_TRAINED';
  out.availability = { LALA_READY: 'Ready', LALA_REACHABLE_NOT_TESTED: 'Reachable — run the real test', LALA_DEGRADED: 'Degraded',
    LALA_INFERENCE_FAILED: 'Inference failed', LALA_UNAVAILABLE: out.gateway_online === false || !c.device ? 'Offline — connect device' : 'Offline' }[out.state];
  out.runtime = c.direct ? 'local (direct Ollama)' : 'local (Ollama via paired device agent)';
  if (c.row) await run('UPDATE model_registry SET health_status = ?, status = ?, last_health_check = ?, updated_at = ? WHERE model_id = ?',
    out.ok ? 'healthy' : 'unhealthy', out.ok ? 'available' : 'unavailable', now(), now(), 'lala-3.5');
  last = { at: Date.now(), value: out };
  return out;
}

/** Synchronous best-effort status for the model list (last recorded health). */
export async function lalaCachedOk() {
  const r = await one("SELECT health_status, last_health_check FROM model_registry WHERE model_id = 'lala-3.5'");
  return !!r && r.health_status === 'healthy' && now() - (r.last_health_check || 0) < 120_000;
}

/**
 * Run one Ollama operation. op: 'chat' (streams via onDelta) | 'load' | 'unload'.
 * Resolves { text, usage }. Throws HttpError 503 (unavailable) / 504 (timeout) / 502 (Ollama error).
 */
export async function ollamaRun({ op = 'chat', messages = [], params = {}, onDelta, signal }) {
  const c = await lalaConfig();
  if (!c.model_tag) throw new HttpError(503, 'model_backend_unavailable', 'Lala 3.5 has no Ollama model tag mapped yet (Admin → Models → Lala 3.5).');
  const options = { temperature: params.temperature, top_p: params.top_p, num_predict: params.max_tokens };
  if (c.direct) return directRun(c.direct, c.model_tag, op, messages, options, onDelta, signal);
  const h = await lalaHealth();
  if (!h.ok) throw new HttpError(503, 'model_backend_unavailable', `Lala 3.5 is unavailable: ${h.detail}.`);
  const id = newId('inf_');
  await run("INSERT INTO inference_jobs (id, device_id, model_tag, op, payload, status, created_at) VALUES (?,?,?,?,?,'queued',?)",
    id, c.device.id, c.model_tag, op, JSON.stringify({ messages, options }), now());
  const deadline = Date.now() + timeoutMs();
  let seen = 0;
  for (;;) {
    if (signal?.aborted) { await run("UPDATE inference_jobs SET status = 'cancelled' WHERE id = ? AND status IN ('queued','running')", id); throw new HttpError(499, 'cancelled', 'Request cancelled'); }
    const j = await one('SELECT status, text, error, usage, started_at FROM inference_jobs WHERE id = ?', id);
    if (j.text.length > seen) { onDelta?.(j.text.slice(seen)); seen = j.text.length; }
    if (j.status === 'completed') return { text: j.text, usage: j.usage ? JSON.parse(j.usage) : { prompt_tokens: 0, completion_tokens: 0 } };
    if (j.status === 'failed') throw new HttpError(502, 'model_backend_error', `Lala 3.5 (Ollama) failed: ${j.error || 'unknown error'}`);
    if (Date.now() > deadline) {
      await run("UPDATE inference_jobs SET status = 'cancelled', error = 'timeout' WHERE id = ? AND status IN ('queued','running')", id);
      throw new HttpError(504, 'model_backend_timeout', j.started_at ? 'Lala 3.5 did not finish in time.' : 'Lala 3.5 gateway did not pick up the request in time.');
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

async function directRun(url, tag, op, messages, options, onDelta, signal) {
  const sig = signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs())]) : AbortSignal.timeout(timeoutMs());
  let r;
  try {
    r = op === 'chat'
      ? await fetch(`${url}/api/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, signal: sig, body: JSON.stringify({ model: tag, messages, stream: true, options }) })
      : await fetch(`${url}/api/generate`, { method: 'POST', headers: { 'content-type': 'application/json' }, signal: sig, body: JSON.stringify({ model: tag, keep_alive: op === 'unload' ? 0 : '5m' }) });
  } catch (e) {
    throw new HttpError(e.name === 'TimeoutError' ? 504 : 503, e.name === 'TimeoutError' ? 'model_backend_timeout' : 'model_backend_unavailable', `Could not reach Ollama: ${e.message}`);
  }
  if (!r.ok) throw new HttpError(502, 'model_backend_error', `Ollama returned HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
  if (op !== 'chat') { await r.text(); return { text: '', usage: { prompt_tokens: 0, completion_tokens: 0 } }; }
  let text = ''; let buf = ''; let usage = null;
  const dec = new TextDecoder();
  for await (const chunk of r.body) {
    buf += dec.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line) continue;
      const j = JSON.parse(line);
      if (j.error) throw new HttpError(502, 'model_backend_error', `Ollama: ${j.error}`);
      const d = j.message?.content;
      if (d) { text += d; onDelta?.(d); }
      if (j.done) usage = { prompt_tokens: j.prompt_eval_count || 0, completion_tokens: j.eval_count || 0 };
    }
  }
  return { text, usage: usage || { prompt_tokens: 0, completion_tokens: 0 } };
}
