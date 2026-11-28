// Admin: model router (Lala 3.5 temporary default, Nick 4.8 transformation, fallback, Ollama gateway diagnostics).
import { one, all, run, now, audit } from '../db.js';
import { readJson, sendJson, bad, notFound, clientIp, HttpError } from '../http.js';
import { requireRole } from '../security.js';
import { overview, advance, healthTick, registryUpsert, LALA } from '../transform.js';
import { lalaHealth, ollamaRun, lalaConfig, resetLalaHealthCache } from '../providers/ollama.js';
import { config } from '../config.js';

const TAG_RE = /^[A-Za-z0-9][A-Za-z0-9._\/-]{0,100}(:[A-Za-z0-9._-]{1,60})?$/;
let lastTick = 0;
/** Opportunistic health tick (at most once a minute) — recovery checks without a frequent cron. */
export async function maybeTick() {
  if (Date.now() - lastTick < 60_000) return;
  lastTick = Date.now();
  try { await healthTick(); } catch { /* never break the caller */ }
}

export function registerModelRouterRoutes(r) {
  r.get('/api/admin/model-router', async (req, res, ctx) => {
    requireRole(ctx, 'admin', 'superadmin');
    const lala = await lalaHealth();
    const c = await lalaConfig();
    // Gateway candidates: connected devices of administrators (the agent reports their Ollama status).
    const devices = await all(`SELECT d.id, d.name, d.hostname, d.platform, d.last_seen_at, d.ollama_status, d.ollama_checked_at, u.email owner
      FROM devices d JOIN users u ON u.id = d.user_id WHERE d.status = 'connected' AND u.role IN ('admin','superadmin') ORDER BY d.last_seen_at DESC`);
    sendJson(res, 200, {
      ...(await overview()),
      lala: { ...lala, direct_url_configured: !!c.direct, gateway_device_id: c.device?.id || null },
      gateways: devices.map((d) => ({ id: d.id, name: d.name, hostname: d.hostname, platform: d.platform, owner: d.owner,
        online: !!d.last_seen_at && now() - d.last_seen_at < 45_000, ollama: d.ollama_status ? JSON.parse(d.ollama_status) : null, ollama_checked_at: d.ollama_checked_at })),
      recent_jobs: await all('SELECT id, op, model_tag, status, error, length(text) chars, created_at, started_at, finished_at FROM inference_jobs ORDER BY created_at DESC LIMIT 10'),
    });
  });

  // Map Lala 3.5 to an installed Ollama tag on a gateway device (or direct mode). The tag must be one Ollama reports.
  r.post('/api/admin/model-router/lala', async (req, res, ctx) => {
    const admin = requireRole(ctx, 'superadmin', 'admin');
    const b = await readJson(req);
    const tag = String(b.model_tag || '').trim();
    if (!TAG_RE.test(tag)) throw bad('model_tag must be an Ollama tag such as llama3.2:3b');
    let deviceId = null;
    if (b.device_id) {
      const d = await one(`SELECT d.* FROM devices d JOIN users u ON u.id = d.user_id WHERE d.id = ? AND d.status = 'connected' AND u.role IN ('admin','superadmin')`, String(b.device_id));
      if (!d) throw notFound('Gateway device not found (it must be a connected device of an administrator)');
      const tags = d.ollama_status ? (JSON.parse(d.ollama_status).tags || []).map((x) => x.name) : [];
      if (!tags.includes(tag)) throw new HttpError(409, 'tag_not_installed', `${tag} is not installed on ${d.name} (installed: ${tags.join(', ') || 'none reported'})`);
      deviceId = d.id;
    } else if (!(process.env.APPROX_OLLAMA_URL)) throw bad('device_id is required (APPROX_OLLAMA_URL is not set on this server)');
    await registryUpsert(LALA, { model_tag: tag, gateway_device_id: deviceId, provider: 'ollama', fallback_enabled: 1 });
    resetLalaHealthCache();
    await audit(admin.id, admin.id, 'model.lala_mapped', LALA, clientIp(req), { model_tag: tag, device_id: deviceId });
    sendJson(res, 200, { status: 'mapped', health: await lalaHealth() });
  });

  // Real tests against Ollama: non-streaming chat, streaming chat (deltas counted), load and unload.
  r.post('/api/admin/model-router/lala/test', async (req, res, ctx) => {
    requireRole(ctx, 'admin', 'superadmin');
    const b = await readJson(req);
    const op = ['chat', 'stream', 'load', 'unload'].includes(b.op) ? b.op : 'chat';
    const t0 = Date.now();
    let deltas = 0;
    try {
      const out = await ollamaRun({ op: op === 'stream' ? 'chat' : op, messages: [{ role: 'user', content: String(b.prompt || 'Reply with one short sentence: what is 2+2?').slice(0, 500) }],
        params: { max_tokens: 64, temperature: 0.2 }, onDelta: op === 'stream' ? () => { deltas++; } : undefined });
      sendJson(res, 200, { ok: true, op, ms: Date.now() - t0, text: out.text.slice(0, 2000), deltas: op === 'stream' ? deltas : undefined, usage: out.usage });
    } catch (e) {
      sendJson(res, 200, { ok: false, op, ms: Date.now() - t0, error: { code: e.code || 'error', status: e.status || 500, message: e.message } });
    }
  });

  r.post('/api/admin/model-router/advance', async (req, res, ctx) => {
    const admin = requireRole(ctx, 'superadmin', 'admin');
    const s = await advance(admin.email || admin.id);
    sendJson(res, 200, { state: s.state, gate_error: s.gate_error });
  });
  r.post('/api/admin/model-router/health', async (req, res, ctx) => {
    requireRole(ctx, 'admin', 'superadmin');
    const s = await healthTick();
    sendJson(res, 200, { state: s.state, fallback_active: !!s.fallback_active, nick_health: s.nick_health });
  });
}

export { config };
