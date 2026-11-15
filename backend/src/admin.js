// Admin authorization: separate from client sessions.
//
//  - Who may be an administrator is configured on the SERVER only: APPROX_ADMIN_EMAILS (comma-separated). Nothing in
//    the web app, the APK or the database alone can make someone an admin.
//  - Admins prove their identity with their Supabase Auth email + password (no second password database), then get a
//    dedicated admin session: an HttpOnly, SameSite=Strict cookie scoped to /api/admin, an absolute lifetime
//    (APPROX_ADMIN_SESSION_HOURS, default 8) and an idle timeout (APPROX_ADMIN_IDLE_MINUTES, default 30), plus its own
//    CSRF token. Client cookies/tokens are never accepted by /api/admin (the dispatcher does not even resolve them).
//  - Every admin request re-checks: session valid, account active, still on the allowlist, role admin/superadmin.
import crypto from 'node:crypto';
import { one, run, now } from './db.js';
import { HttpError, forbidden, clientIp } from './http.js';
import { config } from './config.js';

const env = process.env;
export const adminEmails = () => String(env.APPROX_ADMIN_EMAILS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
export const isAllowlistedAdmin = (email) => adminEmails().includes(String(email || '').toLowerCase());
const hours = () => Math.min(24, Math.max(1, Number(env.APPROX_ADMIN_SESSION_HOURS) || 8));
const idleMinutes = () => Math.min(240, Math.max(5, Number(env.APPROX_ADMIN_IDLE_MINUTES) || 30));
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const token = (n) => crypto.randomBytes(n).toString('base64url');
export const ADMIN_ROLES = ['admin', 'superadmin'];

export function adminCookie(value, maxAgeSec) {
  const secure = config.publicUrl.startsWith('https://') ? '; Secure' : '';
  return `approx_admin=${value}; Path=/api/admin; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSec}${secure}`;
}

export async function createAdminSession(user, req) {
  const t = token(32); const csrf = token(24); const ts = now();
  const id = 'adm_' + token(12);
  await run(`INSERT INTO admin_sessions (id,user_id,token_hash,csrf_token,ip,user_agent,created_at,last_seen_at,expires_at) VALUES (?,?,?,?,?,?,?,?,?)`,
    id, user.id, sha(t), csrf, clientIp(req), String(req.headers['user-agent'] || '').slice(0, 300), ts, ts, ts + hours() * 3600_000);
  return { id, token: t, csrf, maxAge: hours() * 3600 };
}

function cookieValue(req, name) {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

/** The admin behind this request, or null. Expired / idle / de-listed / demoted / inactive sessions are revoked. */
export async function resolveAdmin(req) {
  const t = cookieValue(req, 'approx_admin');
  if (!t) return null;
  const s = await one('SELECT * FROM admin_sessions WHERE token_hash = ? AND revoked_at IS NULL', sha(t));
  if (!s) return null;
  const ts = now();
  const user = await one('SELECT * FROM users WHERE id = ?', s.user_id);
  const valid = s.expires_at > ts && ts - s.last_seen_at < idleMinutes() * 60_000 && user && user.status === 'active'
    && (user.approval_status || 'approved') === 'approved' && ADMIN_ROLES.includes(user.role) && isAllowlistedAdmin(user.email);
  if (!valid) { await run('UPDATE admin_sessions SET revoked_at = ? WHERE id = ?', ts, s.id); return null; }
  if (ts - s.last_seen_at > 30_000) await run('UPDATE admin_sessions SET last_seen_at = ? WHERE id = ?', ts, s.id);
  return { user, session: s };
}

const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
export function enforceAdminCsrf(req, admin) {
  if (!admin || !UNSAFE.has(req.method)) return;
  const sent = String(req.headers['x-admin-csrf'] || '');
  const ok = sent.length === admin.session.csrf_token.length && crypto.timingSafeEqual(Buffer.from(sent), Buffer.from(admin.session.csrf_token));
  if (!ok) throw forbidden('Admin CSRF token missing or invalid', 'csrf_failed');
}

// ---------- client account status (server-side gate for every client request) ----------
export const CLIENT_STATUSES = ['pending', 'approved', 'suspended', 'rejected', 'disabled'];
const PENDING_ALLOWED = [/^\/api\/auth\//, /^\/api\/settings$/, /^\/api\/account\/(export|delete|activity)$/, /^\/api\/notifications/, /^\/api\/feedback$/];
const BLOCKED_ALLOWED = [/^\/api\/auth\/(me|logout)$/];
const MESSAGES = {
  pending: 'Your Approx account is waiting for approval. You will be able to use Approx as soon as an administrator approves it.',
  suspended: 'Your Approx account is suspended. Contact Approx support if you think this is a mistake.',
  rejected: 'Your Approx account application was not approved.',
  disabled: 'This Approx account has been disabled.',
};
/** Throws unless the caller's account status allows this API path. Called by the dispatcher for every client request. */
export function enforceAccountStatus(pathname, auth) {
  if (!auth?.user) return;
  const st = auth.user.approval_status || 'approved';
  if (st === 'approved') return;
  const allowed = st === 'pending' ? PENDING_ALLOWED : BLOCKED_ALLOWED;
  if (allowed.some((rx) => rx.test(pathname))) return;
  throw new HttpError(403, `account_${st}`, MESSAGES[st] || 'Account not allowed.');
}
export const statusMessage = (st) => MESSAGES[st] || null;

// ---------- country (only what the hosting edge reports; never guessed) ----------
/** ISO-3166 alpha-2 from the platform's IP-geolocation header (Vercel / Cloudflare), only behind a trusted proxy. */
export function requestCountry(req) {
  if (!config.trustProxy) return null;
  const c = String(req.headers['x-vercel-ip-country'] || req.headers['cf-ipcountry'] || '').trim().toUpperCase();
  return /^[A-Z]{2}$/.test(c) && !['XX', 'T1'].includes(c) ? c : null;
}

// ---------- platform settings ----------
export async function platformSetting(key, fallback = null) {
  const r = await one('SELECT value FROM platform_settings WHERE key = ?', key);
  return r ? r.value : fallback;
}
export async function setPlatformSetting(key, value, by) {
  await run('INSERT INTO platform_settings (key,value,updated_by,updated_at) VALUES (?,?,?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at',
    key, String(value), by, now());
}
