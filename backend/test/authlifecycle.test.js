// The "verified, but Incorrect email or password" bug, end to end.
// Root cause: Supabase Auth never updates an existing UNCONFIRMED user on a repeated sign-up (internal/api/signup.go:
// "do not update the user because we can't be sure of their claimed identity"). Sign up → no verification → sign up
// again with a new password → verify the new code → sign in with the new password → invalid_credentials.
// Fix (API 1.9): verify-email takes the password and sets it once the code proves the mailbox.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { req, supabase, close } from './helpers.js';
after(() => close());

const FIRST = 'FirstPassw0rd!', CHOSEN = 'ChosenPassw0rd!';
const signup = (email, password) => req('POST', '/api/auth/signup', { body: { email, password, display_name: 'Umar' } });
const login = (email, password, client) => req('POST', '/api/auth/login', { body: { email, password, ...(client ? { client } : {}) } });
const cookieOf = (r) => (r.headers?.get?.('set-cookie') || '').split(';')[0];

test('reproduces the bug: a verified repeat sign-up keeps the first password (old verify call, no password)', async () => {
  const email = `repeat-${Date.now()}@example.com`;
  await signup(email, FIRST);               // first attempt, never verified
  await signup(email, CHOSEN);              // second attempt: the email arrives…
  const code = supabase.lastEmail(email, 'signup').otp;
  const v = await req('POST', '/api/auth/verify-email', { body: { email, token: code } });
  assert.equal(v.data.status, 'verified');   // …verification succeeds…
  const r = await login(email, CHOSEN);
  assert.equal(r.status, 401);               // …and the password the person just chose is refused.
  assert.equal(r.data.error.message, 'Incorrect email or password');
  assert.equal((await login(email, FIRST)).status, 200, 'Supabase still holds the FIRST password');
});

test('fixed flow (mobile): signup → code → password setup → logout → login → session → protected route', async () => {
  const email = `Umar.${Date.now()}@Example.com`;   // mixed case: normalized everywhere
  await signup(email, FIRST);
  assert.equal((await signup(email, CHOSEN)).status, 202);
  const mail = supabase.lastEmail(email.toLowerCase(), 'signup');
  assert.ok(mail?.otp, 'verification email with a code');
  // Before verification: correct password, unverified → told to verify (never a session).
  assert.equal((await login(email, FIRST, 'mobile')).data.error.code, 'email_not_verified');
  const v = await req('POST', '/api/auth/verify-email', { body: { email: `  ${email} `, token: mail.otp, password: CHOSEN, sign_in: true, client: 'mobile' } });
  assert.equal(v.status, 200, JSON.stringify(v.data));
  assert.equal(v.data.password_set, true);
  assert.ok(v.data.token?.length > 20, 'mobile session after verification');
  assert.equal(v.data.user.email, email.toLowerCase());
  assert.equal(v.data.user.email_verified, true);
  // Protected route with that session, then logout → the token is dead.
  assert.equal((await req('GET', '/api/auth/me', { token: v.data.token })).status, 200);
  assert.equal((await req('POST', '/api/auth/logout', { token: v.data.token })).status, 200);
  assert.equal((await req('GET', '/api/auth/me', { token: v.data.token })).status, 401);
  // Login with the SAME email/password the person chose → authenticated → protected routes work and persist.
  const l = await login(email.toUpperCase(), CHOSEN, 'mobile');
  assert.equal(l.status, 200, JSON.stringify(l.data));
  const me1 = await req('GET', '/api/auth/me', { token: l.data.token });
  const me2 = await req('GET', '/api/chats', { token: l.data.token });
  assert.deepEqual([me1.status, me2.status], [200, 200]);
  assert.equal(me1.data.user.id, v.data.user.id, 'one identity: verification and login are the same user');
  // Wrong password and the abandoned first password are refused.
  assert.equal((await login(email, 'WrongPassw0rd!', 'mobile')).status, 401);
  assert.equal((await login(email, FIRST, 'mobile')).status, 401);
  // Duplicate sign-up of the now-verified address: same answer, no email, password unchanged, login still works.
  const before = supabase.emails.length;
  const dup = await signup(email, 'AttackerPassw0rd!');
  assert.equal(dup.status, 202);
  assert.equal(supabase.emails.length, before, 'no email for a verified account');
  assert.equal((await login(email, 'AttackerPassw0rd!')).status, 401);
  assert.equal((await login(email, CHOSEN)).status, 200);
});

test('fixed flow (web): code + password → cookie session; a used code cannot set another password', async () => {
  const email = `web-${Date.now()}@example.com`;
  await signup(email, CHOSEN);
  const code = supabase.lastEmail(email, 'signup').otp;
  const v = await req('POST', '/api/auth/verify-email', { body: { email, token: code, password: CHOSEN, sign_in: true } });
  assert.equal(v.status, 200);
  assert.equal(v.data.token, undefined, 'web gets a cookie, not a bearer token');
  assert.match(cookieOf(v), /^approx_session=/);
  const replay = await req('POST', '/api/auth/verify-email', { body: { email, token: code, password: 'OtherPassw0rd!' } });
  assert.notEqual(replay.status, 200);
  assert.equal((await login(email, CHOSEN)).status, 200);
  assert.equal((await login(email, 'OtherPassw0rd!')).status, 401);
});

test('verification rejects a weak password and a wrong code without changing anything', async () => {
  const email = `weak-${Date.now()}@example.com`;
  await signup(email, CHOSEN);
  const code = supabase.lastEmail(email, 'signup').otp;
  assert.equal((await req('POST', '/api/auth/verify-email', { body: { email, token: code, password: 'short' } })).data.error.code, 'weak_password');
  const wrong = await req('POST', '/api/auth/verify-email', { body: { email, token: code === '000000' ? '111111' : '000000', password: 'NewPassw0rd!!' } });
  assert.notEqual(wrong.status, 200);
  assert.equal((await login(email, CHOSEN)).data.error.code, 'email_not_verified', 'still unverified, password unchanged');
});
