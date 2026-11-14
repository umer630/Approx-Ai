// Google Sign-In, message feedback and conversation export.
// Google's keys are replaced by a local JWKS server (only possible outside production); tokens are real RS256 JWTs.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';

const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const { privateKey: attackerKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'test-kid', alg: 'RS256', use: 'sig' };
const jwks = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'public, max-age=600' }); res.end(JSON.stringify({ keys: [jwk] })); });
await new Promise((r) => jwks.listen(0, '127.0.0.1', r));
const CLIENT = 'approx-test.apps.googleusercontent.com';
process.env.GOOGLE_CLIENT_ID = CLIENT;
process.env.GOOGLE_JWKS_URL = `http://127.0.0.1:${jwks.address().port}/certs`;
const { req, db, makeUser, close } = await import('./helpers.js');
after(() => { jwks.close(); close(); });

function idToken(claims = {}, { key = privateKey, kid = 'test-kid', alg = 'RS256' } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const p = { iss: 'https://accounts.google.com', aud: CLIENT, sub: 'g-1001', email: 'umer.g@gmail.example', email_verified: true, name: 'Umer Khan', iat: now, exp: now + 3600, ...claims };
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const body = `${enc({ alg, kid, typ: 'JWT' })}.${enc(p)}`;
  return `${body}.${crypto.sign('RSA-SHA256', Buffer.from(body), key).toString('base64url')}`;
}

test('auth config exposes only the public Google client id', async () => {
  const r = await req('GET', '/api/auth/config');
  assert.deepEqual(r.data.google, { enabled: true, client_id: CLIENT });
});

test('Google sign-in: rejects forged, wrong-audience, expired and unverified tokens', async () => {
  for (const [why, tok] of [
    ['bad signature', idToken({}, { key: attackerKey })],
    ['wrong audience', idToken({ aud: 'someone-else.apps.googleusercontent.com' })],
    ['wrong issuer', idToken({ iss: 'https://evil.example' })],
    ['expired', idToken({ exp: Math.floor(Date.now() / 1000) - 3600 })],
    ['unverified email', idToken({ email_verified: false })],
    ['unknown key', idToken({}, { kid: 'nope' })],
    ['alg none', idToken({}, { alg: 'none' })],
    ['garbage', 'not.a.jwt'],
  ]) {
    const r = await req('POST', '/api/auth/google', { body: { credential: tok } });
    assert.equal(r.status, 401, why);
    assert.equal(r.data.error.code, 'google_token_invalid', why);
  }
  assert.equal((await db.one("SELECT COUNT(*) n FROM users WHERE email = 'umer.g@gmail.example'")).n, 0, 'no account created');
});

test('Google sign-in creates a verified account, signs in again by Google id, and links an existing email account', async () => {
  const first = await req('POST', '/api/auth/google', { body: { credential: idToken(), client: 'mobile' } });
  assert.equal(first.status, 200);
  assert.ok(first.data.token);
  assert.equal(first.data.user.email, 'umer.g@gmail.example');
  assert.equal(first.data.user.email_verified, true);
  assert.equal(first.data.user.display_name, 'Umer Khan');
  const again = await req('POST', '/api/auth/google', { body: { credential: idToken({ email: 'UMER.G@gmail.example' }), client: 'mobile' } });
  assert.equal(again.data.user.id, first.data.user.id, 'same Google account → same Approx account');
  // Google-only accounts have no password: password sign-in fails.
  assert.equal((await req('POST', '/api/auth/login', { body: { email: 'umer.g@gmail.example', password: '!', client: 'mobile' } })).status, 401);
  // Existing email/password account (unverified) gets linked and verified by Google.
  const u = await makeUser({ verify: false });
  const linked = await req('POST', '/api/auth/google', { body: { credential: idToken({ sub: 'g-2002', email: u.email }), client: 'mobile' } });
  assert.equal(linked.data.user.id, u.id);
  assert.equal(linked.data.user.email_verified, true);
  // A different Google account cannot take over an already-linked email.
  const takeover = await req('POST', '/api/auth/google', { body: { credential: idToken({ sub: 'g-9999', email: u.email }) } });
  assert.equal(takeover.status, 403);
  assert.equal(takeover.data.error.code, 'google_mismatch');
});

test('Android hand-off: one-time code redeemable only with the matching verifier, once', async () => {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const h = await req('POST', '/api/auth/google/handoff', { body: { credential: idToken({ sub: 'g-3003', email: 'android.g@gmail.example' }), challenge } });
  assert.equal(h.status, 200);
  assert.equal((await req('POST', '/api/auth/handoff', { body: { code: h.data.code, verifier: crypto.randomBytes(32).toString('base64url') } })).status, 401, 'wrong verifier');
  const ok = await req('POST', '/api/auth/handoff', { body: { code: h.data.code, verifier } });
  assert.equal(ok.status, 200);
  assert.ok(ok.data.token);
  assert.equal(ok.data.user.email, 'android.g@gmail.example');
  assert.equal((await req('POST', '/api/auth/handoff', { body: { code: h.data.code, verifier } })).status, 401, 'single use');
});

test('message feedback (👍/👎, report) and conversation export', async () => {
  const u = await makeUser();
  const c = await req('POST', '/api/chats', { token: u.token, body: {} });
  await req('POST', `/api/chats/${c.data.chat.id}/messages`, { token: u.token, body: { content: 'Explain photosynthesis' } });
  const chat = await req('GET', `/api/chats/${c.data.chat.id}`, { token: u.token });
  const reply = chat.data.messages.find((m) => m.role === 'assistant');
  const userMsg = chat.data.messages.find((m) => m.role === 'user');
  const fb = (body, mid = reply.id, token = u.token) => req('POST', `/api/chats/${c.data.chat.id}/messages/${mid}/feedback`, { token, body });
  assert.deepEqual((await fb({ rating: 'up' })).data.feedback, { rating: 'up', reported: false });
  assert.deepEqual((await fb({ rating: 'down', report: true, reason: 'incorrect', comment: 'wrong facts' })).data.feedback, { rating: 'down', reported: true });
  assert.deepEqual((await fb({ rating: null })).data.feedback, { rating: null, reported: true }, 'clearing the rating keeps the report');
  assert.equal((await fb({ rating: 'up' }, userMsg.id)).status, 404, 'only assistant replies');
  const other = await makeUser();
  assert.equal((await fb({ rating: 'up' }, reply.id, other.token)).status, 404, 'no access to other people\'s chats');
  const again = await req('GET', `/api/chats/${c.data.chat.id}`, { token: u.token });
  assert.deepEqual(again.data.messages.find((m) => m.id === reply.id).feedback, { rating: null, reported: true });
  const md = await req('GET', `/api/chats/${c.data.chat.id}/export`, { token: u.token });
  assert.equal(md.status, 200);
  assert.match(md.headers.get('content-disposition'), /attachment; filename=".+\.md"/);
  assert.match(md.data, /## You\n\nExplain photosynthesis/);
  assert.match(md.data, /## Approx AI/);
  const js = await req('GET', `/api/chats/${c.data.chat.id}/export?format=json`, { token: u.token });
  assert.equal(js.data.messages.length, 2);
  assert.equal((await req('GET', `/api/chats/${c.data.chat.id}/export`, { token: other.token })).status, 404);
});
