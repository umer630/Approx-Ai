// APK vs browser sign-up: the Android app's own network client (android/src/.../Api.java, run on a JVM by
// android/jvmtest/AuthFlowProbe.java) and the web app's requests go through the same backend to Supabase.
// This proves, request by request, that an APK sign-up reaches Supabase exactly like a browser sign-up and that
// Supabase is asked to send the same email (same endpoint, same redirect, same template type).
// Needs java/javac and org.json (APPROX_JSON_JAR); skipped otherwise.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { req, supabase, close, BASE } from './helpers.js';
after(() => close());
const run = promisify(execFile);

const JAR = process.env.APPROX_JSON_JAR || '';
let hasJava = false;
try { execFileSync('javac', ['-version'], { stdio: 'ignore' }); hasJava = !!JAR && fs.existsSync(JAR); } catch { /* no JDK */ }
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'apkauth-'));
const A = path.resolve('../android');
if (hasJava) execFileSync('javac', ['-cp', JAR, '-d', out, `${A}/src/com/approxtech/ai/Api.java`, `${A}/jvmtest/AuthFlowProbe.java`]);
const apk = async (...args) => JSON.parse((await run('java', ['-cp', `${out}${path.delimiter}${JAR}`, 'AuthFlowProbe', BASE, ...args])).stdout.trim());
const PW = 'GoodPassw0rd!';
const signupCall = (email) => supabase.calls.find((c) => c.path === '/signup' && c.body?.email === email);
const shape = (c) => ({ method: c.method, path: c.path, query: c.query, keys: Object.keys(c.body).sort(), data: c.body.data });

test('APK sign-up sends Supabase the same request as the browser, and Supabase sends the same email', { skip: !hasJava && 'needs javac + APPROX_JSON_JAR' }, async () => {
  const web = `web-${Date.now()}@example.com`, mob = `apk-${Date.now()}@example.com`;
  const w = await req('POST', '/api/auth/signup', { body: { email: web, password: PW, display_name: 'Apk Tester' } });
  const m = await apk('signup', mob, PW);
  assert.equal(w.status, 202);
  assert.equal(m.ok, true, JSON.stringify(m));
  assert.equal(m.body.status, w.data.status);
  assert.deepEqual(shape(signupCall(mob)), shape(signupCall(web)), 'identical Supabase /signup request');
  const ew = supabase.lastEmail(web, 'signup'), em = supabase.lastEmail(mob, 'signup');
  assert.ok(ew && em, 'Supabase sends a confirmation email for both');
  assert.deepEqual([em.type, em.redirect_to], [ew.type, ew.redirect_to]);

  // The APK's code screen: the 6-digit code from that email verifies the address, then the app signs in.
  const unverified = await apk('login', mob, PW);
  assert.equal(unverified.code, 'email_not_verified');
  const v = await apk('verify', mob, em.otp, PW);
  assert.equal(v.ok, true, JSON.stringify(v));
  assert.equal(v.body.status, 'verified');
  assert.equal(v.body.password_set, true);
  assert.ok(v.body.token.length > 20, 'the APK is signed in right after verifying');
  const login = await apk('login', mob, PW);
  assert.equal(login.ok, true, JSON.stringify(login));
  assert.ok(login.body.token.length > 20, 'mobile bearer token');
});

test('APK: signed up twice without verifying → verify with the code + chosen password → that password signs in', { skip: !hasJava && 'needs javac + APPROX_JSON_JAR' }, async () => {
  const e = `apk-twice-${Date.now()}@example.com`;
  await apk('signup', e, 'FirstPassw0rd!');
  await apk('signup', e, PW);                       // the password the person remembers
  const v = await apk('verify', e, supabase.lastEmail(e, 'signup').otp, PW);
  assert.equal(v.ok, true, JSON.stringify(v));
  const login = await apk('login', e, PW);
  assert.equal(login.ok, true, 'before the fix this was 401 "Incorrect email or password"');
  assert.equal((await apk('login', e, 'FirstPassw0rd!')).status, 401);
});

test('APK resend, cooldown, password reset and existing-account sign-up', { skip: !hasJava && 'needs javac + APPROX_JSON_JAR' }, async () => {
  const e = `apk2-${Date.now()}@example.com`;
  await apk('signup', e, PW);
  const before = supabase.emails.filter((x) => x.to === e).length;
  supabase.flags.resendCooldownSecs = 0;
  const r = await apk('resend', e);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(supabase.emails.filter((x) => x.to === e).length, before + 1, 'resend sends a new email');
  supabase.flags.resendCooldownSecs = 60;
  const again = await apk('resend', e);
  assert.equal(again.ok, false); assert.equal(again.status, 429);
  assert.ok(again.retry_after > 0 && again.retry_after <= 60, `exact cooldown reaches the APK (${again.retry_after}s)`);
  supabase.flags.resendCooldownSecs = 0;
  // Existing, verified account: Supabase sends nothing (anti-enumeration) — the APK gets the same answer as the web.
  await apk('verify', e, supabase.lastEmail(e).otp, PW);
  const n = supabase.emails.length;
  const dup = await apk('signup', e, PW);
  assert.equal(dup.ok, true);
  assert.match(dup.body.message, /no new link is sent/);
  assert.equal(supabase.emails.length, n, 'no email for an existing verified account (web and APK alike)');
  const f = await apk('forgot', e);
  assert.equal(f.ok, true, JSON.stringify(f));
  assert.ok(supabase.lastEmail(e, 'recovery'), 'password reset email');
});
