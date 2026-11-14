// Google Sign-In (Google Identity Services). The browser obtains a Google ID token (a JWT signed by Google) from
// Google's own account chooser; this module verifies it before any account is created or linked:
//   RS256 signature against Google's published keys · iss = accounts.google.com · aud = one of our client IDs ·
//   not expired · email present and verified by Google.
// No Google secret is needed (ID-token verification uses public keys). Client IDs are public by design.
import crypto from 'node:crypto';
import { config } from './config.js';
import { HttpError } from './http.js';

const ISSUERS = new Set(['accounts.google.com', 'https://accounts.google.com']);
let jwksCache = { at: 0, maxAgeMs: 0, keys: [] };

async function googleKeys(force = false) {
  if (!force && jwksCache.keys.length && Date.now() - jwksCache.at < jwksCache.maxAgeMs) return jwksCache.keys;
  const r = await fetch(config.google.jwksUrl, { signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new HttpError(502, 'google_unavailable', "Couldn't reach Google to verify the sign-in. Please try again.");
  const body = await r.json();
  const maxAge = Number(/max-age=(\d+)/.exec(r.headers.get('cache-control') || '')?.[1] || 3600);
  jwksCache = { at: Date.now(), maxAgeMs: Math.min(maxAge, 86400) * 1000, keys: Array.isArray(body.keys) ? body.keys : [] };
  return jwksCache.keys;
}

const b64json = (s) => JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));

/** Verify a Google ID token; returns { sub, email, name, picture }. Throws 401 on anything invalid. */
export async function verifyGoogleIdToken(idToken) {
  const invalid = (why) => new HttpError(401, 'google_token_invalid', `Google sign-in could not be verified (${why}).`);
  if (!config.google.clientIds.length) throw new HttpError(503, 'google_not_configured', 'Google sign-in is not configured on this server yet.');
  const parts = typeof idToken === 'string' ? idToken.split('.') : [];
  if (parts.length !== 3 || idToken.length > 4096) throw invalid('malformed token');
  let header; let payload;
  try { header = b64json(parts[0]); payload = b64json(parts[1]); } catch { throw invalid('malformed token'); }
  if (header.alg !== 'RS256' || !header.kid) throw invalid('unexpected algorithm');
  let jwk = (await googleKeys()).find((k) => k.kid === header.kid);
  if (!jwk) jwk = (await googleKeys(true)).find((k) => k.kid === header.kid); // Google rotates keys
  if (!jwk) throw invalid('unknown signing key');
  const key = crypto.createPublicKey({ key: jwk, format: 'jwk' });
  const ok = crypto.verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), key, Buffer.from(parts[2], 'base64url'));
  if (!ok) throw invalid('bad signature');
  const nowSec = Math.floor(Date.now() / 1000);
  if (!ISSUERS.has(payload.iss)) throw invalid('wrong issuer');
  if (!config.google.clientIds.includes(payload.aud)) throw invalid('token is for a different app');
  if (typeof payload.exp !== 'number' || payload.exp < nowSec - 60) throw invalid('expired');
  if (typeof payload.iat === 'number' && payload.iat > nowSec + 300) throw invalid('issued in the future');
  if (!payload.sub || !payload.email) throw invalid('no account identity');
  if (payload.email_verified !== true && payload.email_verified !== 'true') throw invalid('Google has not verified this email address');
  return { sub: String(payload.sub), email: String(payload.email).toLowerCase(), name: String(payload.name || payload.given_name || '').slice(0, 80) };
}

/** For tests only. */
export function _resetGoogleKeyCache() { jwksCache = { at: 0, maxAgeMs: 0, keys: [] }; }
