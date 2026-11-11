// Password hashing, token generation, rate limiting, auth context resolution.
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { one, run, now, securityEvent } from './db.js';
import { HttpError, unauthorized, forbidden, clientIp } from './http.js';
import { config } from './config.js';

const scrypt = promisify(crypto.scrypt);
const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const dk = await scrypt(pw.normalize('NFKC'), salt, 32, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${dk.toString('base64')}`;
}
export async function verifyPassword(pw, stored) {
  const [alg, N, r, p, saltB64, hashB64] = String(stored).split('$');
  if (alg !== 'scrypt') return false;
  const expected = Buffer.from(hashB64, 'base64');
  const dk = await scrypt(pw.normalize('NFKC'), Buffer.from(saltB64, 'base64'), expected.length,
    { N: +N, r: +r, p: +p, maxmem: 64 * 1024 * 1024 });
  return crypto.timingSafeEqual(dk, expected);
}
// Dummy hash so login timing does not reveal whether an account exists.
let dummyHash;
export async function burnPasswordCheck(pw) { dummyHash ||= await hashPassword('dummy-password-x'); await verifyPassword(pw, dummyHash); }

export function passwordPolicy(pw) {
  if (typeof pw !== 'string') return 'Password is required';
  if (pw.length < 10) return 'Password must be at least 10 characters';
  if (pw.length > 256) return 'Password must be at most 256 characters';
  if (!/[a-zA-Z]/.test(pw) || !/[0-9]/.test(pw)) return 'Password must contain letters and numbers';
  if (/^(password|1234567890|qwertyuiop)/i.test(pw)) return 'Password is too common';
  return null;
}

export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
export const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

// ---------- rate limiting (fixed window, persisted in SQLite so restarts don't reset it) ----------
export function rateLimit(key, limit, windowMs) {
  const t = now();
  const row = one('SELECT count, reset_at FROM rate_buckets WHERE key = ?', key);
  if (!row || row.reset_at <= t) {
    run('INSERT INTO rate_buckets (key,count,reset_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET count=excluded.count, reset_at=excluded.reset_at', key, 1, t + windowMs);
    return;
  }
  if (row.count >= limit) {
    throw new HttpError(429, 'rate_limited', 'Too many requests. Please slow down.', { retryAfter: Math.ceil((row.reset_at - t) / 1000) });
  }
  run('UPDATE rate_buckets SET count = count + 1 WHERE key = ?', key);
}

// ---------- sessions ----------
export function createSession(userId, req, client = 'web') {
  const token = randomToken(32);
  const csrf = randomToken(24);
  const t = now();
  const id = 'ses_' + randomToken(12);
  run(`INSERT INTO sessions (id,user_id,token_hash,csrf_token,client,ip,user_agent,created_at,last_seen_at,expires_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`, id, userId, sha256(token), csrf, client, clientIp(req),
  String(req.headers['user-agent'] || '').slice(0, 300), t, t, t + config.auth.sessionDays * 86400_000);
  return { id, token, csrf };
}
export function revokeSessions(userId, exceptId = null) {
  run('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL AND id IS NOT ?', now(), userId, exceptId);
}

export function sessionCookie(token, maxAgeSec) {
  const secure = config.publicUrl.startsWith('https://') ? '; Secure' : '';
  return `approx_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSec}${secure}`;
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

/**
 * Resolve the caller. Three credential types:
 *  - web cookie session   (CSRF token required for state-changing requests)
 *  - bearer session token (Android app; not ambient, so no CSRF needed)
 *  - bearer API key apx_… (developer API; scoped)
 */
export function resolveAuth(req) {
  const authz = String(req.headers.authorization || '');
  if (authz.startsWith('Bearer ')) {
    const tok = authz.slice(7).trim();
    if (tok.startsWith('apx_')) {
      const key = one('SELECT * FROM api_keys WHERE key_hash = ? AND revoked_at IS NULL', sha256(tok));
      if (!key) return null;
      const user = one("SELECT * FROM users WHERE id = ? AND status = 'active'", key.user_id);
      if (!user) return null;
      run('UPDATE api_keys SET last_used_at = ? WHERE id = ?', now(), key.id);
      return { user, kind: 'api_key', apiKey: { ...key, scopes: JSON.parse(key.scopes) } };
    }
    return sessionFromToken(tok, 'bearer');
  }
  const cookieTok = parseCookies(req.headers.cookie).approx_session;
  if (cookieTok) return sessionFromToken(cookieTok, 'cookie');
  return null;
}

function sessionFromToken(token, via) {
  const s = one('SELECT * FROM sessions WHERE token_hash = ? AND revoked_at IS NULL', sha256(token));
  if (!s || s.expires_at < now()) return null;
  const user = one("SELECT * FROM users WHERE id = ? AND status = 'active'", s.user_id);
  if (!user) return null;
  if (now() - s.last_seen_at > 60_000) run('UPDATE sessions SET last_seen_at = ? WHERE id = ?', now(), s.id);
  return { user, kind: via === 'cookie' ? 'cookie' : 'session_bearer', session: s };
}

const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
export function enforceCsrf(req, auth) {
  if (auth?.kind !== 'cookie' || !UNSAFE.has(req.method)) return;
  const sent = String(req.headers['x-csrf-token'] || '');
  const ok = sent.length === auth.session.csrf_token.length &&
    crypto.timingSafeEqual(Buffer.from(sent), Buffer.from(auth.session.csrf_token));
  if (!ok) {
    securityEvent(auth.user.id, 'csrf_rejected', 'medium', clientIp(req), { path: req.url });
    throw forbidden('CSRF token missing or invalid', 'csrf_failed');
  }
}

// Route guards ------------------------------------------------------------------
export function requireUser(ctx) {
  if (!ctx.auth) throw unauthorized();
  if (ctx.auth.kind === 'api_key') throw forbidden('API keys cannot access account endpoints', 'api_key_not_allowed');
  return ctx.auth.user;
}
export function requireVerified(user) {
  if (config.auth.requireVerifiedEmailForChat && !user.email_verified) throw forbidden('Please verify your email address first', 'email_not_verified');
}
export function requireRole(ctx, ...roles) {
  const u = requireUser(ctx);
  if (!roles.includes(u.role)) throw forbidden('Insufficient role');
  return u;
}
export function requireScope(ctx, scope) {
  if (!ctx.auth) throw unauthorized('Missing API key');
  if (ctx.auth.kind === 'api_key' && !ctx.auth.apiKey.scopes.includes(scope)) throw forbidden(`API key lacks scope '${scope}'`, 'insufficient_scope');
  return ctx.auth.user;
}

// Privileged API-key scopes (training worker, artifact import): only admins may hold them, and the
// owner's role is re-checked on every call so a demoted account loses the capability immediately.
export const PRIVILEGED_SCOPES = ['training:worker', 'registry:import'];
export function requirePrivileged(ctx, scope) {
  if (!ctx.auth) throw unauthorized('Missing credentials');
  const u = ctx.auth.user;
  if (!['admin', 'superadmin'].includes(u.role)) throw forbidden('This operation requires an administrator', 'admin_required');
  if (ctx.auth.kind === 'api_key' && !ctx.auth.apiKey.scopes.includes(scope)) throw forbidden(`API key lacks scope '${scope}'`, 'insufficient_scope');
  return u;
}
