// Admin + superadmin: model access grants (FAB), plans, audit/security logs, training registry.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { one, all, run, now, audit } from '../db.js';
import { readJson, sendJson, bad, notFound, forbidden, newId, str, oneOf, clientIp } from '../http.js';
import { requireRole } from '../security.js';
import { getModel } from '../models.js';
import { config } from '../config.js';
import { scrubPii, qualityOk } from '../pii.js';

export function registerAdminRoutes(r) {
  r.get('/api/admin/users', async (req, res, ctx, p, url) => {
    requireRole(ctx, 'admin', 'superadmin');
    const q = `%${(url.searchParams.get('q') || '').slice(0, 100)}%`;
    sendJson(res, 200, { users: all("SELECT id, email, role, plan, email_verified, status, created_at FROM users WHERE email LIKE ? AND status != 'deleted' ORDER BY created_at DESC LIMIT 100", q)
      .map((u) => ({ ...u, grants: all('SELECT model_id, granted_by, reason, expires_at FROM model_access WHERE user_id = ?', u.id) })) });
  });

  r.patch('/api/admin/users/:id', async (req, res, ctx, p) => {
    const admin = requireRole(ctx, 'admin', 'superadmin');
    const target = one('SELECT * FROM users WHERE id = ?', p.id);
    if (!target) throw notFound('User not found');
    const b = await readJson(req);
    if (b.role !== undefined) {
      if (admin.role !== 'superadmin') throw forbidden('Only superadmin can change roles');
      run('UPDATE users SET role = ? WHERE id = ?', oneOf(b.role, 'role', ['user', 'admin', 'superadmin']), target.id);
    }
    if (b.plan !== undefined) run('UPDATE users SET plan = ? WHERE id = ?', oneOf(b.plan, 'plan', ['free', 'pro', 'enterprise']), target.id);
    if (b.status !== undefined) run('UPDATE users SET status = ? WHERE id = ?', oneOf(b.status, 'status', ['active', 'suspended']), target.id);
    audit(target.id, admin.id, 'admin.user_updated', target.id, clientIp(req), b);
    sendJson(res, 200, { status: 'updated' });
  });

  // FAB grants: superadmin only. Sona grants: admin or superadmin.
  r.post('/api/admin/model-access', async (req, res, ctx) => {
    const admin = requireRole(ctx, 'admin', 'superadmin');
    const b = await readJson(req);
    const target = one("SELECT * FROM users WHERE email = ? AND status = 'active'", String(b.email || '').toLowerCase());
    if (!target) throw notFound('User not found');
    const m = getModel(b.model_id);
    if (!m) throw bad('Unknown model');
    if (m.tier === 'restricted' && admin.role !== 'superadmin') throw forbidden('FAB access can only be granted by a superadmin', 'superadmin_required');
    const expires = b.expires_days ? now() + Number(b.expires_days) * 86400_000 : null;
    run('INSERT INTO model_access (user_id,model_id,granted_by,reason,created_at,expires_at) VALUES (?,?,?,?,?,?) ON CONFLICT(user_id,model_id) DO UPDATE SET granted_by=excluded.granted_by, reason=excluded.reason, expires_at=excluded.expires_at',
      target.id, m.id, admin.id, str(b.reason, 'reason', { min: 3, max: 300 }), now(), expires);
    audit(target.id, admin.id, 'admin.model_access_granted', m.id, clientIp(req), { reason: b.reason });
    run('INSERT INTO notifications (id,user_id,title,body,created_at) VALUES (?,?,?,?,?)', newId('ntf_'), target.id, `${m.name} access granted`, `You now have access to ${m.name}.`, now());
    sendJson(res, 200, { status: 'granted' });
  });
  r.delete('/api/admin/model-access/:userId/:modelId', async (req, res, ctx, p) => {
    const admin = requireRole(ctx, 'admin', 'superadmin');
    const m = getModel(p.modelId);
    if (m?.tier === 'restricted' && admin.role !== 'superadmin') throw forbidden('Superadmin required');
    run('DELETE FROM model_access WHERE user_id = ? AND model_id = ?', p.userId, p.modelId);
    audit(p.userId, admin.id, 'admin.model_access_revoked', p.modelId, clientIp(req));
    sendJson(res, 200, { status: 'revoked' });
  });

  r.get('/api/admin/audit', async (req, res, ctx) => {
    requireRole(ctx, 'admin', 'superadmin');
    sendJson(res, 200, { audit: all('SELECT * FROM audit_logs ORDER BY id DESC LIMIT 300'), security_events: all('SELECT * FROM security_events ORDER BY id DESC LIMIT 300') });
  });

  // ---------- training registry ----------
  r.get('/api/admin/training', async (req, res, ctx) => {
    requireRole(ctx, 'superadmin');
    sendJson(res, 200, {
      datasets: all('SELECT id, version, target_model, source, record_count, sha256, created_at FROM training_datasets ORDER BY created_at DESC'),
      jobs: all('SELECT * FROM training_jobs ORDER BY created_at DESC'),
      adapters: all('SELECT * FROM adapters ORDER BY created_at DESC'),
      model_versions: all('SELECT * FROM model_versions ORDER BY created_at DESC'),
    });
  });

  /**
   * Export consented history for Nick/Hike/Sona adaptation (spec §13 pipeline, server half):
   * consent → user-selected chats (training_eligible) → PII scrub → quality → dedupe → JSONL + manifest.
   * FAB chats are excluded at three levels: chats.is_fab CHECK, model flag, and this query.
   */
  r.post('/api/admin/training/export-consented', async (req, res, ctx) => {
    const admin = requireRole(ctx, 'superadmin');
    const b = await readJson(req);
    const target = oneOf(b.target_model, 'target_model', ['nick-4.8', 'hike-6.5', 'sona-9.0'], 'nick-4.8');
    const rows = all(`SELECT c.id chat_id, c.user_id FROM chats c
      JOIN settings s ON s.user_id = c.user_id
      JOIN models m ON m.id = c.model_id
      JOIN users u ON u.id = c.user_id
      WHERE c.training_eligible = 1 AND c.is_fab = 0 AND s.training_opt_in = 1 AND m.history_training_allowed = 1
        AND c.deleted_at IS NULL AND u.status = 'active'`);
    const seen = new Set();
    const records = [];
    const stats = { chats: rows.length, pairs: 0, pii_redactions: 0, dropped_quality: 0, dropped_duplicate: 0 };
    for (const c of rows) {
      const msgs = all("SELECT role, content FROM messages WHERE chat_id = ? AND user_id = ? AND status = 'complete' ORDER BY created_at", c.chat_id, c.user_id);
      for (let i = 0; i + 1 < msgs.length; i++) {
        if (msgs[i].role !== 'user' || msgs[i + 1].role !== 'assistant') continue;
        stats.pairs++;
        if (msgs[i + 1].content.includes('[Development simulator')) { stats.dropped_quality++; continue; }
        const u1 = scrubPii(msgs[i].content); const a1 = scrubPii(msgs[i + 1].content);
        stats.pii_redactions += u1.count + a1.count;
        if (!qualityOk(u1.text, a1.text)) { stats.dropped_quality++; continue; }
        const h = crypto.createHash('sha256').update(u1.text.toLowerCase().replace(/\s+/g, ' ') + '\u0000' + a1.text).digest('hex');
        if (seen.has(h)) { stats.dropped_duplicate++; continue; }
        seen.add(h);
        // No user ids are written to the dataset (pseudonymous contribution).
        records.push({ messages: [{ role: 'user', content: u1.text }, { role: 'assistant', content: a1.text }], meta: { source: 'consented_history', domain: 'mixed' } });
      }
    }
    const version = `${target}-history-${new Date().toISOString().slice(0, 10)}-${crypto.randomBytes(3).toString('hex')}`;
    const dir = path.join(config.dataDir, 'training', 'exports');
    fs.mkdirSync(dir, { recursive: true });
    const jsonl = records.map((x) => JSON.stringify(x)).join('\n') + (records.length ? '\n' : '');
    const sha = crypto.createHash('sha256').update(jsonl).digest('hex');
    fs.writeFileSync(path.join(dir, `${version}.jsonl`), jsonl, { mode: 0o600 });
    const manifest = { version, target_model: target, created_by: admin.id, created_at: new Date().toISOString(), stats, sha256: sha, pipeline: ['explicit_consent', 'user_selected', 'pii_filter', 'quality_filter', 'dedupe', 'fab_excluded'] };
    fs.writeFileSync(path.join(dir, `${version}.manifest.json`), JSON.stringify(manifest, null, 2), { mode: 0o600 });
    run('INSERT INTO training_datasets (id,version,target_model,source,record_count,sha256,manifest,created_at) VALUES (?,?,?,?,?,?,?,?)',
      newId('ds_'), version, target, 'consented_history', records.length, sha, JSON.stringify(manifest), now());
    audit(null, admin.id, 'training.dataset_exported', version, clientIp(req), stats);
    sendJson(res, 201, { dataset: manifest });
  });

  // Register an adapter produced by the training pipeline (training/ scripts emit these fields).
  r.post('/api/admin/training/adapters', async (req, res, ctx) => {
    const admin = requireRole(ctx, 'superadmin');
    const b = await readJson(req);
    const m = getModel(b.model_id);
    if (!m || m.family === 'fab') throw bad('Adapters can only be registered for Nick/Hike/Sona');
    if (!/^[a-f0-9]{64}$/.test(String(b.sha256))) throw bad('sha256 must be a 64-char hex digest');
    const ev = b.eval_report;
    if (!ev || ev.verification_passed !== true) throw bad('Adapter must include an eval_report (verification.json) with verification_passed=true');
    if (ev.smoke_test) throw bad('Smoke-test adapters can never be registered as a model', 'smoke_adapter');
    if (ev.safety_passed !== true) throw bad('Adapter failed safety verification', 'safety_failed');
    const REQUIRED = ['files_exist', 'hashes_match', 'weights_nonempty', 'adapter_trained', 'adapter_loads', 'generation_works', 'malformed_input_handled'];
    const missing = REQUIRED.filter((k) => ev.checks?.[k] !== true);
    if (missing.length) throw bad(`Verification checks not passed: ${missing.join(', ')}`, 'verification_incomplete');
    if (ev.adapter_model_safetensors?.sha256 !== b.sha256) throw bad('sha256 must equal verification.json adapter_model_safetensors.sha256', 'sha256_mismatch');
    if (m.id === 'nick-4.8' && b.base_model !== 'Qwen/Qwen2.5-3B-Instruct') throw bad('Nick 4.8 adapters must use base Qwen/Qwen2.5-3B-Instruct', 'wrong_base_model');
    if (ev.base_model !== b.base_model) throw bad('base_model does not match verification.json', 'base_model_mismatch');
    if (one('SELECT id FROM adapters WHERE sha256 = ?', b.sha256)) throw bad('This adapter is already registered', 'duplicate_adapter');
    const id = newId('adp_');
    run('INSERT INTO adapters (id,model_id,job_id,path,sha256,eval_report,safety_passed,created_at) VALUES (?,?,?,?,?,?,?,?)',
      id, m.id, null, str(b.path, 'path', { max: 500 }), b.sha256, JSON.stringify(b.eval_report), 1, now());
    run('INSERT INTO model_versions (id,model_id,version,base_model,adapter_id,status,created_at) VALUES (?,?,?,?,?,?,?)',
      newId('mv_'), m.id, str(b.version, 'version', { max: 40 }), str(b.base_model, 'base_model', { max: 200 }), id, 'candidate', now());
    audit(null, admin.id, 'training.adapter_registered', id, clientIp(req));
    sendJson(res, 201, { adapter_id: id });
  });
}
