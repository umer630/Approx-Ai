import crypto from 'node:crypto';
import { one, all, run, now, tx, audit, securityEvent } from '../db.js';
import { readJson, sendJson, bad, unauthorized, forbidden, HttpError, newId, isEmail, str, clientIp } from '../http.js';
import {
  verifyPassword, burnPasswordCheck, passwordPolicy, randomToken, sha256, rateLimit,
  createSession, revokeSessions, sessionCookie, requireUser,
} from '../security.js';
import { sendMail } from '../mail.js';
import { notify } from '../notify.js';
import { sb, SupabaseError, toHttpError, requireSupabase, supabaseConfigured, isEmailDeliveryFailure } from '../supabase.js';
import { config } from '../config.js';
import { verifyGoogleIdToken } from '../google.js';
import { platformSetting, requestCountry, statusMessage } from '../admin.js';

const HOUR = 3600_000;


// Supabase Auth is the identity provider for email + password accounts. The backend never sees or stores those
// passwords (accounts linked to Supabase carry password_hash '!'): it asks Supabase to verify them and then issues its
// own Approx session (cookie for web, bearer token for the Android app), so roles, plans, quota and CSRF are unchanged.
export async function localUserFor(sbUser, ip, { displayName = '' } = {}) {
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
        const approval = (await platformSetting('require_approval', '0')) === '1' ? 'pending' : 'approved';
        await run("INSERT INTO users (id,email,password_hash,email_verified,supabase_uid,approval_status,created_at,updated_at) VALUES (?,?,'!',?,?,?,?,?)", id, email, verified ? 1 : 0, uid, approval, t, t);
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

// Two-step verification (Supabase MFA, TOTP). With a verified factor, a correct password is not enough: the
// 6-digit code from the authenticator app must be verified on the same Supabase session (aal1 → aal2).
// Returns the aal2 access token (or the original token when MFA is off). The caller logs the token out.
export async function mfaGate(grant, code) {
  const factor = (grant.user?.factors || []).find((f) => f.factor_type === 'totp' && f.status === 'verified');
  if (!factor) return { token: grant.access_token, mfa: false };
  if (!code) throw new HttpError(401, 'mfa_required', 'Enter the 6-digit code from your authenticator app.');
  try {
    const ch = await sb.mfaChallenge(grant.access_token, factor.id);
    const v = await sb.mfaVerify(grant.access_token, factor.id, ch.id, String(code).replace(/\s+/g, '').slice(0, 10));
    return { token: v.access_token, mfa: true, factor_id: factor.id };
  } catch (e) {
    if (e instanceof SupabaseError && e.status < 500) throw new HttpError(401, 'mfa_invalid', 'That code is not correct or has expired. Use the current code from your authenticator app.');
    throw toHttpError(e);
  }
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
  // A typed code (digits from the email) is an email OTP and must be verified WITH the address — Supabase rejects it
  // as a token_hash. Link tokens (token_hash) keep the hash path.
  const isCode = !b.token_hash && /^\d{6,10}$/.test(th);
  const email = String(b.email || '').trim().toLowerCase();
  if (isCode && !isEmail(email)) throw bad('Enter the email address the code was sent to.', 'email_required');
  let last;
  for (const type of tryTypes) {
    try {
      const s = isCode ? await sb.verifyEmailOtp(email, th, type) : await sb.verifyTokenHash(th, type);
      return { user: s.user, accessToken: s.access_token };
    } catch (e) { last = e; }
  }
  throw toHttpError(last);
}

async function sessionResponse(res, req, user, client) {
  // Suspended / rejected / disabled accounts never get a session (pending accounts do, with limited access).
  if (['suspended', 'rejected', 'disabled'].includes(user.approval_status)) {
    throw new HttpError(403, `account_${user.approval_status}`, statusMessage(user.approval_status));
  }
  const country = requestCountry(req);
  // A sign-in from a device (client + browser/app) this account has never used before is a security notification.
  const ua = String(req.headers['user-agent'] || '').slice(0, 300);
  const known = await one('SELECT 1 FROM sessions WHERE user_id = ? AND client = ? AND user_agent = ? LIMIT 1', user.id, client, ua);
  const first = !(await one('SELECT 1 FROM sessions WHERE user_id = ? LIMIT 1', user.id));
  await run('UPDATE users SET last_login_at = ?, country = COALESCE(?, country) WHERE id = ?', now(), country, user.id);
  if (!known && !first) await notify(user.id, { kind: 'security', title: 'New sign-in', body: `Your account was signed in on a new device (${client === 'mobile' ? 'Android app' : 'web browser'}${country ? `, ${country}` : ''}).`, link: '#/settings/security' });
  const s = await createSession(user.id, req, client);
  const body = { user: await publicUser(user), csrf_token: s.csrf };
  if (client === 'mobile') body.token = s.token; // Android stores this in app-private storage
  else res.setHeader('Set-Cookie', sessionCookie(s.token, config.auth.sessionDays * 86400));
  return body;
}

export async function publicUser(u) {
  const p = await one('SELECT display_name, language FROM profiles WHERE user_id = ?', u.id) || {};
  const approval = u.approval_status || 'approved';
  return { id: u.id, email: u.email, email_verified: !!u.email_verified, mfa_enabled: !!u.mfa_enabled, role: u.role, plan: u.plan, display_name: p.display_name || '', language: p.language || 'auto', created_at: u.created_at,
    approval_status: approval, status_message: statusMessage(approval) };
}

// First superadmin. Called ONLY from the administrator sign-in (/api/admin/auth/login), never from client sign-up,
// verification or client login: a client account is never elevated by signing up. Requires the address to be on the
// server allowlist (checked by the caller), verified, equal to APPROX_BOOTSTRAP_SUPERADMIN_EMAIL, and no active
// superadmin to exist yet. Atomic and audited.
export async function bootstrapSuperadmin(userId, ip) {
  const target = config.bootstrapSuperadminEmail;
  if (!target) return;
  const promoted = await tx(async () => {
    const u = await one("SELECT id, email, email_verified FROM users WHERE id = ? AND status = 'active'", userId);
    if (!u || !u.email_verified || u.email.toLowerCase() !== target) return false;
    if (await one("SELECT id FROM users WHERE role = 'superadmin' AND status = 'active'")) return false;
    await run("UPDATE users SET role = 'superadmin', updated_at = ? WHERE id = ?", now(), u.id);
    return true;
  });
  if (promoted) await audit(userId, 'bootstrap', 'auth.bootstrap_superadmin', userId, ip, { via: 'admin sign-in + APPROX_BOOTSTRAP_SUPERADMIN_EMAIL' });
  return promoted;
}

// Outcome of every verification-email request, for the admin diagnostics (no address, no token — outcome only).
// "accepted_by_supabase" means Supabase handed the email to its mail service; inbox delivery is not observable here.
async function emailEvent(kind, outcome, ip) {
  try { await audit(null, 'system', `auth.email_${kind}`, null, ip, { outcome: String(outcome).slice(0, 60) }); } catch { /* never block auth */ }
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
    let created;
    try { created = await viaSupabase(() => sb.signUp(email, b.password, name)); }
    catch (e) { await emailEvent('signup', e.code || 'error', ip); throw e; }
    const sbUser = created?.user || created;
    // Supabase hides existing accounts: for an address that is already registered AND confirmed it answers like a
    // success but returns no identities and sends NO email. That is the "signup said sent, but nothing arrived" case.
    const newOrUnconfirmed = !!(sbUser?.id && Array.isArray(sbUser.identities) && sbUser.identities.length);
    if (newOrUnconfirmed && !(await one('SELECT id FROM users WHERE email = ?', email))) await localUserFor(sbUser, ip, { displayName: name });
    await emailEvent('signup', newOrUnconfirmed ? 'accepted_by_supabase' : 'existing_account_no_email', ip);
    // Same answer either way (no account enumeration), but it no longer implies an email was sent to existing accounts.
    sendJson(res, 202, { status: 'verification_sent', resend_after_s: 60,
      message: 'If this email is new, a verification link is on its way (check Spam too). If you already have an Approx account with this email, no new link is sent — sign in, or use Forgot password.' });
  });

  r.post('/api/auth/verify-email', async (req, res) => {
    const ip = clientIp(req);
    await rateLimit(`verify:${ip}`, 30, HOUR);
    const b = await readJson(req);
    // Optional (API 1.9): the password for this account, set once the code/link proves control of the mailbox.
    // Needed because Supabase never changes the password of an existing UNCONFIRMED account on a repeated sign-up
    // ("we can't be sure of their claimed identity"): someone who signed up twice keeps the FIRST password, verifies
    // with the new code, and their sign-in with the password they just chose fails. Setting it here, after the proof,
    // makes the verified identity and the password the person knows the same thing.
    // The password changes ONLY when the person explicitly chose a new one (set_password: true). Verifying never
    // touches the existing password otherwise — a typo here must not replace the password the account already has.
    // (Clients before API 1.12 sent the sign-up password with every verification; it is ignored unless set_password.)
    const password = b.set_password === true && typeof b.password === 'string' && b.password !== '' ? b.password : null;
    if (password !== null) { const pwErr = passwordPolicy(password); if (pwErr) throw bad(pwErr, 'weak_password'); }
    requireSupabase();
    const { user: sbUser, accessToken } = await identityFromCallback(b, ['signup', 'email']);
    if (!(sbUser?.email_confirmed_at || sbUser?.confirmed_at)) throw bad('Invalid or expired token', 'invalid_token');
    if (password !== null) {
      if (!accessToken) throw bad('Invalid or expired token', 'invalid_token');
      try { await sb.updateUser(accessToken, { password }); }
      catch (e) { if (!(e instanceof SupabaseError && e.code === 'same_password')) { await sb.logout(accessToken); throw toHttpError(e); } }
    }
    const u = await localUserFor(sbUser, ip);
    await audit(u.id, u.id, 'auth.email_verified', u.id, ip, password !== null ? { password_set: true } : undefined);
    if (accessToken) await sb.logout(accessToken);
    if (password !== null) await revokeSessions(u.id);   // sessions opened with any earlier password end here
    // Signing in right away (web: cookie, Android: bearer token) — the person has just proven the mailbox AND set the password.
    const client = b.client === 'mobile' ? 'mobile' : 'web';
    if (b.sign_in === true) return sendJson(res, 200, { status: 'verified', password_set: password !== null, ...(await sessionResponse(res, req, await one('SELECT * FROM users WHERE id = ?', u.id), client)) });
    sendJson(res, 200, { status: 'verified', password_set: password !== null });
  });

  r.post('/api/auth/resend-verification', async (req, res) => {
    const b = await readJson(req);
    const email = String(b.email || '').toLowerCase().slice(0, 254);
    await rateLimit(`resend:${clientIp(req)}`, 5, HOUR);
    await rateLimit(`resend-email:${email}`, 3, HOUR);
    if (!isEmail(email)) throw bad('A valid email address is required');
    requireSupabase();
    try { await viaSupabase(() => sb.resendSignup(email)); }
    catch (e) { await emailEvent('resend', e.code || 'error', clientIp(req)); throw e; }
    await emailEvent('resend', 'accepted_by_supabase', clientIp(req));
    sendJson(res, 202, { status: 'ok', resend_after_s: 60,
      message: 'If this account exists and is not verified yet, a new link is on its way (check Spam too). Verified accounts do not get a new link — sign in instead.' });
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
          try { await sb.signUp(email, password, ''); } catch (e2) {
            if (isEmailDeliveryFailure(e2)) {
              throw new HttpError(502, 'email_delivery_failed', 'Approx AI has moved to a new sign-in system and your account needs a one-time '
                + "confirmation email, but the email could not be sent right now. Your account and data are safe — please try again later.");
            }
            throw toHttpError(e2);
          }
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
    // The grant comes straight from Supabase over TLS; still require a complete, confirmed identity before trusting it.
    if (!grant?.access_token || !grant?.user?.id || !grant.user.email) throw new HttpError(502, 'auth_unavailable', 'Sign-in service returned an incomplete response. Please try again.');
    if (!(grant.user.email_confirmed_at || grant.user.confirmed_at)) {
      await sb.logout(grant.access_token);
      throw new HttpError(403, 'email_not_verified', 'Please verify your email first. Check your inbox (and spam folder) for the confirmation link, or resend it.');
    }
    let gate;
    try { gate = await mfaGate(grant, b.mfa_code); } catch (e) {
      await sb.logout(grant.access_token);
      if (e.code === 'mfa_invalid') { const known = await one('SELECT id FROM users WHERE email = ?', email); if (known) await securityEvent(known.id, 'mfa_failed', 'medium', ip); }
      throw e;
    }
    const u = await localUserFor(grant.user, ip);
    await sb.logout(gate.token);
    if (!u) throw unauthorized('Incorrect email or password');
    await run('UPDATE users SET mfa_enabled = ? WHERE id = ?', gate.mfa ? 1 : 0, u.id);
    await audit(u.id, u.id, 'auth.login', client, ip, gate.mfa ? { mfa: true } : undefined);
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
          const approval = (await platformSetting('require_approval', '0')) === '1' ? 'pending' : 'approved';
          await run("INSERT INTO users (id,email,password_hash,email_verified,google_sub,approval_status,created_at,updated_at) VALUES (?,?,'!',1,?,?,?,?)", id, g.email, g.sub, approval, t, t);
          await run('INSERT INTO profiles (user_id,display_name) VALUES (?,?)', id, g.name);
          await run("INSERT INTO settings (user_id, theme) VALUES (?, 'light')", id);
          await run("INSERT INTO subscriptions (id,user_id,plan,status,started_at) VALUES (?,?,'free','active',?)", newId('sub_'), id, t);
        });
        await audit(id, id, 'auth.signup_google', id, ip);
      }
      user = await one("SELECT * FROM users WHERE google_sub = ? AND status = 'active'", g.sub);
    }
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
    if (ctx.auth?.session) {
      await run('UPDATE sessions SET revoked_at = ? WHERE id = ?', now(), ctx.auth.session.id);
      await audit(ctx.auth.user.id, ctx.auth.user.id, 'auth.logout', ctx.auth.session.client, clientIp(req));
    }
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
    try { await viaSupabase(() => sb.recover(email)); } // Supabase sends the reset link; unknown addresses get the same answer
    catch (e) { await emailEvent('recovery', e.code || 'error', ip); throw e; }
    await emailEvent('recovery', 'accepted_by_supabase', ip);
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

  // ---------------------------------------------------------------- two-step verification (TOTP)
  r.get('/api/auth/mfa', async (req, res, ctx) => {
    const u = requireUser(ctx);
    sendJson(res, 200, { enabled: !!u.mfa_enabled, available: !!u.supabase_uid });
  });
  // Step 1: password → a new authenticator secret (shown once as a QR code / setup key). Not active until step 2.
  r.post('/api/auth/mfa/enroll', async (req, res, ctx) => {
    const u = requireUser(ctx);
    await rateLimit(`mfa:${u.id}`, 20, HOUR);
    const b = await readJson(req);
    if (u.mfa_enabled) throw new HttpError(409, 'mfa_already_enabled', 'Two-step verification is already on.');
    const g = await reauth(u, b.password);
    try {
      const f = await viaSupabase(() => sb.mfaEnroll(g.access_token));
      sendJson(res, 200, { factor_id: f.id, secret: f.totp?.secret, uri: f.totp?.uri, qr_code: f.totp?.qr_code });
    } finally { await sb.logout(g.access_token); }
  });
  // Step 2: password + the first code from the app → the factor is verified; from now on sign-in needs a code.
  r.post('/api/auth/mfa/verify', async (req, res, ctx) => {
    const u = requireUser(ctx);
    await rateLimit(`mfa:${u.id}`, 20, HOUR);
    const b = await readJson(req);
    const g = await reauth(u, b.password);
    try {
      const ch = await viaSupabase(() => sb.mfaChallenge(g.access_token, String(b.factor_id || '')));
      let v;
      try { v = await sb.mfaVerify(g.access_token, String(b.factor_id), ch.id, String(b.code || '').replace(/\s+/g, '')); }
      catch (e) { if (e instanceof SupabaseError && e.status < 500) throw bad('That code is not correct. Enter the current 6-digit code from your authenticator app.', 'mfa_invalid'); throw toHttpError(e); }
      await sb.logout(v.access_token);
    } finally { await sb.logout(g.access_token); }
    await run('UPDATE users SET mfa_enabled = 1, updated_at = ? WHERE id = ?', now(), u.id);
    await audit(u.id, u.id, 'auth.mfa_enabled', u.id, clientIp(req));
    await notify(u.id, { kind: 'security', title: 'Two-step verification turned on', body: 'Signing in now needs a code from your authenticator app.', link: '#/settings/security' });
    sendJson(res, 200, { enabled: true });
  });
  // Turn off: password + a current code (proves both factors), then the factor is removed at aal2.
  r.post('/api/auth/mfa/disable', async (req, res, ctx) => {
    const u = requireUser(ctx);
    await rateLimit(`mfa:${u.id}`, 20, HOUR);
    const b = await readJson(req);
    const g = await reauth(u, b.password);
    let gate;
    try { gate = await mfaGate(g, b.code || 'missing'); } catch (e) { await sb.logout(g.access_token); throw e.code === 'mfa_invalid' ? bad(e.message, 'mfa_invalid') : e; }
    try { if (gate.mfa) await viaSupabase(() => sb.mfaUnenroll(gate.token, gate.factor_id)); }
    finally { await sb.logout(gate.token); await sb.logout(g.access_token); }
    await run('UPDATE users SET mfa_enabled = 0, updated_at = ? WHERE id = ?', now(), u.id);
    await audit(u.id, u.id, 'auth.mfa_disabled', u.id, clientIp(req));
    await notify(u.id, { kind: 'security', title: 'Two-step verification turned off', body: 'Signing in now needs only your password.', link: '#/settings/security' });
    sendJson(res, 200, { enabled: false });
  });

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
    await notify(u.id, { kind: 'security', title: 'Password changed', body: 'Your Approx AI password was changed.', link: '#/settings/security' });
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
