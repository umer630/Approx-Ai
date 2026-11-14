import crypto from 'node:crypto';
import { one, all, run, now, tx, audit, securityEvent } from '../db.js';
import { readJson, sendJson, bad, unauthorized, forbidden, HttpError, newId, isEmail, str, clientIp } from '../http.js';
import {
  hashPassword, verifyPassword, burnPasswordCheck, passwordPolicy, randomToken, sha256, rateLimit,
  createSession, revokeSessions, sessionCookie, requireUser,
} from '../security.js';
import { sendMail, appLink, mailConfigured } from '../mail.js';
import { config } from '../config.js';
import { verifyGoogleIdToken } from '../google.js';

const HOUR = 3600_000;

async function issueEmailToken(user, purpose, ttlMs, payload = null) {
  const token = randomToken(32);
  await run('UPDATE email_tokens SET used_at = ? WHERE user_id = ? AND purpose = ? AND used_at IS NULL', now(), user.id, purpose);
  await run('INSERT INTO email_tokens (id,user_id,purpose,token_hash,payload,expires_at,created_at) VALUES (?,?,?,?,?,?,?)',
    newId('et_'), user.id, purpose, sha256(token), payload, now() + ttlMs, now());
  return token;
}

async function consumeEmailToken(token, purpose) {
  if (typeof token !== 'string' || token.length < 20 || token.length > 100) throw bad('Invalid or expired token', 'invalid_token');
  const row = await one('SELECT * FROM email_tokens WHERE token_hash = ? AND purpose = ?', sha256(token), purpose);
  if (!row || row.used_at || row.expires_at < now()) throw bad('Invalid or expired token', 'invalid_token');
  await run('UPDATE email_tokens SET used_at = ? WHERE id = ?', now(), row.id);
  return row;
}

async function sessionResponse(res, req, user, client) {
  const s = await createSession(user.id, req, client);
  const body = { user: await publicUser(user), csrf_token: s.csrf };
  if (client === 'mobile') body.token = s.token; // Android stores this in app-private storage
  else res.setHeader('Set-Cookie', sessionCookie(s.token, config.auth.sessionDays * 86400));
  return body;
}

export async function publicUser(u) {
  const p = await one('SELECT display_name, language FROM profiles WHERE user_id = ?', u.id) || {};
  return { id: u.id, email: u.email, email_verified: !!u.email_verified, role: u.role, plan: u.plan, display_name: p.display_name || '', language: p.language || 'auto', created_at: u.created_at };
}

// First-admin bootstrap without a terminal (config.bootstrapSuperadminEmail). Only after the address is verified,
// only while no superadmin exists, atomically, and audited.
async function bootstrapSuperadmin(userId, ip) {
  const target = config.bootstrapSuperadminEmail;
  if (!target) return;
  const promoted = await tx(async () => {
    const u = await one("SELECT id, email, email_verified FROM users WHERE id = ? AND status = 'active'", userId);
    if (!u || !u.email_verified || u.email.toLowerCase() !== target) return false;
    if (await one("SELECT id FROM users WHERE role = 'superadmin' AND status = 'active'")) return false;
    await run("UPDATE users SET role = 'superadmin', updated_at = ? WHERE id = ?", now(), u.id);
    return true;
  });
  if (promoted) await audit(userId, 'bootstrap', 'auth.bootstrap_superadmin', userId, ip, { via: 'APPROX_BOOTSTRAP_SUPERADMIN_EMAIL' });
}

// Email is how accounts are verified and passwords reset. In production, refuse to start those flows when no
// mail transport is configured (instead of telling users to check an inbox that will never receive anything),
// and report delivery failures instead of claiming the email was sent.
function requireMailDelivery() {
  if (config.env === 'production' && !mailConfigured()) {
    throw new HttpError(503, 'email_unavailable', "Email delivery isn't set up on this server yet, so we can't send verification or reset emails. Please try again later.");
  }
}
const mailFailed = (status) => String(status).startsWith('failed');
const deliveryError = () => new HttpError(502, 'email_delivery_failed', "We couldn't send the email right now. Please try again in a few minutes.");

export function registerAuthRoutes(r) {
  r.post('/api/auth/signup', async (req, res) => {
    const ip = clientIp(req);
    await rateLimit(`signup:${ip}`, 10, HOUR);
    const b = await readJson(req);
    const email = str(b.email, 'email', { max: 254 }).toLowerCase();
    if (!isEmail(email)) throw bad('A valid email address is required');
    const pwErr = passwordPolicy(b.password);
    if (pwErr) throw bad(pwErr, 'weak_password');
    await rateLimit(`signup-email:${email}`, 3, HOUR); // applied before lookup: no enumeration, no mail-bombing
    const name = str(b.display_name, 'display_name', { max: 80, required: false }) || '';
    requireMailDelivery();
    const existing = await one('SELECT * FROM users WHERE email = ?', email);
    if (existing) {
      // Same response as a new sign-up (registration status is never revealed). An unverified owner gets a fresh
      // verification code so they are not stuck; a verified owner is told someone tried to sign up.
      let status;
      if (!existing.email_verified && existing.status === 'active') {
        const token = await issueEmailToken(existing, 'verify', 24 * HOUR);
        status = await sendMail(email, 'Verify your Approx AI email', `Welcome to Approx AI.\n\nVerify your email: ${appLink('/#/verify?token=' + token)}\n\nVerification code: ${token}\n\nThis link expires in 24 hours.`);
      } else {
        status = await sendMail(email, 'Approx AI sign-up attempt', 'Someone tried to create an Approx AI account with this email. If it was you, sign in or reset your password.');
      }
      if (mailFailed(status)) throw deliveryError();
      return sendJson(res, 202, { status: 'verification_sent', message: 'If this email can be registered, a verification link has been sent.' });
    }
    const hash = await hashPassword(b.password);
    const id = newId('usr_');
    const t = now();
    await tx(async () => {
      await run('INSERT INTO users (id,email,password_hash,created_at,updated_at) VALUES (?,?,?,?,?)', id, email, hash, t, t);
      await run('INSERT INTO profiles (user_id,display_name) VALUES (?,?)', id, name);
      await run("INSERT INTO settings (user_id, theme) VALUES (?, 'light')", id);
      await run("INSERT INTO subscriptions (id,user_id,plan,status,started_at) VALUES (?,?,'free','active',?)", newId('sub_'), id, t);
    });
    const user = await one('SELECT * FROM users WHERE id = ?', id);
    const token = await issueEmailToken(user, 'verify', 24 * HOUR);
    const sent = await sendMail(email, 'Verify your Approx AI email', `Welcome to Approx AI.\n\nVerify your email: ${appLink('/#/verify?token=' + token)}\n\nVerification code: ${token}\n\nThis link expires in 24 hours.`);
    if (mailFailed(sent)) {
      // Undo the sign-up so the person can simply try again (all user rows cascade from users).
      await run('DELETE FROM users WHERE id = ?', id);
      throw deliveryError();
    }
    await audit(id, id, 'auth.signup', id, ip);
    sendJson(res, 202, { status: 'verification_sent', message: 'If this email can be registered, a verification link has been sent.' });
  });

  r.post('/api/auth/verify-email', async (req, res) => {
    await rateLimit(`verify:${clientIp(req)}`, 30, HOUR);
    const b = await readJson(req);
    const row = await consumeEmailToken(b.token, 'verify');
    await run('UPDATE users SET email_verified = 1, updated_at = ? WHERE id = ?', now(), row.user_id);
    await audit(row.user_id, row.user_id, 'auth.email_verified', row.user_id, clientIp(req));
    await bootstrapSuperadmin(row.user_id, clientIp(req));
    sendJson(res, 200, { status: 'verified' });
  });

  r.post('/api/auth/resend-verification', async (req, res) => {
    const b = await readJson(req);
    const email = String(b.email || '').toLowerCase();
    await rateLimit(`resend:${clientIp(req)}`, 5, HOUR);
    await rateLimit(`resend-email:${email}`, 3, HOUR);
    requireMailDelivery();
    const u = await one('SELECT * FROM users WHERE email = ? AND status = ? AND email_verified = 0', email, 'active');
    if (u) {
      const token = await issueEmailToken(u, 'verify', 24 * HOUR);
      if (mailFailed(await sendMail(u.email, 'Verify your Approx AI email', `Verify your email: ${appLink('/#/verify?token=' + token)}\n\nVerification code: ${token}`))) throw deliveryError();
    }
    sendJson(res, 202, { status: 'ok', message: 'If the account exists and is unverified, a new link has been sent.' });
  });

  r.post('/api/auth/login', async (req, res) => {
    const ip = clientIp(req);
    await rateLimit(`login-ip:${ip}`, 30, 15 * 60_000);
    const b = await readJson(req);
    const email = String(b.email || '').toLowerCase().slice(0, 254);
    const password = typeof b.password === 'string' ? b.password.slice(0, 256) : '';
    const client = b.client === 'mobile' ? 'mobile' : 'web';
    await rateLimit(`login-email:${email}`, 15, 15 * 60_000);
    const user = await one("SELECT * FROM users WHERE email = ? AND status = 'active'", email);
    if (!user) { await burnPasswordCheck(password); throw unauthorized('Incorrect email or password'); }
    if (user.locked_until && user.locked_until > now()) {
      await securityEvent(user.id, 'login_while_locked', 'medium', ip);
      throw new HttpError(423, 'account_locked', 'Account temporarily locked after repeated failed sign-ins. Try again later or reset your password.',
        { retryAfter: Math.ceil((user.locked_until - now()) / 1000) });
    }
    if (!(await verifyPassword(password, user.password_hash))) {
      const fails = user.failed_logins + 1;
      const lock = fails >= config.auth.maxFailedLogins ? now() + config.auth.lockMinutes * 60_000 : null;
      await run('UPDATE users SET failed_logins = ?, locked_until = ? WHERE id = ?', lock ? 0 : fails, lock, user.id);
      await securityEvent(user.id, lock ? 'account_locked' : 'login_failed', lock ? 'high' : 'low', ip, { fails });
      throw unauthorized('Incorrect email or password');
    }
    await run('UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = ?', user.id);
    await audit(user.id, user.id, 'auth.login', client, ip);
    if (user.email_verified) await bootstrapSuperadmin(user.id, ip);
    sendJson(res, 200, await sessionResponse(res, req, await one('SELECT * FROM users WHERE id = ?', user.id), client));
  });

  // Public auth configuration for the sign-in screens (no secrets: Google client IDs are public by design).
  r.get('/api/auth/config', async (req, res) => {
    sendJson(res, 200, { google: { enabled: config.google.clientIds.length > 0, client_id: config.google.clientIds[0] || null },
      email_password: true, email_verification_required: config.auth.requireVerifiedEmailForChat });
  });

  /**
   * Sign in / sign up with Google. Body: { credential: <Google ID token>, client?: 'web'|'mobile' }.
   * The account is found by its Google `sub`; otherwise an existing Approx account with the same (Google-verified)
   * email is linked; otherwise a new account is created. Google verified the address, so it is marked verified.
   */
  async function googleUser(credential, ip) {
    const g = await verifyGoogleIdToken(credential);
    let user = await one("SELECT * FROM users WHERE google_sub = ? AND status = 'active'", g.sub);
    if (!user) {
      const byEmail = await one('SELECT * FROM users WHERE email = ?', g.email);
      if (byEmail && byEmail.status !== 'active') throw forbidden('This account is not active.', 'account_inactive');
      if (byEmail) {
        if (byEmail.google_sub && byEmail.google_sub !== g.sub) throw forbidden('This email is linked to a different Google account.', 'google_mismatch');
        await run('UPDATE users SET google_sub = ?, email_verified = 1, updated_at = ? WHERE id = ?', g.sub, now(), byEmail.id);
        await audit(byEmail.id, byEmail.id, 'auth.google_linked', byEmail.id, ip);
      } else {
        const id = newId('usr_'); const t = now();
        await tx(async () => {
          // No password: '!' never matches a password check. The person can add one later via "Forgot password".
          await run("INSERT INTO users (id,email,password_hash,email_verified,google_sub,created_at,updated_at) VALUES (?,?,'!',1,?,?,?)", id, g.email, g.sub, t, t);
          await run('INSERT INTO profiles (user_id,display_name) VALUES (?,?)', id, g.name);
          await run("INSERT INTO settings (user_id, theme) VALUES (?, 'light')", id);
          await run("INSERT INTO subscriptions (id,user_id,plan,status,started_at) VALUES (?,?,'free','active',?)", newId('sub_'), id, t);
        });
        await audit(id, id, 'auth.signup_google', id, ip);
      }
      user = await one("SELECT * FROM users WHERE google_sub = ? AND status = 'active'", g.sub);
    }
    await bootstrapSuperadmin(user.id, ip);
    return one('SELECT * FROM users WHERE id = ?', user.id);
  }

  r.post('/api/auth/google', async (req, res) => {
    const ip = clientIp(req);
    await rateLimit(`google:${ip}`, 30, 15 * 60_000);
    const b = await readJson(req);
    const user = await googleUser(b.credential, ip);
    await audit(user.id, user.id, 'auth.login_google', b.client === 'mobile' ? 'mobile' : 'web', ip);
    sendJson(res, 200, await sessionResponse(res, req, user, b.client === 'mobile' ? 'mobile' : 'web'));
  });

  // Android: the app opens the web sign-in page with a PKCE-style challenge; after Google sign-in the page gets a
  // one-time code (2 minutes) that is only redeemable with the matching verifier held by the app.
  r.post('/api/auth/google/handoff', async (req, res) => {
    const ip = clientIp(req);
    await rateLimit(`google:${ip}`, 30, 15 * 60_000);
    const b = await readJson(req);
    const challenge = str(b.challenge, 'challenge', { min: 43, max: 64 });
    if (!/^[A-Za-z0-9_-]+$/.test(challenge)) throw bad('Invalid challenge');
    const user = await googleUser(b.credential, ip);
    const code = randomToken(32);
    await run('INSERT INTO auth_handoffs (code_hash,user_id,challenge,expires_at) VALUES (?,?,?,?)', sha256(code), user.id, challenge, now() + 120_000);
    sendJson(res, 200, { code });
  });

  r.post('/api/auth/handoff', async (req, res) => {
    const ip = clientIp(req);
    await rateLimit(`handoff:${ip}`, 30, 15 * 60_000);
    const b = await readJson(req);
    const row = await one('SELECT * FROM auth_handoffs WHERE code_hash = ?', sha256(String(b.code || '')));
    const verifier = String(b.verifier || '');
    const expected = row ? crypto.createHash('sha256').update(verifier).digest('base64url') : '';
    if (!row || row.used_at || row.expires_at < now() || verifier.length < 43 || expected !== row.challenge) {
      throw unauthorized('This sign-in link has expired. Please try again.');
    }
    await run('UPDATE auth_handoffs SET used_at = ? WHERE code_hash = ?', now(), row.code_hash);
    const user = await one("SELECT * FROM users WHERE id = ? AND status = 'active'", row.user_id);
    if (!user) throw unauthorized('Account not available');
    await audit(user.id, user.id, 'auth.login_google', 'mobile', ip);
    sendJson(res, 200, await sessionResponse(res, req, user, 'mobile'));
  });

  r.post('/api/auth/logout', async (req, res, ctx) => {
    if (ctx.auth?.session) await run('UPDATE sessions SET revoked_at = ? WHERE id = ?', now(), ctx.auth.session.id);
    res.setHeader('Set-Cookie', sessionCookie('', 0));
    sendJson(res, 200, { status: 'logged_out' });
  });

  r.get('/api/auth/me', async (req, res, ctx) => {
    const u = requireUser(ctx);
    sendJson(res, 200, { user: await publicUser(u), csrf_token: ctx.auth.session.csrf_token });
  });

  r.post('/api/auth/forgot-password', async (req, res) => {
    const ip = clientIp(req);
    await rateLimit(`forgot:${ip}`, 5, HOUR);
    const b = await readJson(req);
    const email = String(b.email || '').toLowerCase().slice(0, 254);
    await rateLimit(`forgot-email:${email}`, 3, HOUR);
    requireMailDelivery();
    const u = await one("SELECT * FROM users WHERE email = ? AND status = 'active'", email);
    if (u) {
      const token = await issueEmailToken(u, 'reset', HOUR);
      if (mailFailed(await sendMail(u.email, 'Reset your Approx AI password', `Reset your password: ${appLink('/#/reset?token=' + token)}\n\nReset code: ${token}\n\nThis link expires in 1 hour. If you did not request this, ignore this email.`))) throw deliveryError();
      await audit(u.id, 'anonymous', 'auth.password_reset_requested', u.id, ip);
    }
    sendJson(res, 202, { status: 'ok', message: 'If an account exists for this email, a reset link has been sent.' });
  });

  r.post('/api/auth/reset-password', async (req, res) => {
    await rateLimit(`reset:${clientIp(req)}`, 10, HOUR);
    const b = await readJson(req);
    const pwErr = passwordPolicy(b.password);
    if (pwErr) throw bad(pwErr, 'weak_password');
    const row = await consumeEmailToken(b.token, 'reset');
    const hash = await hashPassword(b.password);
    await run('UPDATE users SET password_hash = ?, failed_logins = 0, locked_until = NULL, email_verified = 1, updated_at = ? WHERE id = ?', hash, now(), row.user_id);
    await revokeSessions(row.user_id);
    await audit(row.user_id, row.user_id, 'auth.password_reset', row.user_id, clientIp(req));
    sendJson(res, 200, { status: 'password_reset', message: 'Password updated. All sessions were signed out.' });
  });

  r.post('/api/auth/change-password', async (req, res, ctx) => {
    const u = requireUser(ctx);
    await rateLimit(`chpw:${u.id}`, 10, HOUR);
    const b = await readJson(req);
    if (!(await verifyPassword(String(b.current_password || ''), u.password_hash))) throw forbidden('Current password is incorrect', 'wrong_password');
    const pwErr = passwordPolicy(b.new_password);
    if (pwErr) throw bad(pwErr, 'weak_password');
    await run('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?', await hashPassword(b.new_password), now(), u.id);
    await revokeSessions(u.id, ctx.auth.session.id); // keep current session, revoke all others
    await audit(u.id, u.id, 'auth.password_changed', u.id, clientIp(req));
    await sendMail(u.email, 'Your Approx AI password was changed', 'Your password was changed. If this was not you, reset your password immediately.');
    sendJson(res, 200, { status: 'password_changed' });
  });

  r.post('/api/auth/change-email', async (req, res, ctx) => {
    const u = requireUser(ctx);
    await rateLimit(`chemail:${u.id}`, 5, HOUR);
    const b = await readJson(req);
    if (!(await verifyPassword(String(b.password || ''), u.password_hash))) throw forbidden('Password is incorrect', 'wrong_password');
    const email = String(b.new_email || '').toLowerCase();
    if (!isEmail(email)) throw bad('A valid email address is required');
    const token = await issueEmailToken(u, 'email_change', 24 * HOUR, email);
    if (!await one('SELECT id FROM users WHERE email = ?', email)) {
      await sendMail(email, 'Confirm your new Approx AI email', `Confirm: ${appLink('/#/confirm-email?token=' + token)}\n\nCode: ${token}`);
    }
    sendJson(res, 202, { status: 'confirmation_sent' });
  });

  r.post('/api/auth/confirm-email-change', async (req, res) => {
    const b = await readJson(req);
    const row = await consumeEmailToken(b.token, 'email_change');
    if (await one('SELECT id FROM users WHERE email = ?', row.payload)) throw bad('Email is already in use');
    await run('UPDATE users SET email = ?, email_verified = 1, updated_at = ? WHERE id = ?', row.payload, now(), row.user_id);
    await revokeSessions(row.user_id);
    await audit(row.user_id, row.user_id, 'auth.email_changed', row.user_id, clientIp(req));
    sendJson(res, 200, { status: 'email_changed' });
  });

  r.get('/api/auth/sessions', async (req, res, ctx) => {
    const u = requireUser(ctx);
    const rows = await all('SELECT id, client, ip, user_agent, created_at, last_seen_at FROM sessions WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ? ORDER BY last_seen_at DESC', u.id, now());
    sendJson(res, 200, { sessions: rows.map((s) => ({ ...s, current: s.id === ctx.auth.session.id })) });
  });

  r.delete('/api/auth/sessions/:id', async (req, res, ctx, p) => {
    const u = requireUser(ctx);
    await run('UPDATE sessions SET revoked_at = ? WHERE id = ? AND user_id = ?', now(), p.id, u.id);
    sendJson(res, 200, { status: 'revoked' });
  });

  r.post('/api/auth/sessions/revoke-others', async (req, res, ctx) => {
    const u = requireUser(ctx);
    await revokeSessions(u.id, ctx.auth.session.id);
    sendJson(res, 200, { status: 'revoked' });
  });

  r.post('/api/account/delete', async (req, res, ctx) => {
    const u = requireUser(ctx);
    const b = await readJson(req);
    if (!(await verifyPassword(String(b.password || ''), u.password_hash))) throw forbidden('Password is incorrect', 'wrong_password');
    if (b.confirm !== 'DELETE') throw bad("Type DELETE to confirm");
    // Hard-delete all user content (cascade) and anonymize the user row for audit integrity.
    const { removeUserFiles } = await import('./files.js');
    await removeUserFiles(u.id);
    await tx(async () => {
      for (const t of ['messages', 'chats', 'memories', 'files', 'projects', 'artifacts', 'code_files', 'code_proposals', 'api_keys', 'model_access', 'usage_events', 'notifications', 'sessions', 'email_tokens', 'api_requests'])
        await run(`DELETE FROM ${t} WHERE user_id = ?`, u.id);
      await run("UPDATE users SET email = ?, password_hash = '!', status = 'deleted', updated_at = ? WHERE id = ?", `deleted+${u.id}@approx.invalid`, now(), u.id);
      await run("UPDATE profiles SET display_name = '' WHERE user_id = ?", u.id);
    });
    await audit(u.id, u.id, 'account.deleted', u.id, clientIp(req));
    res.setHeader('Set-Cookie', sessionCookie('', 0));
    sendJson(res, 200, { status: 'deleted' });
  });
}
