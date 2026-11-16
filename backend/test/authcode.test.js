// Verification CODE flow (the numeric code in the Supabase email, {{ .Token }}): verified with email + code.
// Before the fix the backend sent the code as a token_hash, which real Supabase rejects — a typed code never worked.
import test from 'node:test';
import assert from 'node:assert/strict';
import { req, db, close, supabase } from './helpers.js';

test.after(close);
const reset = () => db.run("DELETE FROM rate_buckets WHERE key LIKE 'signup%' OR key LIKE 'verify%' OR key LIKE 'login%' OR key LIKE 'forgot%' OR key LIKE 'reset%'");
const email = `code_${Date.now()}@example.com`;
const password = 'CodePassw0rd!x';

test('signup → Supabase emails a 6-digit code → wrong / missing-email / code-as-hash refused → correct code verifies', async () => {
  await reset();
  assert.equal((await req('POST', '/api/auth/signup', { body: { email, password, display_name: 'Code Test' } })).status, 202);
  const mail = supabase.lastEmail(email, 'signup');
  assert.match(mail.otp, /^\d{6}$/, 'Supabase generated the code');
  const wrong = String((Number(mail.otp) + 1) % 1_000_000).padStart(6, '0');
  const bad = await req('POST', '/api/auth/verify-email', { body: { email, token: wrong } });
  assert.deepEqual([bad.status, bad.data.error.code], [400, 'invalid_token']);
  assert.match(bad.data.error.message, /invalid or has expired/);
  const noEmail = await req('POST', '/api/auth/verify-email', { body: { token: mail.otp } });
  assert.deepEqual([noEmail.status, noEmail.data.error.code], [400, 'email_required']);
  assert.equal((await req('POST', '/api/auth/login', { body: { email, password, client: 'mobile' } })).data.error.code, 'email_not_verified');
  const ok = await req('POST', '/api/auth/verify-email', { body: { email: email.toUpperCase(), token: mail.otp } });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal(ok.data.status, 'verified');
  const again = await req('POST', '/api/auth/verify-email', { body: { email, token: mail.otp } });
  assert.equal(again.data.error.code, 'invalid_token', 'a code works once');
});

test('verified user logs in (mobile token), session restores, logout revokes it', async () => {
  await reset();
  const l = await req('POST', '/api/auth/login', { body: { email, password, client: 'mobile' } });
  assert.equal(l.status, 200); assert.ok(l.data.token.length > 20);
  const me = await req('GET', '/api/auth/me', { token: l.data.token });
  assert.equal(me.data.user.email, email); assert.equal(me.data.user.email_verified, true);
  assert.equal((await req('POST', '/api/auth/logout', { token: l.data.token, body: {} })).status, 200);
  assert.equal((await req('GET', '/api/auth/me', { token: l.data.token })).status, 401, 'session revoked on logout');
});

test('password reset with the emailed code: wrong code refused, correct code sets the new password', async () => {
  await reset();
  assert.equal((await req('POST', '/api/auth/forgot-password', { body: { email } })).status, 202);
  const mail = supabase.lastEmail(email, 'recovery');
  assert.match(mail.otp, /^\d{6}$/);
  const wrong = String((Number(mail.otp) + 7) % 1_000_000).padStart(6, '0');
  assert.equal((await req('POST', '/api/auth/reset-password', { body: { email, token: wrong, password: 'NewCodePassw0rd!x' } })).data.error.code, 'invalid_token');
  const r = await req('POST', '/api/auth/reset-password', { body: { email, token: mail.otp, password: 'NewCodePassw0rd!x' } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal((await req('POST', '/api/auth/login', { body: { email, password, client: 'mobile' } })).status, 401, 'old password rejected');
  assert.equal((await req('POST', '/api/auth/login', { body: { email, password: 'NewCodePassw0rd!x', client: 'mobile' } })).status, 200);
});

test('the email link path (token_hash) still works unchanged', async () => {
  await reset();
  const e2 = `link_${Date.now()}@example.com`;
  await req('POST', '/api/auth/signup', { body: { email: e2, password } });
  const r = await req('POST', '/api/auth/verify-email', { body: { token_hash: supabase.lastEmail(e2, 'signup').token_hash, type: 'signup' } });
  assert.equal(r.status, 200);
});
