// Full-page sections of the Approx workspace: History, Approx Work, Schedule, Settings (+ every settings page),
// and the Background-tasks / Feedback sheets. Every number and list comes from the backend; nothing is invented.
// Pages render instantly from cache (stale-while-revalidate) and show skeletons only on the first load.
import { api, cached, invalidate } from './api.js';
import { h, icon, toast, sheet, confirmDialog, promptDialog, fmtTime, fmtBytes } from './ui.js';
import { state, go, setMain, newChat, refreshRecent, applyTheme, applyTextSize, openPermissions, signOutLocal } from './app.js';
import { SETTINGS } from './views.js';

const skel = (n = 4) => h('div', { class: 'skeleton-list' }, Array.from({ length: n }, () => h('div', { class: 'skeleton line' })));
const pageHead = (title, sub, back) => h('div', { class: 'page-head' }, back ? h('a', { class: 'icon-btn', href: back, 'aria-label': 'Back' }, icon('back')) : null,
  h('div', { class: 'grow' }, h('h1', {}, title), sub ? h('p', { class: 'muted small' }, sub) : null));
const modelName = (id) => state.models.find((m) => m.id === id)?.name || id;
const errBox = (e) => h('div', { class: 'alert error' }, e.message);

// ================= HISTORY =================
const dayGroup = (ts) => {
  const d = new Date(ts); const t0 = new Date(); t0.setHours(0, 0, 0, 0);
  const diff = Math.floor((t0 - new Date(d.getFullYear(), d.getMonth(), d.getDate())) / 86_400_000);
  return diff <= 0 ? 'Today' : diff === 1 ? 'Yesterday' : diff < 7 ? 'Previous 7 days' : diff < 30 ? 'Previous 30 days' : d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
};
export async function historyPage({ focusSearch = false } = {}) {
  let view = 'active'; let before = null; let loading = false; let more = true; let token = 0; let lastGroup = null;
  const q = h('input', { class: 'input search', type: 'search', placeholder: 'Search sessions', 'aria-label': 'Search conversations' });
  const tabs = h('div', { class: 'tabs', role: 'tablist' });
  const list = h('div', { class: 'list' });
  const sentinel = h('div', { class: 'sentinel' });
  const row = (c) => h('div', { class: 'list-item' },
    h('button', { class: 'grow list-open', onclick: () => { if (view !== 'trash') go(`#/c/${c.id}`); }, 'aria-label': `Open ${c.title}` },
      h('div', { class: 'title' }, c.title, state.chat?.id === c.id ? h('span', { class: 'badge green ml6' }, 'Open') : null), h('div', { class: 'sub' }, `${modelName(c.model_id)} · ${fmtTime(c.updated_at)}`)),
    view === 'trash'
      ? [h('button', { class: 'icon-btn', title: 'Restore', 'aria-label': 'Restore', onclick: async () => { await api(`/api/chats/${c.id}`, { method: 'PATCH', body: { restore: true } }); toast('Restored'); refreshRecent(true); reload(); } }, icon('restore')),
        h('button', { class: 'icon-btn', title: 'Delete forever', 'aria-label': 'Delete forever', onclick: async () => { if (await confirmDialog('Delete forever?', 'This permanently deletes the session.', 'Delete', true)) { await api(`/api/chats/${c.id}?purge=1`, { method: 'DELETE' }); reload(); } } }, icon('trash'))]
      : [h('button', { class: 'icon-btn', title: 'Rename', 'aria-label': 'Rename', onclick: async () => { const t = await promptDialog('Rename session', 'Title', c.title); if (t) { await api(`/api/chats/${c.id}`, { method: 'PATCH', body: { title: t } }); refreshRecent(true); reload(); } } }, icon('edit')),
        h('button', { class: 'icon-btn', title: view === 'archived' ? 'Unarchive' : 'Archive', 'aria-label': view === 'archived' ? 'Unarchive' : 'Archive', onclick: async () => { await api(`/api/chats/${c.id}`, { method: 'PATCH', body: { archived: view !== 'archived' } }); toast(view === 'archived' ? 'Unarchived' : 'Archived'); refreshRecent(true); reload(); } }, icon('archive')),
        h('button', { class: 'icon-btn', title: 'Move to trash', 'aria-label': 'Delete', onclick: async () => { await api(`/api/chats/${c.id}`, { method: 'DELETE' }); if (state.chat?.id === c.id) state.chat = null; toast('Moved to trash'); refreshRecent(true); reload(); } }, icon('trash'))]);
  const loadMore = async () => {
    if (loading || !more) return; loading = true; const my = token;
    if (view === 'tasks') { more = false; loading = false; return renderTasks(list); }
    if (!before) list.replaceChildren(skel());
    try {
      const r = await api(`/api/chats?view=${view}&limit=30&q=${encodeURIComponent(q.value)}${before ? `&before=${before}` : ''}`);
      if (my !== token) return;
      if (!before) list.replaceChildren();
      if (!before && !r.chats.length) list.append(h('p', { class: 'muted empty' }, q.value ? 'No sessions match your search.' : view === 'trash' ? 'Trash is empty.' : view === 'archived' ? 'No archived sessions.' : 'No sessions yet — start one from Chat.'));
      for (const c of r.chats) {
        const g = view === 'trash' ? null : dayGroup(c.updated_at);
        if (g && g !== lastGroup) { list.append(h('div', { class: 'date-group' }, g)); lastGroup = g; }
        list.append(row(c));
      }
      more = r.has_more; before = r.chats.at(-1)?.updated_at || before;
    } catch (e) { list.replaceChildren(errBox(e)); } finally { loading = false; }
  };
  const reload = () => { token++; before = null; more = true; loading = false; lastGroup = null; loadMore(); };
  for (const [k, label] of [['active', 'Recent'], ['tasks', 'Background tasks'], ['archived', 'Archived'], ['trash', 'Trash']]) {
    tabs.append(h('button', { role: 'tab', 'aria-selected': String(k === view), onclick: (e) => { view = k; for (const b of tabs.children) b.setAttribute('aria-selected', String(b === e.currentTarget)); q.classList.toggle('hidden', k === 'tasks'); reload(); } }, label));
  }
  let t; q.addEventListener('input', () => { clearTimeout(t); t = setTimeout(reload, 250); });
  setMain(h('div', { class: 'page' }, pageHead('History', 'Your sessions, background tasks and archive.'), q, tabs, list, sentinel));
  new IntersectionObserver((es) => { if (es.some((x) => x.isIntersecting)) loadMore(); }, { root: document.getElementById('main'), rootMargin: '300px' }).observe(sentinel);
  loadMore();
  if (focusSearch) setTimeout(() => q.focus(), 50);
}

// ================= BACKGROUND TASKS =================
const STATUS = { waiting_for_review: ['Waiting for review', 'warn'], applied: ['Applied', 'green'], rejected: ['Rejected', ''], queued: ['Queued', 'warn'],
  running: ['Running', 'warn'], succeeded: ['Succeeded', 'green'], failed: ['Failed', 'error'], stopped: ['Stopped', ''], stop_requested: ['Stopping', 'warn'] };
async function renderTasks(el) {
  el.replaceChildren(skel(3));
  try {
    const r = await api('/api/tasks');
    el.replaceChildren(...(r.tasks.length ? r.tasks.map((t) => {
      const [label, cls] = STATUS[t.status] || [t.status, ''];
      return h(t.kind === 'code_proposal' ? 'a' : 'div', { class: 'list-item', href: t.kind === 'code_proposal' ? `#/code/${t.project_id}` : undefined },
        icon(t.kind === 'gpu_job' ? 'gauge' : 'code'), h('div', { class: 'grow' }, h('div', { class: 'title' }, t.title),
          h('div', { class: 'sub' }, `${t.kind === 'gpu_job' ? 'GPU job' : `Approx Code · ${t.project_name}`} · ${fmtTime(t.created_at)}`)), h('span', { class: `badge ${cls}` }, label));
    }) : [h('p', { class: 'muted empty' }, 'No background tasks. Approx Code agent runs and their review status appear here.')]));
  } catch (e) { el.replaceChildren(errBox(e)); }
}
export function openTasksSheet() { sheet('Background tasks', (s) => { const el = h('div', { class: 'list' }); s.append(el); renderTasks(el); }); }

// ================= FEEDBACK =================
export function openFeedbackSheet({ chatId, category = 'other' } = {}) {
  sheet('Send feedback', (s, close) => {
    const cat = h('select', { class: 'input', 'aria-label': 'Feedback type' }, [['bug', 'Something is broken'], ['idea', 'Idea or request'], ['model_quality', 'Answer quality'], ['billing', 'Plan & billing'], ['other', 'Other']]
      .map(([v, l]) => h('option', { value: v, selected: v === category }, l)));
    const msg = h('textarea', { class: 'input', rows: '5', maxlength: '4000', placeholder: 'Tell us what happened or what you’d like…', 'aria-label': 'Feedback message' });
    const btn = h('button', { class: 'btn primary block', onclick: async () => {
      if (msg.value.trim().length < 3) { toast('Please write a few words'); return msg.focus(); }
      btn.disabled = true; btn.classList.add('loading');
      try { await api('/api/feedback', { method: 'POST', body: { category: cat.value, message: msg.value.trim(), chat_id: chatId || undefined } }); close(); toast('Thanks — your feedback was sent to the Approx team'); }
      catch (e) { toast(e.message); } finally { btn.disabled = false; btn.classList.remove('loading'); }
    } }, 'Send feedback');
    s.append(h('div', { class: 'field' }, h('label', {}, 'Type'), cat), h('div', { class: 'field' }, h('label', {}, 'Message'), msg),
      chatId ? h('p', { class: 'small muted' }, 'A link to this session is included so the team can look into it.') : null, btn);
    setTimeout(() => msg.focus(), 60);
  });
}

// ================= APPROX WORK =================
export async function workPage() { setMain(h('div', { class: 'page' }, pageHead('Approx Work', 'Background tasks and the things you’ve made.'), workExtras())); }

/** Background tasks (code-agent reviews, GPU jobs) and recent artifacts — shown under the Approx Work workspace. */
export function workExtras() {
  const tasks = h('div', { class: 'list' }, skel(2));
  const arts = h('div', { class: 'list' }, skel(2));
  renderTasks(tasks);
  cached('/api/workspace/artifacts', 20_000).then((r) => {
    arts.replaceChildren(...(r.artifacts.length ? r.artifacts.slice(0, 8).map((a) => h('a', { class: 'list-item', href: `#/workspace/${a.id}` }, icon(a.kind === 'code' ? 'code' : 'doc'),
      h('div', { class: 'grow' }, h('div', { class: 'title' }, a.title), h('div', { class: 'sub' }, `${a.kind} · v${a.version} · ${fmtTime(a.updated_at)}`)))) : [h('p', { class: 'muted empty' }, 'Nothing saved yet. Use “Save to Workspace” on any answer.')]));
  }).catch((e) => arts.replaceChildren(errBox(e)));
  return h('div', {}, h('div', { class: 'quick-grid' },
      h('a', { class: 'quick', href: '#/projects' }, icon('folder'), 'Projects'), h('a', { class: 'quick', href: '#/w/code' }, icon('code'), 'Code'),
      h('a', { class: 'quick', href: '#/workspace' }, icon('layers'), 'Artifacts'), h('a', { class: 'quick', href: '#/research' }, icon('search'), 'Research')),
    h('h2', { class: 'section' }, 'Background tasks'), tasks, h('h2', { class: 'section' }, 'Recent artifacts'), arts);
}

// ================= SCHEDULE =================
export function schedulePage() {
  setMain(h('div', { class: 'page' }, pageHead('Schedule', 'Run a prompt or task automatically at set times.'),
    h('div', { class: 'card empty-card' }, icon('calendar'), h('h3', {}, 'Scheduled tasks aren’t available yet'),
      h('p', { class: 'muted' }, 'Approx doesn’t have a scheduler service yet, so nothing can run on a timetable. This page will list your schedules once it exists.'),
      h('p', { class: 'small muted' }, 'Needed on the server: a job scheduler (cron/queue worker) and /api/schedules endpoints to create, list, pause and delete schedules.'))));
}

// ================= SETTINGS =================
const SECTIONS = [
  ['profile', 'user', 'Profile', 'Name, language, activity'], ['billing', 'card', 'Billing', 'Plan and upgrades'], ['usage', 'gauge', 'Usage', 'Requests, models, limits'],
  ['capabilities', 'spark', 'Capabilities', 'Models and tools you can use'], ['code', 'code', 'Approx Code', 'Coding workspace and permissions'],
  ['connectors', 'link', 'Connectors', 'Connected services'], ['notifications', 'bell', 'Notifications', 'Emails and inbox'],
  ['security', 'lock', 'Security', 'Password, two-step verification, email, sessions'], ['appearance', 'palette', 'Appearance', 'Theme, text size, start screen'],
  ['workspaces', 'layers', 'Workspaces', 'Work, Code and Education preferences'], ['data', 'archive', 'Data controls', 'Retention, archive, delete, export'],
  ['account', 'account', 'Account', 'Memory, data, API, delete'], ['help', 'help', 'Help & Support', 'Documentation, contact, report a problem'],
  ['models', 'spark', 'AI settings', 'Default model, routing, streaming, fallback'], ['about', 'info', 'About & updates', 'Version, updates, build'],
];
const GROUPS = [['Your account', ['profile', 'security', 'account']], ['Preferences', ['appearance', 'workspaces', 'code']], ['Notifications', ['notifications']],
  ['AI settings', ['models', 'capabilities']], ['Connected services', ['connectors']], ['Privacy and data', ['data']], ['Billing and usage', ['billing', 'usage']],
  ['Help', ['help', 'about']]];
const EXTRA = { memory: 'Memory', personalization: 'Personalization', privacy: 'Privacy & data', api: 'Developer API', delete: 'Delete account', email: 'Email' };

export function settingsHome() {
  const u = state.user;
  setMain(h('div', { class: 'page settings-home' }, pageHead('Settings'),
    h('a', { class: 'profile-card', href: '#/settings/profile' }, h('span', { class: 'avatar lg' }, (u.display_name || u.email)[0].toUpperCase()),
      h('div', { class: 'grow' }, h('b', {}, u.display_name || u.email.split('@')[0]), h('div', { class: 'small muted' }, u.email)), h('span', { class: 'badge green' }, `${u.plan}`)),
    ...GROUPS.flatMap(([g, keys]) => [h('div', { class: 'settings-group' }, g), h('div', { class: 'settings-list' }, keys.map((k) => SECTIONS.find((x) => x[0] === k)).map(([k, ic, label, sub]) => h('a', { class: 'settings-row', href: `#/settings/${k}` },
      h('span', { class: 'settings-icon' }, icon(ic)), h('span', { class: 'grow' }, h('span', { class: 'title' }, label), h('span', { class: 'sub' }, sub)), icon('chevron'))))]),
    h('button', { class: 'settings-row signout', onclick: signOut }, h('span', { class: 'settings-icon' }, icon('logout')), h('span', { class: 'grow' }, h('span', { class: 'title' }, 'Log out')))));
}
async function signOut() {
  try { await api('/api/auth/logout', { method: 'POST' }); } catch { /* signed out locally anyway */ }
  signOutLocal(); go('#/login');
}

export async function settingsSection(key) {
  const label = SECTIONS.find((x) => x[0] === key)?.[2] || EXTRA[key];
  if (!label) return go('#/settings');
  const body = h('div', { class: 'settings-body' });
  setMain(h('div', { class: 'page' }, pageHead(label, null, EXTRA[key] ? '#/settings/account' : '#/settings'), body));
  try {
    if (PAGES[key]) await PAGES[key](body);
    else await SETTINGS[key](body, () => {});
  } catch (e) { body.append(errBox(e)); }
}

function ring(pct, label, value, sub) {
  const r = 34; const c = 2 * Math.PI * r; const p = Math.max(0, Math.min(100, pct));
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('viewBox', '0 0 84 84'); svg.setAttribute('class', 'ring-svg');
  for (const [cls, dash] of [['ring-bg', `${c} ${c}`], ['ring-fg', `${(p / 100) * c} ${c}`]]) {
    const ci = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    ci.setAttribute('cx', '42'); ci.setAttribute('cy', '42'); ci.setAttribute('r', String(r)); ci.setAttribute('class', cls); ci.setAttribute('stroke-dasharray', dash);
    svg.append(ci);
  }
  return h('div', { class: 'ring-card', role: 'img', 'aria-label': `${label}: ${value}` }, h('div', { class: 'ring' }, svg, h('div', { class: 'ring-val' }, `${Math.round(p)}%`)),
    h('div', {}, h('b', {}, label), h('div', { class: 'small' }, value), sub ? h('div', { class: 'small muted' }, sub) : null));
}
const sw = (label, desc, checked, onChange) => {
  const inp = h('input', { type: 'checkbox', role: 'switch', checked, 'aria-label': label });
  inp.addEventListener('change', async () => { try { await onChange(inp.checked); toast('Saved'); } catch (e) { toast(e.message); inp.checked = !inp.checked; } });
  return h('label', { class: 'switch' }, h('div', {}, h('div', {}, label), desc ? h('div', { class: 'small muted' }, desc) : null), inp);
};
const choice = (label, value, options, onChange) => {
  const sel = h('select', { class: 'input', 'aria-label': label }, options.map(([v, t]) => h('option', { value: v, selected: String(v) === String(value) }, t)));
  sel.addEventListener('change', async () => { const prev = value; try { await onChange(sel.value); value = sel.value; toast('Saved'); } catch (e) { toast(e.message); sel.value = prev; } });
  return h('div', { class: 'field' }, h('label', {}, label), sel);
};
const patch = async (body) => { const r = await api('/api/settings', { method: 'PATCH', body }); state.settings = { ...state.settings, ...r.settings }; invalidate('/api/settings'); return r; };
const meter = (pct) => { const i = h('i'); i.style.width = `${Math.min(100, pct)}%`; return h('div', { class: 'meter' }, i); };

const PAGES = {
  async profile(b) {
    const s = await cached('/api/settings', 30_000);
    const u = s.user;
    const name = h('input', { class: 'input', value: u.display_name, maxlength: '80', id: 'dn', autocomplete: 'name' });
    const lang = h('select', { class: 'input', id: 'lang' }, [['auto', 'Automatic'], ['en', 'English'], ['ur', 'اردو (Urdu)'], ['roman-ur', 'Roman Urdu']].map(([v, l]) => h('option', { value: v, selected: u.language === v }, l)));
    const stats = h('div', { class: 'stat-grid' }, skel(1)); const act = h('div', { class: 'list' }, skel(3));
    b.append(h('div', { class: 'card profile-top' }, h('span', { class: 'avatar lg' }, (u.display_name || u.email)[0].toUpperCase()),
      h('div', { class: 'grow' }, h('b', {}, u.display_name || u.email), h('div', { class: 'small muted' }, u.email),
        h('div', { class: 'small' }, `${u.email_verified ? 'Email verified' : 'Email not verified'} · ${u.plan} plan · ${u.role} · member since ${new Date(u.created_at).toLocaleDateString()}`))),
    h('div', { class: 'field' }, h('label', { for: 'dn' }, 'Name'), name), h('div', { class: 'field' }, h('label', { for: 'lang' }, 'Preferred language'), lang),
    h('button', { class: 'btn primary', onclick: async () => {
      await api('/api/settings', { method: 'PATCH', body: { display_name: name.value.trim(), language: lang.value } });
      state.user.display_name = name.value.trim(); state.user.language = lang.value; invalidate('/api/settings'); toast('Profile saved');
    } }, 'Save profile'), h('h2', { class: 'section' }, 'Your Approx'), stats, h('h2', { class: 'section' }, 'Account activity'), act);
    try {
      const r = await api('/api/account/activity');
      stats.replaceChildren(...[['Sessions', r.stats.chats], ['Messages sent', r.stats.messages], ['Projects', r.stats.projects], ['Files', r.stats.files]].map(([l, v]) => h('div', { class: 'stat' }, h('b', {}, String(v)), h('span', { class: 'small muted' }, l))));
      const nice = (a) => ({ 'auth.login': 'Signed in', 'auth.signup': 'Account created', 'auth.email_verified': 'Email verified', 'auth.password_changed': 'Password changed',
        'auth.password_reset': 'Password reset', 'auth.password_reset_requested': 'Password reset requested', 'auth.email_changed': 'Email changed', 'auth.supabase_linked': 'Sign-in upgraded',
        'chat.branch': 'Session branched', 'feedback.sent': 'Feedback sent', 'auth.login_google': 'Signed in with Google' }[a] || a.replace(/[._]/g, ' '));
      act.replaceChildren(...(r.activity.length ? r.activity.slice(0, 20).map((x) => h('div', { class: 'list-item static' }, h('span', { class: 'grow' }, nice(x.action)), h('span', { class: 'small muted' }, fmtTime(x.created_at))))
        : [h('p', { class: 'muted' }, 'No activity yet.')]));
    } catch (e) { act.replaceChildren(errBox(e)); stats.replaceChildren(); }
  },
  async billing(b) {
    const plan = state.user.plan;
    const u = await cached('/api/usage', 15_000);
    const PLANS = { free: 'Nick 4.8 and Hike 6.5', pro: 'Nick 4.8, Hike 6.5 and Sona 9.0', enterprise: 'All models your organisation is granted' };
    b.append(h('div', { class: 'card plan-card' }, h('div', { class: 'small muted' }, 'Current plan'), h('div', { class: 'plan-name' }, plan[0].toUpperCase() + plan.slice(1)),
      h('div', { class: 'small' }, `Includes ${PLANS[plan] || 'your granted models'}. FAB models are granted individually by Approx Technology.`),
      h('div', { class: 'row' }, h('span', { class: 'small muted grow' }, `${u.window.used} / ${u.window.limit} requests this hour`)), meter((u.window.used / u.window.limit) * 100)),
    h('h2', { class: 'section' }, 'Billing information'),
    h('div', { class: 'alert warn' }, 'Online payments aren’t enabled yet: Approx has no payment provider connected, so there are no invoices or saved payment methods. Plan changes are applied by an administrator.'),
    h('p', { class: 'small muted' }, 'Needed on the server: a payment provider integration (checkout, invoices, webhooks) and /api/billing endpoints.'),
    h('button', { class: 'btn primary block', onclick: () => openFeedbackSheet({ category: 'billing' }) }, 'Request a plan change'),
    h('a', { class: 'btn block', href: '#/settings/usage' }, 'View usage'));
  },
  async usage(b) {
    const box = h('div', {}, skel(4)); b.append(box);
    const draw = (d) => {
      const win = (d.window.used / d.window.limit) * 100;
      const cyc = d.cycle.limit ? (d.cycle.used / d.cycle.limit) * 100 : 0;
      const max = Math.max(1, ...d.daily.map((x) => x.requests));
      const total = d.by_model.reduce((s, x) => s + x.requests, 0) || 1;
      box.replaceChildren(
        h('div', { class: 'ring-grid' }, ring(win, 'This hour', `${d.window.used} of ${d.window.limit} requests`, d.window.resets_at ? `next slot ${new Date(d.window.resets_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : 'full quota available'),
          ring(cyc, `${d.cycle.days}-day cycle`, d.cycle.limit ? `${d.cycle.used} of ${d.cycle.limit}` : `${d.cycle.used} requests (no cycle cap)`, `renews ${new Date(d.cycle.renews_at).toLocaleDateString()}`)),
        h('h2', { class: 'section' }, 'Last 14 days'),
        h('div', { class: 'bars', role: 'img', 'aria-label': 'Requests per day for the last 14 days' }, d.daily.map((x) => { const bar = h('i', { title: `${x.date}: ${x.requests}` }); bar.style.height = `${Math.max(3, (x.requests / max) * 100)}%`; return bar; })),
        h('h2', { class: 'section' }, 'By model (this cycle)'),
        d.by_model.length ? h('div', { class: 'list' }, d.by_model.map((x) => h('div', { class: 'list-item static model-row' }, h('span', { class: 'grow' }, modelName(x.model_id)), h('span', { class: 'small' }, `${x.requests}`), meter((x.requests / total) * 100))))
          : h('p', { class: 'muted' }, 'No requests yet this cycle.'),
        h('h2', { class: 'section' }, 'Tokens (this cycle)'),
        h('div', { class: 'stat-grid' }, h('div', { class: 'stat' }, h('b', {}, d.tokens.tokens_in.toLocaleString()), h('span', { class: 'small muted' }, 'input')),
          h('div', { class: 'stat' }, h('b', {}, d.tokens.tokens_out.toLocaleString()), h('span', { class: 'small muted' }, 'output')),
          h('div', { class: 'stat' }, h('b', {}, d.all_time_requests.toLocaleString()), h('span', { class: 'small muted' }, 'requests all time'))),
        h('p', { class: 'small muted' }, d.token_note));
    };
    try { draw(await cached('/api/usage/details', 10_000, draw)); } catch (e) { box.replaceChildren(errBox(e)); }
  },
  async capabilities(b) {
    const [c, code, research] = await Promise.all([cached('/api/capabilities', 60_000), cached('/api/fabbox/capabilities', 300_000).catch(() => null), cached('/api/research/capabilities', 300_000).catch(() => null)]);
    const usable = (m) => state.models.find((x) => x.id === m.id);
    const yes = (t) => h('span', { class: 'badge green' }, t); const no = (t) => h('span', { class: 'badge' }, t);
    const inputs = (m) => (Array.isArray(m.modalities) ? m.modalities : m.modalities?.input) || [];
    const anyImage = c.models.some((m) => m.available && inputs(m).includes('image'));
    b.append(h('h2', { class: 'section' }, 'Models'), h('div', { class: 'list' }, c.models.map((m) => {
      const live = usable(m); const serving = live && live.backend !== 'unavailable' && live.backend !== 'no_active_version';
      return h('div', { class: 'list-item static' }, icon('spark'), h('div', { class: 'grow' }, h('div', { class: 'title' }, m.name), h('div', { class: 'sub' }, (m.capabilities || []).slice(0, 4).join(' · '))),
        !m.available ? no('Not on your plan') : serving ? yes('Available') : h('span', { class: 'badge warn' }, live?.lifecycle?.label || 'Not served yet'));
    })),
    h('h2', { class: 'section' }, 'Tools'), h('div', { class: 'list' },
      [['Response modes (Low · Medium · High)', true, 'Choose effort per message in the model menu'],
        ['File attachments', true, 'Text, code, data and PDFs are read; up to 10 MB'],
        ['Image understanding', anyImage, anyImage ? 'Available on supported models' : 'Images are stored but current models can’t see image pixels'],
        ['Approx Code', !!code, code ? 'Virtual repository + agent edits with review' : 'Unavailable'],
        ['Research with sources', !!research, research ? `URL sources: ${research.url_sources}; web search: ${String(research.web_search).startsWith('available') ? 'available' : 'not configured'}` : 'Unavailable'],
        ['Background tasks', true, 'Approx Code agent runs and their review status'],
        ['Connectors', false, 'No third-party services can be connected yet']]
        .map(([t, ok, sub]) => h('div', { class: 'list-item static' }, icon(ok ? 'check' : 'close'), h('div', { class: 'grow' }, h('div', { class: 'title' }, t), h('div', { class: 'sub' }, sub)), ok ? yes('Yes') : no('No')))),
    c.pipelines.length ? h('h2', { class: 'section' }, 'Media pipelines') : null,
    c.pipelines.map((p) => h('div', { class: 'list-item static' }, icon('layers'), h('div', { class: 'grow' }, h('div', { class: 'title' }, p.name), h('div', { class: 'sub' }, p.note || p.description || '')), p.status === 'connected' ? yes('Connected') : no('Not connected'))));
  },
  async code(b) {
    const perm = state.settings?.permissions_mode === 'automatic' ? 'Automatic' : 'Manual';
    const list = h('div', { class: 'list' }, skel(2));
    b.append(h('p', { class: 'muted' }, 'Approx Code is a coding workspace: a repository of files and an agent that proposes edits.'),
      h('a', { class: 'btn primary block', href: '#/w/code' }, icon('code'), 'Open Approx Code'),
      h('h2', { class: 'section' }, 'Permissions'), h('button', { class: 'settings-row', onclick: () => openPermissions() },
        h('span', { class: 'settings-icon' }, icon('shield')), h('span', { class: 'grow' }, h('span', { class: 'title' }, perm), h('span', { class: 'sub' }, perm === 'Automatic' ? 'Agent changes are applied immediately' : 'Agent changes wait for your review')), icon('chevron')),
      h('h2', { class: 'section' }, 'Code projects'), list,
      h('a', { class: 'settings-row', href: '#/settings/workspaces' }, h('span', { class: 'grow' }, h('span', { class: 'title' }, 'Default branch'), h('span', { class: 'sub' }, state.settings?.workspace_prefs?.code?.default_branch || 'main')), icon('chevron')));
    try {
      const r = await cached('/api/projects', 15_000);
      const code = r.projects.filter((p) => p.kind === 'fabbox' || p.kind === 'coeprox');
      list.replaceChildren(...(code.length ? code.map((p) => h('a', { class: 'list-item', href: `#/code/${p.id}` }, icon('code'), h('div', { class: 'grow' }, h('div', { class: 'title' }, p.name), h('div', { class: 'sub' }, p.kind === 'coeprox' ? 'Coeprox app' : 'Code workspace'))))
        : [h('p', { class: 'muted' }, 'No code projects yet — create one in Approx Code.')]));
    } catch (e) { list.replaceChildren(errBox(e)); }
  },
  async connectors(b) {
    const st = await api('/api/integrations').catch(() => null);
    const badge = (ok, on, off) => h('span', { class: `badge ${ok ? 'green' : ''}` }, ok ? on : off);
    if (st) b.append(h('h2', { class: 'section' }, 'Approx services'), h('div', { class: 'list' },
      h('div', { class: 'list-item static' }, icon('spark'), h('span', { class: 'grow' }, h('div', { class: 'title' }, 'Lala 3.5 (Ollama)'), h('div', { class: 'sub' }, st.lala.detail)), badge(st.lala.ok, 'Online', 'Offline')),
      h('div', { class: 'list-item static' }, icon('link'), h('span', { class: 'grow' }, h('div', { class: 'title' }, 'Claude (Anthropic)'), h('div', { class: 'sub' }, st.claude.configured ? 'API key configured on the server' : 'Not configured — needs ANTHROPIC_API_KEY on the server')), badge(st.claude.configured, 'Configured', 'Not configured')),
      h('div', { class: 'list-item static' }, icon('code'), h('span', { class: 'grow' }, h('div', { class: 'title' }, 'Your computers (device agent)'), h('div', { class: 'sub' }, `${st.devices.connected} connected`)), h('a', { class: 'btn small', href: '#/w/code' }, 'Manage')),
      st.supabase ? h('div', { class: 'list-item static' }, icon('lock'), h('span', { class: 'grow' }, h('div', { class: 'title' }, 'Supabase Auth (admin diagnostics)'), h('div', { class: 'sub' }, st.supabase.detail)), badge(st.supabase.ok, 'Reachable', 'Problem')) : null));
    b.append(h('h2', { class: 'section' }, 'Connected'), h('p', { class: 'muted' }, 'No third-party accounts are connected to your account.'),
      h('h2', { class: 'section' }, 'Built in (always on)'), h('div', { class: 'list' }, [['File attachments', 'file'], ['Research (URL sources)', 'search'], ['Approx Code', 'code'], ['Artifacts', 'layers'], ['Projects', 'folder']]
        .map(([t, ic]) => h('div', { class: 'list-item static' }, icon(ic), h('span', { class: 'grow' }, t), h('span', { class: 'badge green' }, 'On')))),
      h('h2', { class: 'section' }, 'Third-party services'), h('div', { class: 'list' }, ['Google Drive', 'GitHub', 'Gmail', 'Google Calendar', 'Slack']
        .map((t) => h('div', { class: 'list-item static' }, icon('link'), h('span', { class: 'grow' }, t), h('span', { class: 'badge' }, 'Not available yet')))),
      h('p', { class: 'small muted' }, 'Connecting a service needs OAuth apps registered by Approx Technology and server endpoints (/api/connectors) that store tokens securely on the server — neither exists yet. Approx never shows API keys, passwords or OAuth secrets in the app.'));
  },
  async notifications(b) {
    const s = (await api('/api/settings')).settings;
    const inbox = h('div', { class: 'list' }, skel(2));
    const load = async () => {
      const r = await api('/api/notifications');
      inbox.replaceChildren(...(r.notifications.length ? r.notifications.map((n) => h('div', { class: `list-item notif${n.read_at ? '' : ' unread'}` },
        h('a', { class: 'grow', href: n.link || '#/settings/notifications', onclick: () => api(`/api/notifications/${n.id}/read`, { method: 'POST' }).catch(() => {}) },
          h('div', { class: 'title' }, n.title), h('div', { class: 'sub' }, `${n.body} · ${fmtTime(n.created_at)}`)),
        h('button', { class: 'icon-btn', 'aria-label': `Delete notification: ${n.title}`, onclick: async () => { await api(`/api/notifications/${n.id}`, { method: 'DELETE' }); load(); } }, icon('trash'))))
        : [h('p', { class: 'muted' }, 'No notifications.')]));
      unread.textContent = r.unread ? `${r.unread} unread` : 'All read';
    };
    const unread = h('span', { class: 'small muted grow' });
    b.append(
      sw('Task and code updates', 'In-app notifications when a plan or quiz is ready and when code changes wait for your review.', s.notify_task_updates, (v) => patch({ notify_task_updates: v })),
      sw('Email me a copy', 'Also email the notifications above.', s.notifications_email, (v) => patch({ notifications_email: v })),
      browserNotifSwitch(),
      h('p', { class: 'small muted' }, 'Security notifications (new sign-in, password or two-step verification changes) are always shown and emailed. Email verification and password reset always use email — never browser notifications.'),
      h('div', { class: 'row' }, unread,
        h('button', { class: 'btn small', onclick: async () => { await api('/api/notifications/read-all', { method: 'POST' }); load(); } }, 'Mark all read'),
        h('button', { class: 'btn small', onclick: async () => { if (await confirmDialog('Clear all notifications?', 'Your inbox will be emptied.', 'Clear', true)) { await api('/api/notifications', { method: 'DELETE' }); load(); } } }, 'Clear all')),
      inbox);
    load().catch((e) => inbox.replaceChildren(errBox(e)));
  },
  async workspaces(b) {
    const p = (await api('/api/settings')).settings.workspace_prefs;
    const wp = (ws, key) => (v) => patch({ workspace_prefs: { [ws]: { [key]: v } } });
    const branch = h('input', { class: 'input', value: p.code.default_branch, maxlength: '60', 'aria-label': 'Default branch' });
    b.append(h('h2', { class: 'section' }, 'Approx Education'),
      choice('Quiz length', p.education.quiz_count, [3, 5, 10, 15, 20].map((n) => [n, `${n} questions`]), (v) => wp('education', 'quiz_count')(Number(v))),
      choice('Quiz difficulty', p.education.difficulty, [['easy', 'Easy'], ['mixed', 'Mixed'], ['hard', 'Hard']], wp('education', 'difficulty')),
      choice('Explanations', p.education.explanation_style, [['simple', 'Simple — short steps, everyday words'], ['detailed', 'Detailed — full derivations and examples'], ['exam', 'Exam-focused — key points and model answers']], wp('education', 'explanation_style')),
      h('h2', { class: 'section' }, 'Approx Code'),
      h('div', { class: 'field' }, h('label', {}, 'Default branch for new repositories'), h('div', { class: 'row' }, branch,
        h('button', { class: 'btn', onclick: async () => { try { await wp('code', 'default_branch')(branch.value.trim()); toast('Saved'); } catch (e) { toast(e.message); } } }, 'Save'))),
      h('a', { class: 'settings-row', href: '#/settings/code' }, h('span', { class: 'grow' }, h('span', { class: 'title' }, 'Agent permissions'), h('span', { class: 'sub' }, 'Manual review or automatic apply')), icon('chevron')),
      h('h2', { class: 'section' }, 'Approx Work'),
      sw('A thread for each planned task', 'When Approx plans a goal, give every task its own conversation thread.', p.work.plan_threads, wp('work', 'plan_threads')));
  },
  async data(b) {
    const s = (await api('/api/settings')).settings;
    b.append(
      choice('Keep conversations', s.chat_retention_days, [[0, 'Forever'], [7, '7 days'], [30, '30 days'], [90, '90 days'], [365, '1 year']], async (v) => {
        if (Number(v) && !await confirmDialog('Delete old conversations?', `Conversations and sessions untouched for longer than ${v} days will be deleted now and from now on.`, 'Apply', true)) throw new Error('Not changed');
        await patch({ chat_retention_days: Number(v) });
      }),
      h('div', { class: 'settings-list' },
        h('button', { class: 'settings-row', onclick: async () => { const r = await api('/api/account/data/archive-chats', { method: 'POST' }); toast(`${r.count} conversations archived`); refreshRecent(true); } },
          h('span', { class: 'settings-icon' }, icon('archive')), h('span', { class: 'grow' }, h('span', { class: 'title' }, 'Archive all conversations'), h('span', { class: 'sub' }, 'Move every active conversation to Archived'))),
        h('button', { class: 'settings-row', onclick: () => { location.href = '/api/account/export'; } },
          h('span', { class: 'settings-icon' }, icon('download')), h('span', { class: 'grow' }, h('span', { class: 'title' }, 'Export my data'), h('span', { class: 'sub' }, 'Download everything as JSON'))),
        h('button', { class: 'settings-row danger', onclick: async () => {
          const t = await promptDialog('Delete all conversations', 'Type DELETE to permanently delete every conversation and work session');
          if (t === null) return;
          try { const r = await api('/api/account/data/delete-chats', { method: 'POST', body: { confirm: t } }); toast(`${r.count} conversations deleted`); refreshRecent(true); } catch (e) { toast(e.message); }
        } }, h('span', { class: 'settings-icon' }, icon('trash')), h('span', { class: 'grow' }, h('span', { class: 'title' }, 'Delete all conversations'), h('span', { class: 'sub' }, 'Permanent — cannot be undone')))),
      h('a', { class: 'btn block', href: '#/settings/privacy' }, 'Training consent'), h('a', { class: 'btn block', href: '#/settings/delete' }, 'Delete account'));
  },
  async appearance(b) {
    const cur = state.settings?.theme || 'light';
    const opt = (v, t, d) => h('button', { class: 'option', role: 'radio', 'aria-checked': String(cur === v), onclick: async () => {
      await api('/api/settings', { method: 'PATCH', body: { theme: v } }); state.settings.theme = v; applyTheme(v); invalidate('/api/settings');
      for (const o of b.querySelectorAll('.option')) o.setAttribute('aria-checked', String(o.dataset.v === v)); toast('Theme saved');
    }, 'data-v': v }, h('div', { class: 'grow' }, h('div', { class: 'name' }, t), h('div', { class: 'small muted' }, d)));
    b.append(opt('light', 'Light', 'Green and white (default)'), opt('dark', 'Dark', 'Dark background'), opt('system', 'System', 'Follow your device setting'),
      h('h2', { class: 'section' }, 'Text size'),
      choice('Text size', state.settings?.text_size || 'medium', [['small', 'Small'], ['medium', 'Medium'], ['large', 'Large']], async (v) => { await patch({ text_size: v }); applyTextSize(v); }),
      h('h2', { class: 'section' }, 'Start screen'),
      choice('Open Approx in', state.settings?.default_workspace || 'home', [['home', 'Home (chat)'], ['work', 'Approx Work'], ['code', 'Approx Code'], ['education', 'Approx Education']], (v) => patch({ default_workspace: v })));
  },
  async account(b) {
    const link = (k, ic, t, sub) => h('a', { class: 'settings-row', href: `#/settings/${k}` }, h('span', { class: 'settings-icon' }, icon(ic)), h('span', { class: 'grow' }, h('span', { class: 'title' }, t), h('span', { class: 'sub' }, sub)), icon('chevron'));
    b.append(h('div', { class: 'settings-list' },
      link('memory', 'save', 'Memory', 'What Approx remembers about you'), link('personalization', 'edit', 'Personalization', 'How Approx should respond'),
      link('models', 'spark', 'Model preferences', 'Default model and mode'), link('privacy', 'shield', 'Privacy & data', 'Training consent, export your data'),
      link('api', 'code', 'Developer API', 'API keys and docs'), link('delete', 'trash', 'Delete account', 'Permanently remove your account')),
    h('button', { class: 'btn block', onclick: signOut }, icon('logout'), 'Log out'));
  },
  async security(b) {
    b.append(h('h2', { class: 'section' }, 'Two-step verification'));
    const box = h('div', {});
    b.append(box);
    const draw = async () => {
      const st = await api('/api/auth/mfa');
      if (!st.available) return box.replaceChildren(h('p', { class: 'muted' }, 'This account signs in with Google. Set a password with “Forgot password” to use two-step verification.'));
      const pw = h('input', { class: 'input', type: 'password', autocomplete: 'current-password', placeholder: 'Current password', 'aria-label': 'Current password' });
      const code = h('input', { class: 'input', inputmode: 'numeric', autocomplete: 'one-time-code', placeholder: '6-digit code', maxlength: '8', 'aria-label': 'Authenticator code' });
      const msg = h('div', {});
      if (st.enabled) {
        box.replaceChildren(h('div', { class: 'alert ok' }, 'On — signing in needs a code from your authenticator app.'), pw, code, msg,
          h('button', { class: 'btn danger', onclick: async () => { try { await api('/api/auth/mfa/disable', { method: 'POST', body: { password: pw.value, code: code.value.trim() } }); toast('Two-step verification turned off'); draw(); } catch (e) { msg.replaceChildren(errBox(e)); } } }, 'Turn off'));
        return;
      }
      box.replaceChildren(h('p', { class: 'muted small' }, 'Add a code from an authenticator app (Google Authenticator, Microsoft Authenticator, Authy…) to every sign-in.'), pw, msg,
        h('button', { class: 'btn primary', onclick: async () => {
          try {
            const e = await api('/api/auth/mfa/enroll', { method: 'POST', body: { password: pw.value } });
            const confirm = h('button', { class: 'btn primary', onclick: async () => {
              try { await api('/api/auth/mfa/verify', { method: 'POST', body: { password: pw.value, factor_id: e.factor_id, code: code.value.trim() } }); toast('Two-step verification is on'); draw(); }
              catch (err) { msg.replaceChildren(errBox(err)); }
            } }, 'Confirm and turn on');
            box.replaceChildren(h('p', {}, '1. Scan the QR code with your authenticator app, or enter the setup key.'),
              e.qr_code && e.qr_code.startsWith('data:image/') ? h('img', { class: 'mfa-qr', src: e.qr_code, alt: 'QR code for your authenticator app' }) : null,
              h('div', { class: 'card setup-key' }, e.secret), h('a', { class: 'small', href: e.uri }, 'Open in an authenticator app on this device'),
              h('p', {}, '2. Enter the 6-digit code the app shows.'), code, msg, confirm);
          } catch (err) { msg.replaceChildren(errBox(err)); }
        } }, 'Set up two-step verification'));
    };
    await draw();
    b.append(h('h2', { class: 'section' }, 'Password and sessions'));
    await SETTINGS.security(b);
    b.append(h('h2', { class: 'section' }, 'Email address'));
    await SETTINGS.email(b);
  },
  async about(b) {
    const [v, rel] = await Promise.all([api('/api/version').catch(() => ({})), api('/api/releases/latest').catch((e) => ({ error: e.message }))]);
    const cur = v.versions?.product || '—';
    const newer = rel.available && rel.version && cmpVer(rel.version, cur) > 0;
    b.append(h('dl', { class: 'kv card' },
      h('dt', {}, 'App'), h('dd', {}, 'Approx (web)'),
      h('dt', {}, 'Installed version'), h('dd', {}, cur),
      h('dt', {}, 'Latest release'), h('dd', {}, rel.available ? `${rel.version} · ${new Date(rel.published_at).toLocaleDateString()}` : (rel.reason || rel.error || 'No published release yet')),
      h('dt', {}, 'Update status'), h('dd', {}, rel.available ? (newer ? 'A newer version is published — the web app updates on reload.' : 'Up to date') : '—'),
      h('dt', {}, 'Last checked'), h('dd', {}, new Date().toLocaleString()),
      h('dt', {}, 'Build'), h('dd', {}, `${v.build_id || 'unknown'} · API ${v.versions?.api_contract || '—'}`)),
      rel.available ? h('div', { class: 'list' },
        rel.android?.url ? h('a', { class: 'list-item', href: rel.android.url }, icon('download'), h('span', { class: 'grow' }, h('div', { class: 'title' }, 'Approx for Android (Approx.apk)'), h('div', { class: 'sub mono' }, `SHA-256 ${rel.android.sha256 || 'not published'}`))) : null,
        rel.windows?.url ? h('a', { class: 'list-item', href: rel.windows.url }, icon('download'), h('span', { class: 'grow' }, h('div', { class: 'title' }, 'Approx for Windows (Approx.exe)'), h('div', { class: 'sub mono' }, `SHA-256 ${rel.windows.sha256 || 'not published'}`))) : null) : null,
      rel.notes ? h('details', { class: 'card' }, h('summary', {}, 'Release notes'), h('pre', { class: 'small pre-wrap' }, rel.notes)) : null,
      h('button', { class: 'btn', onclick: () => settingsSection('about') }, 'Check for updates'));
  },
  async help(b) {
    const v = await api('/api/health').catch(() => ({}));
    b.append(h('div', { class: 'settings-list' },
      h('button', { class: 'settings-row', onclick: () => openFeedbackSheet({ category: 'bug' }) }, h('span', { class: 'settings-icon' }, icon('flag')), h('span', { class: 'grow' }, h('span', { class: 'title' }, 'Report a problem'), h('span', { class: 'sub' }, 'Goes straight to the Approx team')), icon('chevron')),
      h('button', { class: 'settings-row', onclick: () => openFeedbackSheet({ category: 'idea' }) }, h('span', { class: 'settings-icon' }, icon('spark')), h('span', { class: 'grow' }, h('span', { class: 'title' }, 'Suggest a feature')), icon('chevron')),
      h('a', { class: 'settings-row', href: '/developers/' }, h('span', { class: 'settings-icon' }, icon('code')), h('span', { class: 'grow' }, h('span', { class: 'title' }, 'Developer documentation')), icon('chevron'))),
    h('div', { class: 'card small muted' }, `Approx AI ${v.version || ''} · build ${v.build_id || 'unknown'} · by Approx Technology`));
  },
};
void fmtBytes; void newChat;

function cmpVer(a, b) { const x = String(a).split('.').map(Number); const y = String(b).split('.').map(Number); for (let i = 0; i < 3; i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0); } return 0; }

/** Browser notifications: an opt-in per browser. Granted → new Approx notifications also appear as system notifications. */
function browserNotifSwitch() {
  if (!('Notification' in window)) return h('p', { class: 'small muted' }, 'This browser does not support notifications.');
  let on = false; try { on = localStorage.getItem('approx.browserNotify') === '1' && Notification.permission === 'granted'; } catch { /* storage blocked */ }
  const note = h('div', { class: 'small muted' }, Notification.permission === 'denied' ? 'Blocked in this browser — allow notifications for this site in the browser settings.' : '');
  const inp = h('input', { type: 'checkbox', role: 'switch', checked: on, disabled: Notification.permission === 'denied', 'aria-label': 'Browser notifications' });
  inp.addEventListener('change', async () => {
    if (inp.checked) {
      const p = await Notification.requestPermission();
      if (p !== 'granted') { inp.checked = false; note.textContent = p === 'denied' ? 'Blocked in this browser — allow notifications for this site in the browser settings.' : 'Permission was not granted.'; return; }
    }
    try { localStorage.setItem('approx.browserNotify', inp.checked ? '1' : '0'); } catch { /* ignore */ }
    toast(inp.checked ? 'Browser notifications on' : 'Browser notifications off');
  });
  return h('label', { class: 'switch' }, h('div', {}, h('div', {}, 'Browser notifications'), h('div', { class: 'small muted' }, 'Show new Approx notifications as system notifications in this browser.'), note), inp);
}
