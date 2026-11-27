// Verification-email behaviour: honest responses for new vs already-confirmed addresses (no enumeration), Supabase
// cooldown / hourly cap reported with the exact wait, email-request outcomes recorded for admin diagnostics.
import test from 'node:test';
import assert from 'node:assert/strict';
import { req, makeUser, db, close, asAdmin, supabase } from './helpers.js';

test.after(close);
const reset = () => db.run("DELETE FROM rate_buckets WHERE key LIKE 'signup%' OR key LIKE 'resend%'");

test('new address: Supabase sends the confirmation email; outcome recorded', async () => {
  await reset();
  const email = `new_${Date.now()}@example.com`;
  const r = await req('POST', '/api/auth/signup', { body: { email, password: 'GoodPassw0rd!x' } });
  assert.equal(r.status, 202);
  assert.equal(r.data.resend_after_s, 60);
  assert.ok(supabase.lastEmail(email, 'signup'), 'confirmation email handed to the mail service');
  assert.ok(await db.one("SELECT 1 FROM audit_logs WHERE action = 'auth.email_signup' AND json_extract(detail, '$.outcome') = 'accepted_by_supabase'"));
});

test('already-confirmed address: same answer (no enumeration), NO email, honest wording, outcome recorded', async () => {
  await reset();
  const u = await makeUser();
  const before = supabase.emails.filter((m) => m.to === u.email).length;
  const r = await req('POST', '/api/auth/signup', { body: { email: u.email, password: 'OtherPassw0rd!x' } });
  assert.equal(r.status, 202);
  assert.equal(supabase.emails.filter((m) => m.to === u.email).length, before, 'Supabase sends nothing for a confirmed account');
  assert.match(r.data.message, /already have an Approx account/);
  assert.ok(await db.one("SELECT 1 FROM audit_logs WHERE action = 'auth.email_signup' AND json_extract(detail, '$.outcome') = 'existing_account_no_email'"));
  // audit details never contain the address
  assert.equal((await db.one("SELECT COUNT(*) n FROM audit_logs WHERE action LIKE 'auth.email_%' AND detail LIKE ?", `%${u.email}%`)).n, 0);
});

test('resend: per-address cooldown → 429 email_cooldown with the exact seconds + Retry-After; hourly cap distinguished', async () => {
  await reset();
  const email = `cool_${Date.now()}@example.com`;
  await req('POST', '/api/auth/signup', { body: { email, password: 'GoodPassw0rd!x' } });
  supabase.flags.resendCooldownSecs = 47;
  const r = await req('POST', '/api/auth/resend-verification', { body: { email } });
  assert.deepEqual([r.status, r.data.error.code, r.data.error.retry_after_s], [429, 'email_cooldown', 47]);
  assert.equal(r.headers.get('retry-after'), '47');
  assert.match(r.data.error.message, /47 seconds/);
  supabase.flags.resendCooldownSecs = 0; supabase.flags.emailHourlyCap = true;
  await reset();
  const cap = await req('POST', '/api/auth/resend-verification', { body: { email } });
  assert.deepEqual([cap.status, cap.data.error.code], [429, 'email_rate_limited']);
  supabase.flags.emailHourlyCap = false;
  await reset();
  const ok = await req('POST', '/api/auth/resend-verification', { body: { email } });
  assert.equal(ok.status, 202); assert.equal(ok.data.resend_after_s, 60);
  assert.ok(await db.one("SELECT 1 FROM audit_logs WHERE action = 'auth.email_resend' AND json_extract(detail, '$.outcome') IN ('email_cooldown', 'email_rate_limited')"));
});

test('admin diagnostics: Supabase Auth reachability/settings, email outcomes, registry, APK contract — no secrets', async () => {
  const a = await asAdmin(await makeUser(), 'admin');
  const d = await req('GET', '/api/admin/diagnostics', { headers: { cookie: a.admin.cookie } });
  assert.equal(d.status, 200);
  assert.equal(d.data.supabase_auth.configured, true);
  assert.ok(Array.isArray(d.data.email_requests_24h) && d.data.email_requests_24h.length >= 2);
  assert.equal(d.data.models.length, 5);
  assert.equal(d.data.apk.api_contract, '1.10');
  assert.doesNotMatch(JSON.stringify(d.data), /sb_secret|sb_publishable_test_key|password|token/i);
  const u = await makeUser();
  assert.equal((await req('GET', '/api/admin/diagnostics', { token: u.token })).status, 401);
});
