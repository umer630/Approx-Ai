// Browser test for the FAB 500X Code workspace (desktop + mobile) against the real backend (fake Supabase, dev
// simulator provider — the simulator's proposals are labelled as such). Run: node web/test/fab500x-ui.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const S = process.env.S || fs.mkdtempSync(path.join(os.tmpdir(), 'fx-shots-'));
const H = await import('../../backend/test/helpers.js');
const { req, makeUser, asAdmin, BASE, close } = H;
const results = [];
const ok = (name, cond, extra = '') => { results.push([name, !!cond]); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  — ' + String(extra).slice(0, 400)}`); };

const sa = await asAdmin(await makeUser(), 'superadmin');
const dev = await makeUser();
const plain = await makeUser();
await req('PUT', `/api/admin/clients/${dev.id}/models/fab-500x`, { headers: { cookie: sa.admin.cookie, 'x-admin-csrf': sa.admin.csrf }, body: { access: 'enabled', reason: 'ui test' } });

const b = await chromium.launch();
const login = async (ctx, u) => {
  const p = await ctx.newPage();
  await p.goto(BASE + '/#/login', { waitUntil: 'domcontentloaded' });
  await p.evaluate(async ([email, password]) => fetch('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) }), [u.email, u.password]);
  return p;
};
try {
  // Normal user: no drawer entry, workspace refuses.
  const c0 = await b.newContext({ viewport: { width: 1280, height: 820 } });
  const p0 = await login(c0, plain);
  await p0.goto(BASE + '/#/', { waitUntil: 'load' }); await p0.waitForTimeout(800);
  ok('normal user: no FAB 500X Code entry', await p0.locator('#drawer a[href="#/fab500x"]').count() === 0);
  await p0.evaluate(() => { location.hash = '#/fab500x'; }); await p0.waitForTimeout(700);
  ok('normal user: direct URL shows the no-access message', /administrator has granted access/.test(await p0.locator('#main').innerText()));
  await c0.close();

  // Granted user, desktop.
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  const p = await login(ctx, dev);
  const errs = []; p.on('console', (m) => { if (m.type() === 'error' && !/40[0-9]|50[0-9]/.test(m.text())) errs.push(m.text()); });
  await p.goto(BASE + '/#/', { waitUntil: 'load' }); await p.waitForTimeout(800);
  ok('granted user: drawer shows FAB 500X Code', await p.locator('#drawer a[href="#/fab500x"]').count() === 1);
  await p.locator('#drawer a[href="#/fab500x"]').click(); await p.waitForTimeout(800);
  const home = await p.locator('#main').innerText();
  ok('home: honest capabilities (terminal unavailable, image/video not connected)', /no isolated sandbox runner/.test(home) && /not connected/.test(home), home.slice(0, 300));
  await p.locator('input[aria-label="Project name"]').fill('Shop site');
  await p.getByRole('button', { name: 'Create' }).click(); await p.waitForSelector('.fx', { timeout: 5000 });
  ok('IDE opens full-screen (not the chat page)', await p.locator('.fx-top').isVisible() && await p.locator('#prompt').count() === 0);
  ok('IDE layout: explorer, editor area, assistant, panel', await p.locator('.fx-side').isVisible() && await p.locator('.fx-center').isVisible() && await p.locator('.fx-asst').isVisible() && await p.locator('.fx-panel').isVisible());
  // create a file through the dialog
  await p.getByRole('button', { name: 'New file' }).click(); await p.waitForTimeout(200);
  await p.locator('.sheet input').fill('src/app.js'); await p.locator('.sheet .btn.primary').click(); await p.waitForTimeout(700);
  ok('new file opens in a tab', (await p.locator('.fx-tab.active').innerText()).includes('app.js'));
  await p.locator('.fx-ta').click();
  await p.keyboard.type('const api_key = "abcdefghijklmnopqrstuvwx";\nfunction greet(name) { return `hi ${name}`; }\n// done\n');
  await p.waitForTimeout(300);
  ok('syntax highlighting renders keywords, strings and comments', await p.locator('.fx-hl .tk-kw').count() >= 2 && await p.locator('.fx-hl .tk-str').count() >= 1 && await p.locator('.fx-hl .tk-com').count() === 1);
  ok('unsaved marker shown', (await p.locator('.fx-tab.active .fx-x').innerText()).includes('●'));
  await p.keyboard.press('Control+s'); await p.waitForTimeout(600);
  ok('Ctrl+S saves to the server', (await p.evaluate(async (pid) => (await (await fetch(`/api/fab500x/projects/${pid}/file?path=src/app.js`)).json()).file.content, p.url().split('/').pop())).includes('greet'));
  // find / replace
  await p.keyboard.press('Control+f'); await p.locator('input[aria-label="Find"]').fill('greet'); await p.locator('input[aria-label="Replace"]').fill('welcome');
  await p.locator('.fx-find .btn', { hasText: 'All' }).click(); await p.waitForTimeout(300);
  ok('find/replace all', (await p.locator('.fx-ta').inputValue()).includes('welcome') && !(await p.locator('.fx-ta').inputValue()).includes('greet'));
  await p.keyboard.press('Control+s'); await p.waitForTimeout(500);
  // problems panel flags the hard-coded secret
  await p.locator('.fx-ptabs button', { hasText: 'Problems' }).click(); await p.waitForTimeout(700);
  ok('Problems panel flags the hard-coded secret', /Possible hard-coded secret/.test(await p.locator('.fx-pbody').innerText()));
  // terminal is honest
  await p.locator('.fx-ptabs button', { hasText: 'Terminal' }).click(); await p.locator('.fx-cmd').fill('npm test'); await p.keyboard.press('Enter'); await p.waitForTimeout(600);
  ok('Terminal: no fake execution (runner_not_configured)', /runner_not_configured/.test(await p.locator('.fx-term').innerText()));
  // assistant: manual proposal with diff → approve
  await p.locator('textarea[aria-label="Instruction for FAB 500X"]').fill('Document the project in NOTES.md');
  await p.locator('.fx-asst .btn.primary', { hasText: 'Send' }).click(); await p.waitForSelector('.fx-prop', { timeout: 8000 });
  const card = await p.locator('.fx-prop').first().innerText();
  ok('assistant: proposal with plan + diff + commands, pending (Manual)', /pending/i.test(card) && /NOTES\.md/.test(card) && /npm test/.test(card) && await p.locator('.fx-prop .fx-diff .add').count() > 0, card.slice(0, 300));
  ok('assistant: simulator is labelled, not presented as FAB 500X output', /simulator/i.test(await p.locator('.fx-asst').innerText()));
  await p.screenshot({ path: path.join(S, 'fx-01-desktop.png') });
  await p.locator('.fx-prop .btn.primary').first().click(); await p.waitForTimeout(900);
  ok('approve applies the change (file appears in explorer)', (await p.locator('.fx-tree').innerText()).includes('NOTES.md'));
  // source control
  await p.locator('.fx-sidetabs button[aria-label="Source control"]').click(); await p.waitForTimeout(600);
  ok('Source control lists changes', /NOTES\.md/.test(await p.locator('.fx-side').innerText()));
  await p.locator('.fx-side input').fill('first checkpoint'); await p.locator('.fx-side .btn.primary').click(); await p.waitForTimeout(700);
  ok('checkpoint clears the change list', /No changes/.test(await p.locator('.fx-side').innerText()));
  // project search
  await p.locator('.fx-sidetabs button[aria-label="Search"]').click(); await p.locator('.fx-side input[type=search]').fill('welcome'); await p.keyboard.press('Enter'); await p.waitForTimeout(600);
  ok('project search finds matches', /src\/app\.js/.test(await p.locator('.fx-results').innerText()));
  ok('desktop: no horizontal page overflow', await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  await p.screenshot({ path: path.join(S, 'fx-02-desktop-search.png') });
  ok('no unexpected console errors', errs.length === 0, errs.join(' | '));

  // Mobile
  const m = await b.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, storageState: await ctx.storageState() });
  const mp = await m.newPage(); await mp.goto(p.url(), { waitUntil: 'load' }); await mp.waitForTimeout(900);
  ok('mobile: IDE fits the screen', await mp.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  ok('mobile: section tabs (Files / Editor / FAB 500X / Panel)', await mp.locator('.fx-mnav button').count() === 4 && await mp.locator('.fx-mnav').isVisible());
  await mp.locator('.fx-mnav button', { hasText: 'Files' }).tap(); await mp.waitForTimeout(300);
  ok('mobile: Files shows the explorer', await mp.locator('.fx-side').isVisible() && !(await mp.locator('.fx-asst').isVisible()));
  await mp.screenshot({ path: path.join(S, 'fx-03-mobile-files.png') });
  await mp.locator('.fx-row.file', { hasText: 'app.js' }).tap(); await mp.waitForTimeout(600);
  ok('mobile: opening a file switches to the editor', await mp.locator('.fx-center').isVisible() && (await mp.locator('.fx-ta').inputValue()).includes('welcome'));
  await mp.screenshot({ path: path.join(S, 'fx-04-mobile-editor.png') });
  await mp.locator('.fx-mnav button', { hasText: 'FAB 500X' }).tap(); await mp.waitForTimeout(300);
  ok('mobile: assistant section', await mp.locator('.fx-asst').isVisible());
  await mp.screenshot({ path: path.join(S, 'fx-05-mobile-assistant.png') });
  await m.close(); await ctx.close();
} catch (e) { ok('run completed', false, e.stack); }
await b.close(); close();
const fails = results.filter((r) => !r[1]);
console.log(`\n${results.length - fails.length}/${results.length} passed${fails.length ? ' — FAILED: ' + fails.map((f) => f[0]).join('; ') : ''}\nscreenshots: ${S}`);
process.exit(fails.length ? 1 : 0);
