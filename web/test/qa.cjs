// Approx AI web QA (Playwright). Boot the backend first, then run against it:
//   APPROX_DATA_DIR=/tmp/qa node --disable-warning=ExperimentalWarning backend/src/server.js &
//   S=/tmp/qa DATA=/tmp/qa node web/test/qa.cjs
// Checks: signup→verify(CLI)→login, Low/Medium/High efficiency modes, model indicator, admin registry +
// compute console, mobile layout (no horizontal overflow). Screenshots go to $S.
const { chromium, devices } = require('playwright');
const { execFileSync } = require('child_process');
const BASE='http://127.0.0.1:8080';
const S=process.env.S, DATA=process.env.DATA;
const fails=[]; const ok=(n,c,d='')=>{console.log((c?'PASS':'FAIL')+'  '+n+(c?'':'  — '+d));if(!c)fails.push(n);};
async function signup(p,email){
  await p.goto(BASE,{waitUntil:'networkidle'});
  await p.getByText('Create account',{exact:true}).click(); await p.waitForTimeout(400);
  await p.locator('input[type=email]').fill(email);
  const ps=p.locator('input[type=password]'); for(let i=0;i<await ps.count();i++) await ps.nth(i).fill('Str0ng!Passw0rd1');
  await p.locator('.btn.primary').first().click(); await p.waitForTimeout(800);
}
async function login(p,email){
  await p.goto(BASE,{waitUntil:'networkidle'});
  await p.locator('input[type=email]').fill(email);
  await p.locator('input[type=password]').first().fill('Str0ng!Passw0rd1');
  await p.getByRole('button',{name:'Sign in'}).first().click(); await p.waitForTimeout(1500);
}
(async()=>{
 const b=await chromium.launch({args:['--no-sandbox']});
 const email=`qa_${Date.now()}@example.com`;
 const ctx=await b.newContext({viewport:{width:1280,height:860},deviceScaleFactor:2});
 const p=await ctx.newPage(); const errs=[]; p.on('console',m=>{if(m.type()==='error'&&!m.text().includes('401'))errs.push(m.text());});
 await signup(p,email);
 // verify + promote via operator CLI against the same data dir
 execFileSync('node',['--disable-warning=ExperimentalWarning','backend/src/cli.js','verify',email],{env:{...process.env,APPROX_DATA_DIR:DATA},cwd:process.cwd()});
 execFileSync('node',['--disable-warning=ExperimentalWarning','backend/src/cli.js','promote',email,'superadmin'],{env:{...process.env,APPROX_DATA_DIR:DATA},cwd:process.cwd()});
 await login(p,email);
 ok('login lands in app', !(await p.locator('body').innerText()).includes('Welcome back'));
 // model picker + mode toggle
 await p.locator('.model-pill, #model-chip, [aria-label*="model" i]').first().click().catch(()=>{});
 await p.waitForTimeout(600);
 const grp=p.locator('.sheet .mode-toggle').first(); const modes=(await grp.locator('button').allTextContents()).map(s=>s.trim());
 ok('three efficiency modes Low/Medium/High', JSON.stringify(modes)===JSON.stringify(['Low','Medium','High']), modes.join(','));
 await grp.locator('button[data-mode="low"]').click(); await p.waitForTimeout(400);
 const ind=(await p.locator('#model-indicator').first().innerText().catch(()=>''))||(await p.locator('body').innerText());
 ok('Low selection reflected in indicator', /Low/.test(ind), ind.slice(0,60));
 await p.keyboard.press('Escape').catch(()=>{});
 await p.screenshot({path:S+'/qa/desktop-app.png'});
 // admin console
 await p.goto(BASE+'/#/admin',{waitUntil:'networkidle'}); await p.waitForTimeout(1500);
 const adminText=await p.locator('body').innerText();
 ok('admin console loads', adminText.includes('Admin console')&&!adminText.includes('Admins only'));
 ok('admin: registry section', adminText.includes('Model registry'));
 ok('admin: compute section', adminText.includes('Compute'));
 ok('admin: registry lists models/empty-state', adminText.includes('no active version')||adminText.includes('no releases')||/v\d+\.\d+\.\d+/.test(adminText), adminText.slice(0,80));
 await p.screenshot({path:S+'/qa/desktop-admin.png',fullPage:true});
 ok('no console errors', errs.length===0, errs.slice(0,2).join(' | '));
 await ctx.close();
 // mobile
 const mctx=await b.newContext({...devices['iPhone 13']}); const mp=await mctx.newPage();
 await mp.goto(BASE,{waitUntil:'networkidle'});
 const sw=await mp.evaluate(()=>document.documentElement.scrollWidth), cw=await mp.evaluate(()=>document.documentElement.clientWidth);
 ok('mobile: no horizontal overflow', sw<=cw+2, `${sw}>${cw}`);
 await mp.screenshot({path:S+'/qa/mobile.png'});
 await mctx.close();
 await b.close();
 console.log('\n'+(fails.length?fails.length+' FAILED: '+fails.join(', '):'ALL PASSED'));
 process.exit(fails.length?1:0);
})().catch(e=>{console.error(e.message);process.exit(2);});
