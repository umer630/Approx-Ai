// Supabase Auth (GoTrue) — the authoritative identity provider for email + password accounts.
//
// Only the PUBLISHABLE key is needed (it is public by design; Row Level Security protects data, and these calls only
// act on the caller's own account). An optional server-only SUPABASE_SECRET_KEY enables admin account deletion; it is
// never sent to a client and never logged.
import { config } from './config.js';
import { HttpError } from './http.js';

export const supabaseConfigured = () => !!(config.supabase.url && config.supabase.publishableKey);

export function requireSupabase() {
  if (!supabaseConfigured()) {
    throw new HttpError(503, 'auth_not_configured', 'Sign-in is not configured on this server yet (Supabase Auth). Please try again later.');
  }
}

/** Supabase error → { status, code, message } (handles both the current and the older GoTrue error shapes). */
export class SupabaseError extends Error {
  constructor(status, code, message, errorId = null) { super(message); this.status = status; this.code = code; this.errorId = errorId; }
}

// Supabase answers 500 "Error sending confirmation email" (or recovery / email-change / magic-link email) when its SMTP
// settings cannot deliver: the sign-up is rolled back, so this is a delivery failure, not an outage.
const EMAIL_SEND_FAILURE = /error sending (confirmation|recovery|magic link|email change|invite|reauthentication)/i;
export const isEmailDeliveryFailure = (e) => e instanceof SupabaseError && e.status >= 500 && EMAIL_SEND_FAILURE.test(e.message || '');

/** Server-side diagnostics for failed Supabase calls. Never includes request bodies, emails, passwords or tokens. */
function logSupabaseError(path, e) {
  if (process.env.APPROX_ENV === 'test' && !process.env.APPROX_LOG_AUTH_ERRORS) return;
  console.error(JSON.stringify({ event: 'supabase_auth_error', path, status: e.status, code: e.code, message: String(e.message).slice(0, 200), error_id: e.errorId }));
}

async function call(method, path, { body, query, bearer, admin = false } = {}) {
  requireSupabase();
  const url = new URL(config.supabase.url.replace(/\/+$/, '') + '/auth/v1' + path);
  for (const [k, v] of Object.entries(query || {})) if (v != null) url.searchParams.set(k, v);
  const key = admin ? config.supabase.secretKey : config.supabase.publishableKey;
  const headers = { apikey: key, 'content-type': 'application/json', 'x-client-info': 'approx-ai-backend/1.0' };
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  else if (admin) headers.authorization = `Bearer ${key}`;
  let res;
  try {
    res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15_000) });
  } catch (e) {
    const err = new SupabaseError(503, 'auth_unreachable', `Supabase Auth is unreachable: ${e.name}`);
    logSupabaseError(path, err);
    throw err;
  }
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (!res.ok) {
    const code = data?.error_code || data?.code_name || data?.error || (res.status === 429 ? 'over_request_rate_limit' : `http_${res.status}`);
    const msg = data?.msg || data?.message || data?.error_description || `Supabase Auth error ${res.status}`;
    const err = new SupabaseError(res.status, String(code), String(msg), data?.error_id || res.headers.get('x-request-id') || null);
    // Expected outcomes (wrong password, unconfirmed email, expired link…) are not logged; anything else is.
    if (res.status >= 500 || !EXPECTED.has(err.code)) logSupabaseError(path, err);
    throw err;
  }
  return data;
}

const EXPECTED = new Set(['invalid_credentials', 'invalid_grant', 'email_not_confirmed', 'weak_password', 'same_password', 'otp_expired',
  'bad_jwt', 'session_not_found', 'user_not_found', 'email_exists', 'user_already_exists', 'over_email_send_rate_limit', 'over_request_rate_limit', 'mfa_verification_failed', 'mfa_challenge_expired', 'insufficient_aal']);
const redirectTo = () => config.supabase.callbackUrl;

export const sb = {
  /** Creates an unconfirmed user and makes Supabase send the confirmation email. */
  signUp: (email, password, displayName) => call('POST', '/signup', { query: { redirect_to: redirectTo() },
    body: { email, password, data: displayName ? { display_name: displayName } : {} } }),
  passwordGrant: (email, password) => call('POST', '/token', { query: { grant_type: 'password' }, body: { email, password } }),
  resendSignup: (email) => call('POST', '/resend', { query: { redirect_to: redirectTo() }, body: { type: 'signup', email } }),
  recover: (email) => call('POST', '/recover', { query: { redirect_to: redirectTo() }, body: { email } }),
  verifyTokenHash: (tokenHash, type) => call('POST', '/verify', { body: { type, token_hash: tokenHash } }),
  // The numeric code from the email ({{ .Token }}) is an email OTP: Supabase verifies it together with the address.
  verifyEmailOtp: (email, token, type) => call('POST', '/verify', { body: { type, email, token } }),
  getUser: (accessToken) => call('GET', '/user', { bearer: accessToken }),
  updateUser: (accessToken, attrs) => call('PUT', '/user', { bearer: accessToken, query: attrs.email ? { redirect_to: redirectTo() } : undefined, body: attrs }),
  /** Ends the Supabase session we only needed to prove identity (Approx issues its own session). Best effort. */
  logout: (accessToken) => call('POST', '/logout', { bearer: accessToken, query: { scope: 'local' } }).catch(() => null),
  // MFA (TOTP authenticator apps). Enrolling/removing a verified factor needs an aal2 session.
  mfaEnroll: (accessToken) => call('POST', '/factors', { bearer: accessToken, body: { factor_type: 'totp', friendly_name: `Approx ${Date.now()}` } }),
  mfaChallenge: (accessToken, factorId) => call('POST', `/factors/${encodeURIComponent(factorId)}/challenge`, { bearer: accessToken, body: {} }),
  mfaVerify: (accessToken, factorId, challengeId, code) => call('POST', `/factors/${encodeURIComponent(factorId)}/verify`, { bearer: accessToken, body: { challenge_id: challengeId, code } }),
  mfaUnenroll: (accessToken, factorId) => call('DELETE', `/factors/${encodeURIComponent(factorId)}`, { bearer: accessToken }),
  adminDeleteUser: (id) => (config.supabase.secretKey ? call('DELETE', `/admin/users/${encodeURIComponent(id)}`, { admin: true }) : null),
};

/** Map a Supabase error to the HTTP error shown to the person (never leaks internals). */
export function toHttpError(e) {
  if (!(e instanceof SupabaseError)) return e;
  if (isEmailDeliveryFailure(e)) {
    return new HttpError(502, 'email_delivery_failed',
      "We couldn't send the email (the email service is not delivering right now), so nothing was changed. Please try again later.");
  }
  switch (e.code) {
    case 'email_not_confirmed':
      return new HttpError(403, 'email_not_verified', 'Please verify your email first. Check your inbox (and spam folder) for the confirmation link, or resend it.');
    case 'invalid_credentials': case 'invalid_grant':
      return new HttpError(401, 'unauthorized', 'Incorrect email or password');
    case 'weak_password':
      return new HttpError(400, 'weak_password', e.message || 'Password is too weak');
    case 'same_password':
      return new HttpError(400, 'same_password', 'Choose a password different from your current one.');
    case 'otp_expired': case 'flow_state_expired': case 'bad_jwt': case 'session_not_found': case 'user_not_found': case 'not_found':
      return new HttpError(400, 'invalid_token', 'This link or code is invalid or has expired. Request a new one.');
    case 'over_email_send_rate_limit': {
      // Supabase sends two different limits under this code: a per-address cooldown ("…only request this after 47
      // seconds") and the project-wide hourly email cap ("email rate limit exceeded"). Report which one, with the wait.
      const secs = Number(/after (\d+) seconds?/i.exec(e.message || '')?.[1]);
      if (secs > 0) return new HttpError(429, 'email_cooldown', `Please wait ${secs} seconds before requesting another email for this address.`, { retry_after_s: secs, retryAfter: secs });
      return new HttpError(429, 'email_rate_limited', 'The email sending limit for Approx AI has been reached for now. Please try again later (it resets within the hour).', { retry_after_s: 600, retryAfter: 600 });
    }
    case 'over_request_rate_limit':
      return new HttpError(429, 'rate_limited', 'Too many requests. Please slow down.');
    case 'email_address_invalid': case 'validation_failed':
      return new HttpError(400, 'bad_request', 'A valid email address is required');
    case 'captcha_failed':
      return new HttpError(400, 'captcha_required', 'Sign-in is protected by a CAPTCHA in Supabase, which this app does not support. Turn off CAPTCHA protection in Supabase Auth settings.');
    case 'signup_disabled':
      return new HttpError(403, 'signup_disabled', 'New sign-ups are currently disabled.');
    case 'email_exists': case 'user_already_exists':
      return new HttpError(400, 'email_in_use', 'Email is already in use');
    case 'auth_unreachable':
      return new HttpError(503, 'auth_unavailable', 'Sign-in service is temporarily unavailable. Please try again.');
    case 'no_api_key': case 'invalid_api_key':
      return new HttpError(503, 'auth_not_configured', 'Sign-in is misconfigured on this server (Supabase API key rejected).');
    default:
      if (e.status >= 500) return new HttpError(502, 'auth_unavailable', `Sign-in service error (${e.code}). Please try again.`);
      if (e.status === 401 || e.status === 403) return new HttpError(400, 'invalid_token', 'This link or code is invalid or has expired. Request a new one.');
      return new HttpError(400, 'auth_error', e.message);
  }
}
