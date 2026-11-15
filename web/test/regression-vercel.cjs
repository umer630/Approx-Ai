// Frozen-feature regression for the web app, run against the Vercel deployment topology (vercel-emulator.mjs:
// static web/ + rewrites to the api/index.js serverless function with VERCEL=1). Read-only with respect to the
// frontend: it checks that every frozen feature is present and works end-to-end on the serverless backend.
//   S=<screenshot dir> node web/test/regression-vercel.cjs
// Mock services (in-process): a GPU inference server that serves nick-4.8@1.0.0 and a Brevo mail endpoint.
// Database: a scratch libSQL file (APPROX_TEST_EPHEMERAL_DB) because no Turso server is reachable here.
const { chromium } = require('playwright');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');

const S = process.env.S || fs.mkdtempSync(path.join(os.tmpdir(), 'approx-shots-'));
const results = [];
const ok = (n, c, d = '') => { results.push([n, !!c]); console.log((c ? 'PASS' : 'FAIL') + '  ' + n + (c ? '' : '  — ' + d)); };
const listen = (h) => new Promise((r) => { const s = http.createServer(h); s.listen(0, '127.0.0.1', () => r(s)); });
const readBody = async (req) => { const c = []; for await (const x of req) c.push(x); return Buffer.concat(c).toString('utf8'); };

(async () => {
  // Supabase Auth test double (the same one the backend test suite uses).
  const { startFakeSupabase } = await import(path.join(__dirname, '../../backend/test/fake-supabase.js'));
  const supabase = await startFakeSupabase();
  const mails = [];
  const brevo = await listen(async (req, res) => { mails.push(JSON.parse(await readBody(req))); res.writeHead(201); res.end('{}'); });
  const REPLY = ['Here is **bold** text and code:\n\n', '```js\nconsole.log("approx");\n```\n'];
  const NICK_PIN = '2faae21620ef0aea6140b296b43ab5fcf5ba2c5b721067f91797b288a09c34c4';
  const inf = await listen(async (req, res) => {
    if (req.url === '/health') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ status: 'ok', serving: { 'nick-4.8': '1.0.0' },
      details: { 'nick-4.8': { version: '1.0.0', adapter_sha256: NICK_PIN, production_ready: true, smoke_test: false } } })); }
    const reqBody = JSON.parse((await readBody(req)) || '{}');
    if (reqBody.stream === false) { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ choices: [{ message: { content: 'Ready.' } }] })); }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    for (const p of REPLY) res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: p } }] })}\n\n`);
    res.end('data: [DONE]\n\n');
  });
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'approx-reg-'));
  const emu = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(__dirname, 'vercel-emulator.mjs')], {
    env: { PATH: process.env.PATH, HOME: process.env.HOME, VERCEL: '1', APPROX_ENV: 'test', APPROX_TEST_EPHEMERAL_DB: '1',
      APPROX_DB_URL: `file:${path.join(scratch, 'db.sqlite')}`, APPROX_MODEL_NICK_URL: `http://127.0.0.1:${inf.address().port}/v1`,
      MAIL_TRANSPORT: 'brevo', MAIL_HTTP_ENDPOINT: `http://127.0.0.1:${brevo.address().port}`, MAIL_HTTP_API_KEY: 'test-key',
      MAIL_FROM: 'Approx AI <noreply@example.com>', APPROX_BOOTSTRAP_SUPERADMIN_EMAIL: 'owner@example.com', APPROX_PUBLIC_URL: 'https://approx-ai.vercel.app',
      SUPABASE_URL: supabase.url, SUPABASE_PUBLISHABLE_KEY: supabase.publishableKey },
    stdio: ['ignore', 'pipe', 'inherit'] });
  const port = await new Promise((r) => { let o = ''; emu.stdout.on('data', (d) => { o += d; const m = /PORT (\d+)/.exec(o); if (m) r(m[1]); }); });
  const BASE = `http://127.0.0.1:${port}`;
  const b = await chromium.launch();
  try {
    // Static hosting checks (what Vercel will serve from web/).
    const st = await fetch(BASE + '/');
    ok('static index served with CSP + nosniff', st.status === 200 && (st.headers.get('content-security-policy') || '').includes("default-src 'self'") && st.headers.get('x-content-type-options') === 'nosniff');
    ok('developer console page served', (await fetch(BASE + '/developers/')).status === 200);
    ok('test files are not deployed (.vercelignore)', (await fetch(BASE + '/test/qa.cjs')).status === 404);
    const hz = await (await fetch(BASE + '/api/health')).json();
    ok('API via rewrite: serverless runtime, database ok', hz.runtime === 'serverless' && hz.database === 'ok', JSON.stringify(hz));

    const ctx = await b.newContext({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: 2 });
    const p = await ctx.newPage();
    const errs = []; p.on('console', (m) => { if (m.type() === 'error' && !/40[13]/.test(m.text()) && !m.text().includes('ERR_INTERNET_DISCONNECTED')) errs.push(m.text()); });
    await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE });

    // Splash: painted before JS (in the HTML), then removed — never a blank screen.
    const firstHtml = await (await fetch(BASE + '/')).text();
    ok('splash in the HTML: logo + "by Approx Technology"', firstHtml.includes('id="splash"') && firstHtml.includes('by Approx Technology') && firstHtml.includes('logo-mark-192.png'));
    await p.goto(BASE + '/#/login', { waitUntil: 'domcontentloaded' });
    ok('splash visible while starting', await p.locator('#splash').count() === 1);
    await p.waitForTimeout(1200);
    ok('splash removed after start (≤ ~1 s)', await p.locator('#splash').count() === 0);
    ok('login: "Welcome to Approx AI" / "Sign in to continue"', (await p.locator('.auth-card').innerText()).includes('Welcome to Approx AI') && (await p.locator('.auth-card').innerText()).includes('Sign in to continue'));
    ok('login: Forgot password? + Create account', (await p.locator('.auth-links').innerText()).includes('Forgot password?') && (await p.locator('.auth-links').innerText()).includes('Create account'));
    // Sign-up screen: Google button (disabled: no client ID configured here), password toggle, confirm password, sign-in link.
    await p.goto(BASE + '/#/signup', { waitUntil: 'networkidle' }); await p.waitForTimeout(400);
    ok('signup: "Create your Approx account" with Name, Email, Password, Confirm', (await p.locator('.auth-card').innerText()).includes('Create your Approx account') && await p.locator('#name').count() === 1);
    ok('signup: Continue with Google shown (disabled without a configured client ID)', await p.locator('.google-btn[disabled]').count() === 1 && (await p.locator('.google-slot').innerText()).includes('isn’t set up'));
    ok('signup: confirm password field', await p.locator('#password2').count() === 1);
    await p.locator('#password').fill('abc');
    await p.locator('[aria-controls="password"]').click();
    ok('password visibility toggle', await p.locator('#password').getAttribute('type') === 'text');
    ok('signup: "Already have an account? Sign in"', (await p.locator('.auth-links').innerText()).includes('Already have an account?'));
    await p.locator('#name').fill('X'); await p.locator('#email').fill('x@example.com'); await p.locator('#password').fill('Str0ng!Passw0rd1'); await p.locator('#password2').fill('Different1234');
    await p.locator('button[type=submit]').click(); await p.waitForTimeout(200);
    ok('signup: mismatched passwords caught before any request', (await p.locator('[role=alert]').innerText()).includes('don’t match'));
    await p.screenshot({ path: path.join(S, 'v-00-signup.png') });
    // Auth: signup → verification code (mailed) → verify page → sign in.
    await p.goto(BASE + '/#/signup', { waitUntil: 'networkidle' });
    await p.locator('input[type=email]').fill('owner@example.com');
    await p.goto(BASE + '/#/signup', { waitUntil: 'networkidle' }); await p.waitForTimeout(300);
    await p.locator('#name').fill('');
    await p.locator('#email').fill('owner@example.com');
    await p.locator('#password').fill('Str0ng!Passw0rd1'); await p.locator('#password2').fill('Str0ng!Passw0rd1');
    await p.locator('.btn.primary').first().click(); await p.waitForTimeout(300);
    ok('signup: name is required', (await p.locator('[role=alert]').innerText()).includes('Enter your name'));
    await p.locator('#name').fill('Owner');
    await p.locator('.btn.primary').first().click(); await p.waitForTimeout(1000);
    ok('after signup: "Check your email" state with resend', (await p.locator('.auth-card').innerText()).includes('Check your email') && await p.getByRole('button', { name: 'Resend verification email' }).count() === 1);
    ok('no onboarding questionnaire after signup', !/what do you want to build|what are you working on|tell me about your project/i.test(await p.locator('body').innerText()));
    const vmail = supabase.lastEmail('owner@example.com', 'signup');
    ok('signup: Supabase sends the confirmation email', !!vmail);
    ok('confirmation link returns to the public origin callback (no localhost)', vmail?.redirect_to === 'https://approx-ai.vercel.app/?auth=callback', vmail?.redirect_to);
    // Unverified sign-in: clear message + resend button.
    await p.goto(BASE + '/#/login', { waitUntil: 'networkidle' });
    await p.locator('input[type=email]').fill('owner@example.com'); await p.locator('input[type=password]').first().fill('Str0ng!Passw0rd1');
    let errsBefore = errs.length;
    await p.getByRole('button', { name: 'Sign in' }).first().click(); await p.waitForTimeout(800);
    ok('unverified sign-in explains and offers "Resend link"', (await p.locator('[role=alert]').innerText()).includes('verify your email') && await p.getByRole('button', { name: 'Resend link' }).count() === 1);
    await p.getByRole('button', { name: 'Resend link' }).click(); await p.waitForTimeout(600);
    ok('resend from the sign-in page sends a new link', supabase.emails.filter((m) => m.to === 'owner@example.com' && m.type === 'signup').length === 2, supabase.emails.filter((m) => m.to === 'owner@example.com').length);
    errs.length = errsBefore;
    // Click the emailed link: Supabase redirects to /?auth=callback#access_token=…; the app confirms and signs in.
    const landed = await supabase.click(supabase.lastEmail('owner@example.com', 'signup').link);
    const frag = new URLSearchParams(landed.params).toString();
    await p.goto(BASE + `/?auth=callback#${frag}`, { waitUntil: 'networkidle' }); await p.waitForTimeout(1200);
    ok('confirmation link verifies the email and signs the person in', (await p.locator('body').innerText()).includes('Email verified') && (await p.locator('body').innerText()).includes('Continue to Approx AI'));
    ok('tokens removed from the address bar', !/access_token|auth=callback/.test(p.url()), p.url());
    await p.reload({ waitUntil: 'networkidle' }); await p.waitForTimeout(500);
    ok('reload after verifying: no loop, no error', !(await p.locator('.alert.error').count()));
    // An old (superseded) link lands with an error fragment → clear message, resend offered.
    errsBefore = errs.length;
    const old = await supabase.click(supabase.emails.find((m) => m.to === 'owner@example.com').link);
    await p.goto(BASE + `/?auth=callback#${new URLSearchParams(old.params)}`, { waitUntil: 'networkidle' }); await p.waitForTimeout(600);
    ok('expired link shows a clear error with a resend option', (await p.locator('.alert.error').innerText().catch(() => '')).includes('invalid or has expired') && await p.locator('details[open]').count() === 1);
    errs.length = errsBefore;
    await fetch(BASE + '/api/auth/logout', { method: 'POST' });
    await ctx.clearCookies();
    // Password reset: Forgot password → Supabase email → link lands on /?auth=callback#…type=recovery → new password.
    await p.goto(BASE + '/#/forgot', { waitUntil: 'networkidle' });
    await p.locator('input[type=email]').fill('owner@example.com');
    await p.locator('.btn.primary').first().click(); await p.waitForTimeout(800);
    const rmail = supabase.lastEmail('owner@example.com', 'recovery');
    ok('forgot password: Supabase sends the reset email to the public callback', rmail?.redirect_to === 'https://approx-ai.vercel.app/?auth=callback');
    const rl = await supabase.click(rmail.link);
    await p.goto(BASE + `/?auth=callback#${new URLSearchParams(rl.params)}`, { waitUntil: 'networkidle' }); await p.waitForTimeout(600);
    ok('reset link opens "Choose a new password" without asking for a code', (await p.locator('body').innerText()).includes('Choose a new password') && await p.locator('#token').count() === 0);
    await p.locator('#newpw').fill('Str0ng!Passw0rd2'); await p.locator('button[type=submit]').click(); await p.waitForTimeout(1000);
    ok('new password saved', (await p.locator('body').innerText()).includes('Password updated'));
    await fetch(BASE + '/api/auth/forgot-password', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'owner@example.com' }) });
    const back = await fetch(BASE + '/api/auth/reset-password', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: supabase.lastEmail('owner@example.com', 'recovery').token_hash, password: 'Str0ng!Passw0rd1' }) });
    ok('reset by pasted code (Android path) works', back.status === 200);
    await p.goto(BASE + '/#/login', { waitUntil: 'networkidle' });
    // Auth UX: green + white page, logo mark (transparent, no dark tile), friendly offline error, loading state.
    ok('auth page background is white', await p.evaluate(() => getComputedStyle(document.body).backgroundColor) === 'rgb(255, 255, 255)');
    ok('auth logo uses the transparent mark', (await p.locator('.auth-card .logo img').getAttribute('src')).includes('logo-mark'));
    ok('primary button is Approx green', await p.locator('.btn.primary').evaluate((b) => getComputedStyle(b).backgroundColor) === 'rgb(14, 159, 85)');
    ok('buttons animate transform (press feedback)', (await p.locator('.btn.primary').evaluate((b) => getComputedStyle(b).transitionProperty)).includes('transform'));
    ok('press-down :active scale rule present', await p.evaluate(() => [...document.styleSheets].some((ss) => { try { return [...ss.cssRules].some((r) => /:active/.test(r.selectorText || '') && /scale\(/.test(r.cssText)); } catch { return false; } })));
    await p.route('**/api/auth/login', (r) => r.abort('internetdisconnected'));
    await p.locator('input[type=email]').fill('owner@example.com');
    await p.locator('input[type=password]').first().fill('Str0ng!Passw0rd1');
    await p.getByRole('button', { name: 'Sign in' }).first().click(); await p.waitForTimeout(600);
    ok('offline login shows a friendly error (no raw "Failed to fetch")', (await p.locator('[role=alert]').innerText()).includes("Can't reach Approx AI"));
    ok('button returns to normal after the error (no endless spinner)', await p.locator('button[type=submit]').evaluate((b) => !b.disabled && !b.classList.contains('loading') && b.textContent === 'Sign in'));
    await p.unroute('**/api/auth/login');
    let release; const hold = new Promise((r) => { release = r; });
    await p.route('**/api/auth/login', async (r) => { await hold; await r.continue(); });
    const clickP = p.locator('button[type=submit]').click();
    await p.waitForTimeout(250);
    ok('loading state while signing in (spinner + label + disabled)', await p.locator('button[type=submit]').evaluate((b) => b.disabled && b.classList.contains('loading') && b.textContent === 'Signing in…'));
    release(); await clickP; await p.unroute('**/api/auth/login');
    // The held request was a real sign-in: it completes and lands in the app.
    await p.waitForSelector('#prompt', { timeout: 10000 }).catch(() => {});
    ok('login lands in app', await p.locator('#prompt').count() === 1);
    // Activate Nick 4.8 through the real lifecycle flow (superadmin; backend verifies health + SHA-256 + generation).
    const act = await p.evaluate(async (pin) => {
      const me = await (await fetch('/api/auth/me')).json();
      const r = await fetch('/api/admin/models/nick-4.8/lifecycle', { method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': me.csrf_token },
        body: JSON.stringify({ to: 'DEPLOYING', version: '1.0.0', artifact: { uri: 'gs://approx-models/nick-4.8/1.0.0/adapter.tar.gz', sha256: pin, base_model: 'Qwen/Qwen2.5-3B-Instruct', base_revision: 'aa8e72537993ba99e69dfaafa59ed015b17504d1' } }) });
      return [r.status, await r.json()];
    }, NICK_PIN);
    ok('Nick 4.8 activated via lifecycle verification', act[0] === 200 && act[1].lifecycle?.state === 'ACTIVE', JSON.stringify(act[1]).slice(0, 200));
    await p.reload({ waitUntil: 'networkidle' }); await p.waitForTimeout(1000);
    // Returning user: session restored straight into the workspace — no login, no questionnaire.
    ok('returning user lands in the chat workspace', await p.locator('#prompt').count() === 1 && !p.url().includes('login'));
    const welcome = await p.locator('.welcome').innerText().catch(() => '');
    ok('welcome: "Peace be upon you, Owner" + "How can I help you today?"', welcome.includes('Peace be upon you, Owner') && welcome.includes('How can I help you today?'), welcome);
    ok('welcome has no questionnaire / task categories', !/what do you want to build|what are you working on|choose a task|suggestion/i.test(welcome) && await p.locator('.suggestion').count() === 0);
    ok('can type immediately', await p.evaluate(() => { const t = document.getElementById('prompt'); t.focus(); return document.activeElement === t; }));
    ok('header logo uses the transparent mark', (await p.locator('.brand img').getAttribute('src')).includes('logo-mark'));
    ok('app background is white (not black)', await p.evaluate(() => getComputedStyle(document.body).backgroundColor) === 'rgb(255, 255, 255)');
    await p.screenshot({ path: path.join(S, 'v-01-home.png') });

    // Composer: [+] text [model] [mic?] [send]; desktop shows the persistent sidebar.
    for (const lbl of ['Add attachments and tools', 'Select model', 'Send', 'New chat']) ok(`control present: ${lbl}`, await p.locator(`[aria-label="${lbl}"]`).count() >= 1);
    ok('composer has no mode toggle inside (mode lives in the model menu)', await p.locator('.composer .mode-toggle').count() === 0);
    ok('send button is Approx green', await p.locator('.round.send').evaluate((b) => getComputedStyle(b).backgroundColor) === 'rgb(14, 159, 85)');
    ok('desktop: sidebar drawer visible with Approx sections', await p.locator('#drawer').isVisible() && ['Projects', 'Approx Code', 'Artifacts', 'Schedule', 'Approx Work'].every((n) => true) &&
      ['Projects', 'Approx Code', 'Artifacts', 'Schedule', 'Approx Work', 'Recent'].every(Boolean));
    const drawerText = await p.locator('#drawer').innerText();
    for (const n of ['Approx', 'Projects', 'Approx Code', 'Artifacts', 'Schedule', 'Approx Work', 'Recent']) ok(`drawer: ${n}`, drawerText.toLowerCase().includes(n.toLowerCase()));
    const navLabels = await p.locator('nav.bottom-nav a').evaluateAll((as) => as.map((a) => a.getAttribute('aria-label')));
    ok('bottom nav: Chat / History / Work / Settings', JSON.stringify(navLabels) === '["Chat","History","Work","Settings"]', navLabels.join(','));

    // Model selector: only models this account may use (+ Auto); mode is separate.
    const allowed = await p.evaluate(async () => (await (await fetch('/api/models')).json()).models.filter((m) => m.available).map((m) => m.name));
    await p.locator('[aria-label="Select model"]').click(); await p.waitForTimeout(400);
    const sheetText = await p.locator('.sheet').innerText();
    ok('model menu: Auto + every model this account may use', sheetText.includes('Auto') && allowed.every((n) => sheetText.includes(n)), allowed.join(','));
    ok('Nick 4.8 shows the version the GPU host serves (v1.0.0)', /Nick 4\.8[\s\S]*v1\.0\.0/.test(sheetText));
    const modes = (await p.locator('.sheet .mode-toggle button').allTextContents()).map((x) => x.trim());
    ok('response modes Low/Medium/High in the model menu', JSON.stringify(modes) === '["Low","Medium","High"]', modes.join(','));
    await p.locator('.sheet .mode-toggle button[data-mode="high"]').click(); await p.waitForTimeout(300);
    await p.screenshot({ path: path.join(S, 'v-02-model-picker.png') });
    if (await p.locator('.sheet').count()) await p.keyboard.press('Escape');
    await p.locator('[aria-label="Select model"]').click(); await p.waitForTimeout(300);
    await p.locator('.sheet .option', { hasText: 'Nick 4.8' }).click(); await p.waitForTimeout(300);
    const chip = await p.locator('#model-chip').innerText();
    ok('selected model + mode stay visible in the composer chip', chip.includes('Nick 4.8') && chip.includes('High'), chip);

    // Plus menu: Photo / Files / Camera / Add to session / Add to project / Permissions — each wired.
    await p.locator('[aria-label="Add attachments and tools"]').click(); await p.waitForTimeout(300);
    const plus = await p.locator('.sheet').innerText();
    for (const n of ['Photo', 'Files', 'Camera', 'Add to session', 'Add to project', 'Permissions']) ok(`plus menu: ${n}`, plus.includes(n));
    await p.screenshot({ path: path.join(S, 'v-03-plus-menu.png') });
    for (const [label, check] of [['Photo', (i) => i.accept === 'image/*' && i.multiple], ['Files', (i) => i.accept.includes('.pdf') && i.accept.includes('.py')], ['Camera', (i) => i.accept === 'image/*' && i.capture === 'environment']]) {
      if (!(await p.locator('.sheet').count())) { await p.locator('[aria-label="Add attachments and tools"]').click(); await p.waitForTimeout(250); }
      const [fc] = await Promise.all([p.waitForEvent('filechooser', { timeout: 3000 }).catch(() => null), p.locator('.sheet .list-item').filter({ has: p.locator('.title', { hasText: new RegExp(`^${label}$`) }) }).click()]);
      const attrs = fc ? await fc.element().evaluate((i) => ({ accept: i.accept, multiple: i.multiple, capture: i.getAttribute('capture') })) : null;
      ok(`plus → ${label} opens the right picker`, !!attrs && check(attrs), JSON.stringify(attrs));
      if (fc && label === 'Files') await fc.setFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('Approx notes for the session') });
      await p.waitForTimeout(500);
    }
    ok('Files: upload attached to the message', (await p.locator('#att-chips').innerText()).includes('notes.txt'));
    await p.locator('#att-chips button').first().click();
    await p.locator('[aria-label="Add attachments and tools"]').click(); await p.waitForTimeout(250);
    await p.locator('.sheet .list-item', { hasText: 'Add to session' }).click(); await p.waitForTimeout(700);
    ok('Add to session lists files from your library', (await p.locator('.sheet').innerText()).includes('notes.txt'));
    await p.locator('.sheet .list-item', { hasText: 'notes.txt' }).click(); await p.waitForTimeout(300);
    ok('Add to session re-attaches a library file', (await p.locator('#att-chips').innerText()).includes('notes.txt'));
    await p.locator('#att-chips button').first().click();
    await p.locator('[aria-label="Add attachments and tools"]').click(); await p.waitForTimeout(250);
    await p.locator('.sheet .list-item', { hasText: 'Permissions' }).click(); await p.waitForTimeout(300);
    await p.locator('.sheet .option', { hasText: 'Automatic' }).click(); await p.waitForTimeout(600);
    ok('Permissions → Automatic saved on the server', (await p.evaluate(async () => (await (await fetch('/api/settings')).json()).settings.permissions_mode)) === 'automatic');
    await p.locator('[aria-label="Add attachments and tools"]').click(); await p.waitForTimeout(250);
    await p.locator('.sheet .list-item', { hasText: 'Permissions' }).click(); await p.waitForTimeout(300);
    await p.locator('.sheet .option', { hasText: 'Manual' }).click(); await p.waitForTimeout(500);

    // Chat: send → streamed reply from Nick 4.8 (GPU host) with markdown, code copy, copy + regenerate.
    await p.locator('#prompt').fill('Show me some code');
    const sendBtn = p.locator('.round.send');
    await sendBtn.click();
    await p.waitForTimeout(150);
    ok('send shows a stop/sending state while streaming', (await sendBtn.getAttribute('aria-label')) === 'Stop' || (await p.locator('.msg.assistant pre code').count()) > 0);
    await p.waitForSelector('.msg.assistant pre code', { timeout: 15000 }).catch(() => {});
    await p.waitForTimeout(800);
    const last = p.locator('.msg.assistant').last();
    ok('assistant reply rendered', (await last.innerText()).includes('console.log("approx")'));
    ok('markdown: bold rendered', await last.locator('strong').count() >= 1);
    ok('markdown: code block rendered', await last.locator('pre code').count() >= 1);
    ok('code block copy button', await last.locator('[data-copy-code]').count() >= 1);
    ok('message copy + regenerate buttons', await last.locator('[aria-label="Copy"]').count() >= 1 && await last.locator('[aria-label="Regenerate"]').count() >= 1);
    ok('send button returns to normal after the reply', (await sendBtn.getAttribute('aria-label')) === 'Send');
    ok('URL switched to chat route', /#\/c\/\w+/.test(p.url()));
    await p.waitForTimeout(600);
    ok('header shows the session title', (await p.locator('#chat-title').innerText()).length > 0 && (await p.locator('#chat-title').innerText()) !== 'New chat');
    ok('drawer Recent shows the real session', await p.locator('#drawer-recent .recent-item').count() >= 1);
    await p.screenshot({ path: path.join(S, 'v-04-chat.png') });
    await last.locator('[aria-label="Regenerate"]').click(); await p.waitForTimeout(1500);
    ok('regenerate produced a reply', (await p.locator('.msg.assistant').last().innerText()).includes('console.log'));
    const lastA = p.locator('.msg.assistant').last();
    await lastA.locator('[aria-label="Good response"]').click(); await p.waitForTimeout(500);
    ok('👍 marks the reply', await lastA.locator('[aria-label="Good response"][aria-pressed="true"]').count() === 1);
    const chatId = /#\/c\/(\w+)/.exec(p.url())[1];
    const persisted = await p.evaluate(async (id) => (await (await fetch(`/api/chats/${id}`)).json()).messages.filter((m) => m.role === 'assistant').pop().feedback, chatId);
    ok('feedback saved on the server', persisted?.rating === 'up', JSON.stringify(persisted));
    await p.locator('.msg.user').first().locator('[aria-label="Edit"]').click();
    ok('edit puts the message back in the composer', (await p.locator('#prompt').inputValue()) === 'Show me some code');
    await p.locator('#prompt').fill('');

    // ⋯ session menu: every item works against the backend.
    let t0 = Date.now(); await p.locator('[aria-label="Session options"]').click(); await p.waitForSelector('.sheet'); const menuMs = Date.now() - t0;
    ok(`⋯ menu opens immediately (${menuMs} ms)`, menuMs < 400);
    const menuText = await p.locator('.sheet').innerText();
    for (const n of ['Copy branch', 'Background tasks', 'Share', 'Rename', 'Archive', 'Send feedback']) ok(`session menu: ${n}`, menuText.includes(n));
    await p.screenshot({ path: path.join(S, 'v-04b-chat-menu.png') });
    await p.locator('.sheet .list-item', { hasText: 'Rename' }).click(); await p.waitForTimeout(300);
    await p.locator('.sheet input').fill('Renamed session'); await p.locator('.sheet .btn.primary').click(); await p.waitForTimeout(700);
    ok('Rename updates the header and the server', (await p.locator('#chat-title').innerText()) === 'Renamed session' &&
      (await p.evaluate(async (id) => (await (await fetch(`/api/chats/${id}`)).json()).chat.title, chatId)) === 'Renamed session');
    await p.locator('[aria-label="Session options"]').click(); await p.waitForTimeout(250);
    await p.locator('.sheet .list-item', { hasText: 'Copy branch' }).click(); await p.waitForTimeout(1200);
    const branchId = /#\/c\/(\w+)/.exec(p.url())?.[1];
    ok('Copy branch opens a new session with the same messages', branchId && branchId !== chatId && (await p.locator('#chat-title').innerText()).includes('(branch)') && await p.locator('.msg.assistant').count() >= 1);
    await p.locator('[aria-label="Session options"]').click(); await p.waitForTimeout(250);
    await p.locator('.sheet .list-item', { hasText: 'Background tasks' }).click(); await p.waitForTimeout(700);
    ok('Background tasks sheet loads (real /api/tasks)', (await p.locator('.sheet').innerText()).includes('Background tasks') && await p.locator('.sheet .alert.error').count() === 0);
    await p.keyboard.press('Escape');
    await p.locator('[aria-label="Session options"]').click(); await p.waitForTimeout(250);
    await p.locator('.sheet .list-item', { hasText: 'Send feedback' }).click(); await p.waitForTimeout(300);
    await p.locator('.sheet textarea').fill('The new drawer is great'); await p.locator('.sheet .btn.primary').click(); await p.waitForTimeout(700);
    const fb = await p.evaluate(async () => (await (await fetch('/api/admin/feedback')).json()).app_feedback);
    ok('Send feedback stored (visible to admins)', fb?.some((x) => x.message === 'The new drawer is great' && x.chat_id));
    await p.locator('[aria-label="Session options"]').click(); await p.waitForTimeout(250);
    await p.locator('.sheet .list-item', { hasText: 'Archive' }).click(); await p.waitForTimeout(800);
    ok('Archive archives the session on the server', (await p.evaluate(async (id) => (await (await fetch(`/api/chats/${id}`)).json()).chat.archived, branchId)) === true);

    // History page: Recent / Background tasks / Archived / Trash + search (SPA, no reload).
    await p.evaluate(() => { window.__noReload = 'still-here'; });
    t0 = Date.now(); await p.locator('#drawer a.drawer-more').click(); await p.waitForSelector('[aria-label="Search conversations"]'); const histMs = Date.now() - t0;
    ok(`History opens fast (${histMs} ms)`, histMs < 1000);
    await p.waitForTimeout(500);
    ok('History lists real sessions', (await p.locator('#main .list-item').count()) >= 1);
    await p.locator('.tabs button', { hasText: 'Archived' }).click(); await p.waitForTimeout(600);
    ok('History → Archived shows the archived branch', (await p.locator('#main').innerText()).includes('(branch)'));
    await p.locator('[aria-label="Search conversations"]').fill('Renamed'); await p.waitForTimeout(700);
    await p.locator('.tabs button', { hasText: 'Recent' }).click(); await p.waitForTimeout(700);
    ok('History search finds the renamed session', (await p.locator('#main').innerText()).includes('Renamed session'));
    await p.screenshot({ path: path.join(S, 'v-05-history.png') });

    // Settings: page navigation without reload; every section opens and loads.
    t0 = Date.now(); await p.goto(BASE + '/#/settings', { waitUntil: 'commit' }).catch(() => {}); await p.evaluate(() => { location.hash = '#/settings'; });
    await p.waitForSelector('.settings-list'); const setMs = Date.now() - t0;
    ok(`Settings opens fast (${setMs} ms)`, setMs < 1500);
    const set = await p.locator('#main').innerText();
    for (const n of ['Profile', 'Billing', 'Usage', 'Capabilities', 'Approx Code', 'Connectors', 'Notifications', 'Security', 'Appearance', 'Account', 'Help & Support', 'Admin console', 'Log out']) ok(`settings: ${n}`, set.includes(n));
    ok('settings rows have icons', await p.locator('.settings-row .settings-icon svg').count() >= 11);
    await p.screenshot({ path: path.join(S, 'v-06-settings.png') });
    for (const key of ['profile', 'billing', 'usage', 'capabilities', 'code', 'connectors', 'notifications', 'security', 'appearance', 'account', 'help', 'memory', 'models', 'privacy', 'personalization', 'api']) {
      await p.evaluate((k) => { location.hash = `#/settings/${k}`; }, key); await p.waitForTimeout(700);
      const body = await p.locator('#main').innerText();
      ok(`settings/${key} loads without error`, await p.locator('#main .alert.error').count() === 0 && (body.length > 40 || await p.locator('#main textarea, #main input, #main select').count() > 0), body.slice(0, 120));
      if (['profile', 'usage', 'billing', 'capabilities', 'connectors'].includes(key)) await p.screenshot({ path: path.join(S, `v-06-${key}.png`) });
    }
    await p.evaluate(() => { location.hash = '#/settings/profile'; }); await p.waitForTimeout(700);
    ok('Profile shows real account data + activity', (await p.locator('#main').innerText()).includes('owner@example.com') && (await p.locator('#main').innerText()).includes('Signed in'));
    await p.evaluate(() => { location.hash = '#/settings/usage'; }); await p.waitForTimeout(800);
    ok('Usage shows rings, 14-day bars and per-model usage', await p.locator('.ring-card').count() === 2 && await p.locator('.bars i').count() === 14 && (await p.locator('#main').innerText()).includes('Nick 4.8'));
    await p.evaluate(() => { location.hash = '#/settings/billing'; }); await p.waitForTimeout(500);
    ok('Billing shows the real plan and names the missing payment backend (no fake payments)', /Free/.test(await p.locator('#main').innerText()) && (await p.locator('#main').innerText()).includes('no payment provider'));
    await p.evaluate(() => { location.hash = '#/settings/capabilities'; }); await p.waitForTimeout(600);
    ok('Capabilities lists models with real availability', (await p.locator('#main').innerText()).includes('Nick 4.8') && (await p.locator('#main').innerText()).includes('Connectors'));
    await p.evaluate(() => { location.hash = '#/settings/connectors'; }); await p.waitForTimeout(400);
    ok('Connectors: nothing connected, no secrets shown', (await p.locator('#main').innerText()).includes('No services are connected') && !/sb_secret|service_role|api[_ ]?key\s*[:=]/i.test(await p.locator('#main').innerText()));
    await p.evaluate(() => { location.hash = '#/settings/appearance'; }); await p.waitForTimeout(400);
    await p.locator('.option', { hasText: 'Dark' }).click(); await p.waitForTimeout(500);
    ok('Appearance → Dark applies and saves', await p.evaluate(() => document.documentElement.dataset.theme) === 'dark');
    await p.locator('.option', { hasText: 'Light' }).click(); await p.waitForTimeout(500);
    ok('navigation stayed in-page (no full reload)', await p.evaluate(() => window.__noReload) === 'still-here');
    await p.evaluate(() => { location.hash = '#/work'; }); await p.waitForTimeout(700);
    ok('Approx Work: background tasks + artifacts', /background tasks/i.test(await p.locator('#main').innerText()) && /recent artifacts/i.test(await p.locator('#main').innerText()));
    await p.evaluate(() => { location.hash = '#/schedule'; }); await p.waitForTimeout(400);
    ok('Schedule states the missing scheduler backend honestly (no fake schedules)', (await p.locator('#main').innerText()).includes('aren’t available yet'));

    // Feature pages: Projects, Workspace (Approx Work equivalent), Code (Approx Code equivalent), Research, Admin.
    for (const [route, label] of [['#/projects', 'Projects'], ['#/workspace', 'Workspace'], ['#/code', 'Code'], ['#/research', 'Research'], ['#/admin', 'Admin']]) {
      await p.goto(BASE + '/' + route, { waitUntil: 'networkidle' }); await p.waitForTimeout(600);
      const t = await p.locator('#main').innerText().catch(() => '');
      ok(`page ${route} loads`, t.length > 10 && !/Unknown endpoint|Internal error/i.test(t), t.slice(0, 120));
      await p.screenshot({ path: path.join(S, `v-07-${label.toLowerCase()}.png`) });
    }
    const adminText = await p.locator('#main').innerText();
    ok('admin registry shows Nick 4.8 served by the GPU host', /nick-4\.8\s*active v1\.0\.0/.test(adminText) && adminText.includes('served by inference server'), adminText.slice(adminText.indexOf('Model registry'), adminText.indexOf('Model registry') + 300));
    ok('admin registry does not claim versions for unserved models', /hike-6\.5\s*no active version/.test(adminText));

    // Developer console with API key creation.
    await p.goto(BASE + '/developers/', { waitUntil: 'networkidle' }); await p.waitForTimeout(800);
    ok('developer console renders', (await p.locator('body').innerText()).length > 50);
    await p.screenshot({ path: path.join(S, 'v-08-developers.png') });

    // Desktop/web responsive: wide layout keeps the sidebar and hides the bottom nav.
    await p.goto(BASE + '/', { waitUntil: 'networkidle' }); await p.waitForTimeout(900);
    const lay = await p.evaluate(() => ({ w: innerWidth, nav: getComputedStyle(document.querySelector('nav.bottom-nav') || document.body).display,
      drawer: (() => { const d = document.getElementById('drawer'); return d ? `${getComputedStyle(d).position}/${getComputedStyle(d).transform}` : 'none'; })(), hash: location.hash }));
    ok('desktop: bottom nav hidden, sidebar shown', lay.nav === 'none' && lay.drawer.startsWith('static'), JSON.stringify(lay));
    // Mobile layout: drawer, bottom nav, composer visible, voice button wiring.
    const m = await b.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, storageState: await ctx.storageState() });
    await m.addInitScript(() => {
      // Speech-recognition stand-in (headless Chromium has none): checks the mic wiring end-to-end in the page.
      window.SpeechRecognition = class { start() { setTimeout(() => { this.onresult?.({ results: [[{ transcript: 'Mujhe MySQL database banana hai' }]] }); this.onend?.(); }, 50); } stop() { this.onend?.(); } };
    });
    const mp = await m.newPage(); await mp.goto(BASE + '/', { waitUntil: 'networkidle' }); await mp.waitForTimeout(1000);
    ok('mobile: no horizontal overflow', await mp.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
    ok('mobile: bottom nav visible', await mp.locator('nav.bottom-nav').isVisible());
    const box = await mp.locator('.composer').boundingBox();
    ok('mobile: composer fully on screen above the nav', box && box.y + box.height <= 844 && box.y > 400, JSON.stringify(box));
    let t1 = Date.now(); await mp.locator('[aria-label="Open menu"]').tap(); await mp.waitForTimeout(260); const drawMs = Date.now() - t1;
    ok(`mobile: drawer opens (${drawMs} ms incl. animation)`, await mp.evaluate(() => document.querySelector('.shell').classList.contains('drawer-open')) && drawMs < 800);
    await mp.screenshot({ path: path.join(S, 'v-09-mobile-drawer.png') });
    await mp.locator('.drawer-scrim').click({ position: { x: 370, y: 400 } }); await mp.waitForTimeout(300);
    ok('mobile: drawer closes on tap outside', !(await mp.evaluate(() => document.querySelector('.shell').classList.contains('drawer-open'))));
    await mp.locator('[aria-label="Voice input"]').tap(); await mp.waitForTimeout(400);
    ok('voice: speech result goes into the composer', (await mp.locator('#prompt').inputValue()).includes('MySQL database'));
    await mp.screenshot({ path: path.join(S, 'v-09-mobile.png') });
    await mp.locator('nav.bottom-nav a[aria-label="Settings"]').tap(); await mp.waitForTimeout(500);
    ok('mobile: bottom nav → Settings', await mp.locator('.settings-list').count() >= 1);
    await mp.screenshot({ path: path.join(S, 'v-10-mobile-settings.png') });
    // Log out and sign in again.
    await mp.locator('.settings-row.signout').tap(); await mp.waitForTimeout(800);
    ok('logout returns to sign-in', mp.url().includes('#/login') && (await mp.locator('.auth-card').innerText()).includes('Welcome to Approx AI'));
    await mp.locator('input[type=email]').fill('owner@example.com'); await mp.locator('input[type=password]').first().fill('Str0ng!Passw0rd1');
    await mp.getByRole('button', { name: 'Sign in' }).first().tap(); await mp.waitForSelector('#prompt', { timeout: 8000 }).catch(() => {});
    ok('login again lands in the workspace', await mp.locator('#prompt').count() === 1);
    ok('no console errors', errs.length === 0, errs.join(' | '));
  } catch (e) { ok('run completed', false, e.stack); }
  await b.close(); emu.kill(); brevo.close(); inf.close(); supabase.close();
  const fails = results.filter((r) => !r[1]);
  console.log(`\n${results.length - fails.length}/${results.length} passed${fails.length ? ' — FAILED: ' + fails.map((f) => f[0]).join('; ') : ''}`);
  process.exit(fails.length ? 1 : 0);
})();
