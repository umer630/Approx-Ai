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
  const mails = [];
  const brevo = await listen(async (req, res) => { mails.push(JSON.parse(await readBody(req))); res.writeHead(201); res.end('{}'); });
  const REPLY = ['Here is **bold** text and code:\n\n', '```js\nconsole.log("approx");\n```\n'];
  const inf = await listen(async (req, res) => {
    if (req.url === '/health') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ status: 'ok', serving: { 'nick-4.8': '1.0.0' } })); }
    await readBody(req);
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    for (const p of REPLY) res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: p } }] })}\n\n`);
    res.end('data: [DONE]\n\n');
  });
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'approx-reg-'));
  const emu = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(__dirname, 'vercel-emulator.mjs')], {
    env: { PATH: process.env.PATH, HOME: process.env.HOME, VERCEL: '1', APPROX_ENV: 'test', APPROX_TEST_EPHEMERAL_DB: '1',
      APPROX_DB_URL: `file:${path.join(scratch, 'db.sqlite')}`, APPROX_MODEL_NICK_URL: `http://127.0.0.1:${inf.address().port}/v1`,
      MAIL_TRANSPORT: 'brevo', MAIL_HTTP_ENDPOINT: `http://127.0.0.1:${brevo.address().port}`, MAIL_HTTP_API_KEY: 'test-key',
      MAIL_FROM: 'Approx AI <noreply@example.com>', APPROX_BOOTSTRAP_SUPERADMIN_EMAIL: 'owner@example.com' },
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

    // Auth: signup → verification code (mailed) → verify page → sign in.
    await p.goto(BASE + '/#/signup', { waitUntil: 'networkidle' });
    await p.locator('input[type=email]').fill('owner@example.com');
    const pws = p.locator('input[type=password]'); for (let i = 0; i < await pws.count(); i++) await pws.nth(i).fill('Str0ng!Passw0rd1');
    await p.locator('.btn.primary').first().click(); await p.waitForTimeout(1000);
    ok('signup sends verification mail', mails.length === 1);
    const code = /Verification code: (\S+)/.exec(mails[0]?.textContent || '')?.[1];
    await p.goto(BASE + `/#/verify?token=${encodeURIComponent(code || '')}`, { waitUntil: 'networkidle' });
    await p.locator('button[type=submit]').click(); await p.waitForTimeout(800);
    ok('verify page confirms email', (await p.locator('body').innerText()).includes('Email verified'));
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
    ok('greeting is warm and personal', /^(Hi Owner — ready when you are\.|Good (morning|afternoon|evening), Owner\.|Welcome back, Owner\.|Still at it, Owner\?|Morning, Owner\. Good to see you\.|Good to see you, Owner\.)$/.test((await p.locator('.welcome h1').innerText()).trim()), await p.locator('.welcome h1').innerText());
    ok('header logo uses the transparent mark', (await p.locator('.brand img').getAttribute('src')).includes('logo-mark'));
    ok('app background is white (not black)', await p.evaluate(() => getComputedStyle(document.body).backgroundColor) === 'rgb(255, 255, 255)');
    await p.screenshot({ path: path.join(S, 'v-01-home.png') });

    // Composer controls.
    for (const lbl of ['Add attachments and tools', 'Select model', 'Send', 'Current model', 'Account', 'Settings'])
      ok(`control present: ${lbl}`, await p.locator(`[aria-label="${lbl}"]`).count() >= 1);
    const navText = (await p.locator('nav.bottom-nav button').allInnerTexts()).map((t) => t.trim());
    ok('bottom nav: New chat / History / Settings', JSON.stringify(navText) === '["New chat","History","Settings"]', navText.join(','));

    // Model selector: all five models + Master Router + Low/Medium/High.
    await p.locator('[aria-label="Select model"]').click(); await p.waitForTimeout(500);
    const sheetText = await p.locator('.sheet').innerText();
    for (const n of ['Master Router (Auto)', 'Nick 4.8', 'Hike 6.5', 'Sona 9.0', 'FAB 100x', 'FAB 500X']) ok(`model selector lists ${n}`, sheetText.includes(n));
    ok('Nick 4.8 shows the version the GPU host serves (v1.0.0)', /Nick 4\.8[\s\S]*v1\.0\.0/.test(sheetText));
    const modes = (await p.locator('.sheet .mode-toggle button').allTextContents()).map((s) => s.trim());
    ok('modes Low/Medium/High', JSON.stringify(modes) === '["Low","Medium","High"]', modes.join(','));
    await p.locator('.sheet .mode-toggle button[data-mode="high"]').click(); await p.waitForTimeout(300);
    await p.screenshot({ path: path.join(S, 'v-02-model-picker.png') });
    if (await p.locator('.sheet').count()) await p.keyboard.press('Escape');
    await p.locator('[aria-label="Select model"]').click(); await p.waitForTimeout(400);
    await p.locator('.sheet .option', { hasText: 'Nick 4.8' }).click(); await p.waitForTimeout(300);
    ok('model indicator shows Nick 4.8', (await p.locator('#model-indicator').innerText()).includes('Nick 4.8'));
    ok('composer mode toggle matches the mode chosen in the model sheet (High)', await p.locator('.composer .mode-toggle button[data-mode="high"][aria-pressed="true"]').count() === 1);

    // Plus menu.
    await p.locator('[aria-label="Add attachments and tools"]').click(); await p.waitForTimeout(400);
    const plus = await p.locator('.sheet').innerText();
    for (const n of ['File', 'Image', 'PDF', 'Document', 'Camera', 'Data analysis', 'Research', 'Code (Fabbox)', 'Workspace', 'Projects']) ok(`plus menu: ${n}`, plus.includes(n));
    await p.screenshot({ path: path.join(S, 'v-03-plus-menu.png') });
    await p.keyboard.press('Escape');

    // Chat: send → streamed reply from Nick 4.8 (GPU host) with markdown, code copy, copy + regenerate.
    await p.locator('#prompt').fill('Show me some code');
    await p.locator('[aria-label="Send"]').click();
    await p.waitForSelector('.msg.assistant pre code', { timeout: 15000 }).catch(() => {});
    await p.waitForTimeout(800);
    const last = p.locator('.msg.assistant').last();
    ok('assistant reply rendered', (await last.innerText()).includes('console.log("approx")'));
    ok('markdown: bold rendered', await last.locator('strong').count() >= 1);
    ok('markdown: code block rendered', await last.locator('pre code').count() >= 1);
    ok('code block copy button', await last.locator('[data-copy-code]').count() >= 1);
    ok('message copy button', await last.locator('[aria-label="Copy"]').count() >= 1);
    ok('message regenerate button', await last.locator('[aria-label="Regenerate"]').count() >= 1);
    ok('URL switched to chat route', /#\/c\/\w+/.test(p.url()));
    await p.screenshot({ path: path.join(S, 'v-04-chat.png') });
    await last.locator('[aria-label="Regenerate"]').click(); await p.waitForTimeout(1500);
    ok('regenerate produced a reply', (await p.locator('.msg.assistant').last().innerText()).includes('console.log'));

    // History + search.
    await p.locator('nav.bottom-nav button', { hasText: 'History' }).click(); await p.waitForTimeout(700);
    ok('history search box', await p.locator('[aria-label="Search conversations"]').count() === 1);
    ok('history lists the chat', (await p.locator('.sheet').innerText()).length > 30);
    await p.screenshot({ path: path.join(S, 'v-05-history.png') });
    await p.keyboard.press('Escape');

    // Settings sections.
    await p.locator('[aria-label="Settings"]').first().click(); await p.waitForTimeout(500);
    const set = await p.locator('.sheet').innerText();
    for (const n of ['Account & profile', 'Security & password', 'Privacy & data controls', 'Memory', 'Model preferences', 'Usage & quota', 'API', 'Delete account', 'Admin console', 'Log out']) ok(`settings: ${n}`, set.includes(n));
    await p.locator('.sheet .list-item', { hasText: 'Model preferences' }).click(); await p.waitForTimeout(600);
    ok('model preferences section loads without error', await p.locator('.sheet .alert.error').count() === 0);
    await p.screenshot({ path: path.join(S, 'v-06-settings.png') });
    await p.keyboard.press('Escape');

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

    // Mobile layout.
    const m = await b.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, storageState: await ctx.storageState() });
    const mp = await m.newPage(); await mp.goto(BASE + '/', { waitUntil: 'networkidle' }); await mp.waitForTimeout(800);
    ok('mobile: no horizontal overflow', await mp.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
    await mp.screenshot({ path: path.join(S, 'v-09-mobile.png') });
    ok('no console errors', errs.length === 0, errs.join(' | '));
  } catch (e) { ok('run completed', false, e.stack); }
  await b.close(); emu.kill(); brevo.close(); inf.close();
  const fails = results.filter((r) => !r[1]);
  console.log(`\n${results.length - fails.length}/${results.length} passed${fails.length ? ' — FAILED: ' + fails.map((f) => f[0]).join('; ') : ''}`);
  process.exit(fails.length ? 1 : 0);
})();
