// LIVE end-to-end check — NO MOCKS, NO SIMULATOR. A real Supabase-authenticated user calls the deployed Approx backend,
// which routes to the real inference server of each model and streams a real generation back.
//
//   APPROX_LIVE_BASE=https://approx-ai.vercel.app \
//   APPROX_LIVE_EMAIL=<verified test account> APPROX_LIVE_PASSWORD=<its password> \
//   [APPROX_LIVE_MODELS="nick-4.8 hike-6.5 sona-9.0 fab-100x"] [APPROX_LIVE_GRANTED_FAB500X=1] \
//   node backend/test/live/live-inference.mjs
//
// Credentials come only from the environment (never committed, never printed). A model counts as CONNECTED only if:
// it is "online" in /api/models, the router selected exactly that model, the stream produced non-empty text, the
// response is not the development simulator, and a served version is reported. Anything else is reported as such.
const BASE = (process.env.APPROX_LIVE_BASE || '').replace(/\/$/, '');
const EMAIL = process.env.APPROX_LIVE_EMAIL || '';
const PASSWORD = process.env.APPROX_LIVE_PASSWORD || '';
const WANT = (process.env.APPROX_LIVE_MODELS || 'nick-4.8 hike-6.5 sona-9.0 fab-100x').split(/\s+/).filter(Boolean);
if (!BASE) { console.error('APPROX_LIVE_BASE is required'); process.exit(2); }

const results = [];
const rec = (name, status, detail = '') => { results.push({ name, status, detail }); console.log(`${status.padEnd(8)} ${name}${detail ? ' — ' + detail : ''}`); };
const j = async (r) => { const t = await r.text(); try { return JSON.parse(t); } catch { return t; } };

// 1. unauthenticated access is refused
for (const p of ['/api/models', '/api/v1/models']) rec(`unauthenticated ${p} refused`, (await fetch(BASE + p)).status === 401 ? 'PASS' : 'FAIL');
const health = await j(await fetch(BASE + '/api/health'));
rec('backend health', health?.status === 'ok' ? 'PASS' : 'FAIL', `database=${health?.database} auth=${health?.auth_provider}`);

if (!EMAIL || !PASSWORD) {
  rec('authenticated checks', 'SKIPPED', 'APPROX_LIVE_EMAIL / APPROX_LIVE_PASSWORD not set (a real verified Supabase account is required)');
} else {
  const login = await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: EMAIL, password: PASSWORD, client: 'mobile' }) });
  const lj = await j(login);
  if (login.status !== 200) { rec('real Supabase login', 'FAIL', `HTTP ${login.status} ${lj?.error?.code || ''}`); }
  else {
    rec('real Supabase login → Approx session', 'PASS');
    const auth = { authorization: `Bearer ${lj.token}` };
    const models = (await j(await fetch(BASE + '/api/models', { headers: auth }))).models || [];
    for (const id of WANT) {
      const m = models.find((x) => x.id === id);
      if (!m) { rec(`${id}: listed`, 'FAIL', 'not visible for this account'); continue; }
      if (!m.available) { rec(`${id}: connected`, 'BLOCKED', 'this account has no access (plan/grant)'); continue; }
      if (m.status !== 'online' || m.simulator) { rec(`${id}: connected`, 'OFFLINE', `status=${m.status}${m.simulator ? ' (simulator)' : ''} — ${m.status_reason || ''}`); continue; }
      const chat = await j(await fetch(BASE + '/api/chats', { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ model: id }) }));
      const t0 = Date.now();
      const r = await fetch(`${BASE}/api/chats/${chat.chat.id}/messages`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json', accept: 'text/event-stream' },
        body: JSON.stringify({ content: 'In one sentence: what is 12 × 12? Reply in English.', model: id, mode: 'low' }) });
      const body = await r.text();
      const ev = body.split('\n\n').filter(Boolean).map((b) => ({ e: /event: (.*)/.exec(b)?.[1], d: (() => { try { return JSON.parse(/data: (.*)/.exec(b)?.[1] || 'null'); } catch { return null; } })() }));
      const routeEv = ev.find((x) => x.e === 'route')?.d;
      const text = ev.filter((x) => x.e === 'delta').map((x) => x.d?.text || x.d?.content || '').join('');
      const ok = r.status === 200 && routeEv?.model_id === id && text.trim().length > 0 && !/Development simulator/i.test(text) && (routeEv?.model_version || m.active_version);
      rec(`${id}: authenticated → router → inference server → streamed answer`, ok ? 'PASS' : 'FAIL',
        ok ? `v${routeEv?.model_version || m.active_version} · ${Date.now() - t0} ms · "${text.trim().slice(0, 80)}"` : `HTTP ${r.status} route=${routeEv?.model_id} text=${JSON.stringify(text.slice(0, 120))}`);
    }
    // private model: must be invisible + refused unless this account holds a grant
    const fab = models.find((x) => x.id === 'fab-500x');
    const c = await j(await fetch(BASE + '/api/chats', { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: '{}' }));
    const r5 = await fetch(`${BASE}/api/chats/${c.chat.id}/messages`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ content: 'hi', model: 'fab-500x' }) });
    if (process.env.APPROX_LIVE_GRANTED_FAB500X === '1') rec('fab-500x: granted account can use it', fab && r5.status === 200 ? 'PASS' : 'FAIL', `listed=${!!fab} HTTP ${r5.status}`);
    else rec('fab-500x: invisible and refused without a grant', !fab && r5.status === 400 ? 'PASS' : 'FAIL', `listed=${!!fab} HTTP ${r5.status}`);
    const bad = await fetch(`${BASE}/api/chats/${c.chat.id}/messages`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ content: 'hi', model: 'no-such-model' }) });
    rec('invalid model refused', bad.status === 400 ? 'PASS' : 'FAIL', `HTTP ${bad.status}`);
  }
}
const fails = results.filter((r) => r.status === 'FAIL');
console.log(`\n${results.filter((r) => r.status === 'PASS').length} passed · ${fails.length} failed · ${results.filter((r) => !['PASS', 'FAIL'].includes(r.status)).length} not connected/skipped`);
process.exit(fails.length ? 1 : 0);
