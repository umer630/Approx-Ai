// Approx AI Admin panel (separate from the client app). It holds NO credentials and makes NO authorization decisions:
// the server checks the admin session on every /api/admin request. Hiding a button here is cosmetic only.
import { h, icon, toast, confirmDialog, promptDialog } from '/js/ui.js';

const root = document.getElementById('admin');
let csrf = '';
let me = null;

// ---------------- API ----------------
class AdminError extends Error { constructor(status, body) { super(body?.error?.message || `Request failed (${status})`); this.status = status; this.code = body?.error?.code; } }
async function api(path, { method = 'GET', body } = {}) {
  const headers = {};
  if (method !== 'GET') headers['X-Admin-CSRF'] = csrf;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let res;
  try { res = await fetch(path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined, credentials: 'same-origin', signal: AbortSignal.timeout(30_000) }); }
  catch { throw new AdminError(0, { error: { message: 'Cannot reach the server. Check your connection.' } }); }
  const data = (res.headers.get('content-type') || '').includes('json') ? await res.json() : null;
  if (res.status === 401 && path !== '/api/admin/auth/login') { me = null; csrf = ''; navigate('/admin/login', { replace: true, expired: true }); throw new AdminError(401, data); }
  if (!res.ok) throw new AdminError(res.status, data);
  return data;
}

// ---------------- formatting ----------------
const num = (n) => (n ?? 0).toLocaleString();
const when = (t) => (t ? new Date(t).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '—');
const day = (t) => (t ? new Date(t).toLocaleDateString(undefined, { dateStyle: 'medium' }) : '—');
const pill = (v, cls = v) => h('span', { class: `pill ${cls}` }, v);
const bytes = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : n < 1073741824 ? `${(n / 1048576).toFixed(1)} MB` : `${(n / 1073741824).toFixed(2)} GB`);
let regionNames; try { regionNames = new Intl.DisplayNames(undefined, { type: 'region' }); } catch { regionNames = null; }
const countryName = (c) => (!c || c === 'Unknown' ? 'Unknown' : `${regionNames?.of(c) || c} (${c})`);
const EVENT_LABELS = {
  'auth.signup': 'Registered', 'auth.email_verified': 'Verified email', 'auth.login': 'Logged in', 'auth.logout': 'Logged out',
  'model.request': 'Model request', 'auth.password_reset': 'Password reset', 'auth.password_reset_requested': 'Password reset requested',
  'admin.client_approved': 'Approved', 'admin.client_suspended': 'Suspended', 'admin.client_rejected': 'Rejected', 'admin.client_disabled': 'Disabled',
  'admin.client_pending': 'Set to pending', 'admin.login': 'Admin signed in', 'admin.logout': 'Admin signed out', 'admin.login_failed': 'Failed admin sign-in',
  'admin.model_enabled': 'Model enabled', 'admin.model_restricted': 'Model restricted', 'admin.model_default': 'Model access reset',
  'admin.quota_changed': 'Quota changed', 'admin.client_updated': 'Client updated', 'admin.setting_changed': 'Setting changed',
};
const label = (e) => EVENT_LABELS[e] || e.replace(/[._]/g, ' ');

// ---------------- router (path based: /admin, /admin/clients/:id, …) ----------------
const ROUTES = [
  [/^\/admin\/login\/?$/, () => loginPage()],
  [/^\/admin\/?$/, () => page('Dashboard', dashboard)],
  [/^\/admin\/clients\/?$/, () => page('Clients', clientsPage)],
  [/^\/admin\/clients\/([\w-]+)\/?$/, (m) => page('Client', (el) => clientPage(el, m[1]), '/admin/clients')],
  [/^\/admin\/usage\/?$/, () => page('Usage', usagePage)],
  [/^\/admin\/models\/?$/, () => page('Models', modelsPage)],
  [/^\/admin\/activity\/?$/, () => page('Activity', activityPage)],
  [/^\/admin\/audit\/?$/, () => page('Audit log', auditPage)],
];
const NAV = [['/admin', 'Dashboard', 'gauge'], ['/admin/clients', 'Clients', 'user'], ['/admin/usage', 'Usage', 'data'], ['/admin/models', 'Models', 'layers'],
  ['/admin/activity', 'Activity', 'history'], ['/admin/audit', 'Audit log', 'shield']];
let flash = null;

function navigate(path, { replace = false, expired = false } = {}) {
  if (expired) flash = 'Your admin session ended. Please sign in again.';
  if (replace) history.replaceState(null, '', path); else history.pushState(null, '', path);
  render();
}
window.addEventListener('popstate', render);
document.addEventListener('click', (e) => {
  const a = e.target.closest('a[data-nav]');
  if (!a || e.metaKey || e.ctrlKey || e.shiftKey) return;
  e.preventDefault(); navigate(a.getAttribute('href'));
});

async function render() {
  const path = location.pathname;
  if (!path.startsWith('/admin/login') && !me) {
    try { const r = await api('/api/admin/auth/me'); me = r.admin; csrf = r.csrf_token; } catch { return; }
  }
  if (path.startsWith('/admin/login') && me) return navigate('/admin', { replace: true });
  for (const [re, fn] of ROUTES) { const m = re.exec(path); if (m) return fn(m); }
  navigate('/admin', { replace: true });
}

// ---------------- sign-in ----------------
function loginPage() {
  document.title = 'Administrator Sign In · Approx AI Admin';
  const email = h('input', { class: 'input', type: 'email', id: 'admin-email', name: 'email', autocomplete: 'username', required: true, maxlength: 254 });
  const password = h('input', { class: 'input', type: 'password', id: 'admin-password', name: 'password', autocomplete: 'current-password', required: true, maxlength: 256 });
  const msg = h('div', { role: 'alert', 'aria-live': 'polite' }, flash ? h('div', { class: 'alert warn small' }, flash) : null);
  flash = null;
  const submit = h('button', { class: 'btn primary', type: 'submit' }, 'Sign in');
  const form = h('form', { novalidate: true, onsubmit: async (e) => {
    e.preventDefault();
    if (submit.disabled) return;
    if (!email.value.trim() || !password.value) { msg.replaceChildren(h('div', { class: 'alert error small' }, 'Enter your admin email and password.')); return; }
    submit.disabled = true; submit.textContent = 'Signing in…';
    try {
      const r = await api('/api/admin/auth/login', { method: 'POST', body: { email: email.value.trim(), password: password.value } });
      password.value = '';
      me = r.admin; csrf = r.csrf_token;
      navigate('/admin', { replace: true });
    } catch (err) {
      password.value = '';
      const text = err.status === 429 ? 'Too many attempts. Please wait a few minutes and try again.'
        : err.code === 'admin_not_configured' ? 'Administrator sign-in is not configured on this server.'
        : err.status === 0 || err.status >= 500 ? err.message : 'Invalid administrator credentials';
      msg.replaceChildren(h('div', { class: 'alert error small' }, text));
      submit.disabled = false; submit.textContent = 'Sign in';
    }
  } },
  h('div', { class: 'brand' }, h('img', { src: '/assets/logo-mark-192.png', alt: '' }), h('div', { class: 'sub' }, 'Approx AI Admin'), h('h1', {}, 'Administrator Sign In')),
  h('label', { for: 'admin-email' }, 'Admin email'), email,
  h('label', { for: 'admin-password' }, 'Admin password'), password,
  msg, submit,
  h('p', { class: 'note' }, 'Restricted area. Sign-ins are logged.'));
  root.replaceChildren(h('div', { class: 'adm-login' }, form));
  email.focus();
}

// ---------------- shell ----------------
function page(title, build, activeOverride) {
  document.title = `${title} · Approx AI Admin`;
  const active = activeOverride || location.pathname.replace(/\/$/, '') || '/admin';
  const shell = h('div', { class: 'adm-shell' });
  const closeNav = () => shell.classList.remove('nav-open');
  const side = h('aside', { class: 'adm-side' },
    h('div', { class: 'brand' }, h('img', { src: '/assets/logo-mark-192.png', alt: '' }), h('div', {}, 'Approx AI', h('small', {}, 'Admin'))),
    h('nav', { class: 'adm-nav', 'aria-label': 'Admin' }, NAV.map(([href, text, ic]) => h('a', { href, 'data-nav': '', class: active === href ? 'active' : '', onclick: closeNav }, icon(ic), text))),
    h('div', { class: 'me' }, h('div', {}, me.email), h('div', {}, me.role),
      h('button', { class: 'btn', onclick: logout }, icon('logout'), 'Sign out')));
  const main = h('main', { class: 'adm-main' }, h('div', { class: 'skeleton' }));
  shell.append(side, h('div', { class: 'adm-scrim', onclick: closeNav }),
    h('div', { class: 'adm-body' }, h('header', { class: 'adm-top' }, h('button', { class: 'icon-btn', 'aria-label': 'Menu', onclick: () => shell.classList.add('nav-open') }, icon('menu')), h('b', {}, title)), main));
  root.replaceChildren(shell);
  Promise.resolve(build(main)).catch((e) => { if (e.status !== 401) main.replaceChildren(h('div', { class: 'alert error' }, e.message)); });
}
async function logout() {
  try { await api('/api/admin/auth/logout', { method: 'POST', body: {} }); } catch { /* the session is gone either way */ }
  me = null; csrf = '';
  navigate('/admin/login', { replace: true });
}
const head = (title, ...extra) => h('div', { class: 'adm-head' }, h('h1', {}, title), ...extra);
const stat = (k, v, accent) => h('div', { class: `adm-stat${accent ? ' accent' : ''}` }, h('div', { class: 'k' }, k), h('div', { class: 'v' }, num(v)));
const card = (title, ...kids) => h('section', { class: 'adm-card' }, h('h2', {}, ...[].concat(title)), ...kids);
const empty = (t) => h('div', { class: 'empty' }, t);

// ---------------- charts (inline SVG, real data only) ----------------
const SVG = 'http://www.w3.org/2000/svg';
const s = (tag, attrs = {}, ...kids) => { const el = document.createElementNS(SVG, tag); for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v); el.append(...kids); return el; };
function barChart(rows, keys) {
  const W = 600; const H = 170; const pad = { l: 30, r: 6, t: 8, b: 20 };
  const max = Math.max(1, ...rows.flatMap((r) => keys.map((k) => r[k])));
  const bw = (W - pad.l - pad.r) / rows.length;
  const svg = s('svg', { class: 'chart', viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none', role: 'img', 'aria-label': `Daily ${keys.join(' and ')}, last ${rows.length} days` });
  for (const f of [0, 0.5, 1]) {
    const y = pad.t + (H - pad.t - pad.b) * (1 - f);
    svg.append(s('line', { class: 'grid', x1: pad.l, x2: W - pad.r, y1: y, y2: y }), s('text', { class: 'axis', x: 2, y: y + 3 }, String(Math.round(max * f))));
  }
  rows.forEach((r, i) => {
    keys.forEach((k, j) => {
      const hgt = ((H - pad.t - pad.b) * r[k]) / max;
      const w = (bw - 2) / keys.length;
      svg.append(s('rect', { class: j ? 'bar2' : 'bar', x: pad.l + i * bw + 1 + j * w, y: H - pad.b - hgt, width: Math.max(1, w - 1), height: hgt, rx: 1.5 }, s('title', {}, `${r.date}: ${r[k]} ${k}`)));
    });
    if ((rows.length - 1 - i) % 7 === 0) svg.append(s('text', { class: 'axis', x: pad.l + i * bw, y: H - 5 }, r.date.slice(5)));
  });
  return svg;
}
function hbars(items, { labelOf, valueOf, extra }) {
  if (!items.length) return empty('No data yet.');
  const max = Math.max(1, ...items.map(valueOf));
  return h('div', {}, items.map((x) => h('div', { class: 'hbar' }, h('span', {}, labelOf(x)),
    h('div', { class: 'track' }, (() => { const f = h('div', { class: 'fill' }); f.style.width = `${(100 * valueOf(x)) / max}%`; return f; })()), h('span', { class: 'n' }, extra ? extra(x) : num(valueOf(x))))));
}

// ---------------- dashboard ----------------
async function dashboard(main) {
  const o = await api('/api/admin/overview');
  const c = o.clients;
  main.replaceChildren(
    head('Dashboard', h('span', { class: 'hint' }, `Live data · ${when(Date.now())}`)),
    h('div', { class: 'adm-grid' }, stat('Total clients', c.total, true), stat('Active (30 days)', c.active_30d), stat('New (7 days)', c.new_7d), stat('Online now', c.online_now),
      stat('Verified', c.verified), stat('Unverified', c.unverified), stat('Pending approval', c.pending), stat('Suspended', c.suspended)),
    h('div', { class: 'adm-grid' }, stat('Requests total', o.requests.total, true), stat('Requests today', o.requests.today), stat('Requests this month', o.requests.month),
      h('div', { class: 'adm-stat' }, h('div', { class: 'k' }, 'Storage'), h('div', { class: 'v' }, bytes(o.storage.bytes)), h('div', { class: 'k' }, `${num(o.storage.files)} file${o.storage.files === 1 ? '' : 's'}`))),
    card(['Last 30 days'], barChart(o.daily, ['requests', 'signups']), h('div', { class: 'legend' }, h('span', {}, h('i', { class: 'sw1' }), 'Model requests'), h('span', {}, h('i', { class: 'sw2' }), 'Sign-ups'))),
    h('div', { class: 'adm-cols adm-section' },
      card(['Model usage', h('span', { class: 'muted' }, 'this month')], hbars(o.model_usage_month, { labelOf: (x) => x.model_id, valueOf: (x) => x.requests })),
      card(['Users by country', h('span', { class: 'muted' }, 'from sign-in edge data')], hbars(o.countries, { labelOf: (x) => countryName(x.country), valueOf: (x) => x.users, extra: (x) => `${num(x.users)} · ${x.percent}%` }))),
    h('p', { class: 'hint small muted' }, `Active = ${o.definitions.active_30d}. Online = ${o.definitions.online_now}. Country comes from the hosting edge at sign-in; "Unknown" when it was not available.`),
    me.role === 'superadmin' ? await approvalSetting() : null);
}
async function approvalSetting() {
  const r = await api('/api/admin/platform-settings');
  const box = h('input', { type: 'checkbox', checked: r.require_approval, onchange: async (e) => {
    try { const x = await api('/api/admin/platform-settings', { method: 'PUT', body: { require_approval: e.target.checked } }); toast(x.require_approval ? 'New sign-ups now need approval' : 'New sign-ups are approved automatically'); }
    catch (err) { e.target.checked = !e.target.checked; toast(err.message); }
  } });
  return card(['Platform'], h('label', { class: 'check-row' }, box, h('span', {}, 'Require admin approval for new sign-ups')));
}

// ---------------- clients ----------------
const STATUSES = ['pending', 'approved', 'suspended', 'rejected', 'disabled'];
async function clientsPage(main) {
  const sp = new URLSearchParams(location.search);
  const q = h('input', { class: 'input search', type: 'search', placeholder: 'Search name, email or ID', value: sp.get('q') || '', 'aria-label': 'Search clients' });
  const sel = (name, labelText, opts) => h('select', { class: 'input', 'aria-label': labelText, 'data-k': name }, h('option', { value: '' }, labelText), opts.map(([v, t]) => h('option', { value: v, selected: sp.get(name) === v }, t)));
  const models = (await api('/api/admin/models-overview')).models;
  const fStatus = sel('status', 'All statuses', STATUSES.map((x) => [x, x[0].toUpperCase() + x.slice(1)]));
  const fVer = sel('verified', 'Verified: any', [['yes', 'Verified'], ['no', 'Unverified']]);
  const fPlan = sel('plan', 'All plans', [['free', 'Free'], ['pro', 'Pro'], ['enterprise', 'Enterprise']]);
  const fModel = sel('model', 'Model access: any', models.map((m) => [m.id, `Enabled: ${m.name}`]));
  const fCountry = h('select', { class: 'input', 'aria-label': 'Country', 'data-k': 'country' }, h('option', { value: '' }, 'All countries'));
  const fSort = sel('sort', 'Sort: newest', [['oldest', 'Oldest'], ['last_login', 'Last login'], ['usage', 'Highest usage']]);
  const table = h('div', {}, h('div', { class: 'skeleton' }));
  let offset = 0;
  const load = async () => {
    const p = new URLSearchParams();
    if (q.value.trim()) p.set('q', q.value.trim());
    for (const el of [fStatus, fVer, fPlan, fModel, fCountry, fSort]) if (el.value) p.set(el.dataset.k, el.value);
    history.replaceState(null, '', `/admin/clients${p.toString() ? '?' + p : ''}`);
    p.set('offset', offset); p.set('limit', 25);
    const r = await api(`/api/admin/clients?${p}`);
    if (fCountry.options.length === 1) for (const c of r.countries) fCountry.append(h('option', { value: c.country, selected: sp.get('country') === c.country }, `${countryName(c.country)} · ${c.users}`));
    table.replaceChildren(r.clients.length ? h('div', { class: 'adm-table-wrap' }, h('table', { class: 'adm-table' },
      h('thead', {}, h('tr', {}, ['Client', 'ID', 'Status', 'Approval', 'Verified', 'Registered', 'Last login', 'Country', 'Requests', 'Plan'].map((x) => h('th', {}, x)))),
      h('tbody', {}, r.clients.map((c) => h('tr', { tabindex: 0, onclick: () => navigate(`/admin/clients/${c.id}`), onkeydown: (e) => { if (e.key === 'Enter') navigate(`/admin/clients/${c.id}`); } },
        h('td', { class: 'who', 'data-label': 'Client' }, h('b', {}, c.name || '—'), h('span', {}, c.email)),
        h('td', { class: 'id', 'data-label': 'ID' }, c.id),
        h('td', { 'data-label': 'Account' }, pill(c.account_status, c.account_status === 'active' ? 'approved' : 'disabled')),
        h('td', { 'data-label': 'Approval' }, pill(c.approval_status)),
        h('td', { 'data-label': 'Verified' }, pill(c.email_verified ? 'yes' : 'no')),
        h('td', { 'data-label': 'Registered' }, day(c.created_at)),
        h('td', { 'data-label': 'Last login' }, when(c.last_login_at)),
        h('td', { 'data-label': 'Country' }, countryName(c.country)),
        h('td', { 'data-label': 'Requests' }, num(c.requests)),
        h('td', { 'data-label': 'Plan' }, c.plan)))))) : empty('No clients match these filters.'),
    h('div', { class: 'pager' }, h('span', {}, `${num(r.total)} client${r.total === 1 ? '' : 's'}${r.total ? ` · showing ${offset + 1}–${offset + r.clients.length}` : ''}`),
      h('div', { class: 'actions' }, h('button', { class: 'btn', disabled: offset === 0, onclick: () => { offset = Math.max(0, offset - 25); load(); } }, 'Previous'),
        h('button', { class: 'btn', disabled: !r.has_more, onclick: () => { offset += 25; load(); } }, 'Next'))));
  };
  let t;
  q.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => { offset = 0; load(); }, 250); });
  for (const el of [fStatus, fVer, fPlan, fModel, fCountry, fSort]) el.addEventListener('change', () => { offset = 0; load(); });
  main.replaceChildren(head('Clients'), h('div', { class: 'adm-filters' }, q, fStatus, fVer, fPlan, fModel, fCountry, fSort), table);
  await load();
}

const ACTIONS = {
  pending: [['approved', 'Approve', 'primary'], ['rejected', 'Reject', 'danger']],
  approved: [['suspended', 'Suspend', 'danger'], ['disabled', 'Disable', 'danger']],
  suspended: [['approved', 'Reactivate', 'primary'], ['disabled', 'Disable', 'danger']],
  rejected: [['approved', 'Approve', 'primary'], ['pending', 'Back to pending', '']],
  disabled: [['approved', 'Restore', 'primary']],
};
async function clientPage(main, id) {
  const d = await api(`/api/admin/clients/${encodeURIComponent(id)}`);
  const c = d.client; const u = d.usage; const q = u.quota;
  const reload = () => clientPage(main, id);
  const setStatus = async (st, text, danger) => {
    const blocking = ['suspended', 'rejected', 'disabled'].includes(st);
    let reason = null;
    if (blocking) { reason = await promptDialog(`${text} ${c.email}?`, 'Reason (required · recorded in the audit log)', ''); if (reason === null) return; }
    else if (!(await confirmDialog(`${text} ${c.email}?`, 'This takes effect immediately.', text, danger))) return;
    try { await api(`/api/admin/clients/${c.id}/status`, { method: 'POST', body: { status: st, reason: reason || undefined } }); toast(`${text}: done`); reload(); } catch (e) { toast(e.message); }
  };
  const isAdminTarget = c.role !== 'user';
  const canAct = c.id !== me.id && (!isAdminTarget || me.role === 'superadmin');
  const plan = h('select', { class: 'input auto', 'aria-label': 'Plan', disabled: !canAct, onchange: async (e) => {
    try { await api(`/api/admin/clients/${c.id}`, { method: 'PATCH', body: { plan: e.target.value } }); toast('Plan updated'); reload(); } catch (err) { toast(err.message); reload(); }
  } }, ['free', 'pro', 'enterprise'].map((p) => h('option', { value: p, selected: c.plan === p }, p)));
  const modelRows = d.access.models.map((m) => h('div', { class: 'model-row' },
    h('div', { class: 'grow' }, h('b', {}, m.name), h('div', { class: 'small muted' }, `${m.id} · tier ${m.tier}`)),
    pill(m.available ? 'enabled' : 'restricted'),
    h('select', { class: 'input', 'aria-label': `Access to ${m.name}`, disabled: !canAct, onchange: async (e) => {
      try { const r = await api(`/api/admin/clients/${c.id}/models/${m.id}`, { method: 'PUT', body: { access: e.target.value } }); toast(`${m.name}: ${r.access} (${r.available ? 'available' : 'not available'})`); reload(); }
      catch (err) { toast(err.message); reload(); }
    } }, [['default', 'Plan default'], ['enabled', 'Enabled'], ['restricted', 'Restricted']].map(([v, t]) => h('option', { value: v, selected: m.override === v }, t)))));
  const lim = d.limits || {};
  const field = (name, text, value, ph) => { const i = h('input', { class: 'input', type: 'number', min: 0, step: 1, name, value: value ?? '', placeholder: ph, disabled: !canAct }); return [i, h('label', {}, text, i)]; };
  const [win, fWin] = field('window_limit', `Requests per ${d.defaults.window_minutes} min`, lim.window_limit, `default ${d.defaults.window_limit}`);
  const [cyc, fCyc] = field('cycle_limit', `Requests per ${d.defaults.cycle_days} days`, lim.cycle_limit, d.defaults.cycle_limit ? `default ${d.defaults.cycle_limit}` : 'default: unlimited');
  const perModel = d.access.models.map((m) => field(`m_${m.id}`, `${m.name} per ${d.defaults.cycle_days} days`, lim.model_limits?.[m.id], 'no model limit'));
  const saveLimits = h('button', { class: 'btn primary', disabled: !canAct, onclick: async () => {
    const model_limits = {}; d.access.models.forEach((m, i) => { if (perModel[i][0].value !== '') model_limits[m.id] = perModel[i][0].value; });
    try { await api(`/api/admin/clients/${c.id}/limits`, { method: 'PUT', body: { window_limit: win.value, cycle_limit: cyc.value, model_limits } }); toast('Quota saved'); reload(); } catch (e) { toast(e.message); }
  } }, 'Save limits');
  const tokens = (u.tokens.tokens_in || 0) + (u.tokens.tokens_out || 0);
  main.replaceChildren(
    h('p', {}, h('a', { href: '/admin/clients', 'data-nav': '' }, '← All clients')),
    head(c.name || c.email, pill(c.approval_status)),
    !canAct ? h('div', { class: 'alert warn small adm-section' }, c.id === me.id ? 'This is your own account; it cannot be changed here.' : 'Only a superadmin can change another administrator.') : null,
    h('div', { class: 'adm-cols adm-section' },
      card(['Account'], h('dl', { class: 'kv' },
        h('dt', {}, 'ID'), h('dd', { class: 'id' }, c.id), h('dt', {}, 'Name'), h('dd', {}, c.name || '—'), h('dt', {}, 'Email'), h('dd', {}, c.email),
        h('dt', {}, 'Role'), h('dd', {}, c.role), h('dt', {}, 'Verification'), h('dd', {}, pill(c.email_verified ? 'yes' : 'no'), ' ', c.email_verified ? 'verified' : 'not verified'),
        h('dt', {}, 'Account status'), h('dd', {}, c.account_status), h('dt', {}, 'Approval'), h('dd', {}, c.approval_status, c.approval_reason ? ` — ${c.approval_reason}` : ''),
        h('dt', {}, 'Registered'), h('dd', {}, when(c.created_at)), h('dt', {}, 'Last login'), h('dd', {}, when(c.last_login_at)),
        h('dt', {}, 'Last activity'), h('dd', {}, when(c.last_activity_at)), h('dt', {}, 'Active sessions'), h('dd', {}, num(c.active_sessions)),
        h('dt', {}, 'Country'), h('dd', {}, countryName(c.country)), h('dt', {}, 'Plan'), h('dd', {}, plan))),
      card(['Actions'], h('div', { class: 'actions' }, canAct ? (ACTIONS[c.approval_status] || []).map(([st, text, cls]) => h('button', { class: `btn ${cls}`, onclick: () => setStatus(st, text, cls === 'danger') }, text)) : h('span', { class: 'muted small' }, 'No actions available.')),
        h('p', { class: 'small muted' }, 'Status changes are enforced by the server on the client’s next request. Suspending, rejecting or disabling also signs the client out everywhere.'))),
    h('div', { class: 'adm-cols adm-section' },
      card(['Usage'], h('div', { class: 'adm-grid' }, stat('Requests total', u.requests.total, true), stat('Today', u.requests.today), stat('This month', u.requests.month), stat('Tokens', tokens)),
        h('dl', { class: 'kv' }, h('dt', {}, `Window (${q.window.minutes} min)`), h('dd', {}, `${num(q.window.used)} / ${num(q.window.limit)} · ${num(q.window.remaining)} remaining`),
          h('dt', {}, `Cycle (${q.cycle.days} days)`), h('dd', {}, q.cycle.limit ? `${num(q.cycle.used)} / ${num(q.cycle.limit)} · ${num(Math.max(0, q.cycle.limit - q.cycle.used))} remaining` : `${num(q.cycle.used)} used · no cycle limit`),
          h('dt', {}, 'Custom limits'), h('dd', {}, q.custom_limits ? 'yes' : 'no (platform defaults)')),
        h('h2', { class: 'sub-h' }, 'By model'), hbars(u.by_model, { labelOf: (x) => x.model_id, valueOf: (x) => x.requests })),
      card(['Access'], h('dl', { class: 'kv' }, h('dt', {}, 'API access'), h('dd', {}, `${d.access.api_access} (${num(d.access.api_keys_active)} active keys)`),
        h('dt', {}, 'Tool permissions'), h('dd', {}, d.access.permissions_mode)), h('h2', { class: 'sub-h' }, 'Model permissions'), ...modelRows)),
    card(['Quota limits', h('span', { class: 'muted' }, 'empty = platform default')], h('div', { class: 'limits' }, fWin, fCyc, ...perModel.map((x) => x[1])), h('div', { class: 'actions spaced' }, saveLimits)),
    card(['Recent activity'], d.activity.length ? h('ul', { class: 'feed' }, d.activity.map((a) => h('li', {}, h('time', {}, when(a.created_at)), h('div', {}, h('span', { class: 'ev' }, label(a.action)), a.by_admin ? h('span', { class: 'meta' }, ' · by an administrator') : null)))) : empty('No activity recorded.')));
}

// ---------------- usage ----------------
async function usagePage(main) {
  const u = await api('/api/admin/usage');
  main.replaceChildren(head('Usage', h('span', { class: 'hint' }, 'This month')),
    h('div', { class: 'adm-grid' }, stat('Input tokens', u.tokens_month.tokens_in, true), stat('Output tokens', u.tokens_month.tokens_out), stat('Clients with custom limits', u.custom_limits)),
    h('div', { class: 'adm-cols adm-section' },
      card(['Requests by model'], hbars(u.by_model_month, { labelOf: (x) => x.model_id, valueOf: (x) => x.requests, extra: (x) => `${num(x.requests)} · ${num(x.clients)} clients` })),
      card(['Requests by mode'], hbars(u.by_mode_month, { labelOf: (x) => x.mode, valueOf: (x) => x.requests }))),
    card(['Top clients'], u.top_clients_month.length ? h('ul', { class: 'feed' }, u.top_clients_month.map((x) => h('li', {}, h('span', {}, `${num(x.requests)} requests`), h('a', { href: `/admin/clients/${x.user_id}`, 'data-nav': '' }, x.email)))) : empty('No requests this month.')),
    card(['Platform defaults'], h('dl', { class: 'kv' }, h('dt', {}, 'Window'), h('dd', {}, `${num(u.defaults.window_limit)} requests / ${u.defaults.window_minutes} min`),
      h('dt', {}, 'Cycle'), h('dd', {}, u.defaults.cycle_limit ? `${num(u.defaults.cycle_limit)} / ${u.defaults.cycle_days} days` : `no limit (${u.defaults.cycle_days}-day cycle)`))));
}

// ---------------- models (access overview + lifecycle / registry / compute) ----------------
async function modelsPage(main) {
  const o = await api('/api/admin/models-overview');
  const isSuper = me.role === 'superadmin';
  const lifeBox = h('div', {}, h('div', { class: 'skeleton' }));
  const healthBox = h('div', {});
  const statusCls = (st) => (st === 'online' ? 'approved' : st === 'failed' ? 'restricted' : st === 'offline' ? 'disabled' : 'pending');
  const rows = o.models.map((m) => h('tr', { class: 'static' },
    h('td', { class: 'who', 'data-label': 'Model' }, h('b', {}, m.name), h('span', {}, `${m.id} · ${m.role || ''}`)),
    h('td', { 'data-label': 'Status' }, pill(m.status, statusCls(m.status)), m.simulator ? h('div', { class: 'small muted' }, 'simulator') : null),
    h('td', { 'data-label': 'Version' }, m.version ? `v${m.version}` : '—'),
    h('td', { 'data-label': 'Access' }, m.access || m.tier, m.private ? h('div', { class: 'small muted' }, 'private · admin-granted') : null),
    h('td', { 'data-label': 'Available' }, isSuper ? h('input', { type: 'checkbox', checked: m.available, 'aria-label': `${m.name} available`, onchange: async (e) => {
      try { await api(`/api/admin/models/${m.id}/availability`, { method: 'PUT', body: { available: e.target.checked } }); toast(`${m.name} ${e.target.checked ? 'enabled' : 'disabled'}`); }
      catch (err) { e.target.checked = !e.target.checked; toast(err.message); }
    } }) : (m.available ? 'yes' : 'no')),
    h('td', { 'data-label': 'Requests (month)' }, num(m.requests_month)),
    h('td', { 'data-label': 'Failed (24h / month)' }, `${num(m.failed_24h)} / ${num(m.failed_month)}`),
    h('td', { 'data-label': 'Health' }, h('button', { class: 'btn', onclick: async () => {
      healthBox.replaceChildren(h('div', { class: 'skeleton' }));
      try {
        const hh = await api(`/api/admin/models/${m.id}/health`);
        const f = await api(`/api/admin/models/${m.id}/failures`);
        healthBox.replaceChildren(card([`${m.name} health`], h('dl', { class: 'kv' },
          h('dt', {}, 'Status'), h('dd', {}, pill(hh.status, statusCls(hh.status)), ' ', hh.reason || ''),
          h('dt', {}, 'Inference server'), h('dd', {}, hh.upstream.configured === false ? 'not configured' : `${hh.upstream.reachable ? 'reachable' : 'unreachable'}${hh.upstream.serving ? ` · serving ${JSON.stringify(hh.upstream.serving)}` : ''}${hh.upstream.error ? ` · ${hh.upstream.error}` : ''}`),
          h('dt', {}, 'Lifecycle'), h('dd', {}, hh.lifecycle ? `${hh.lifecycle.state}${hh.lifecycle.version ? ' v' + hh.lifecycle.version : ''}` : '—'),
          h('dt', {}, 'Smoke test'), h('dd', {}, hh.smoke_test)),
        h('h2', { class: 'sub-h' }, 'Recent failed requests'),
        f.failures.length ? h('ul', { class: 'feed' }, f.failures.slice(0, 20).map((x) => h('li', {}, h('time', {}, when(x.created_at)), h('div', {}, h('span', { class: 'ev' }, x.code), ` · ${x.email || 'unknown'} · ${x.source || ''}`)))) : empty('No failed requests.')));
      } catch (e) { healthBox.replaceChildren(h('div', { class: 'alert error small' }, e.message)); }
    } }, 'Check'))));
  const grants = await api('/api/admin/models/fab-500x/grants').catch(() => ({ grants: [] }));
  main.replaceChildren(head('Models'),
    card(['Models', h('span', { class: 'muted' }, 'status comes from live serving evidence')], h('div', { class: 'adm-table-wrap' }, h('table', { class: 'adm-table' },
      h('thead', {}, h('tr', {}, ['Model', 'Status', 'Version', 'Access', 'Available', 'Requests (month)', 'Failed (24h / month)', 'Health'].map((x) => h('th', {}, x)))), h('tbody', {}, rows))),
      h('p', { class: 'small muted' }, 'Only "online" models can be selected by clients. Disabling a model refuses it for everyone immediately. Per-client access is set on each client’s page.')),
    healthBox,
    card(['FAB 500X private access', h('span', { class: 'muted' }, 'explicit grants only — no role bypass')],
      grants.grants.filter((g) => g.access === 'grant').length ? h('ul', { class: 'feed' }, grants.grants.filter((g) => g.access === 'grant').map((g) => h('li', {}, h('time', {}, when(g.created_at)),
        h('div', {}, h('a', { href: `/admin/clients/${g.user_id}`, 'data-nav': '' }, g.email), h('span', { class: 'meta' }, ` · granted by ${g.granted_by || 'unknown'}${g.reason ? ' · ' + g.reason : ''}`),
          isSuper ? h('div', {}, h('button', { class: 'btn danger', onclick: async () => {
            if (!(await confirmDialog(`Revoke FAB 500X for ${g.email}?`, 'Takes effect on their next request.', 'Revoke', true))) return;
            try { await api(`/api/admin/clients/${g.user_id}/models/fab-500x`, { method: 'PUT', body: { access: 'default' } }); toast('Revoked'); modelsPage(main); } catch (e) { toast(e.message); }
          } }, 'Revoke')) : null)))) : empty('Nobody has FAB 500X access.'),
      h('p', { class: 'small muted' }, 'Grant access from a client’s page → Model permissions → FAB 500X → Enabled (superadmin).')),
    card(['Deployment lifecycle', h('span', { class: 'muted' }, isSuper ? '' : 'read-only (superadmin can deploy)')], lifeBox),
    card(['GPU training'], await computeBox(isSuper)));
  renderLifecycle(lifeBox, isSuper);
}
async function renderLifecycle(box, isSuper) {
  let r;
  try { r = await api('/api/admin/models/lifecycle'); } catch (e) { box.replaceChildren(h('div', { class: 'alert error small' }, e.message)); return; }
  box.replaceChildren(...r.models.map((m) => h('div', { class: 'model-row' },
    h('div', { class: 'grow' }, h('b', {}, m.model_id), h('div', { class: 'small muted' }, [m.label, m.version ? `v${m.version}` : null, m.adapter_sha256 ? `sha256 ${m.adapter_sha256.slice(0, 12)}…` : (m.pinned_sha256 ? `pinned ${m.pinned_sha256.slice(0, 12)}…` : null)].filter(Boolean).join(' · ')),
      m.failed_stage ? h('div', { class: 'small danger-text' }, `Failed at ${m.failed_stage}: ${m.detail}`) : null),
    pill(m.state, m.state === 'ACTIVE' ? 'approved' : m.state === 'FAILED' ? 'restricted' : 'pending'),
    isSuper && ['DEPLOYING', 'ACTIVE'].includes(m.state) ? h('button', { class: 'btn', onclick: async (e) => {
      e.currentTarget.disabled = true;
      try { await api(`/api/admin/models/${m.model_id}/verify-deployment`, { method: 'POST', body: {} }); toast('Deployment verified'); } catch (err) { toast(err.message); }
      renderLifecycle(box, isSuper);
    } }, 'Re-verify') : null)));
}
async function computeBox(isSuper) {
  let r;
  try { r = await api('/api/admin/compute'); } catch (e) { return h('div', { class: 'alert error small' }, e.message); }
  const online = (r.workers || []).filter((w) => w.online);
  return h('div', {}, h('p', { class: 'small muted' }, `${online.length} GPU worker${online.length === 1 ? '' : 's'} online. Training is started from the training pipeline; this view is for monitoring.`),
    (r.jobs || []).length ? h('ul', { class: 'feed' }, r.jobs.slice(0, 10).map((j) => h('li', {}, h('time', {}, when(j.created_at)), h('div', {}, h('span', { class: 'ev' }, j.models.join(', ')), ' ', pill(j.status, j.status === 'succeeded' ? 'approved' : j.status === 'failed' ? 'restricted' : 'pending'),
      h('div', { class: 'meta' }, j.phase || ''),
      isSuper && ['queued', 'running', 'stop_requested'].includes(j.status) ? h('button', { class: 'btn', onclick: async () => { try { await api(`/api/admin/compute/jobs/${j.id}/stop`, { method: 'POST', body: {} }); toast('Stop requested'); } catch (e) { toast(e.message); } } }, 'Stop') : null)))) : empty('No training jobs.'));
}

// ---------------- activity & audit ----------------
async function activityPage(main) {
  const list = h('ul', { class: 'feed' });
  const more = h('button', { class: 'btn' }, 'Load more');
  let before = '';
  const load = async () => {
    const r = await api(`/api/admin/activity?limit=80${before ? `&before=${before}` : ''}`);
    list.append(...r.events.map((e) => h('li', {}, h('time', {}, when(e.at)), h('div', {}, h('span', { class: 'ev' }, label(e.event)),
      e.user ? h('span', {}, ' · ', e.user_id ? h('a', { href: `/admin/clients/${e.user_id}`, 'data-nav': '' }, e.user) : e.user) : null,
      e.detail ? h('div', { class: 'meta' }, e.detail) : null, e.by_admin ? h('div', { class: 'meta' }, 'by an administrator') : null))));
    if (!list.children.length) list.replaceWith(empty('No activity yet.'));
    before = r.next_before || ''; more.hidden = !r.next_before || r.events.length < 80;
  };
  more.onclick = load;
  main.replaceChildren(head('Activity', h('span', { class: 'hint' }, 'Sign-ups, verification, sign-ins, model requests and admin actions')), card(['Live feed'], list, more));
  await load();
}
async function auditPage(main) {
  const list = h('ul', { class: 'feed' });
  const more = h('button', { class: 'btn' }, 'Load more');
  let before = '';
  const load = async () => {
    const r = await api(`/api/admin/audit-log${before ? `?before=${before}` : ''}`);
    list.append(...r.entries.map((e) => h('li', {}, h('time', {}, when(e.at)), h('div', {},
      h('span', { class: 'ev' }, label(e.action)), h('span', { class: 'meta' }, ` · by ${e.admin}`),
      h('div', { class: 'meta' }, [e.target_user ? `client ${e.target_user}` : null, e.target && !String(e.target).startsWith('usr_') ? e.target : null,
        e.detail && Object.keys(e.detail).length ? Object.entries(e.detail).map(([k, v]) => `${k}: ${v}`).join(' · ') : null].filter(Boolean).join(' · '))))));
    if (!list.children.length) list.replaceWith(empty('No admin actions recorded yet.'));
    before = r.next_before || ''; more.hidden = !r.next_before || r.entries.length < 100;
  };
  more.onclick = load;
  main.replaceChildren(head('Audit log', h('span', { class: 'hint' }, 'Append-only. Entries cannot be edited or deleted.')), card(['Administrator actions'], list, more));
  await load();
}

render();
