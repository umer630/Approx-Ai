// Approx Admin Panel API. Every route except /api/admin/auth/login requires an ADMIN SESSION (requireRole → ctx.admin),
// which the dispatcher resolves from the /api/admin-scoped cookie only. All privileged writes are audited with
// actor = "admin:<admin user id>". Nothing here returns passwords, password hashes, tokens or Supabase identifiers.
import { one, all, run, now, tx, audit, securityEvent } from '../db.js';
import { readJson, sendJson, bad, notFound, forbidden, HttpError, oneOf, str, clientIp } from '../http.js';
import { rateLimit, revokeSessions, burnPasswordCheck } from '../security.js';
import { requireRole } from '../security.js';
import { sb, SupabaseError, requireSupabase } from '../supabase.js';
import { getModel, listModels, canUseModel, modelStatus, isPrivateModel } from '../models.js';
import { upstreamHealth } from '../providers/index.js';
import { catalogModel } from '../catalog.js';
import { usageSummary } from '../quota.js';
import { lifecycleOf } from '../lifecycle.js';
import { config, VERSIONS } from '../config.js';
import { localUserFor, bootstrapSuperadmin, mfaGate } from './auth.js';
import { adminCookie, createAdminSession, isAllowlistedAdmin, adminEmails, CLIENT_STATUSES, platformSetting, setPlatformSetting } from '../admin.js';

const ADMIN = ['admin', 'superadmin'];
const DAY = 86_400_000;
const INVALID = () => new HttpError(401, 'invalid_admin_credentials', 'Invalid administrator credentials');
const actor = (a) => `admin:${a.id}`;
const startOfDay = (t = now()) => Math.floor(t / DAY) * DAY;
const startOfMonth = () => { const d = new Date(); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1); };

// Safe client projection (no hashes, tokens or provider ids).
async function clientRow(u) {
  const p = await one('SELECT display_name FROM profiles WHERE user_id = ?', u.id) || {};
  return { id: u.id, name: p.display_name || '', email: u.email, role: u.role, plan: u.plan, account_status: u.status,
    approval_status: u.approval_status || 'approved', email_verified: !!u.email_verified, created_at: u.created_at,
    last_login_at: u.last_login_at || null, country: u.country || null, requests: u.requests ?? undefined };
}

export function registerAdminPanelRoutes(r) {
  // ================= auth =================
  r.post('/api/admin/auth/login', async (req, res) => {
    const ip = clientIp(req);
    await rateLimit(`admin-login-ip:${ip}`, 10, 15 * 60_000);
    const b = await readJson(req);
    const email = String(b.email || '').toLowerCase().slice(0, 254);
    const password = typeof b.password === 'string' ? b.password.slice(0, 256) : '';
    await rateLimit(`admin-login-email:${email}`, 5, 15 * 60_000);
    if (!adminEmails().length) throw new HttpError(503, 'admin_not_configured', 'Administrator sign-in is not configured on this server.');
    const fail = async (why) => {
      const known = await one('SELECT id FROM users WHERE email = ?', email);
      await securityEvent(known?.id || null, 'admin_login_failed', 'high', ip, { reason: why });
      await audit(known?.id || null, 'anonymous', 'admin.login_failed', null, ip, { reason: why });
      throw INVALID();
    };
    if (!email || !password) return fail('missing');
    if (!isAllowlistedAdmin(email)) { await burnPasswordCheck(password); return fail('not_allowlisted'); }
    requireSupabase();
    let grant;
    try { grant = await sb.passwordGrant(email, password); } catch (e) {
      if (e instanceof SupabaseError && !['invalid_credentials', 'invalid_grant', 'email_not_confirmed'].includes(e.code)) throw new HttpError(503, 'auth_unavailable', 'Sign-in service is temporarily unavailable.');
      return fail('wrong_credentials');
    }
    // Administrators with two-step verification on must give the authenticator code here too.
    let gate;
    try { gate = await mfaGate(grant, b.mfa_code); } catch (e) {
      await sb.logout(grant.access_token);
      if (e.code === 'mfa_required') throw e;
      return fail('mfa_invalid');
    }
    await sb.logout(gate.token);
    if (!(grant.user?.email_confirmed_at || grant.user?.confirmed_at)) return fail('unverified');
    let u;
    try { u = await localUserFor(grant.user, ip); } catch { return fail('account_inactive'); }
    if (!u || u.status !== 'active' || (u.approval_status || 'approved') !== 'approved') return fail('account_inactive');
    // Elevation happens ONLY here, after the allowlist + Supabase password + verified-email checks above:
    // the bootstrap address becomes the first superadmin (if none exists); any other allowlisted account becomes admin.
    if (u.role !== 'superadmin' && await bootstrapSuperadmin(u.id, ip)) u = await one('SELECT * FROM users WHERE id = ?', u.id);
    if (!ADMIN.includes(u.role)) {
      await run("UPDATE users SET role = 'admin', updated_at = ? WHERE id = ?", now(), u.id);
      await audit(u.id, 'system', 'admin.role_granted_by_allowlist', u.id, ip);
      u = await one('SELECT * FROM users WHERE id = ?', u.id);
    }
    const s = await createAdminSession(u, req);
    await audit(u.id, actor(u), 'admin.login', u.id, ip);
    res.setHeader('Set-Cookie', adminCookie(s.token, s.maxAge));
    sendJson(res, 200, { admin: { id: u.id, email: u.email, role: u.role }, csrf_token: s.csrf, expires_in: s.maxAge });
  });

  r.post('/api/admin/auth/logout', async (req, res, ctx) => {
    if (ctx.admin) {
      await run('UPDATE admin_sessions SET revoked_at = ? WHERE id = ?', now(), ctx.admin.session.id);
      await audit(ctx.admin.user.id, actor(ctx.admin.user), 'admin.logout', ctx.admin.user.id, clientIp(req));
    }
    res.setHeader('Set-Cookie', adminCookie('', 0));
    sendJson(res, 200, { status: 'logged_out' });
  });

  r.get('/api/admin/auth/me', async (req, res, ctx) => {
    const a = requireRole(ctx, ...ADMIN);
    const p = await one('SELECT display_name FROM profiles WHERE user_id = ?', a.id) || {};
    sendJson(res, 200, { admin: { id: a.id, email: a.email, role: a.role, name: p.display_name || '' }, csrf_token: ctx.admin.session.csrf_token,
      expires_at: ctx.admin.session.expires_at });
  });

  // ================= overview =================
  r.get('/api/admin/overview', async (req, res, ctx) => {
    requireRole(ctx, ...ADMIN);
    const t = now();
    const c = await one(`SELECT COUNT(*) total,
      SUM(email_verified = 1) verified, SUM(email_verified = 0) unverified,
      SUM(COALESCE(approval_status,'approved') = 'pending') pending, SUM(COALESCE(approval_status,'approved') = 'approved') approved,
      SUM(COALESCE(approval_status,'approved') = 'suspended') suspended, SUM(COALESCE(approval_status,'approved') = 'rejected') rejected,
      SUM(COALESCE(approval_status,'approved') = 'disabled') disabled, SUM(created_at >= ?) new_7d
      FROM users WHERE status != 'deleted'`, t - 7 * DAY);
    const active30 = (await one('SELECT COUNT(DISTINCT user_id) n FROM usage_events WHERE created_at >= ?', t - 30 * DAY)).n;
    const online = (await one('SELECT COUNT(DISTINCT user_id) n FROM sessions WHERE revoked_at IS NULL AND expires_at > ? AND last_seen_at >= ?', t, t - 5 * 60_000)).n;
    const req1 = await one('SELECT COUNT(*) total, SUM(created_at >= ?) today, SUM(created_at >= ?) month FROM usage_events', startOfDay(t), startOfMonth());
    const byModel = await all('SELECT model_id, COUNT(*) requests FROM usage_events WHERE created_at >= ? GROUP BY model_id ORDER BY requests DESC', startOfMonth());
    const storage = await one('SELECT COUNT(*) files, COALESCE(SUM(size),0) bytes FROM files');
    const days = 30; const from = startOfDay(t) - (days - 1) * DAY;
    const dReq = Object.fromEntries((await all('SELECT CAST(created_at / 86400000 AS INTEGER) d, COUNT(*) n FROM usage_events WHERE created_at >= ? GROUP BY d', from)).map((x) => [x.d, x.n]));
    const dNew = Object.fromEntries((await all("SELECT CAST(created_at / 86400000 AS INTEGER) d, COUNT(*) n FROM users WHERE created_at >= ? AND status != 'deleted' GROUP BY d", from)).map((x) => [x.d, x.n]));
    const daily = Array.from({ length: days }, (_, i) => { const d = from / DAY + i; return { date: new Date(d * DAY).toISOString().slice(0, 10), requests: dReq[d] || 0, signups: dNew[d] || 0 }; });
    sendJson(res, 200, {
      clients: { total: c.total || 0, active_30d: active30, new_7d: c.new_7d || 0, online_now: online, verified: c.verified || 0, unverified: c.unverified || 0,
        pending: c.pending || 0, approved: c.approved || 0, suspended: c.suspended || 0, rejected: c.rejected || 0, disabled: c.disabled || 0 },
      requests: { total: req1.total || 0, today: req1.today || 0, month: req1.month || 0 },
      model_usage_month: byModel, storage, daily, countries: await countries(),
      definitions: { active_30d: 'clients with at least one AI request in the last 30 days', online_now: 'clients with a session used in the last 5 minutes' },
    });
  });

  async function countries() {
    const rows = await all("SELECT COALESCE(country, 'Unknown') country, COUNT(*) n FROM users WHERE status != 'deleted' GROUP BY COALESCE(country, 'Unknown') ORDER BY n DESC");
    const total = rows.reduce((s, x) => s + x.n, 0) || 1;
    return rows.map((x) => ({ country: x.country, users: x.n, percent: Math.round((x.n / total) * 1000) / 10 }));
  }

  // ================= clients =================
  r.get('/api/admin/clients', async (req, res, ctx, p, url) => {
    requireRole(ctx, ...ADMIN);
    const sp = url.searchParams;
    const where = ["u.status != 'deleted'"]; const args = [];
    const q = (sp.get('q') || '').trim().slice(0, 100);
    if (q) {
      const like = '%' + q.replace(/[\\%_]/g, (x) => '\\' + x) + '%';
      where.push("(u.email LIKE ? ESCAPE '\\' OR u.id = ? OR EXISTS (SELECT 1 FROM profiles pr WHERE pr.user_id = u.id AND pr.display_name LIKE ? ESCAPE '\\'))"); args.push(like, q, like);
    }
    const status = sp.get('status'); if (status) { where.push("COALESCE(u.approval_status,'approved') = ?"); args.push(oneOf(status, 'status', CLIENT_STATUSES)); }
    const verified = sp.get('verified'); if (verified === 'yes' || verified === 'no') where.push(`u.email_verified = ${verified === 'yes' ? 1 : 0}`);
    const country = sp.get('country'); if (country) { if (country === 'Unknown') where.push('u.country IS NULL'); else { where.push('u.country = ?'); args.push(country.slice(0, 2).toUpperCase()); } }
    const plan = sp.get('plan'); if (plan) { where.push('u.plan = ?'); args.push(oneOf(plan, 'plan', ['free', 'pro', 'enterprise'])); }
    const model = sp.get('model'); if (model) { where.push("EXISTS (SELECT 1 FROM model_access ma WHERE ma.user_id = u.id AND ma.model_id = ? AND ma.access = 'grant')"); args.push(model.slice(0, 40)); }
    const sorts = { newest: 'u.created_at DESC', oldest: 'u.created_at ASC', last_login: 'COALESCE(u.last_login_at,0) DESC', usage: 'requests DESC' };
    const order = sorts[sp.get('sort')] || sorts.newest;
    const limit = Math.min(100, Math.max(1, parseInt(sp.get('limit') || '50', 10) || 50));
    const offset = Math.max(0, parseInt(sp.get('offset') || '0', 10) || 0);
    const rows = await all(`SELECT u.*, (SELECT COUNT(*) FROM usage_events e WHERE e.user_id = u.id) requests FROM users u WHERE ${where.join(' AND ')}
      ORDER BY ${order}, u.id LIMIT ${limit + 1} OFFSET ${offset}`, ...args);
    const total = (await one(`SELECT COUNT(*) n FROM users u WHERE ${where.join(' AND ')}`, ...args)).n;
    sendJson(res, 200, { clients: await Promise.all(rows.slice(0, limit).map(clientRow)), total, has_more: rows.length > limit, countries: await countries() });
  });

  async function target(id) {
    const u = await one("SELECT * FROM users WHERE id = ? AND status != 'deleted'", id);
    if (!u) throw notFound('Client not found');
    return u;
  }

  r.get('/api/admin/clients/:id', async (req, res, ctx, p) => {
    requireRole(ctx, ...ADMIN);
    const u = await target(p.id);
    const summary = await usageSummary(u);
    const byModel = await all('SELECT model_id, COUNT(*) requests FROM usage_events WHERE user_id = ? GROUP BY model_id ORDER BY requests DESC', u.id);
    const tokens = await one("SELECT COALESCE(SUM(tokens_in),0) tokens_in, COALESCE(SUM(tokens_out),0) tokens_out FROM messages WHERE user_id = ? AND role = 'assistant'", u.id);
    const totals = await one('SELECT COUNT(*) total, SUM(created_at >= ?) today, SUM(created_at >= ?) month FROM usage_events WHERE user_id = ?', startOfDay(), startOfMonth(), u.id);
    const overrides = Object.fromEntries((await all('SELECT model_id, access, granted_by, reason, expires_at FROM model_access WHERE user_id = ?', u.id)).map((x) => [x.model_id, x]));
    const models = await Promise.all((await listModels()).map(async (m) => ({ id: m.id, name: m.name, tier: m.tier, available: await canUseModel(u, m),
      override: overrides[m.id] ? (overrides[m.id].access === 'deny' ? 'restricted' : 'enabled') : 'default' })));
    const limits = await one('SELECT window_limit, cycle_limit, model_limits, updated_at FROM user_limits WHERE user_id = ?', u.id);
    const s = await one('SELECT permissions_mode FROM settings WHERE user_id = ?', u.id) || {};
    const apiKeys = (await one('SELECT COUNT(*) n FROM api_keys WHERE user_id = ? AND revoked_at IS NULL', u.id)).n;
    const sessions = (await one('SELECT COUNT(*) n, MAX(last_seen_at) last FROM sessions WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ?', u.id, now()));
    const activity = await all('SELECT action, actor, created_at FROM audit_logs WHERE user_id = ? ORDER BY id DESC LIMIT 30', u.id);
    sendJson(res, 200, {
      client: { ...(await clientRow(u)), approval_reason: u.approval_reason || null, approval_updated_at: u.approval_updated_at || null,
        last_activity_at: Math.max(sessions.last || 0, u.last_login_at || 0) || null, active_sessions: sessions.n },
      usage: { requests: { total: totals.total || 0, today: totals.today || 0, month: totals.month || 0 }, by_model: byModel, tokens, quota: summary },
      access: { models, permissions_mode: s.permissions_mode || 'manual', api_keys_active: apiKeys, api_access: apiKeys > 0 ? 'enabled' : 'no keys' },
      limits: limits ? { window_limit: limits.window_limit, cycle_limit: limits.cycle_limit, model_limits: JSON.parse(limits.model_limits || '{}'), updated_at: limits.updated_at } : null,
      defaults: { window_limit: config.quota.windowLimit, window_minutes: config.quota.windowMinutes, cycle_limit: config.quota.cycleLimit || null, cycle_days: config.quota.cycleDays },
      activity: activity.map((x) => ({ action: x.action, by_admin: String(x.actor).startsWith('admin:'), created_at: x.created_at })),
    });
  });

  // Approval / account status. Takes effect immediately: the dispatcher reads the status on every request, and blocking
  // statuses also revoke every client session and API key use.
  r.post('/api/admin/clients/:id/status', async (req, res, ctx, p) => {
    const a = requireRole(ctx, ...ADMIN);
    const u = await target(p.id);
    const b = await readJson(req);
    const st = oneOf(b.status, 'status', CLIENT_STATUSES);
    if (u.id === a.id) throw forbidden('You cannot change your own account status', 'self_change');
    if (ADMIN.includes(u.role) && a.role !== 'superadmin') throw forbidden('Only a superadmin can change another administrator', 'superadmin_required');
    const reason = str(b.reason, 'reason', { max: 300, required: false }) || null;
    await run('UPDATE users SET approval_status = ?, approval_reason = ?, approval_updated_at = ?, updated_at = ? WHERE id = ?', st, reason, now(), now(), u.id);
    if (['suspended', 'rejected', 'disabled'].includes(st)) { await revokeSessions(u.id); await run('UPDATE admin_sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL', now(), u.id); }
    await audit(u.id, actor(a), `admin.client_${st}`, u.id, clientIp(req), { from: u.approval_status || 'approved', to: st, reason });
    sendJson(res, 200, { client: await clientRow(await one('SELECT * FROM users WHERE id = ?', u.id)) });
  });

  r.patch('/api/admin/clients/:id', async (req, res, ctx, p) => {
    const a = requireRole(ctx, ...ADMIN);
    const u = await target(p.id);
    const b = await readJson(req);
    const changes = {};
    if (b.plan !== undefined) { changes.plan = oneOf(b.plan, 'plan', ['free', 'pro', 'enterprise']); await run('UPDATE users SET plan = ?, updated_at = ? WHERE id = ?', changes.plan, now(), u.id); }
    if (b.role !== undefined) {
      if (a.role !== 'superadmin') throw forbidden('Only a superadmin can change roles', 'superadmin_required');
      changes.role = oneOf(b.role, 'role', ['user', 'admin', 'superadmin']);
      await run('UPDATE users SET role = ?, updated_at = ? WHERE id = ?', changes.role, now(), u.id);
    }
    if (!Object.keys(changes).length) throw bad('Nothing to change');
    await audit(u.id, actor(a), 'admin.client_updated', u.id, clientIp(req), changes);
    sendJson(res, 200, { client: await clientRow(await one('SELECT * FROM users WHERE id = ?', u.id)) });
  });

  // Model access: enabled (explicit grant) · restricted (explicit deny, wins over plan/tier) · default (plan rules).
  r.put('/api/admin/clients/:id/models/:modelId', async (req, res, ctx, p) => {
    const a = requireRole(ctx, ...ADMIN);
    const u = await target(p.id);
    const m = await getModel(p.modelId);
    if (!m) throw notFound('Unknown model');
    const b = await readJson(req);
    const access = oneOf(b.access, 'access', ['enabled', 'restricted', 'default']);
    if (m.tier === 'restricted' && access === 'enabled' && a.role !== 'superadmin') throw forbidden('FAB access can only be granted by a superadmin', 'superadmin_required');
    if (access === 'default') await run('DELETE FROM model_access WHERE user_id = ? AND model_id = ?', u.id, m.id);
    else {
      await run(`INSERT INTO model_access (user_id,model_id,granted_by,reason,created_at,expires_at,access) VALUES (?,?,?,?,?,NULL,?)
        ON CONFLICT(user_id,model_id) DO UPDATE SET granted_by = excluded.granted_by, reason = excluded.reason, created_at = excluded.created_at, expires_at = NULL, access = excluded.access`,
      u.id, m.id, a.id, str(b.reason, 'reason', { max: 300, required: false }) || `admin panel: ${access}`, now(), access === 'enabled' ? 'grant' : 'deny');
    }
    await audit(u.id, actor(a), `admin.model_${access}`, m.id, clientIp(req), { model: m.id });
    sendJson(res, 200, { model: m.id, access, available: await canUseModel(u, m) });
  });

  // Quotas: per-client overrides of the platform defaults (null clears an override).
  r.put('/api/admin/clients/:id/limits', async (req, res, ctx, p) => {
    const a = requireRole(ctx, ...ADMIN);
    const u = await target(p.id);
    const b = await readJson(req);
    const num = (v, k) => (v === null || v === undefined || v === '' ? null : (Number.isInteger(+v) && +v >= 0 && +v <= 1_000_000 ? +v : (() => { throw bad(`${k} must be a whole number 0–1000000`); })()));
    const win = num(b.window_limit, 'window_limit'); const cyc = num(b.cycle_limit, 'cycle_limit');
    const models = {};
    for (const [k, v] of Object.entries(b.model_limits || {})) { if (!await getModel(k)) throw bad(`Unknown model ${k}`); const n = num(v, k); if (n !== null) models[k] = n; }
    if (win === null && cyc === null && !Object.keys(models).length) await run('DELETE FROM user_limits WHERE user_id = ?', u.id);
    else {
      await run(`INSERT INTO user_limits (user_id,window_limit,cycle_limit,model_limits,updated_by,updated_at) VALUES (?,?,?,?,?,?)
        ON CONFLICT(user_id) DO UPDATE SET window_limit = excluded.window_limit, cycle_limit = excluded.cycle_limit, model_limits = excluded.model_limits,
        updated_by = excluded.updated_by, updated_at = excluded.updated_at`, u.id, win, cyc, JSON.stringify(models), a.id, now());
    }
    await audit(u.id, actor(a), 'admin.quota_changed', u.id, clientIp(req), { window_limit: win, cycle_limit: cyc, model_limits: models });
    sendJson(res, 200, { limits: { window_limit: win, cycle_limit: cyc, model_limits: models }, quota: await usageSummary(u) });
  });

  // ================= activity / audit / usage / models / settings =================
  r.get('/api/admin/activity', async (req, res, ctx, p, url) => {
    requireRole(ctx, ...ADMIN);
    const before = parseInt(url.searchParams.get('before') || '', 10) || now() + 1;
    const limit = Math.min(200, Math.max(10, parseInt(url.searchParams.get('limit') || '80', 10) || 80));
    const audits = await all(`SELECT 'audit' src, a.action event, a.actor, a.target, a.created_at, a.user_id, u.email FROM audit_logs a LEFT JOIN users u ON u.id = a.user_id
      WHERE a.created_at < ? ORDER BY a.created_at DESC LIMIT ?`, before, limit);
    const reqs = await all(`SELECT 'usage' src, 'model.request' event, e.model_id target, e.mode, e.created_at, e.user_id, u.email FROM usage_events e LEFT JOIN users u ON u.id = e.user_id
      WHERE e.created_at < ? ORDER BY e.created_at DESC LIMIT ?`, before, limit);
    const events = [...audits, ...reqs].sort((x, y) => y.created_at - x.created_at).slice(0, limit)
      .map((e) => ({ at: e.created_at, event: e.event, user_id: e.user_id, user: e.email || null, by_admin: String(e.actor || '').startsWith('admin:'),
        detail: e.src === 'usage' ? `${e.target} · ${e.mode}` : (e.target && !String(e.target).includes('@') ? String(e.target).slice(0, 60) : null) }));
    sendJson(res, 200, { events, next_before: events.at(-1)?.at || null });
  });

  r.get('/api/admin/audit-log', async (req, res, ctx, p, url) => {
    requireRole(ctx, ...ADMIN);
    const before = parseInt(url.searchParams.get('before') || '', 10) || 2 ** 52;
    const rows = await all(`SELECT a.id, a.action, a.actor, a.target, a.created_at, a.detail, t.email target_email, ad.email admin_email FROM audit_logs a
      LEFT JOIN users t ON t.id = a.user_id LEFT JOIN users ad ON ad.id = substr(a.actor, 7)
      WHERE (a.actor LIKE 'admin:%' OR a.action LIKE 'admin.%') AND a.id < ? ORDER BY a.id DESC LIMIT 100`, before);
    sendJson(res, 200, { entries: rows.map((x) => ({ id: x.id, at: x.created_at, action: x.action, target_user: x.target_email || null, target: x.target,
      admin: x.admin_email || (String(x.actor).startsWith('admin:') ? x.actor : x.actor === 'anonymous' ? 'unauthenticated' : x.actor), detail: safeDetail(x.detail) })),
    next_before: rows.at(-1)?.id || null });
  });

  r.get('/api/admin/usage', async (req, res, ctx) => {
    requireRole(ctx, ...ADMIN);
    const month = startOfMonth();
    sendJson(res, 200, {
      by_model_month: await all('SELECT model_id, COUNT(*) requests, COUNT(DISTINCT user_id) clients FROM usage_events WHERE created_at >= ? GROUP BY model_id ORDER BY requests DESC', month),
      by_mode_month: await all('SELECT mode, COUNT(*) requests FROM usage_events WHERE created_at >= ? GROUP BY mode ORDER BY requests DESC', month),
      top_clients_month: (await all(`SELECT e.user_id, u.email, COUNT(*) requests FROM usage_events e JOIN users u ON u.id = e.user_id WHERE e.created_at >= ?
        GROUP BY e.user_id ORDER BY requests DESC LIMIT 10`, month)),
      tokens_month: await one("SELECT COALESCE(SUM(tokens_in),0) tokens_in, COALESCE(SUM(tokens_out),0) tokens_out FROM messages WHERE role = 'assistant' AND created_at >= ?", month),
      custom_limits: (await one('SELECT COUNT(*) n FROM user_limits')).n,
      defaults: { window_limit: config.quota.windowLimit, window_minutes: config.quota.windowMinutes, cycle_limit: config.quota.cycleLimit || null, cycle_days: config.quota.cycleDays },
    });
  });

  // All models (enabled or not) with live status, version, availability, visibility, usage and failures.
  const allModels = () => all('SELECT * FROM models ORDER BY rowid');
  r.get('/api/admin/models-overview', async (req, res, ctx) => {
    requireRole(ctx, ...ADMIN);
    const month = startOfMonth(); const day = now() - DAY;
    const models = await Promise.all((await allModels()).map(async (m) => {
      const lc = await lifecycleOf(m.id);
      const c = catalogModel(m.id) || {};
      const o = await one("SELECT SUM(access = 'grant') enabled, SUM(access = 'deny') restricted FROM model_access WHERE model_id = ?", m.id);
      const u = await one('SELECT COUNT(*) requests FROM usage_events WHERE model_id = ? AND created_at >= ?', m.id, month);
      const f = await one('SELECT COUNT(*) month, SUM(created_at >= ?) day FROM model_failures WHERE model_id = ? AND created_at >= ?', day, m.id, month);
      const st = await modelStatus(m);
      return { id: m.id, name: m.name, tier: m.tier, role: c.role || null, access: c.access || null, capabilities: c.capabilities || [],
        enabled: !!m.enabled, available: m.available !== 0, visibility: m.visibility || 'public', private: isPrivateModel(m),
        status: st.status, status_reason: st.reason, simulator: !!st.simulator, lifecycle: lc?.state || null, version: lc?.version || null,
        base_model: c.base_model || null, overrides_enabled: o.enabled || 0, overrides_restricted: o.restricted || 0,
        requests_month: u.requests, failed_month: f.month || 0, failed_24h: f.day || 0 };
    }));
    sendJson(res, 200, { models, statuses: ['configured', 'training', 'trained', 'packaged', 'deploying', 'online', 'offline', 'failed'],
      tiers: { default: 'all clients', advanced: 'all clients', premium: 'Pro / Enterprise plans or an explicit grant', restricted: 'explicit grant only (superadmin)' },
      access: { standard: 'all clients', advanced: 'by plan', restricted: 'explicit grant (superadmin)', 'admin-granted': 'private: invisible and refused without an explicit grant (superadmin), no role bypass' } });
  });

  // Inference health for one model: live /health of its server + derived status (never cached as "connected").
  r.get('/api/admin/models/:id/health', async (req, res, ctx, p) => {
    requireRole(ctx, ...ADMIN);
    const m = await one('SELECT * FROM models WHERE id = ?', p.id);
    if (!m) throw notFound('Unknown model');
    const h = await upstreamHealth(m);
    const st = await modelStatus(m);
    const lc = await lifecycleOf(m.id);
    sendJson(res, 200, { model: m.id, status: st.status, reason: st.reason, simulator: !!st.simulator,
      upstream: h.configured ? { reachable: !!h.reachable, status: h.status ?? null, serving: h.serving?.[m.id] ?? null, gpu: h.gpu ?? null, error: h.error ?? null } : { configured: false },
      lifecycle: lc ? { state: lc.state, version: lc.version, verified_at: lc.verified_at ?? null, detail: lc.detail } : null,
      smoke_test: 'POST /api/admin/models/:id/verify-deployment (superadmin) runs health + SHA-256 + a real generation' });
  });

  // Recent failed model requests (no prompts or answers are stored).
  r.get('/api/admin/models/:id/failures', async (req, res, ctx, p) => {
    requireRole(ctx, ...ADMIN);
    const rows = await all(`SELECT f.created_at, f.code, f.status, f.source, u.email FROM model_failures f LEFT JOIN users u ON u.id = f.user_id
      WHERE f.model_id = ? ORDER BY f.id DESC LIMIT 100`, p.id);
    sendJson(res, 200, { failures: rows });
  });

  // Who holds an explicit grant (FAB 500X private access list).
  r.get('/api/admin/models/:id/grants', async (req, res, ctx, p) => {
    requireRole(ctx, ...ADMIN);
    const rows = await all(`SELECT u.id user_id, u.email, ma.access, ma.reason, ma.created_at, ma.expires_at, g.email granted_by FROM model_access ma
      JOIN users u ON u.id = ma.user_id LEFT JOIN users g ON g.id = ma.granted_by WHERE ma.model_id = ? ORDER BY ma.created_at DESC`, p.id);
    sendJson(res, 200, { grants: rows });
  });

  // Availability (on/off for everyone) and visibility (public / private=admin-granted). Superadmin only, audited.
  r.put('/api/admin/models/:id/availability', async (req, res, ctx, p) => {
    const a = requireRole(ctx, 'superadmin');
    const m = await one('SELECT * FROM models WHERE id = ?', p.id);
    if (!m) throw notFound('Unknown model');
    const b = await readJson(req);
    const changes = {};
    if (b.available !== undefined) { if (typeof b.available !== 'boolean') throw bad('available must be true or false'); changes.available = b.available; }
    if (b.visibility !== undefined) {
      changes.visibility = oneOf(b.visibility, 'visibility', ['public', 'private']);
      if (changes.visibility === 'public' && catalogModel(m.id)?.access === 'admin-granted') throw forbidden('This model is admin-granted by policy and cannot be made public', 'policy_private_model');
    }
    if (!Object.keys(changes).length) throw bad('Nothing to change');
    await run('UPDATE models SET available = COALESCE(?, available), visibility = COALESCE(?, visibility) WHERE id = ?',
      changes.available === undefined ? null : (changes.available ? 1 : 0), changes.visibility ?? null, m.id);
    await audit(null, actor(a), 'admin.model_availability', m.id, clientIp(req), changes);
    const n = await one('SELECT * FROM models WHERE id = ?', m.id);
    sendJson(res, 200, { model: m.id, available: n.available !== 0, visibility: n.visibility });
  });

  // Diagnostics: Supabase Auth, email requests, API, model registry, inference, training, APK contract. No secrets.
  r.get('/api/admin/diagnostics', async (req, res, ctx) => {
    requireRole(ctx, ...ADMIN);
    const sbUrl = config.supabase.url; const key = config.supabase.publishableKey;
    const probe = async (path) => {
      if (!sbUrl || !key) return { ok: false, error: 'not configured' };
      const t = Date.now();
      try {
        const r2 = await fetch(`${sbUrl}/auth/v1${path}`, { headers: { apikey: key }, signal: AbortSignal.timeout(6000) });
        return { ok: r2.ok, status: r2.status, ms: Date.now() - t, body: r2.ok ? await r2.json().catch(() => null) : null };
      } catch (e) { return { ok: false, error: e.name, ms: Date.now() - t }; }
    };
    const [health, settings] = await Promise.all([probe('/health'), probe('/settings')]);
    const st = settings.body || {};
    const since = now() - DAY;
    const emails = await all(`SELECT action, json_extract(detail, '$.outcome') outcome, COUNT(*) n, MAX(created_at) last_at FROM audit_logs
      WHERE action IN ('auth.email_signup','auth.email_resend','auth.email_recovery') AND created_at >= ? GROUP BY action, outcome ORDER BY action, n DESC`, since);
    const models = await Promise.all((await all('SELECT * FROM models ORDER BY rowid')).map(async (m) => {
      const lc = await lifecycleOf(m.id);
      const s2 = await modelStatus(m);
      const hh = await upstreamHealth(m);
      return { id: m.id, status: s2.status, reason: s2.reason, lifecycle: lc?.state || null, version: lc?.version || null,
        inference: hh.configured ? (hh.reachable ? 'reachable' : `unreachable${hh.error ? ` (${hh.error})` : ''}`) : 'not configured', available: m.available !== 0 };
    }));
    const job = await one('SELECT id, status, phase, created_at, finished_at FROM gpu_jobs ORDER BY created_at DESC LIMIT 1').catch(() => null);
    sendJson(res, 200, {
      supabase_auth: { configured: !!(sbUrl && key), host: sbUrl ? new URL(sbUrl).host : null, reachable: health.ok, latency_ms: health.ms ?? null,
        version: health.body?.version || null, email_signup_enabled: st.external ? !!st.external.email : null, signup_disabled: st.disable_signup ?? null,
        email_autoconfirm: st.mailer_autoconfirm ?? null, callback_url: config.supabase.callbackUrl,
        note: 'SMTP host/credentials and inbox delivery are not visible through the public Auth API; check Supabase → Authentication → Emails (SMTP) and Logs → Auth.' },
      email_requests_24h: emails.map((x) => ({ kind: x.action.replace('auth.email_', ''), outcome: x.outcome, count: x.n, last_at: x.last_at })),
      api: { status: 'ok', versions: VERSIONS, build_id: config.buildId, public_url: config.publicUrl },
      admin: { allowlist_configured: adminEmails().length > 0, allowlisted_count: adminEmails().length },
      models, training: { latest_job: job || null },
      apk: { api_contract: VERSIONS.api_contract, min_version_code: VERSIONS.min_apk_version_code, api_url: config.publicUrl,
        model_discovery: 'GET /api/models (status, selectable, active_version) — no versions are built into the APK' },
    });
  });

  r.get('/api/admin/platform-settings', async (req, res, ctx) => {
    requireRole(ctx, ...ADMIN);
    sendJson(res, 200, { require_approval: (await platformSetting('require_approval', '0')) === '1' });
  });
  r.put('/api/admin/platform-settings', async (req, res, ctx) => {
    const a = requireRole(ctx, 'superadmin');
    const b = await readJson(req);
    if (typeof b.require_approval !== 'boolean') throw bad('require_approval must be true or false');
    await setPlatformSetting('require_approval', b.require_approval ? '1' : '0', a.id);
    await audit(null, actor(a), 'admin.setting_changed', 'require_approval', clientIp(req), { require_approval: b.require_approval });
    sendJson(res, 200, { require_approval: b.require_approval });
  });

  void tx;
}

// Audit details shown in the panel: only simple, non-secret fields.
function safeDetail(raw) {
  let d; try { d = JSON.parse(raw || '{}'); } catch { return null; }
  const out = {};
  for (const [k, v] of Object.entries(d || {})) {
    if (/pass|token|secret|key|hash|credential/i.test(k)) continue;
    if (['string', 'number', 'boolean'].includes(typeof v) || v === null) out[k] = typeof v === 'string' ? v.slice(0, 120) : v;
    else if (typeof v === 'object') out[k] = JSON.stringify(v).slice(0, 160);
  }
  return out;
}
