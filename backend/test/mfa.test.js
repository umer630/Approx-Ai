// Two-step verification (Supabase MFA TOTP): enroll → verify → sign-in needs the code (client + admin) → disable.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { req, makeUser, close, db } from './helpers.js';
import { totp } from './totp.js';
after(() => close());

let u, secret, factor;
const login = (body) => req('POST', '/api/auth/login', { body: { email: u.email, password: u.password, client: 'mobile', ...body } });

test('enroll needs the password; the factor is not active until a correct code confirms it', async () => {
  u = await makeUser();
  assert.deepEqual((await req('GET', '/api/auth/mfa', { token: u.token })).data, { enabled: false, available: true });
  assert.equal((await req('POST', '/api/auth/mfa/enroll', { token: u.token, body: { password: 'WrongPassw0rd!' } })).data.error.code, 'wrong_password');
  const e = await req('POST', '/api/auth/mfa/enroll', { token: u.token, body: { password: u.password } });
  assert.equal(e.status, 200);
  ({ secret, factor_id: factor } = e.data);
  assert.match(e.data.uri, /^otpauth:\/\/totp\//); assert.ok(secret.length >= 16);
  assert.equal((await login({})).status, 200, 'unverified factor: sign-in unchanged');
  assert.equal((await req('POST', '/api/auth/mfa/verify', { token: u.token, body: { password: u.password, factor_id: factor, code: '000000' === totp(secret) ? '111111' : '000000' } })).data.error.code, 'mfa_invalid');
  const v = await req('POST', '/api/auth/mfa/verify', { token: u.token, body: { password: u.password, factor_id: factor, code: totp(secret) } });
  assert.equal(v.status, 200); assert.equal(v.data.enabled, true);
  assert.equal((await req('GET', '/api/auth/me', { token: u.token })).data.user.mfa_enabled, true);
  assert.ok((await db.all('SELECT subject FROM mail_outbox WHERE to_email = ?', u.email)).some((m) => /Two-step verification turned on/.test(m.subject)));
});

test('sign-in: password alone → mfa_required (no session); wrong code refused; correct code → session', async () => {
  const a = await login({});
  assert.equal(a.status, 401); assert.equal(a.data.error.code, 'mfa_required'); assert.equal(a.data.token, undefined);
  const b = await login({ mfa_code: '123456' === totp(secret) ? '654321' : '123456' });
  assert.equal(b.data.error.code, 'mfa_invalid');
  const wrongPw = await req('POST', '/api/auth/login', { body: { email: u.email, password: 'WrongPassw0rd!', mfa_code: totp(secret) } });
  assert.equal(wrongPw.status, 401); assert.notEqual(wrongPw.data.error.code, 'mfa_required', 'a wrong password never reveals that MFA is on');
  const c = await login({ mfa_code: totp(secret) });
  assert.equal(c.status, 200, JSON.stringify(c.data)); assert.ok(c.data.token);
  assert.equal((await req('GET', '/api/chats', { token: c.data.token })).status, 200);
});

test('disable needs password + a current code; afterwards the password alone signs in again', async () => {
  assert.equal((await req('POST', '/api/auth/mfa/disable', { token: u.token, body: { password: u.password, code: '000000' === totp(secret) ? '111111' : '000000' } })).data.error.code, 'mfa_invalid');
  assert.equal((await login({})).data.error.code, 'mfa_required', 'still on after a failed disable');
  const d = await req('POST', '/api/auth/mfa/disable', { token: u.token, body: { password: u.password, code: totp(secret) } });
  assert.equal(d.status, 200); assert.equal(d.data.enabled, false);
  assert.equal((await login({})).status, 200);
  assert.equal((await req('GET', '/api/auth/mfa', { token: u.token })).data.enabled, false);
});
