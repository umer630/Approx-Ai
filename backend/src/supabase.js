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
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
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
    throw new SupabaseError(503, 'auth_unreachable', `Supabase Auth is unreachable: ${e.name}`);
  }
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (!res.ok) {
    const code = data?.error_code || data?.code_name || data?.error || (res.status === 429 ? 'over_request_rate_limit' : `http_${res.status}`);
    const msg = data?.msg || data?.message || data?.error_description || `Supabase Auth error ${res.status}`;
    throw new SupabaseError(res.status, String(code), String(msg));
  }
  return data;
}

const redirectTo = () => config.supabase.callbackUrl;

export const sb = {
  /** Creates an unconfirmed user and makes Supabase send the confirmation email. */
  signUp: (email, password, displayName) => call('POST', '/signup', { query: { redirect_to: redirectTo() },
    body: { email, password, data: displayName ? { display_name: displayName } : {} } }),
  passwordGrant: (email, password) => call('POST', '/token', { query: { grant_type: 'password' }, body: { email, password } }),
  resendSignup: (email) => call('POST', '/resend', { query: { redirect_to: redirectTo() }, body: { type: 'signup', email } }),
  recover: (email) => call('POST', '/recover', { query: { redirect_to: redirectTo() }, body: { email } }),
  verifyTokenHash: (tokenHash, type) => call('POST', '/verify', { body: { type, token_hash: tokenHash } }),
  getUser: (accessToken) => call('GET', '/user', { bearer: accessToken }),
  updateUser: (accessToken, attrs) => call('PUT', '/user', { bearer: accessToken, query: attrs.email ? { redirect_to: redirectTo() } : undefined, body: attrs }),
  /** Ends the Supabase session we only needed to prove identity (Approx issues its own session). Best effort. */
  logout: (accessToken) => call('POST', '/logout', { bearer: accessToken, query: { scope: 'local' } }).catch(() => null),
  adminDeleteUser: (id) => (config.supabase.secretKey ? call('DELETE', `/admin/users/${encodeURIComponent(id)}`, { admin: true }) : null),
};

/** Map a Supabase error to the HTTP error shown to the person (never leaks internals). */
export function toHttpError(e) {
  if (!(e instanceof SupabaseError)) return e;
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
    case 'over_email_send_rate_limit':
      return new HttpError(429, 'rate_limited', 'Too many emails were requested. Please wait a few minutes and try again.');
    case 'over_request_rate_limit':
      return new HttpError(429, 'rate_limited', 'Too many requests. Please slow down.');
    case 'email_address_invalid': case 'validation_failed':
      return new HttpError(400, 'bad_request', 'A valid email address is required');
    case 'signup_disabled':
      return new HttpError(403, 'signup_disabled', 'New sign-ups are currently disabled.');
    case 'email_exists': case 'user_already_exists':
      return new HttpError(400, 'email_in_use', 'Email is already in use');
    case 'auth_unreachable':
      return new HttpError(503, 'auth_unavailable', 'Sign-in service is temporarily unavailable. Please try again.');
    default:
      if (e.status >= 500) return new HttpError(502, 'auth_unavailable', 'Sign-in service error. Please try again.');
      if (e.status === 401 || e.status === 403) return new HttpError(400, 'invalid_token', 'This link or code is invalid or has expired. Request a new one.');
      return new HttpError(400, 'auth_error', e.message);
  }
}
