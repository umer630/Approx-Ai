// Platform routes: health + status, model registry (versions, activation, import), GPU compute control
// plane (jobs + workers) and the media capability layer (video / image / audio pipelines).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { one, all, run, now, audit, describeDbError } from '../db.js';
import { readJson, readBodyToFile, sendJson, bad, notFound, forbidden, newId, str, HttpError, clientIp } from '../http.js';
import { requireUser, requireRole, requireScope, requireVerified, requirePrivileged, rateLimit } from '../security.js';
import { modelsForUser, getModel, canUseModel, listModels } from '../models.js';
import { backendStatus, upstreamHealth } from '../providers/index.js';
import { catalog, catalogModel, catalogPipeline, modeList, DEFAULT_MODE, MODES } from '../catalog.js';
import * as registry from '../registry.js';
import { complete } from '../engine.js';
import { config, VERSIONS } from '../config.js';

const WORKER_ONLINE_MS = 120_000;
const LOG_TAIL_BYTES = 64 * 1024;
const JOB_ACTIVE = ['queued', 'running', 'stop_requested'];

const parse = (s, d) => { try { return JSON.parse(s); } catch { return d; } };
function jobView(j, { log = false } = {}) {
  return { id: j.id, kind: j.kind, models: parse(j.models, []), options: parse(j.options, {}), status: j.status, requested_by: j.requested_by,
    worker_id: j.worker_id, phase: j.phase, progress: parse(j.progress, {}), results: parse(j.results, {}),
    created_at: j.created_at, started_at: j.started_at, updated_at: j.updated_at, finished_at: j.finished_at,
    ...(log ? { log_tail: j.log_tail } : {}) };
}
function workerView(w) {
  return { id: w.id, name: w.name, gpu: parse(w.gpu, {}), runtime: parse(w.runtime, {}), current_job_id: w.current_job_id,
    last_seen_at: w.last_seen_at, online: now() - w.last_seen_at < WORKER_ONLINE_MS };
}

function pipelineStatus(p) {
  const url = process.env[p.env_url] || '';
  return { id: p.id, name: p.name, kind: p.kind, tasks: p.tasks, description: p.description,
    status: url ? 'connected' : 'not_connected',
    note: url ? null : `No ${p.name.toLowerCase()} runtime is connected (${p.env_url} is not set).` };
}

function trainableModels() { return catalog.models.filter((m) => m.training_config).map((m) => m.id); }

export function registerPlatformRoutes(r) {
  // ================= health / status =================
  // Public liveness: no secrets, no model details.
  const health = async (req, res) => {
    let db = 'ok';
    let dbError;
    let foreignKeys;
    try { await one('SELECT 1 AS x'); foreignKeys = (await one('PRAGMA foreign_keys'))?.foreign_keys === 1 ? 'on' : 'off'; } catch (e) {
      db = e.code === 'database_not_configured' ? 'not_configured' : 'error';
      if (db === 'error') { dbError = describeDbError(e); console.error('[health] database error:', e); }
    }
    sendJson(res, db === 'ok' ? 200 : 503, { status: db === 'ok' ? 'ok' : 'degraded', service: 'approx-ai-api', version: VERSIONS.backend, database: db,
      ...(dbError ? { database_error: dbError } : {}), ...(foreignKeys ? { foreign_keys: foreignKeys } : {}),
      build_id: config.buildId, runtime: config.serverless ? 'serverless' : 'server', registry_source: config.registry.source, file_storage: config.files.storage, time: new Date().toISOString() });
  };
  r.get('/api/health', health);
  r.get('/api/v1/health', health);

  // Authenticated status for the web app and the Android console.
  r.get('/api/status', async (req, res, ctx) => {
    const u = requireUser(ctx);
    const admin = ['admin', 'superadmin'].includes(u.role);
    const models = (await modelsForUser(u)).map((m) => ({ ...m, backend: backendStatus(m) }));
    const inference = {};
    for (const m of await listModels()) {
      if (inference[m.family]) continue;
      const h = await upstreamHealth(m);
      inference[m.family] = admin ? h : { configured: h.configured, reachable: h.reachable ?? false };
    }
    const body = {
      api: { status: 'ok', versions: VERSIONS, build_id: config.buildId, environment: config.env, time: new Date().toISOString() },
      inference, models, modes: modeList(), default_mode: DEFAULT_MODE,
      pipelines: catalog.pipelines.map(pipelineStatus),
    };
    if (admin) {
      const workers = (await all('SELECT * FROM gpu_workers ORDER BY last_seen_at DESC LIMIT 20')).map(workerView);
      const active = await one(`SELECT * FROM gpu_jobs WHERE status IN ('running','stop_requested','queued') ORDER BY created_at DESC LIMIT 1`);
      const last = await one(`SELECT * FROM gpu_jobs ORDER BY updated_at DESC LIMIT 1`);
      body.gpu = { workers_online: workers.filter((w) => w.online).length, workers,
        note: workers.length ? null : 'No GPU worker has connected. Training runs on a GPU worker (e.g. the Colab pipeline), never on the API server.' };
      body.training = { active_job: active ? jobView(active) : null, last_job: last ? jobView(last) : null };
    }
    sendJson(res, 200, body);
  });

  r.get('/api/capabilities', async (req, res, ctx) => {
    const u = requireUser(ctx);
    sendJson(res, 200, {
      models: (await modelsForUser(u)).map((m) => ({ id: m.id, name: m.name, kind: m.kind, available: m.available, capabilities: m.capabilities, modalities: m.modalities, pipelines: m.pipelines })),
      pipelines: catalog.pipelines.map(pipelineStatus),
      kinds: ['language_model', 'code_model', 'multimodal_model', 'video_pipeline'],
    });
  });

  // ================= public API: models + versions =================
  r.get('/api/v1/models/:id', async (req, res, ctx, p) => {
    const u = requireScope(ctx, 'models:read');
    const m = await getModel(p.id);
    if (!m) throw notFound(`Unknown model '${p.id}'`);
    if (!await canUseModel(u, m)) throw forbidden(`Your account does not have access to ${m.name}`, 'model_access_denied');
    const c = catalogModel(m.id) || {};
    const st = await registry.publicModelState(m.id);
    sendJson(res, 200, { id: m.id, object: 'model', name: m.name, tier: m.tier, kind: c.kind, capabilities: c.capabilities || [], modalities: c.modalities,
      owned_by: 'approx-technology', backend: backendStatus(m), active_version: st.active_version, release_status: st.release_status,
      production_ready: st.production_ready, versions: st.validated_versions, modes: MODES });
  });

  // In inference-registry mode (serverless) this backend has no persistent artifact store: release import and
  // activation happen on the GPU inference host, which verifies every artifact and enforces its SHA-256 pin.
  const requireLocalRegistry = () => {
    if (config.registry.source === 'inference') {
      throw new HttpError(409, 'registry_managed_by_inference_server',
        'This deployment reads the live model version from the inference server. Import and activate releases on the GPU inference host (node backend/src/cli.js models import|activate there).');
    }
  };
  // ================= admin: registry =================
  r.get('/api/admin/registry', async (req, res, ctx) => {
    requireRole(ctx, 'admin', 'superadmin');
    const o = await registry.registryOverview();
    if (config.registry.source === 'inference') {
      // The GPU inference server is the source of truth here (it verifies releases and enforces SHA-256 pins).
      // Report what it actually serves, in the same shape the admin console already renders.
      const models = await Promise.all(o.models.map(async (m) => {
        const model = (await getModel(m.id)) || { id: m.id, family: catalogModel(m.id).family };
        const h = await upstreamHealth(model);
        const served = h.reachable ? (h.serving?.[m.id] ?? null) : null;
        return { ...m, active_version: served, backend: backendStatus(model),
          active_problem: !h.configured ? null : !h.reachable ? 'inference server unreachable' : null,
          versions: served ? [{ version: served, status: 'served by inference server', production_ready: false, activatable: false, errors: [] }] : [] };
      }));
      return sendJson(res, 200, { ...o, dir: 'inference server (managed on the GPU host)', auto_activate: false, source: 'inference', models });
    }
    sendJson(res, 200, { ...o, source: config.registry.source, models: await Promise.all(o.models.map(async (m) => ({ ...m, backend: await backendStatus((await getModel(m.id)) || { id: m.id, family: catalogModel(m.id).family }) }))) });
  });
  r.post('/api/admin/registry/rescan', async (req, res, ctx) => {
    requireRole(ctx, 'admin', 'superadmin');
    requireLocalRegistry();
    await registry.scan({ force: true });
    sendJson(res, 200, { status: 'rescanned', registry: await registry.registryOverview() });
  });
  r.get('/api/admin/registry/:model/:version', async (req, res, ctx, p) => {
    requireRole(ctx, 'admin', 'superadmin');
    const d = await registry.releaseDetail(p.model, p.version);
    if (!d) throw notFound('Release not found');
    sendJson(res, 200, d);
  });
  r.post('/api/admin/registry/activate', async (req, res, ctx) => {
    const admin = requireRole(ctx, 'superadmin');
    requireLocalRegistry();
    await rateLimit(`registry-activate:${admin.id}`, 30, 3600_000);
    const b = await readJson(req);
    const out = await registry.activate(str(b.model_id, 'model_id', { max: 60 }), str(b.version, 'version', { max: 40 }),
      { actor: admin.id, allowNonProduction: b.allow_non_production === true, reason: str(b.reason, 'reason', { max: 300, required: false }) || '' });
    sendJson(res, 200, { status: 'activated', ...out });
  });
  r.post('/api/admin/registry/deactivate', async (req, res, ctx) => {
    const admin = requireRole(ctx, 'superadmin');
    requireLocalRegistry();
    const b = await readJson(req);
    const out = await registry.deactivate(str(b.model_id, 'model_id', { max: 60 }), { actor: admin.id, reason: str(b.reason, 'reason', { max: 300, required: false }) || '' });
    sendJson(res, 200, { status: 'deactivated', ...out });
  });
  // Upload a release archive (raw .tar.gz body). Superadmin session, or an admin API key with scope registry:import
  // (used by the training pipeline). Importing never activates anything.
  r.post('/api/admin/registry/import', async (req, res, ctx) => {
    const actor = ctx.auth?.kind === 'api_key' ? requirePrivileged(ctx, 'registry:import') : requireRole(ctx, 'superadmin');
    requireLocalRegistry();
    await rateLimit(`registry-import:${actor.id}`, 20, 3600_000);
    const declared = String(req.headers['x-artifact-sha256'] || '').toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(declared)) throw bad('X-Artifact-Sha256 header (SHA-256 of the archive) is required', 'sha256_required');
    const tmpDir = path.join(config.dataDir, 'tmp');
    fs.mkdirSync(tmpDir, { recursive: true });
    const tmp = path.join(tmpDir, `upload-${crypto.randomBytes(8).toString('hex')}.tar.gz`);
    try {
      const up = await readBodyToFile(req, tmp, config.registry.maxArtifactBytes);
      if (!up.bytes) throw bad('Empty upload');
      if (up.sha256 !== declared) throw new HttpError(422, 'sha256_mismatch', 'Uploaded archive does not match X-Artifact-Sha256');
      const out = await registry.importArchive(tmp, { actor: actor.id, source: ctx.auth.kind === 'api_key' ? 'training-pipeline' : 'admin-upload' });
      const { dir: _d, ...release } = out.release || {};
      sendJson(res, out.status === 'imported' ? 201 : 200, { status: out.status, model_id: out.model_id, version: out.version, release,
        active_version: (await registry.getActive(out.model_id))?.version ?? null,
        next: release.activatable ? 'A superadmin can now activate this version (POST /api/admin/registry/activate).' : 'This release cannot be activated.' });
    } finally { fs.rmSync(tmp, { force: true }); }
  });

  // ================= admin: compute control plane =================
  r.get('/api/admin/compute', async (req, res, ctx) => {
    requireRole(ctx, 'admin', 'superadmin');
    sendJson(res, 200, {
      workers: (await all('SELECT * FROM gpu_workers ORDER BY last_seen_at DESC LIMIT 50')).map(workerView),
      jobs: (await all('SELECT * FROM gpu_jobs ORDER BY created_at DESC LIMIT 50')).map((j) => jobView(j)),
      trainable_models: trainableModels(),
      note: 'Jobs are executed by GPU workers (run_all_training.py --worker on a GPU runtime). A queued job waits until a worker claims it.',
    });
  });
  r.post('/api/admin/compute/jobs', async (req, res, ctx) => {
    const admin = requireRole(ctx, 'superadmin');
    await rateLimit(`compute-job:${admin.id}`, 30, 3600_000);
    const b = await readJson(req);
    const allowed = trainableModels();
    const models = b.models === 'all' || b.models === undefined ? allowed : b.models;
    if (!Array.isArray(models) || !models.length || models.some((m) => !allowed.includes(m))) throw bad(`models must be "all" or a list from: ${allowed.join(', ')}`);
    const options = {};
    for (const k of ['max_hours', 'max_steps']) {
      if (b[k] !== undefined) { const n = Number(b[k]); if (!Number.isFinite(n) || n < 0 || n > 100000) throw bad(`${k} must be a non-negative number`); options[k] = n; }
    }
    if ((await one(`SELECT COUNT(*) c FROM gpu_jobs WHERE status IN ('queued','running','stop_requested')`)).c >= 5) throw new HttpError(409, 'too_many_jobs', 'There are already 5 active jobs');
    const id = newId('job_');
    await run('INSERT INTO gpu_jobs (id, kind, models, options, status, requested_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)',
      id, 'training', JSON.stringify([...new Set(models)]), JSON.stringify(options), 'queued', admin.id, now(), now());
    await audit(null, admin.id, 'compute.job_created', id, clientIp(req), { models, options });
    const online = (await all('SELECT last_seen_at FROM gpu_workers')).filter((w) => now() - w.last_seen_at < WORKER_ONLINE_MS).length;
    sendJson(res, 201, { job: jobView(await one('SELECT * FROM gpu_jobs WHERE id = ?', id)),
      workers_online: online, note: online ? 'A worker will claim this job shortly.' : 'No GPU worker is online: the job stays queued until one connects.' });
  });
  r.get('/api/admin/compute/jobs/:id', async (req, res, ctx, p) => {
    requireRole(ctx, 'admin', 'superadmin');
    const j = await one('SELECT * FROM gpu_jobs WHERE id = ?', p.id);
    if (!j) throw notFound('Job not found');
    sendJson(res, 200, { job: jobView(j, { log: true }) });
  });
  r.post('/api/admin/compute/jobs/:id/stop', async (req, res, ctx, p) => {
    const admin = requireRole(ctx, 'superadmin');
    const j = await one('SELECT * FROM gpu_jobs WHERE id = ?', p.id);
    if (!j) throw notFound('Job not found');
    if (!JOB_ACTIVE.includes(j.status)) throw new HttpError(409, 'job_not_active', `Job is already ${j.status}`);
    const next = j.status === 'queued' ? 'stopped' : 'stop_requested';
    await run('UPDATE gpu_jobs SET status = ?, updated_at = ?, finished_at = ? WHERE id = ?', next, now(), next === 'stopped' ? now() : null, j.id);
    await audit(null, admin.id, 'compute.job_stop_requested', j.id, clientIp(req));
    sendJson(res, 200, { job: jobView(await one('SELECT * FROM gpu_jobs WHERE id = ?', j.id)) });
  });

  // ----- worker API (admin API key with scope training:worker) -----
  async function touchWorker(ctx, b) {
    const w = b.worker || {};
    const id = str(w.id, 'worker.id', { min: 4, max: 80 });
    if (!/^[A-Za-z0-9._:-]+$/.test(id)) throw bad('worker.id has invalid characters');
    const gpu = JSON.stringify(w.gpu && typeof w.gpu === 'object' ? w.gpu : {}).slice(0, 4000);
    const runtime = JSON.stringify(w.runtime && typeof w.runtime === 'object' ? w.runtime : {}).slice(0, 4000);
    await run(`INSERT INTO gpu_workers (id, name, api_key_id, gpu, runtime, first_seen_at, last_seen_at) VALUES (?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, api_key_id = excluded.api_key_id, gpu = excluded.gpu, runtime = excluded.runtime, last_seen_at = excluded.last_seen_at`,
    id, String(w.name || '').slice(0, 80), ctx.auth.apiKey?.id ?? null, gpu, runtime, now(), now());
    return id;
  }
  // Heartbeat + claim: returns the oldest queued job (now running, bound to this worker) or null.
  r.post('/api/v1/worker/claim', async (req, res, ctx) => {
    requirePrivileged(ctx, 'training:worker');
    const b = await readJson(req);
    const workerId = await touchWorker(ctx, b);
    let job = null;
    if (b.claim !== false) {
      const q = await one(`SELECT * FROM gpu_jobs WHERE status = 'queued' ORDER BY created_at LIMIT 1`);
      if (q && (await run(`UPDATE gpu_jobs SET status = 'running', worker_id = ?, started_at = ?, updated_at = ? WHERE id = ? AND status = 'queued'`, workerId, now(), now(), q.id)).changes) {
        await run('UPDATE gpu_workers SET current_job_id = ? WHERE id = ?', q.id, workerId);
        job = jobView(await one('SELECT * FROM gpu_jobs WHERE id = ?', q.id));
      }
    }
    sendJson(res, 200, { worker_id: workerId, job });
  });
  // A run started by hand on the GPU machine registers itself so it shows up in the dashboard.
  r.post('/api/v1/worker/jobs', async (req, res, ctx) => {
    const u = requirePrivileged(ctx, 'training:worker');
    const b = await readJson(req);
    const workerId = await touchWorker(ctx, b);
    const allowed = trainableModels();
    if (!Array.isArray(b.models) || !b.models.length || b.models.some((m) => !allowed.includes(m))) throw bad(`models must be a list from: ${allowed.join(', ')}`);
    const id = newId('job_');
    await run('INSERT INTO gpu_jobs (id, kind, models, options, status, requested_by, worker_id, created_at, started_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
      id, 'training', JSON.stringify(b.models), JSON.stringify({ self_started: true }), 'running', u.id, workerId, now(), now(), now());
    await run('UPDATE gpu_workers SET current_job_id = ? WHERE id = ?', id, workerId);
    await audit(null, u.id, 'compute.job_self_started', id, clientIp(req), { models: b.models, worker: workerId });
    sendJson(res, 201, { job: jobView(await one('SELECT * FROM gpu_jobs WHERE id = ?', id)) });
  });
  r.post('/api/v1/worker/jobs/:id/report', async (req, res, ctx, p) => {
    requirePrivileged(ctx, 'training:worker');
    const b = await readJson(req, 512 * 1024);
    const workerId = await touchWorker(ctx, b);
    const j = await one('SELECT * FROM gpu_jobs WHERE id = ?', p.id);
    if (!j) throw notFound('Job not found');
    if (j.worker_id && j.worker_id !== workerId) throw forbidden('This job belongs to another worker', 'wrong_worker');
    if (!['running', 'stop_requested'].includes(j.status)) return sendJson(res, 409, { error: { code: 'job_not_active', message: `Job is ${j.status}` }, stop_requested: true });
    const sets = ['updated_at = ?']; const args = [now()];
    if (b.phase !== undefined) { sets.push('phase = ?'); args.push(String(b.phase).slice(0, 120)); }
    if (b.progress && typeof b.progress === 'object') { sets.push('progress = ?'); args.push(JSON.stringify(b.progress).slice(0, 60_000)); }
    if (b.results && typeof b.results === 'object') { sets.push('results = ?'); args.push(JSON.stringify(b.results).slice(0, 200_000)); }
    if (typeof b.log_append === 'string' && b.log_append) { sets.push('log_tail = ?'); args.push((j.log_tail + b.log_append).slice(-LOG_TAIL_BYTES)); }
    let final = null;
    if (b.status !== undefined) {
      if (!['succeeded', 'failed', 'stopped', 'blocked'].includes(b.status)) throw bad('status must be succeeded, failed, stopped or blocked');
      final = b.status;
      sets.push('status = ?', 'finished_at = ?'); args.push(final, now());
      await run('UPDATE gpu_workers SET current_job_id = NULL WHERE id = ?', workerId);
    }
    await run(`UPDATE gpu_jobs SET ${sets.join(', ')} WHERE id = ?`, ...args, j.id);
    if (final) await audit(null, `worker:${workerId}`, 'compute.job_finished', j.id, clientIp(req), { status: final });
    sendJson(res, 200, { status: final || j.status, stop_requested: !final && j.status === 'stop_requested' });
  });

  // ================= media capability layer =================
  // Interface contract for external pipelines (docs/CAPABILITIES.md): POST <url>/v1/<task> with a JSON body, bearer key,
  // JSON response. Nothing here generates media by itself — without a connected pipeline the answer is 501.
  async function callPipeline(pipelineId, task, payload, ctx) {
    const p = catalogPipeline(pipelineId);
    const url = (process.env[p.env_url] || '').replace(/\/$/, '');
    if (!url) throw new HttpError(501, 'capability_unavailable', `${p.name} is not available: no ${p.kind.replace('_', ' ')} runtime is connected to this server (${p.env_url}).`, { pipeline: p.id, kind: p.kind });
    let r;
    try {
      r = await fetch(`${url}/v1/${task}`, { method: 'POST', signal: AbortSignal.timeout(120_000),
        headers: { 'Content-Type': 'application/json', 'X-Request-Id': ctx.requestId, ...(process.env[p.env_key] ? { Authorization: `Bearer ${process.env[p.env_key]}` } : {}) },
        body: JSON.stringify(payload) });
    } catch { throw new HttpError(502, 'pipeline_error', `Could not reach the ${p.name.toLowerCase()} pipeline`); }
    const body = await r.json().catch(() => null);
    if (!r.ok || !body) throw new HttpError(502, 'pipeline_error', `${p.name} pipeline returned HTTP ${r.status}`);
    return { pipeline: p.id, kind: p.kind, task, result: body };
  }
  async function mediaModel(ctx, modelId, pipelineId) {
    const u = requireScope(ctx, 'chat');
    requireVerified(u);
    await rateLimit(`media:${u.id}`, 20, 600_000);
    const m = await getModel(modelId || 'fab-500x');
    if (!m) throw bad('Unknown model', 'unknown_model');
    if (!await canUseModel(u, m)) throw forbidden(`Your account does not have access to ${m.name}`, 'model_access_denied');
    if (pipelineId && !(catalogModel(m.id)?.pipelines || []).includes(pipelineId)) throw bad(`${m.name} does not include the ${pipelineId} pipeline`, 'capability_not_supported');
    return { u, m };
  }
  r.post('/api/v1/media/video/generations', async (req, res, ctx) => {
    const b = await readJson(req);
    const { m } = await mediaModel(ctx, b.model, "video-generation");
    const task = b.image_file_id ? 'image-to-video' : 'text-to-video';
    const payload = { prompt: str(b.prompt, 'prompt', { min: 3, max: 4000 }), duration_s: Math.min(60, Math.max(1, Number(b.duration_s) || 5)),
      aspect_ratio: ['16:9', '9:16', '1:1'].includes(b.aspect_ratio) ? b.aspect_ratio : '16:9', storyboard: b.storyboard ?? null };
    if (b.image_file_id) {
      const f = await one("SELECT id, kind FROM files WHERE id = ? AND user_id = ? AND scan_status = 'clean'", String(b.image_file_id), ctx.auth.user.id);
      if (!f || f.kind !== 'image') throw bad('image_file_id must be one of your uploaded images', 'attachment_not_found');
      payload.image_file_id = f.id;
    }
    sendJson(res, 202, { model: m.id, ...(await callPipeline('video-generation', task, payload, ctx)) });
  });
  r.post('/api/v1/media/video/understanding', async (req, res, ctx) => {
    const b = await readJson(req);
    const { m } = await mediaModel(ctx, b.model, "video-understanding");
    sendJson(res, 200, { model: m.id, ...(await callPipeline('video-understanding', 'video-understanding', { question: str(b.question, 'question', { min: 3, max: 2000 }), video_url: str(b.video_url, 'video_url', { max: 2000 }) }, ctx)) });
  });
  // Storyboard / scene / shot planning is TEXT planning done by the language model — it does not render video.
  r.post('/api/v1/media/storyboard', async (req, res, ctx) => {
    const b = await readJson(req);
    const { u, m } = await mediaModel(ctx, b.model, null);
    if (!(catalogModel(m.id)?.capabilities || []).includes('media_planning')) throw bad(`${m.name} does not offer media planning`, 'capability_not_supported');
    const brief = str(b.brief, 'brief', { min: 5, max: 4000 });
    const scenes = Math.min(12, Math.max(1, Number(b.scenes) || 4));
    let text = '';
    const out = await complete({ user: u, chat: null, text: brief, requestedModel: m.id, requestedMode: b.mode || 'high', source: 'media', requestId: ctx.requestId,
      history: [], skipMemoryCapture: true, onDelta: (d) => { text += d; },
      systemExtra: `STORYBOARD_JSON_PROTOCOL. Plan a video as ${scenes} scene(s). Respond with ONLY a JSON object: ` +
        '{"title": string, "scenes": [{"scene": number, "summary": string, "duration_s": number, "shots": [{"shot": number, "description": string, "camera": string}]}]}. ' +
        'This is a written plan only; you cannot render video.' });
    if (out.refused) return sendJson(res, 200, { refused: true, message: out.text });
    let plan;
    try {
      plan = JSON.parse((out.text || text).match(/\{[\s\S]*\}/)?.[0] ?? '');
      if (!plan || !Array.isArray(plan.scenes)) throw new Error();
    } catch { throw new HttpError(502, 'planner_bad_output', 'The model did not return a valid storyboard. Try again or rephrase.'); }
    sendJson(res, 200, { model: m.id, model_version: out.route.version, kind: 'storyboard_plan', storyboard: plan,
      video_generation: pipelineStatus(catalogPipeline('video-generation')) });
  });
}
