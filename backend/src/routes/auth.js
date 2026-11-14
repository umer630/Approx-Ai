import crypto from 'node:crypto';
import { one, all, run, now, tx, audit, securityEvent } from '../db.js';
import { readJson, sendJson, bad, unauthorized, forbidden, HttpError, newId, isEmail, str, clientIp } from '../http.js';
import {
  verifyPassword, burnPasswordCheck, passwordPolicy, randomToken, sha256, rateLimit,
  createSession, revokeSessions, sessionCookie, requireUser,
} from '../security.js';
import { sendMail } from '../mail.js';
import { sb, SupabaseError, toHttpError, requireSupabase, supabaseConfigured } from '../supabase.js';
import { config } from '../config.js';
import { verifyGoogleIdToken } from '../google.js';

const HOUR = 3600_000;


// Supabase Auth is the identity provider for email + password accounts. The backend never sees or stores those
// passwords (accounts linked to Supabase carry password_hash '!'): it asks Supabase to verify them and then issues its
// own Approx session (cookie for web, bearer token for the Android app), so roles, plans, quota and CSRF are unchanged.
async function localUserFor(sbUser, ip, { displayName = '' } = {}) {
  const uid = String(sbUser.id);
  const email = String(sbUser.email || '').toLowerCase();
  const verified = !!(sbUser.email_confirmed_at || sbUser.confirmed_at);
  let u = await one('SELECT * FROM users WHERE supabase_uid = ?', uid);
  if (!u) {
    const byEmail = await one('SELECT * FROM users WHERE email = ?', email);
    if (byEmail) {
      if (byEmail.supabase_uid && byEmail.supabase_uid !== uid) throw forbidden('This email is linked to a different sign-in account.', 'account_conflict');
      if (!verified) return null; // never link an existing account before Supabase has confirmed the address
      // Existing account (earlier sign-in system or Google): link it. Its old local password stops working.
      await run("UPDATE users SET supabase_uid = ?, password_hash = '!', email_verified = 1, failed_logins = 0, locked_until = NULL, updated_at = ? WHERE id = ?",
        uid, now(), byEmail.id);
      await audit(byEmail.id, byEmail.id, 'auth.supabase_linked', byEmail.id, ip);
    } else {
      const id = newId('usr_'); const t = now();
      await tx(async () => {
        await run("INSERT INTO users (id,email,password_hash,email_verified,supabase_uid,created_at,updated_at) VALUES (?,?,'!',?,?,?,?)", id, email, verified ? 1 : 0, uid, t, t);
        await run('INSERT INTO profiles (user_id,display_name) VALUES (?,?)', id, String(displayName || sbUser.user_metadata?.display_name || '').slice(0, 80));
        await run("INSERT INTO settings (user_id, theme) VALUES (?, 'light')", id);
        await run("INSERT INTO subscriptions (id,user_id,plan,status,started_at) VALUES (?,?,'free','active',?)", newId('sub_'), id, t);
      });
      await audit(id, id, 'auth.signup', id, ip);
    }
    u = await one('SELECT * FROM users WHERE supabase_uid = ?', uid);
  } else {
    // Keep the local copy in sync with Supabase (verification state and a confirmed email change).
    if (verified && email && email !== u.email && !(await one('SELECT id FROM users WHERE email = ? AND id != ?', email, u.id))) {
      await run('UPDATE users SET email = ?, updated_at = ? WHERE id = ?', email, now(), u.id);
      await audit(u.id, u.id, 'auth.email_changed', u.id, ip);
    }
    if (verified && !u.email_verified) await run('UPDATE users SET email_verified = 1, updated_at = ? WHERE id = ?', now(), u.id);
    u = await one('SELECT * FROM users WHERE id = ?', u.id);
  }
  // Suspended / deleted accounts get the same answer as a wrong password (account status is never revealed).
  if (u.status !== 'active') throw unauthorized('Incorrect email or password');
  return u;
}

// Supabase calls → HTTP errors the apps understand.
async function viaSupabase(fn) {
  try { return await fn(); } catch (e) { throw toHttpError(e); }
}

// A pasted code (Android / "Have a code?") is the token hash from the Supabase email; a link lands on the web app with
// an access token (implicit flow) or a token hash (custom email templates). Returns { user, accessToken }.
async function identityFromCallback(b, types) {
  if (typeof b.access_token === 'string' && b.access_token.length > 20) {
    const user = await viaSupabase(() => sb.getUser(b.access_token));
    return { user, accessToken: b.access_token };
  }
  const th = String(b.token_hash || b.token || '').trim();
  if (th.length < 6 || th.length > 200) throw bad('Invalid or expired token', 'invalid_token');
  const tryTypes = b.type && types.includes(b.type) ? [b.type] : types;
  let last;
  for (const type of tryTypes) {
    try {
      const s = await sb.verifyTokenHash(th, type);
      return { user: s.user, accessToken: s.access_token };
    } catch (e) { last = e; }
  }
  throw toHttpError(last);
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

export function registerAuthRoutes(r) {
  r.post('/api/auth/signup', async (req, res) => {
    const ip = clientIp(req);
    await rateLimit(`signup:${ip}`, 10, HOUR);
    const b = await readJson(req);
    const email = str(b.email, 'email', { max: 254 }).toLowerCase();
    if (!isEmail(email)) throw bad('A valid email address is required');
    const pwErr = passwordPolicy(b.password);
    if (pwErr) throw bad(pwErr, 'weak_password');
    await rateLimit(`signup-email:${email}`, 3, HOUR); // applied before any lookup: no enumeration, no mail-bombing
    const name = str(b.display_name, 'display_name', { max: 80, required: false }) || '';
    requireSupabase();
    // Supabase creates the unconfirmed user and sends the confirmation email. For an address that is already
    // registered it answers the same way (no enumeration) and re-sends the link if that account is still unconfirmed.
    const created = await viaSupabase(() => sb.signUp(email, b.password, name));
    const sbUser = created?.user || created;
    if (sbUser?.id && Array.isArray(sbUser.identities) && sbUser.identities.length && !(await one('SELECT id FROM users WHERE email = ?', email))) {
      await localUserFor(sbUser, ip, { displayName: name });
    }
    sendJson(res, 202, { status: 'verification_sent', message: 'If this email can be registered, a verification link has been sent.' });
  });

  r.post('/api/auth/verify-email', async (req, res) => {
    const ip = clientIp(req);
    await rateLimit(`verify:${ip}`, 30, HOUR);
    const b = await readJson(req);
    requireSupabase();
    const { user: sbUser, accessToken } = await identityFromCallback(b, ['signup', 'email']);
    if (!(sbUser?.email_confirmed_at || sbUser?.confirmed_at)) throw bad('Invalid or expired token', 'invalid_token');
    const u = await localUserFor(sbUser, ip);
    await audit(u.id, u.id, 'auth.email_verified', u.id, ip);
    await bootstrapSuperadmin(u.id, ip);
    if (accessToken) await sb.logout(accessToken);
    // The web app signs the person in straight from the confirmation link; the Android app shows its sign-in screen.
    if (b.sign_in === true) return sendJson(res, 200, { status: 'verified', ...(await sessionResponse(res, req, await one('SELECT * FROM users WHERE id = ?', u.id), 'web')) });
    sendJson(res, 200, { status: 'verified' });
  });

  r.post('/api/auth/resend-verification', async (req, res) => {
    const b = await readJson(req);
    const email = String(b.email || '').toLowerCase().slice(0, 254);
    await rateLimit(`resend:${clientIp(req)}`, 5, HOUR);
    await rateLimit(`resend-email:${email}`, 3, HOUR);
    if (!isEmail(email)) throw bad('A valid email address is required');
    requireSupabase();
    await viaSupabase(() => sb.resendSignup(email));
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
    if (!email || !password) throw unauthorized('Incorrect email or password');
    requireSupabase();
    let grant;
    try {
      grant = await sb.passwordGrant(email, password);
    } catch (e) {
      if (e instanceof SupabaseError && ['invalid_credentials', 'invalid_grant'].includes(e.code)) {
        // One-time migration of an account created by the earlier sign-in system: if its old password is correct,
        // create the Supabase account with that password (Supabase emails a confirmation link) instead of failing.
        const legacy = await one("SELECT * FROM users WHERE email = ? AND status = 'active' AND supabase_uid IS NULL AND password_hash LIKE 'scrypt$%'", email);
        if (legacy && await verifyPassword(password, legacy.password_hash)) {
          await viaSupabase(() => sb.signUp(email, password, ''));
          await audit(legacy.id, legacy.id, 'auth.migration_email_sent', legacy.id, ip);
          throw new HttpError(409, 'account_migration_required',
            'Approx AI has moved to a new sign-in system. We emailed you a confirmation link — open it, then sign in again with the same password.');
        }
        if (!legacy) await burnPasswordCheck(password);
        const known = await one('SELECT id FROM users WHERE email = ?', email);
        if (known) await securityEvent(known.id, 'login_failed', 'low', ip);
      }
      throw toHttpError(e);
    }
    const u = await localUserFor(grant.user, ip);
    await sb.logout(grant.access_token);
    if (!u) throw unauthorized('Incorrect email or password');
    await audit(u.id, u.id, 'auth.login', client, ip);
    if (u.email_verified) await bootstrapSuperadmin(u.id, ip);
    sendJson(res, 200, await sessionResponse(res, req, await one('SELECT * FROM users WHERE id = ?', u.id), client));
  });

  // Public auth configuration for the sign-in screens (no secrets: Google client IDs are public by design).
  r.get('/api/auth/config', async (req, res) => {
    sendJson(res, 200, { google: { enabled: config.google.clientIds.length > 0, client_id: config.google.clientIds[0] || null },
      email_password: true, email_verification_required: config.auth.requireVerifiedEmailForChat,
      provider: 'supabase', provider_configured: supabaseConfigured() });
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
    if (!isEmail(email)) throw bad('A valid email address is required');
    requireSupabase();
    await viaSupabase(() => sb.recover(email)); // Supabase sends the reset link; unknown addresses get the same answer
    const u = await one("SELECT id FROM users WHERE email = ? AND status = 'active'", email);
    if (u) await audit(u.id, 'anonymous', 'auth.password_reset_requested', u.id, ip);
    sendJson(res, 202, { status: 'ok', message: 'If an account exists for this email, a reset link has been sent.' });
  });

  r.post('/api/auth/reset-password', async (req, res) => {
    const ip = clientIp(req);
    await rateLimit(`reset:${ip}`, 10, HOUR);
    const b = await readJson(req);
    const pwErr = passwordPolicy(b.password);
    if (pwErr) throw bad(pwErr, 'weak_password');
    requireSupabase();
    const { user: sbUser, accessToken } = await identityFromCallback(b, ['recovery']);
    await viaSupabase(() => sb.updateUser(accessToken, { password: b.password }));
    // The reset link proved control of the mailbox, so the address counts as verified.
    const u = await localUserFor({ ...sbUser, email_confirmed_at: sbUser.email_confirmed_at || new Date().toISOString() }, ip);
    await sb.logout(accessToken);
    if (u) {
      await run('UPDATE users SET failed_logins = 0, locked_until = NULL, email_verified = 1, updated_at = ? WHERE id = ?', now(), u.id);
      await revokeSessions(u.id);
      await audit(u.id, u.id, 'auth.password_reset', u.id, ip);
    }
    sendJson(res, 200, { status: 'password_reset', message: 'Password updated. All sessions were signed out.' });
  });

  // Re-authenticate with Supabase (current password) and return its short-lived access token.
  async function reauth(u, password) {
    if (!u.supabase_uid) throw forbidden('This account signs in with Google. Use "Forgot password" to add an email password first.', 'no_password');
    try { return await sb.passwordGrant(u.email, String(password || '').slice(0, 256)); } catch (e) {
      if (e instanceof SupabaseError && ['invalid_credentials', 'invalid_grant'].includes(e.code)) throw forbidden('Password is incorrect', 'wrong_password');
      throw toHttpError(e);
    }
  }

  r.post('/api/auth/change-password', async (req, res, ctx) => {
    const u = requireUser(ctx);
    await rateLimit(`chpw:${u.id}`, 10, HOUR);
    const b = await readJson(req);
    const pwErr = passwordPolicy(b.new_password);
    if (pwErr) throw bad(pwErr, 'weak_password');
    requireSupabase();
    const g = await reauth(u, b.current_password).catch((e) => { throw e.code === 'wrong_password' ? forbidden('Current password is incorrect', 'wrong_password') : e; });
    await viaSupabase(() => sb.updateUser(g.access_token, { password: b.new_password }));
    await sb.logout(g.access_token);
    await revokeSessions(u.id, ctx.auth.session.id); // keep current session, revoke all others
    await audit(u.id, u.id, 'auth.password_changed', u.id, clientIp(req));
    await sendMail(u.email, 'Your Approx AI password was changed', 'Your password was changed. If this was not you, reset your password immediately.');
    sendJson(res, 200, { status: 'password_changed' });
  });

  r.post('/api/auth/change-email', async (req, res, ctx) => {
    const u = requireUser(ctx);
    await rateLimit(`chemail:${u.id}`, 5, HOUR);
    const b = await readJson(req);
    const email = String(b.new_email || '').toLowerCase();
    if (!isEmail(email)) throw bad('A valid email address is required');
    requireSupabase();
    const g = await reauth(u, b.password);
    // Supabase emails the confirmation link(s) (with "secure email change" on: one to each address).
    await viaSupabase(() => sb.updateUser(g.access_token, { email }));
    await sb.logout(g.access_token);
    sendJson(res, 202, { status: 'confirmation_sent' });
  });

  r.post('/api/auth/confirm-email-change', async (req, res) => {
    const ip = clientIp(req);
    await rateLimit(`confirm-email:${ip}`, 30, HOUR);
    const b = await readJson(req);
    requireSupabase();
    const { user: sbUser, accessToken } = await identityFromCallback(b, ['email_change']);
    if (sbUser.new_email) { // the other address still has to confirm
      if (accessToken) await sb.logout(accessToken);
      return sendJson(res, 202, { status: 'confirmation_pending', message: 'Confirmed. Now open the link sent to your other email address to finish the change.' });
    }
    const before = await one('SELECT * FROM users WHERE supabase_uid = ?', String(sbUser.id));
    const u = await localUserFor(sbUser, ip);
    if (accessToken) await sb.logout(accessToken);
    if (before && u && before.email !== u.email) await revokeSessions(u.id);
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
    if (b.confirm !== 'DELETE') throw bad("Type DELETE to confirm");
    let supabaseDeleted = false;
    if (u.supabase_uid) {
      requireSupabase();
      const g = await reauth(u, b.password);
      await sb.logout(g.access_token);
      // With the server-only secret key the Supabase identity is deleted too; otherwise it stays (and the deleted
      // Approx account refuses to sign in again) until removed in the Supabase dashboard.
      try { supabaseDeleted = !!(await sb.adminDeleteUser(u.supabase_uid)); } catch { supabaseDeleted = false; }
    } else if (!(await verifyPassword(String(b.password || ''), u.password_hash))) throw forbidden('Password is incorrect', 'wrong_password');
    // Hard-delete all user content (cascade) and anonymize the user row for audit integrity.
    const { removeUserFiles } = await import('./files.js');
    await removeUserFiles(u.id);
    await tx(async () => {
      for (const t of ['messages', 'chats', 'memories', 'files', 'projects', 'artifacts', 'code_files', 'code_proposals', 'api_keys', 'model_access', 'usage_events', 'notifications', 'sessions', 'email_tokens', 'api_requests'])
        await run(`DELETE FROM ${t} WHERE user_id = ?`, u.id);
      await run("UPDATE users SET email = ?, password_hash = '!', status = 'deleted', supabase_uid = CASE WHEN ? THEN NULL ELSE supabase_uid END, updated_at = ? WHERE id = ?",
        `deleted+${u.id}@approx.invalid`, supabaseDeleted ? 1 : 0, now(), u.id);
      await run("UPDATE profiles SET display_name = '' WHERE user_id = ?", u.id);
    });
    await audit(u.id, u.id, 'account.deleted', u.id, clientIp(req));
    res.setHeader('Set-Cookie', sessionCookie('', 0));
    sendJson(res, 200, { status: 'deleted' });
  });
}
