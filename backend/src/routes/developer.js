// Approx AI API platform (spec §26–27): key management for the dashboard + public /api/v1.
import { one, all, run, now, audit } from '../db.js';
import { readJson, sendJson, bad, notFound, forbidden, newId, str, startSse, HttpError, clientIp } from '../http.js';
import { requireUser, requireVerified, requireScope, randomToken, sha256, rateLimit, PRIVILEGED_SCOPES } from '../security.js';
import { backendStatus } from '../providers/index.js';
import { complete } from '../engine.js';
import { modelsForUser, MODES } from '../models.js';
import { usageSummary } from '../quota.js';
import { VERSIONS } from '../config.js';

const SCOPES = ['chat', 'models:read', 'usage:read'];
const scopesFor = (u) => (['admin', 'superadmin'].includes(u.role) ? [...SCOPES, ...PRIVILEGED_SCOPES] : SCOPES);

function keyView(k) {
  return { id: k.id, name: k.name, prefix: k.prefix, scopes: JSON.parse(k.scopes), created_at: k.created_at, last_used_at: k.last_used_at, revoked_at: k.revoked_at, rotated_from: k.rotated_from };
}
async function mintKey(userId, name, scopes, rotatedFrom = null) {
  const secret = 'apx_' + randomToken(32);
  const id = newId('key_');
  await run('INSERT INTO api_keys (id,user_id,name,prefix,key_hash,scopes,created_at,rotated_from) VALUES (?,?,?,?,?,?,?,?)',
    id, userId, name, secret.slice(0, 12), sha256(secret), JSON.stringify(scopes), now(), rotatedFrom);
  return { id, secret };
}

async function logApi(ctx, { endpoint, model, version, mode, status, t0 }) {
  if (ctx.auth?.kind !== 'api_key') return;
  await run('INSERT INTO api_requests (id,user_id,api_key_id,endpoint,model_id,model_version,mode,status,latency_ms,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
    ctx.requestId, ctx.auth.user.id, ctx.auth.apiKey.id, endpoint, model || null, version || null, mode || null, status, now() - t0, now());
}

export function registerDeveloperRoutes(r) {
  // ----- dashboard (session auth) -----
  r.get('/api/developer/keys', async (req, res, ctx) => {
    const u = requireUser(ctx);
    sendJson(res, 200, { keys: (await all('SELECT * FROM api_keys WHERE user_id = ? ORDER BY created_at DESC', u.id)).map(keyView), available_scopes: scopesFor(u) });
  });
  r.post('/api/developer/keys', async (req, res, ctx) => {
    const u = requireUser(ctx);
    requireVerified(u);
    await rateLimit(`keys:${u.id}`, 20, 3600_000);
    const b = await readJson(req);
    const scopes = Array.isArray(b.scopes) && b.scopes.length ? b.scopes : ['chat', 'models:read'];
    if (scopes.some((s) => !scopesFor(u).includes(s))) throw bad(`scopes must be from: ${scopesFor(u).join(', ')}`);
    if ((await one('SELECT COUNT(*) c FROM api_keys WHERE user_id = ? AND revoked_at IS NULL', u.id)).c >= 10) throw bad('Active key limit (10) reached');
    const k = await mintKey(u.id, str(b.name, 'name', { min: 1, max: 60 }), [...new Set(scopes)]);
    await audit(u.id, u.id, 'api_key.created', k.id, clientIp(req));
    sendJson(res, 201, { key: keyView(await one('SELECT * FROM api_keys WHERE id = ?', k.id)), secret: k.secret, warning: 'Store this secret now. It will not be shown again.' });
  });
  r.post('/api/developer/keys/:id/rotate', async (req, res, ctx, p) => {
    const u = requireUser(ctx);
    const old = await one('SELECT * FROM api_keys WHERE id = ? AND user_id = ? AND revoked_at IS NULL', p.id, u.id);
    if (!old) throw notFound('Key not found');
    const k = await mintKey(u.id, old.name, JSON.parse(old.scopes), old.id);
    await run('UPDATE api_keys SET revoked_at = ? WHERE id = ?', now(), old.id);
    await audit(u.id, u.id, 'api_key.rotated', old.id, clientIp(req), { new: k.id });
    sendJson(res, 201, { key: keyView(await one('SELECT * FROM api_keys WHERE id = ?', k.id)), secret: k.secret });
  });
  r.delete('/api/developer/keys/:id', async (req, res, ctx, p) => {
    const u = requireUser(ctx);
    if (!(await run('UPDATE api_keys SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL', now(), p.id, u.id)).changes) throw notFound('Key not found');
    await audit(u.id, u.id, 'api_key.revoked', p.id, clientIp(req));
    sendJson(res, 200, { status: 'revoked' });
  });
  r.get('/api/developer/requests', async (req, res, ctx) => {
    const u = requireUser(ctx);
    sendJson(res, 200, { requests: (await all('SELECT r.*, k.name key_name FROM api_requests r LEFT JOIN api_keys k ON k.id = r.api_key_id WHERE r.user_id = ? ORDER BY r.created_at DESC LIMIT 200', u.id)).map((x) => ({ ...x, user_id: undefined })) });
  });
  r.get('/api/developer/overview', async (req, res, ctx) => {
    const u = requireUser(ctx);
    const day = now() - 86400_000;
    sendJson(res, 200, {
      versions: VERSIONS,
      usage: await usageSummary(u),
      active_keys: (await one('SELECT COUNT(*) c FROM api_keys WHERE user_id = ? AND revoked_at IS NULL', u.id)).c,
      requests_24h: (await one('SELECT COUNT(*) c FROM api_requests WHERE user_id = ? AND created_at > ?', u.id, day)).c,
      errors_24h: (await one('SELECT COUNT(*) c FROM api_requests WHERE user_id = ? AND created_at > ? AND status >= 400', u.id, day)).c,
    });
  });

  // ----- public API v1 (API key or session bearer) -----
  r.get('/api/v1/models', async (req, res, ctx) => {
    const u = requireScope(ctx, 'models:read');
    sendJson(res, 200, { object: 'list', data: (await modelsForUser(u)).filter((m) => m.available).map((m) => ({ id: m.id, object: 'model', name: m.name, tier: m.tier, kind: m.kind, owned_by: 'approx-technology',
      backend: backendStatus(m), active_version: m.active_version, production_ready: m.production_ready, versions: m.validated_versions })), modes: MODES });
  });

  r.get('/api/v1/usage', async (req, res, ctx) => sendJson(res, 200, await usageSummary(requireScope(ctx, 'usage:read'))));

  /**
   * POST /api/v1/chat/completions
   * { model: "nick-4.8"|"auto"|…, version?: "1.0.0", mode: "low"|"medium"|"high", messages: [{role, content}], stream?: bool }
   * `version` is optional: omitted = the active registry version; only the active version is served.
   */
  r.post('/api/v1/chat/completions', async (req, res, ctx) => {
    const t0 = now();
    const u = requireScope(ctx, 'chat');
    if (!u.email_verified) throw forbidden('Verify your account email before using the API', 'email_not_verified');
    await rateLimit(`api-burst:${u.id}`, 60, 60_000);
    const b = await readJson(req, 1024 * 1024);
    if (!Array.isArray(b.messages) || !b.messages.length || b.messages.length > 200) throw bad('messages must be a non-empty array (max 200)');
    const msgs = b.messages.map((m) => {
      if (!m || !['user', 'assistant', 'system'].includes(m.role) || typeof m.content !== 'string') throw bad('each message needs role (user|assistant|system) and string content');
      return { role: m.role === 'system' ? 'user' : m.role, content: m.role === 'system' ? `[Developer instruction] ${m.content}` : m.content };
    });
    const last = msgs.pop();
    if (last.role !== 'user') throw bad('the last message must have role "user"');
    if (b.version !== undefined && (!b.model || b.model === 'auto')) throw bad('version requires an explicit model', 'version_requires_model');
    if (b.stream !== undefined && typeof b.stream !== 'boolean') throw bad('stream must be a boolean');
    let sse = null;
    let routeInfo = null;
    const created = Math.floor(t0 / 1000);
    try {
      const out = await complete({
        user: u, chat: null, text: last.content, requestedModel: b.model || 'auto', requestedMode: b.mode, requestedVersion: b.version, source: 'api', requestId: ctx.requestId,
        history: msgs, skipMemoryCapture: true,
        onRoute: (r) => { routeInfo = r; },
        onDelta: b.stream ? (d) => {
          if (!sse) sse = startSse(res);
          sse.send('chunk', { id: ctx.requestId, object: 'chat.completion.chunk', created, model: routeInfo.model.id, model_version: routeInfo.version, mode: routeInfo.mode, choices: [{ index: 0, delta: { content: d } }] });
        } : undefined,
      });
      await logApi(ctx, { endpoint: 'chat.completions', model: out.route.model.id, version: out.route.version, mode: out.route.mode, status: 200, t0 });
      const body = {
        id: ctx.requestId, object: 'chat.completion', created, model: out.route.model.id, model_version: out.route.version, mode: out.route.mode, route_reason: out.route.reason,
        choices: [{ index: 0, message: { role: 'assistant', content: out.text }, finish_reason: out.refused ? 'content_filter' : 'stop' }],
        usage: out.usage,
      };
      if (b.stream) { if (!sse) sse = startSse(res); sse.send('done', body); return sse.end(); }
      sendJson(res, 200, body);
    } catch (e) {
      await logApi(ctx, { endpoint: 'chat.completions', model: routeInfo?.model.id, version: routeInfo?.version, mode: routeInfo?.mode, status: e instanceof HttpError ? e.status : 500, t0 });
      if (sse) { sse.send('error', { code: e.code || 'internal_error', message: e instanceof HttpError ? e.message : 'Stream interrupted' }); return sse.end(); }
      throw e;
    }
  });
}
