// Full-page sections of the Approx workspace: History, Approx Work, Schedule, Settings (+ every settings page),
// and the Background-tasks / Feedback sheets. Every number and list comes from the backend; nothing is invented.
// Pages render instantly from cache (stale-while-revalidate) and show skeletons only on the first load.
import { api, cached, invalidate } from './api.js';
import { h, icon, toast, sheet, confirmDialog, promptDialog, fmtTime, fmtBytes } from './ui.js';
import { state, go, setMain, newChat, refreshRecent, applyTheme, openPermissions, signOutLocal } from './app.js';
import { SETTINGS } from './views.js';

const skel = (n = 4) => h('div', { class: 'skeleton-list' }, Array.from({ length: n }, () => h('div', { class: 'skeleton line' })));
const pageHead = (title, sub, back) => h('div', { class: 'page-head' }, back ? h('a', { class: 'icon-btn', href: back, 'aria-label': 'Back' }, icon('back')) : null,
  h('div', { class: 'grow' }, h('h1', {}, title), sub ? h('p', { class: 'muted small' }, sub) : null));
const modelName = (id) => state.models.find((m) => m.id === id)?.name || id;
const errBox = (e) => h('div', { class: 'alert error' }, e.message);

// ================= HISTORY =================
export async function historyPage() {
  let view = 'active'; let before = null; let loading = false; let more = true; let token = 0;
  const q = h('input', { class: 'input search', type: 'search', placeholder: 'Search sessions', 'aria-label': 'Search conversations' });
  const tabs = h('div', { class: 'tabs', role: 'tablist' });
  const list = h('div', { class: 'list' });
  const sentinel = h('div', { class: 'sentinel' });
  const row = (c) => h('div', { class: 'list-item' },
    h('button', { class: 'grow list-open', onclick: () => { if (view !== 'trash') go(`#/c/${c.id}`); }, 'aria-label': `Open ${c.title}` },
      h('div', { class: 'title' }, c.title), h('div', { class: 'sub' }, `${modelName(c.model_id)} · ${fmtTime(c.updated_at)}`)),
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
      list.append(...r.chats.map(row));
      more = r.has_more; before = r.chats.at(-1)?.updated_at || before;
    } catch (e) { list.replaceChildren(errBox(e)); } finally { loading = false; }
  };
  const reload = () => { token++; before = null; more = true; loading = false; loadMore(); };
  for (const [k, label] of [['active', 'Recent'], ['tasks', 'Background tasks'], ['archived', 'Archived'], ['trash', 'Trash']]) {
    tabs.append(h('button', { role: 'tab', 'aria-selected': String(k === view), onclick: (e) => { view = k; for (const b of tabs.children) b.setAttribute('aria-selected', String(b === e.currentTarget)); q.classList.toggle('hidden', k === 'tasks'); reload(); } }, label));
  }
  let t; q.addEventListener('input', () => { clearTimeout(t); t = setTimeout(reload, 250); });
  setMain(h('div', { class: 'page' }, pageHead('History', 'Your sessions, background tasks and archive.'), q, tabs, list, sentinel));
  new IntersectionObserver((es) => { if (es.some((x) => x.isIntersecting)) loadMore(); }, { root: document.getElementById('main'), rootMargin: '300px' }).observe(sentinel);
  loadMore();
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
export async function workPage() {
  const tasks = h('div', { class: 'list' }, skel(2));
  const arts = h('div', { class: 'list' }, skel(2));
  setMain(h('div', { class: 'page' }, pageHead('Approx Work', 'Background tasks and the things you’ve made.'),
    h('div', { class: 'quick-grid' },
      h('a', { class: 'quick', href: '#/projects' }, icon('folder'), 'Projects'), h('a', { class: 'quick', href: '#/code' }, icon('code'), 'Approx Code'),
      h('a', { class: 'quick', href: '#/workspace' }, icon('layers'), 'Artifacts'), h('a', { class: 'quick', href: '#/research' }, icon('search'), 'Research')),
    h('h2', { class: 'section' }, 'Background tasks'), tasks, h('h2', { class: 'section' }, 'Recent artifacts'), arts));
  renderTasks(tasks);
  try {
    const r = await cached('/api/workspace/artifacts', 20_000);
    arts.replaceChildren(...(r.artifacts.length ? r.artifacts.slice(0, 8).map((a) => h('a', { class: 'list-item', href: `#/workspace/${a.id}` }, icon(a.kind === 'code' ? 'code' : 'doc'),
      h('div', { class: 'grow' }, h('div', { class: 'title' }, a.title), h('div', { class: 'sub' }, `${a.kind} · v${a.version} · ${fmtTime(a.updated_at)}`)))) : [h('p', { class: 'muted empty' }, 'Nothing saved yet. Use “Save to Workspace” on any answer.')]));
  } catch (e) { arts.replaceChildren(errBox(e)); }
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
  ['security', 'lock', 'Security', 'Password, email, sessions'], ['appearance', 'palette', 'Appearance', 'Theme'],
  ['account', 'account', 'Account', 'Memory, data, API, delete'], ['help', 'help', 'Help & Support', 'Feedback and app info'],
];
const EXTRA = { memory: 'Memory', personalization: 'Personalization', models: 'Model preferences', privacy: 'Privacy & data', api: 'Developer API', delete: 'Delete account', email: 'Email' };

export function settingsHome() {
  const u = state.user;
  setMain(h('div', { class: 'page settings-home' }, pageHead('Settings'),
    h('a', { class: 'profile-card', href: '#/settings/profile' }, h('span', { class: 'avatar lg' }, (u.display_name || u.email)[0].toUpperCase()),
      h('div', { class: 'grow' }, h('b', {}, u.display_name || u.email.split('@')[0]), h('div', { class: 'small muted' }, u.email)), h('span', { class: 'badge green' }, `${u.plan}`)),
    h('div', { class: 'settings-list' }, SECTIONS.map(([k, ic, label, sub]) => h('a', { class: 'settings-row', href: `#/settings/${k}` },
      h('span', { class: 'settings-icon' }, icon(ic)), h('span', { class: 'grow' }, h('span', { class: 'title' }, label), h('span', { class: 'sub' }, sub)), icon('chevron')))),
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
      h('a', { class: 'btn primary block', href: '#/code' }, icon('code'), 'Open Approx Code'),
      h('h2', { class: 'section' }, 'Permissions'), h('button', { class: 'settings-row', onclick: () => openPermissions() },
        h('span', { class: 'settings-icon' }, icon('shield')), h('span', { class: 'grow' }, h('span', { class: 'title' }, perm), h('span', { class: 'sub' }, perm === 'Automatic' ? 'Agent changes are applied immediately' : 'Agent changes wait for your review')), icon('chevron')),
      h('h2', { class: 'section' }, 'Code projects'), list);
    try {
      const r = await cached('/api/projects', 15_000);
      const code = r.projects.filter((p) => p.kind === 'fabbox' || p.kind === 'coeprox');
      list.replaceChildren(...(code.length ? code.map((p) => h('a', { class: 'list-item', href: `#/code/${p.id}` }, icon('code'), h('div', { class: 'grow' }, h('div', { class: 'title' }, p.name), h('div', { class: 'sub' }, p.kind === 'coeprox' ? 'Coeprox app' : 'Code workspace'))))
        : [h('p', { class: 'muted' }, 'No code projects yet — create one in Approx Code.')]));
    } catch (e) { list.replaceChildren(errBox(e)); }
  },
  async connectors(b) {
    b.append(h('h2', { class: 'section' }, 'Connected'), h('p', { class: 'muted' }, 'No services are connected to your account.'),
      h('h2', { class: 'section' }, 'Built in (always on)'), h('div', { class: 'list' }, [['File attachments', 'file'], ['Research (URL sources)', 'search'], ['Approx Code', 'code'], ['Artifacts', 'layers'], ['Projects', 'folder']]
        .map(([t, ic]) => h('div', { class: 'list-item static' }, icon(ic), h('span', { class: 'grow' }, t), h('span', { class: 'badge green' }, 'On')))),
      h('h2', { class: 'section' }, 'Third-party services'), h('div', { class: 'list' }, ['Google Drive', 'GitHub', 'Gmail', 'Google Calendar', 'Slack']
        .map((t) => h('div', { class: 'list-item static' }, icon('link'), h('span', { class: 'grow' }, t), h('span', { class: 'badge' }, 'Not available yet')))),
      h('p', { class: 'small muted' }, 'Connecting a service needs OAuth apps registered by Approx Technology and server endpoints (/api/connectors) that store tokens securely on the server — neither exists yet. Approx never shows API keys, passwords or OAuth secrets in the app.'));
  },
  async appearance(b) {
    const cur = state.settings?.theme || 'light';
    const opt = (v, t, d) => h('button', { class: 'option', role: 'radio', 'aria-checked': String(cur === v), onclick: async () => {
      await api('/api/settings', { method: 'PATCH', body: { theme: v } }); state.settings.theme = v; applyTheme(v); invalidate('/api/settings');
      for (const o of b.querySelectorAll('.option')) o.setAttribute('aria-checked', String(o.dataset.v === v)); toast('Theme saved');
    }, 'data-v': v }, h('div', { class: 'grow' }, h('div', { class: 'name' }, t), h('div', { class: 'small muted' }, d)));
    b.append(opt('light', 'Light', 'Green and white (default)'), opt('dark', 'Dark', 'Dark background'), opt('system', 'System', 'Follow your device setting'));
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
    await SETTINGS.security(b);
    b.append(h('h2', { class: 'section' }, 'Email address'));
    await SETTINGS.email(b);
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
