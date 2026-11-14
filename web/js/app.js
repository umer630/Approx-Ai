import { api, stream, upload, setCsrf, ApiError } from './api.js';
import { h, icon, toast, sheet, fmtTime, fmtBytes, confirmDialog, promptDialog } from './ui.js';
import { markdown } from './md.js';
import { greeting } from './greeting.js';
import * as views from './views.js';

export const state = {
  user: null, models: [], modes: ['low', 'medium', 'high'], modeDetails: [], defaultMode: 'medium', usage: null, settings: null,
  chat: null, messages: [], model: 'auto', mode: 'medium', attachments: [], streaming: null, projectId: null,
};
const app = document.getElementById('app');

// ---------------- routing ----------------
const routes = [
  [/^#\/login$/, () => authView('login')],
  [/^#\/signup$/, () => authView('signup')],
  [/^#\/forgot$/, () => authView('forgot')],
  [/^#\/verify/, () => tokenView('verify')],
  [/^#\/reset/, () => tokenView('reset')],
  [/^#\/confirm-email/, () => tokenView('confirm')],
  [/^#\/google-mobile/, () => googleMobileView()],
  [/^#\/c\/([\w]+)$/, (m) => shell(() => chatView(m[1]))],
  [/^#\/projects$/, () => shell(() => views.projectsView())],
  [/^#\/projects\/([\w]+)$/, (m) => shell(() => views.projectView(m[1]))],
  [/^#\/workspace$/, () => shell(() => views.workspaceView())],
  [/^#\/workspace\/([\w]+)$/, (m) => shell(() => views.artifactView(m[1]))],
  [/^#\/code$/, () => shell(() => views.codeProjectsView())],
  [/^#\/code\/([\w]+)$/, (m) => shell(() => views.codeView(m[1]))],
  [/^#\/research$/, () => shell(() => views.researchView())],
  [/^#\/admin$/, () => shell(() => views.adminView())],
  [/^#?\/?$/, () => shell(() => chatView(null))],
];
const PUBLIC = /^#\/(login|signup|forgot|verify|reset|confirm-email|google-mobile)/;

export function go(hash) { if (location.hash === hash) render(); else location.hash = hash; }
window.addEventListener('hashchange', render);

async function render() {
  const hash = location.hash || '#/';
  if (!state.user && !PUBLIC.test(hash)) {
    try { const me = await api('/api/auth/me'); state.user = me.user; setCsrf(me.csrf_token); await bootstrap(); } catch { return go('#/login'); }
  }
  for (const [re, fn] of routes) { const m = re.exec(hash); if (m) return fn(m); }
  go('#/');
}

async function bootstrap() {
  const [m, s, u] = await Promise.all([api('/api/models'), api('/api/settings'), api('/api/usage')]);
  state.models = m.models; state.modes = m.modes; state.modeDetails = m.mode_details || []; state.defaultMode = m.default_mode || 'medium'; state.settings = s.settings; state.usage = u;
  state.mode = s.settings.default_mode;
  state.model = 'auto';
  // Green + white is the default; Dark is an explicit choice in Settings.
  document.documentElement.dataset.theme = s.settings.theme === 'dark' ? 'dark' : 'light';
}
export async function refreshUsage() { try { state.usage = await api('/api/usage'); } catch { /* ignore */ } }

// ---------------- auth views ----------------
function authFrame(title, subtitle, ...content) {
  app.replaceChildren(h('div', { class: 'auth' }, h('div', { class: 'auth-card' },
    h('div', { class: 'logo' }, h('img', { src: '/assets/logo-mark-192.png', alt: 'Approx AI logo' }), h('h1', {}, title), subtitle ? h('div', { class: 'muted' }, subtitle) : null),
    ...content,
    h('p', { class: 'muted small', }, '© Approx Technology'))));
}
function formMsg() { return h('div', { class: 'hidden', role: 'alert' }); }
function showMsg(el, text, kind = 'error') { el.className = `alert ${kind}`; el.textContent = text; }

// ---- account helpers (this device only: email + name, never tokens or passwords) ----
const RECENT_KEY = 'approx.recentAccounts';
function recentAccounts() { try { return JSON.parse(localStorage.getItem(RECENT_KEY) || '[]').filter((a) => a && typeof a.email === 'string').slice(0, 4); } catch { return []; } }
function rememberAccount(user) {
  try {
    const list = [{ email: user.email, name: user.display_name || '' }, ...recentAccounts().filter((a) => a.email !== user.email)].slice(0, 4);
    localStorage.setItem(RECENT_KEY, JSON.stringify(list));
  } catch { /* storage unavailable */ }
}
function forgetAccount(email) { try { localStorage.setItem(RECENT_KEY, JSON.stringify(recentAccounts().filter((a) => a.email !== email))); } catch { /* ignore */ } }
async function signedIn(r) { state.user = r.user; setCsrf(r.csrf_token); rememberAccount(r.user); await bootstrap(); go('#/'); }

/** Password input with a Show/Hide toggle. */
function passwordField(id, labelText, autocomplete, hint) {
  const input = h('input', { class: 'input', type: 'password', autocomplete, required: true, id, minlength: '10' });
  const toggle = h('button', { class: 'pw-toggle', type: 'button', 'aria-label': 'Show password', 'aria-controls': id, onclick: () => {
    const show = input.type === 'password'; input.type = show ? 'text' : 'password';
    toggle.textContent = show ? 'Hide' : 'Show'; toggle.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
  } }, 'Show');
  return { input, el: h('div', { class: 'field' }, h('label', { for: id }, labelText), h('div', { class: 'pw-wrap' }, input, toggle), hint ? h('span', { class: 'small muted' }, hint) : null) };
}

/** Google's official button + account chooser (Google Identity Services). Only rendered when a client ID is configured. */
let gisLoad;
function loadGis() {
  gisLoad ||= new Promise((resolve, reject) => {
    const sc = document.createElement('script'); sc.src = 'https://accounts.google.com/gsi/client'; sc.async = true;
    sc.onload = () => resolve(window.google); sc.onerror = () => { gisLoad = null; reject(new Error("Couldn't load Google sign-in. Check your connection.")); };
    document.head.append(sc);
  });
  return gisLoad;
}
function googleSection(msg, onCredential) {
  const slot = h('div', { class: 'google-slot' });
  const wrap = h('div', { class: 'google-wrap' }, slot, h('div', { class: 'or' }, h('span', {}, 'or')));
  (async () => {
    let cfg; try { cfg = await api('/api/auth/config'); } catch { cfg = null; }
    if (!cfg?.google?.enabled) {
      slot.replaceChildren(h('button', { class: 'btn block google-btn', type: 'button', disabled: true, title: 'Not configured' }, h('span', { class: 'g-logo', 'aria-hidden': 'true' }, 'G'), 'Continue with Google'),
        h('div', { class: 'small muted center' }, 'Google sign-in isn’t set up on this server yet.'));
      return;
    }
    try {
      const google = await loadGis();
      google.accounts.id.initialize({ client_id: cfg.google.client_id, ux_mode: 'popup', auto_select: false, cancel_on_tap_outside: true,
        callback: async (resp) => { try { await onCredential(resp.credential); } catch (e) { showMsg(msg, e.message); } } });
      google.accounts.id.renderButton(slot, { type: 'standard', theme: 'outline', size: 'large', text: 'continue_with', shape: 'pill', width: Math.min(360, slot.clientWidth || 360) });
    } catch (e) { slot.replaceChildren(h('div', { class: 'small muted center' }, e.message)); }
  })();
  return wrap;
}

function authView(kind) {
  const msg = formMsg();
  const email = h('input', { class: 'input', type: 'email', autocomplete: 'email', required: true, id: 'email', placeholder: 'you@example.com' });
  const pwf = kind !== 'forgot' ? passwordField('password', 'Password', kind === 'signup' ? 'new-password' : 'current-password', kind === 'signup' ? 'At least 10 characters with letters and numbers.' : null) : null;
  const pw2 = kind === 'signup' ? passwordField('password2', 'Confirm password', 'new-password') : null;
  const name = h('input', { class: 'input', autocomplete: 'name', id: 'name', maxlength: '80' });
  const btn = h('button', { class: 'btn primary block', type: 'submit' }, kind === 'login' ? 'Sign in' : kind === 'signup' ? 'Create account' : 'Send reset link');
  const label = btn.textContent;
  const busyLabel = kind === 'login' ? 'Signing in…' : kind === 'signup' ? 'Creating account…' : 'Sending…';
  const form = h('form', { novalidate: true, onsubmit: async (e) => {
    e.preventDefault();
    if (btn.disabled) return; // no duplicate submissions
    // Clear validation messages before any network call.
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.value.trim())) { showMsg(msg, 'Enter a valid email address.'); email.focus(); return; }
    if (pwf && !pwf.input.value) { showMsg(msg, 'Enter your password.'); pwf.input.focus(); return; }
    if (kind === 'signup') {
      if (pwf.input.value.length < 10 || !/[a-z]/i.test(pwf.input.value) || !/\d/.test(pwf.input.value)) { showMsg(msg, 'Use at least 10 characters with letters and numbers.'); pwf.input.focus(); return; }
      if (pwf.input.value !== pw2.input.value) { showMsg(msg, 'The passwords don’t match.'); pw2.input.focus(); return; }
    }
    btn.disabled = true; btn.classList.add('loading'); btn.setAttribute('aria-busy', 'true'); btn.textContent = busyLabel;
    msg.className = 'hidden';
    try {
      if (kind === 'login') {
        await signedIn(await api('/api/auth/login', { method: 'POST', body: { email: email.value.trim(), password: pwf.input.value } }));
      } else if (kind === 'signup') {
        const r = await api('/api/auth/signup', { method: 'POST', body: { email: email.value.trim(), password: pwf.input.value, display_name: name.value } });
        showMsg(msg, `${r.message} Check your inbox (and spam folder), then open the link to verify.`, 'ok'); form.reset();
      } else {
        const r = await api('/api/auth/forgot-password', { method: 'POST', body: { email: email.value.trim() } });
        showMsg(msg, r.message, 'ok');
      }
    } catch (err) { showMsg(msg, err.message); } finally { btn.disabled = false; btn.classList.remove('loading'); btn.removeAttribute('aria-busy'); btn.textContent = label; }
  } },
  kind === 'signup' ? h('div', { class: 'field' }, h('label', { for: 'name' }, 'Name (optional)'), name) : null,
  h('div', { class: 'field' }, h('label', { for: 'email' }, 'Email'), email),
  pwf?.el, pw2?.el, msg, btn);

  // Accounts used on this device before: tap to continue (fills the email; the password is still required).
  const recent = kind === 'login' ? recentAccounts() : [];
  const chooser = recent.length ? h('div', { class: 'account-chooser' }, h('div', { class: 'small muted' }, 'Choose an account'),
    ...recent.map((a) => h('div', { class: 'account-row' },
      h('button', { class: 'account', type: 'button', onclick: () => { email.value = a.email; pwf.input.focus(); } },
        h('span', { class: 'account-avatar', 'aria-hidden': 'true' }, (a.name || a.email)[0].toUpperCase()),
        h('span', { class: 'grow' }, h('b', {}, a.name || a.email.split('@')[0]), h('span', { class: 'small muted' }, a.email))),
      h('button', { class: 'icon-btn small', type: 'button', 'aria-label': `Remove ${a.email} from this device`, title: 'Remove from this device', onclick: (e) => { forgetAccount(a.email); e.currentTarget.closest('.account-row').remove(); } }, '×')))) : null;

  const google = kind !== 'forgot' ? googleSection(msg, async (credential) => signedIn(await api('/api/auth/google', { method: 'POST', body: { credential } }))) : null;
  const links = h('div', { class: 'auth-links' },
    kind === 'login' ? h('a', { href: '#/signup' }, 'Create account') : kind === 'signup' ? h('span', {}, 'Already have an account? ', h('a', { href: '#/login' }, 'Sign in')) : h('a', { href: '#/login' }, 'Sign in'),
    kind === 'login' ? h('a', { href: '#/forgot' }, 'Forgot password?') : null);
  if (kind === 'login') links.append(h('a', { href: '#/verify' }, 'Have a code?'));
  authFrame(kind === 'login' ? 'Welcome back' : kind === 'signup' ? 'Create your Approx AI account' : 'Reset password',
    kind === 'login' ? 'Sign in to Approx AI' : kind === 'signup' ? 'Free to start — Nick 4.8 and Hike 6.5 included.' : null, chooser, google, form, links);
}

/** Android "Continue with Google": runs Google sign-in in the browser, then returns to the app with a one-time code. */
function googleMobileView() {
  const params = new URLSearchParams(location.hash.split('?')[1] || '');
  const challenge = params.get('challenge') || ''; const st = params.get('state') || '';
  const msg = formMsg();
  if (!/^[A-Za-z0-9_-]{43,64}$/.test(challenge) || !/^[A-Za-z0-9_-]{8,64}$/.test(st)) {
    return authFrame('Continue with Google', null, h('div', { class: 'alert error' }, 'This sign-in link is incomplete. Start again from the Approx AI app.'));
  }
  authFrame('Continue with Google', 'Choose the Google account to use with the Approx AI app.', googleSection(msg, async (credential) => {
    const r = await api('/api/auth/google/handoff', { method: 'POST', body: { credential, challenge } });
    showMsg(msg, 'Signed in. Returning to the Approx AI app…', 'ok');
    location.href = `approxai://auth?code=${encodeURIComponent(r.code)}&state=${encodeURIComponent(st)}`;
  }), msg);
}

function tokenView(kind) {
  const params = new URLSearchParams(location.hash.split('?')[1] || '');
  const msg = formMsg();
  const tok = h('input', { class: 'input', value: params.get('token') || '', id: 'token', autocomplete: 'one-time-code' });
  const pw = h('input', { class: 'input', type: 'password', autocomplete: 'new-password', id: 'newpw' });
  const resendEmail = h('input', { class: 'input', type: 'email', placeholder: 'you@example.com' });
  const btn = h('button', { class: 'btn primary block', type: 'submit' }, kind === 'reset' ? 'Set new password' : 'Confirm');
  const form = h('form', { onsubmit: async (e) => {
    e.preventDefault();
    if (btn.disabled) return;
    const label = btn.textContent;
    btn.disabled = true; btn.classList.add('loading'); btn.setAttribute('aria-busy', 'true'); btn.textContent = 'Please wait…';
    try {
      if (kind === 'verify') {
        await api('/api/auth/verify-email', { method: 'POST', body: { token: tok.value.trim() } });
        if (state.user) state.user.email_verified = true;
        return done('Email verified', 'Your email address is confirmed. You can now use Approx AI.');
      } else if (kind === 'reset') {
        await api('/api/auth/reset-password', { method: 'POST', body: { token: tok.value.trim(), password: pw.value } });
        state.user = null;
        return done('Password updated', 'Your password has been changed. Sign in with your new password.');
      } else {
        await api('/api/auth/confirm-email-change', { method: 'POST', body: { token: tok.value.trim() } });
        state.user = null;
        return done('Email changed', 'Your new email address is confirmed. Please sign in again.');
      }
    } catch (err) { showMsg(msg, err.message); } finally { btn.disabled = false; btn.classList.remove('loading'); btn.removeAttribute('aria-busy'); btn.textContent = label; }
  } },
  h('div', { class: 'field' }, h('label', { for: 'token' }, 'Code from your email'), tok),
  kind === 'reset' ? h('div', { class: 'field' }, h('label', { for: 'newpw' }, 'New password'), pw) : null, msg, btn);
  const extra = kind === 'verify' ? h('details', { class: 'small' }, h('summary', { class: 'muted' }, 'Resend verification email'),
    h('div', { class: 'row' }, resendEmail, h('button', { class: 'btn', type: 'button', onclick: async () => {
      const r = await api('/api/auth/resend-verification', { method: 'POST', body: { email: resendEmail.value } }).catch((e) => ({ message: e.message }));
      showMsg(msg, r.message, 'ok');
    } }, 'Send'))) : null;
  // Success: one clear next step. The token is removed from the address bar first, so reloading this page can never
  // resubmit a used token or bounce between routes.
  function done(title, text) {
    history.replaceState(null, '', `#/${kind === 'confirm' ? 'confirm-email' : kind}`);
    const next = state.user ? ['#/', 'Continue to Approx AI'] : ['#/login', 'Continue to sign in'];
    authFrame(title, null, h('div', { class: 'alert ok', role: 'status' }, text),
      h('button', { class: 'btn primary block', type: 'button', onclick: () => go(next[0]) }, next[1]));
  }
  authFrame(kind === 'verify' ? 'Verify your email' : kind === 'reset' ? 'Choose a new password' : 'Confirm email change', null, form, extra,
    h('div', { class: 'auth-links' }, h('a', { href: state.user ? '#/' : '#/login' }, state.user ? 'Back to chat' : 'Sign in')));
  // Opened from the email link (token in the URL fragment): submit once automatically. Reset still needs a password.
  if (params.get('token') && kind !== 'reset') form.requestSubmit();
}

// ---------------- shell: top bar + main + composer + three-button nav ----------------
let mainEl; let composerEl;
function shell(renderMain) {
  const initials = (state.user.display_name || state.user.email).trim()[0].toUpperCase();
  const top = h('header', { class: 'topbar' },
    h('a', { class: 'brand', href: '#/', 'aria-label': 'Approx AI home' }, h('img', { src: '/assets/logo-mark-64.png', alt: '' }), h('span', {}, 'Approx ', h('span', { class: 'ai' }, 'AI'))),
    h('div', { class: 'spacer' }),
    h('button', { class: 'model-pill', 'aria-label': 'Current model', onclick: openModelPicker }, h('span', { class: 'dot' }), h('span', { id: 'model-indicator' }, modelLabel())),
    h('button', { class: 'avatar', 'aria-label': 'Account', title: state.user.email, onclick: () => views.openSettings('account') }, initials),
    h('button', { class: 'icon-btn hide-sm', 'aria-label': 'Settings', onclick: () => views.openSettings() }, icon('settings')));
  mainEl = h('main', { class: 'main', id: 'main' });
  composerEl = h('div', { class: 'composer-wrap' });
  const nav = h('nav', { class: 'bottom-nav', 'aria-label': 'Primary' },
    h('button', { onclick: newChat, class: location.hash.startsWith('#/c/') || location.hash === '#/' || !location.hash ? 'active' : '' }, icon('chat'), 'New chat'),
    h('button', { onclick: () => views.openHistory() }, icon('history'), 'History'),
    h('button', { onclick: () => views.openSettings() }, icon('settings'), 'Settings'));
  app.replaceChildren(top, mainEl, composerEl, nav);
  renderMain();
}
export function setMain(...nodes) { mainEl.replaceChildren(...nodes); }
export function hideComposer() { composerEl.classList.add('hidden'); }

export function modeLabel(mode = state.mode) {
  const d = state.modeDetails.find((x) => x.id === mode);
  return d ? d.label : (mode ? mode[0].toUpperCase() + mode.slice(1) : 'Medium');
}
export function modelLabel() {
  const m = state.models.find((x) => x.id === state.model);
  return `${m ? m.name : 'Auto'} · ${modeLabel()}`;
}
function updateIndicator() {
  const el = document.getElementById('model-indicator'); if (el) el.textContent = modelLabel();
  const c = document.getElementById('model-chip'); if (c) c.replaceChildren(h('b', {}, (state.models.find((x) => x.id === state.model)?.name) || 'Auto'), icon('chevron'));
  // Keep every mode toggle on screen (composer + model sheet) showing the same selected mode.
  for (const b of document.querySelectorAll('.mode-toggle button[data-mode]')) b.setAttribute('aria-pressed', String(b.dataset.mode === state.mode));
}

export function openModelPicker() {
  sheet('Choose model', (s, close) => {
    s.append(h('p', { class: 'muted small' }, 'Models and modes are separate: the model decides who answers; the efficiency mode (Low / Medium / High) decides how much effort it spends on each reply.'));
    const opt = (id, name, desc, available, badge) => h('button', { class: 'option', role: 'radio', 'aria-checked': String(state.model === id), disabled: !available,
      onclick: () => { state.model = id; updateIndicator(); close(); } },
    h('div', { class: 'grow' }, h('div', { class: 'row' }, h('span', { class: 'name' }, name), badge), h('div', { class: 'small muted' }, desc)));
    s.append(opt('auto', 'Master Router (Auto)', 'Picks the best model you have access to for each message.', true, h('span', { class: 'badge green' }, 'Recommended')));
    for (const m of state.models) {
      const badge = modelBadge(m);
      const sub = [m.kind && m.kind !== 'language_model' ? m.kind.replace('_', ' ') : null,
        m.active_version ? `v${m.active_version}` : (m.lifecycle && m.lifecycle.state !== 'ACTIVE' ? m.lifecycle.label : (m.available ? 'no active version' : null))].filter(Boolean).join(' · ');
      s.append(opt(m.id, m.name, m.description + (sub ? `  (${sub})` : ''), m.available && m.backend !== 'unavailable' && m.backend !== 'no_active_version', badge));
    }
    s.append(h('h3', {}, 'Mode'), modeToggle(close));
  });
}
export function modeToggle(after) {
  const wrap = h('div', { class: 'mode-toggle', role: 'group', 'aria-label': 'Efficiency mode' });
  const modes = state.modeDetails.length ? state.modeDetails : state.modes.map((id) => ({ id, label: id }));
  for (const d of modes) {
    wrap.append(h('button', { type: 'button', 'data-mode': d.id, 'aria-pressed': String(state.mode === d.id), title: d.description || '', onclick: () => {
      state.mode = d.id; for (const b of wrap.children) b.setAttribute('aria-pressed', String(b.getAttribute('data-mode') === d.id)); updateIndicator(); after?.();
    } }, d.label));
  }
  return wrap;
}
function modelBadge(m) {
  if (!m.available) return h('span', { class: 'badge' }, m.tier === 'restricted' ? 'Restricted' : 'Premium');
  if (m.backend === 'unavailable') return h('span', { class: 'badge warn' }, 'Offline');
  if (m.backend === 'no_active_version') return h('span', { class: 'badge warn' }, 'No active version');
  if (m.backend === 'dev-simulator') return h('span', { class: 'badge warn' }, 'Simulator');
  if (m.production_ready) return h('span', { class: 'badge green' }, 'Live');
  if (m.backend === 'active' || m.backend === 'configured') return h('span', { class: 'badge' }, 'Preview');
  return null;
}

// ---------------- chat ----------------
export function newChat() { state.chat = null; state.messages = []; state.attachments = []; state.projectId = null; go('#/'); }

async function chatView(id) {
  composerEl.classList.remove('hidden');
  if (id) {
    try {
      const r = await api(`/api/chats/${id}`);
      state.chat = r.chat; state.messages = r.messages; state.mode = r.chat.mode; state.projectId = r.chat.project_id;
    } catch (e) { toast(e.message); return go('#/'); }
  } else if (!state.chat || state.chat.id) { state.chat = null; state.messages = []; }
  renderMessages();
  renderComposer();
}

const SUGGESTIONS = [
  ['Explain a concept', 'Explain how vaccines train the immune system, simply.'],
  ['Roman Urdu', 'Mujhe ek professional email likhne mein madad karo.'],
  ['اردو', 'علامہ اقبال کی شاعری کے بنیادی موضوعات بیان کریں۔'],
  ['Code', 'Write a Python function that validates a Pakistani CNIC number format.'],
  ['Security', 'Review this login flow for OWASP Top 10 risks: email + password, JWT in localStorage.'],
  ['Plan', 'Plan a 4-week study schedule for learning SQL from scratch.'],
];

// ---- conversation menu (⋯): rename, share, export, archive, delete ----
function chatHead() {
  if (!state.chat?.id) return null;
  return h('div', { class: 'chat-head' }, h('div', { class: 'title grow', id: 'chat-title' }, state.chat.title || 'New conversation'),
    h('button', { class: 'icon-btn', 'aria-label': 'Conversation options', title: 'Conversation options', onclick: openChatMenu }, icon('more')));
}
function conversationMarkdown() {
  return [`# ${state.chat?.title || 'Conversation'}`, ''].concat(state.messages.filter((m) => m.role !== 'system')
    .flatMap((m) => [`## ${m.role === 'user' ? 'You' : 'Approx AI'}`, '', m.content, ''])).join('\n');
}
function openChatMenu() {
  const c = state.chat; if (!c?.id) return;
  sheet('Conversation', (s, close) => {
    const item = (ic, label, fn, danger) => h('button', { class: `list-item${danger ? ' danger' : ''}`, onclick: async () => { close(); try { await fn(); } catch (e) { toast(e.message); } } }, icon(ic), h('span', { class: 'grow' }, label));
    s.append(h('div', { class: 'list' },
      item('edit', 'Rename', async () => {
        const t = await promptDialog('Rename conversation', 'Title', c.title); if (!t) return;
        await api(`/api/chats/${c.id}`, { method: 'PATCH', body: { title: t } }); c.title = t;
        const el = document.getElementById('chat-title'); if (el) el.textContent = t; toast('Renamed');
      }),
      item('share', 'Share', async () => {
        const text = conversationMarkdown();
        if (navigator.share) { try { await navigator.share({ title: c.title || 'Approx AI conversation', text }); return; } catch (e) { if (e.name === 'AbortError') return; } }
        await navigator.clipboard.writeText(text); toast('Conversation copied — paste it anywhere to share');
      }),
      item('download', 'Export as Markdown', async () => {
        const r = await fetch(`/api/chats/${c.id}/export?format=md`, { credentials: 'same-origin' });
        if (!r.ok) throw new Error('Export failed. Please try again.');
        const blob = await r.blob(); const a = h('a', { href: URL.createObjectURL(blob), download: `${(c.title || 'conversation').replace(/[^\p{L}\p{N} _-]+/gu, '').trim() || 'conversation'}.md` });
        document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 2000); toast('Exported');
      }),
      item('archive', 'Archive', async () => { await api(`/api/chats/${c.id}`, { method: 'PATCH', body: { archived: true } }); toast('Archived'); newChat(); }),
      item('trash', 'Delete', async () => {
        if (!(await confirmDialog('Delete conversation?', 'It moves to Trash in History, where you can restore it.', 'Delete', true))) return;
        await api(`/api/chats/${c.id}`, { method: 'DELETE' }); toast('Moved to trash'); newChat();
      }, true)));
  });
}

function renderMessages() {
  const list = h('div', { class: 'messages', id: 'messages' });
  if (!state.messages.length) {
    let returning = false;
    try { returning = localStorage.getItem('approx.seen') === '1'; localStorage.setItem('approx.seen', '1'); } catch { /* private mode */ }
    const g = greeting({ displayName: state.user.display_name, email: state.user.email, returning });
    list.append(h('div', { class: 'welcome' }, h('img', { src: '/assets/logo-mark-192.png', alt: '' }), h('h1', {}, g.title),
      h('p', { class: 'lead' }, g.subtitle),
      h('p', { class: 'muted small' }, 'English · اردو · Roman Urdu — ask anything.'),
      !state.user.email_verified ? h('div', { class: 'alert warn' }, 'Verify your email to start chatting. ', h('a', { href: '#/verify' }, 'Enter code')) : null,
      h('div', { class: 'suggestions' }, SUGGESTIONS.map(([t, p]) => h('button', { class: 'suggestion', onclick: () => { const ta = document.getElementById('prompt'); ta.value = p; ta.dispatchEvent(new Event('input')); ta.focus(); } }, h('b', {}, t), h('div', { class: 'muted small' }, p))))));
  }
  for (const m of state.messages) list.append(messageEl(m));
  setMain(...[chatHead(), list].filter(Boolean));
  scrollDown(true);
}
// Follow new output only while the reader is at (or near) the bottom; `force` for the reader's own actions.
function scrollDown(force = false) {
  const near = mainEl.scrollHeight - mainEl.scrollTop - mainEl.clientHeight < 140;
  if (force || near) requestAnimationFrame(() => { mainEl.scrollTop = mainEl.scrollHeight; });
}

function messageEl(m) {
  const isUser = m.role === 'user';
  const bubble = h('div', { class: `bubble ${isUser ? '' : 'md'}` });
  if (isUser) { bubble.textContent = m.content; if (/[؀-ۿ]/.test(m.content)) bubble.setAttribute('dir', 'rtl'); }
  else bubble.innerHTML = markdown(m.content);
  bubble.addEventListener('click', (e) => { const b = e.target.closest('[data-copy-code]'); if (b) { navigator.clipboard.writeText(b.closest('pre').querySelector('code').textContent); toast('Code copied'); } });
  const atts = m.attachments?.length ? h('div', { class: 'att-chips' }, m.attachments.map((a) => h('span', { class: 'chip' }, icon(a.kind === 'image' ? 'image' : 'file'), a.filename))) : null;
  const actions = h('div', { class: 'actions' },
    h('button', { 'aria-label': 'Copy', title: 'Copy', onclick: () => { navigator.clipboard.writeText(m.content); toast('Copied'); } }, icon('copy')),
    !isUser ? h('button', { 'aria-label': 'Regenerate', title: 'Regenerate', onclick: regenerate }, icon('refresh')) : null,
    !isUser ? h('button', { 'aria-label': 'Save to Workspace', title: 'Save to Approx Workspace', onclick: () => saveToWorkspace(m) }, icon('save')) : null,
    ...(!isUser && m.id && state.chat?.id ? feedbackButtons(m) : []),
    isUser ? h('button', { 'aria-label': 'Edit', title: 'Edit and resend', onclick: () => {
      const ta = document.getElementById('prompt'); if (!ta) return;
      ta.value = m.content; ta.dispatchEvent(new Event('input')); ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length);
    } }, icon('edit')) : null);
  const meta = h('div', { class: 'meta' }, actions,
    !isUser && m.model_id ? h('span', { class: 'tag', title: m.route_reason || '' }, `${state.models.find((x) => x.id === m.model_id)?.name || m.model_id} · ${modeLabel(m.mode)}`) : null,
    m.created_at ? h('span', {}, fmtTime(m.created_at)) : null);
  return h('article', { class: `msg ${m.role} ${m.status === 'error' ? 'error' : ''}`, 'data-id': m.id || '' }, atts, bubble, meta);
}

// 👍 / 👎 / Report on an assistant reply (stored per message; tapping the active rating clears it).
function feedbackButtons(m) {
  const fb = m.feedback || { rating: null, reported: false };
  const send = async (body) => {
    const r = await api(`/api/chats/${state.chat.id}/messages/${m.id}/feedback`, { method: 'POST', body });
    m.feedback = r.feedback; up.setAttribute('aria-pressed', String(r.feedback.rating === 'up')); down.setAttribute('aria-pressed', String(r.feedback.rating === 'down'));
    flag.classList.toggle('reported', r.feedback.reported);
  };
  const up = h('button', { 'aria-label': 'Good response', title: 'Good response', 'aria-pressed': String(fb.rating === 'up'),
    onclick: () => send({ rating: m.feedback?.rating === 'up' ? null : 'up' }).then(() => toast('Thanks for the feedback')).catch((e) => toast(e.message)) }, icon('up'));
  const down = h('button', { 'aria-label': 'Bad response', title: 'Bad response', 'aria-pressed': String(fb.rating === 'down'),
    onclick: () => send({ rating: m.feedback?.rating === 'down' ? null : 'down' }).then(() => toast('Thanks — this helps improve Approx')).catch((e) => toast(e.message)) }, icon('down'));
  const flag = h('button', { class: fb.reported ? 'reported' : '', 'aria-label': 'Report response', title: 'Report this response', onclick: () => {
    sheet('Report this response', (s, close) => {
      const note = h('textarea', { class: 'input', rows: '3', maxlength: '1000', placeholder: 'What went wrong? (optional)' });
      const reasons = [['incorrect', 'Incorrect or misleading'], ['harmful', 'Harmful or unsafe'], ['unhelpful', 'Not helpful'], ['other', 'Something else']];
      s.append(h('div', { class: 'list' }, reasons.map(([k, label]) => h('button', { class: 'list-item', onclick: async () => {
        try { await send({ rating: m.feedback?.rating || 'down', report: true, reason: k, comment: note.value.trim() || undefined }); close(); toast('Report sent. Thank you.'); } catch (e) { toast(e.message); }
      } }, h('span', { class: 'grow' }, label)))), h('div', { class: 'field' }, note));
    });
  } }, icon('flag'));
  return [up, down, flag];
}

async function saveToWorkspace(m) {
  const code = /```(\w*)\n([\s\S]*?)```/.exec(m.content);
  const body = code ? { title: `Code from ${state.chat?.title || 'chat'}`, kind: 'code', language: code[1] || '', content: code[2], chat_id: state.chat?.id }
    : { title: state.chat?.title || 'Document', kind: 'document', content: m.content, chat_id: state.chat?.id };
  try { const r = await api('/api/workspace/artifacts', { method: 'POST', body }); toast('Saved to Approx Workspace'); go(`#/workspace/${r.artifact.id}`); } catch (e) { toast(e.message); }
}

function renderComposer() {
  const ta = h('textarea', { id: 'prompt', rows: '1', placeholder: 'Ask Approx AI anything...', 'aria-label': 'Message', dir: 'auto', maxlength: '100000' });
  const send = h('button', { class: 'round send', 'aria-label': 'Send', disabled: true }, icon('send'));
  const chips = h('div', { class: 'att-chips', id: 'att-chips' });
  const sync = () => {
    ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, window.innerHeight * 0.4) + 'px';
    send.disabled = !state.streaming && !ta.value.trim();
  };
  ta.addEventListener('input', sync);
  ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && window.matchMedia('(pointer: fine)').matches) { e.preventDefault(); if (!send.disabled) send.click(); } });
  send.addEventListener('click', () => {
    if (state.streaming) { state.streaming.abort(); return; }
    const text = ta.value.trim(); if (!text) return;
    ta.value = ''; sync(); sendMessage(text, send);
  });
  const renderChips = () => chips.replaceChildren(...state.attachments.map((a) => h('span', { class: 'chip' }, icon(a.kind === 'image' ? 'image' : 'file'), `${a.filename} · ${fmtBytes(a.size)}`,
    h('button', { 'aria-label': `Remove ${a.filename}`, onclick: () => { state.attachments = state.attachments.filter((x) => x.id !== a.id); renderChips(); } }, '×'))));
  renderChips();
  const plus = h('button', { class: 'round', 'aria-label': 'Add attachments and tools', onclick: () => openPlusMenu(renderChips, ta) }, icon('plus'));
  const modelChip = h('button', { class: 'select-chip', id: 'model-chip', 'aria-label': 'Select model', onclick: openModelPicker });
  const mic = micButton(ta, sync);
  composerEl.replaceChildren(h('div', { class: 'composer' }, chips, ta,
    h('div', { class: 'bar' }, plus, modelChip, modeToggle(), h('div', { class: 'spacer' }), mic, send)),
  h('div', { class: 'composer-note' }, usageNote()));
  updateIndicator();
}
/** Voice input with the browser's own speech recognition. Not rendered where the browser has none (no fake mic). */
function micButton(ta, sync) {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return null;
  let rec = null; let base = '';
  const btn = h('button', { class: 'round mic', type: 'button', 'aria-label': 'Voice input', title: 'Voice input', 'aria-pressed': 'false' }, icon('mic'));
  const stop = () => { if (rec) rec.stop(); };
  const setListening = (on) => { btn.classList.toggle('listening', on); btn.setAttribute('aria-pressed', String(on)); btn.setAttribute('aria-label', on ? 'Stop listening' : 'Voice input'); };
  btn.addEventListener('click', () => {
    if (rec) return stop();
    rec = new SR(); rec.interimResults = true; rec.continuous = false;
    rec.lang = state.user?.language === 'ur' ? 'ur-PK' : (navigator.language || 'en-US');
    base = ta.value ? ta.value.replace(/\s*$/, ' ') : '';
    rec.onresult = (e) => { let t = ''; for (const r of e.results) t += r[0].transcript; ta.value = base + t; sync(); };
    rec.onerror = (e) => {
      toast(e.error === 'not-allowed' || e.error === 'service-not-allowed' ? 'Microphone access was blocked. Allow it in your browser settings to use voice input.'
        : e.error === 'no-speech' ? "Didn't catch that — try again." : 'Voice input stopped. Please try again.');
    };
    rec.onend = () => { rec = null; setListening(false); ta.focus(); };
    try { rec.start(); setListening(true); } catch { rec = null; setListening(false); }
  });
  return btn;
}

function usageNote() {
  const u = state.usage?.window;
  return u ? `${u.remaining}/${u.limit} requests left this hour · Approx AI can make mistakes — verify important info.` : 'Approx AI can make mistakes — verify important info.';
}

async function sendMessage(text, sendBtn) {
  if (!state.chat) {
    try {
      const r = await api('/api/chats', { method: 'POST', body: { model: state.model, mode: state.mode, project_id: state.projectId || undefined } });
      state.chat = r.chat; history.replaceState(null, '', `#/c/${r.chat.id}`);
      const hd = chatHead(); if (hd) mainEl.prepend(hd);
    } catch (e) { toast(e.message); return; }
  }
  const attachments = state.attachments; state.attachments = [];
  document.getElementById('att-chips')?.replaceChildren();
  const userMsg = { role: 'user', content: text, attachments, created_at: Date.now() };
  state.messages.push(userMsg);
  const list = document.getElementById('messages');
  list.querySelector('.welcome')?.remove();
  list.append(messageEl(userMsg));
  const live = h('article', { class: 'msg assistant' }, h('div', { class: 'bubble md' }, h('span', { class: 'typing', 'aria-label': 'Approx AI is responding' }, h('i'), h('i'), h('i'))));
  list.append(live); scrollDown(true);
  const ctrl = new AbortController();
  state.streaming = ctrl; sendBtn.replaceChildren(icon('stop')); sendBtn.disabled = false; sendBtn.setAttribute('aria-label', 'Stop');
  let acc = ''; let routeInfo = null; let pending = false;
  const bubble = live.querySelector('.bubble');
  const paint = () => { pending = false; bubble.innerHTML = markdown(acc); scrollDown(); };
  try {
    await stream(`/api/chats/${state.chat.id}/messages`, { content: text, model: state.model, mode: state.mode, attachments: attachments.map((a) => a.id) }, {
      route: (r) => { routeInfo = r; },
      delta: (d) => { acc += d.text; if (!pending) { pending = true; requestAnimationFrame(paint); } },
      done: (d) => {
        state.usage = d.usage;
        if (d.memory_saved) toast(`Saved to memory: “${d.memory_saved.content.slice(0, 40)}”`);
        state.chat.title = d.title;
        const msg = { id: d.message_id, role: 'assistant', content: acc, model_id: routeInfo?.model_id, mode: routeInfo?.mode, route_reason: routeInfo?.reason, created_at: Date.now() };
        state.messages.push(msg); live.replaceWith(messageEl(msg));
      },
      error: (e) => { throw new ApiError(500, { error: e }); },
    }, ctrl.signal);
  } catch (e) {
    const aborted = e.name === 'AbortError';
    const msg = aborted ? 'Stopped.' : e.message;
    live.replaceWith(h('article', { class: 'msg assistant error' }, h('div', { class: 'bubble' }, acc ? h('div', { class: 'md', html: markdown(acc) }) : null, h('p', {}, msg)),
      h('div', { class: 'meta' }, h('div', { class: 'actions' }, h('button', { 'aria-label': 'Retry', title: 'Retry', onclick: () => { state.messages.pop(); renderMessages(); sendMessage(text, document.querySelector('.round.send')); } }, icon('refresh'))),
        e.code === 'email_not_verified' ? h('a', { href: '#/verify' }, 'Verify email') : null, e.code === 'quota_exceeded' ? h('span', {}, 'Quota resets automatically.') : null)));
  } finally {
    state.streaming = null;
    const b = document.querySelector('.round.send');
    if (b) { b.replaceChildren(icon('send')); b.setAttribute('aria-label', 'Send'); b.disabled = !document.getElementById('prompt')?.value.trim(); }
    const note = document.querySelector('.composer-note'); if (note) note.textContent = usageNote();
  }
}

async function regenerate() {
  if (!state.chat || state.streaming) return;
  const lastUserIdx = state.messages.map((m) => m.role).lastIndexOf('user');
  if (lastUserIdx < 0) return;
  const text = state.messages[lastUserIdx].content;
  // Server deletes the last turn and re-runs it.
  state.messages = state.messages.slice(0, lastUserIdx + 1);
  renderMessages();
  const list = document.getElementById('messages');
  const live = h('article', { class: 'msg assistant' }, h('div', { class: 'bubble md' }, h('span', { class: 'typing' }, h('i'), h('i'), h('i'))));
  list.append(live);
  let acc = ''; let routeInfo = null;
  try {
    await stream(`/api/chats/${state.chat.id}/regenerate`, { model: state.model, mode: state.mode }, {
      route: (r) => { routeInfo = r; },
      delta: (d) => { acc += d.text; live.querySelector('.bubble').innerHTML = markdown(acc); },
      done: (d) => { state.usage = d.usage; const msg = { id: d.message_id, role: 'assistant', content: acc, model_id: routeInfo?.model_id, mode: routeInfo?.mode, created_at: Date.now() }; state.messages.push(msg); live.replaceWith(messageEl(msg)); },
      error: (e) => { throw new ApiError(500, { error: e }); },
    });
  } catch (e) { live.replaceWith(h('article', { class: 'msg assistant error' }, h('div', { class: 'bubble' }, e.message))); }
  void text;
}

// ---------------- Plus (+) menu ----------------
const ACCEPT = {
  file: '.txt,.md,.csv,.tsv,.json,.xml,.yaml,.yml,.log,.py,.js,.ts,.tsx,.jsx,.java,.kt,.c,.cpp,.h,.cs,.go,.rs,.rb,.php,.swift,.sql,.html,.css,.sh,.toml,.ini,.pdf,.docx,.xlsx,.pptx,.png,.jpg,.jpeg,.webp,.gif',
  image: '.png,.jpg,.jpeg,.webp,.gif', pdf: '.pdf', document: '.docx,.xlsx,.pptx,.txt,.md', data: '.csv,.tsv,.json,.xlsx',
};
function pickFiles(accept, renderChips, { capture, after } = {}) {
  const inp = h('input', { type: 'file', accept, multiple: !capture, capture: capture || undefined, class: 'hidden' });
  inp.addEventListener('change', async () => {
    for (const f of inp.files) {
      if (f.size > 10 * 1024 * 1024) { toast(`${f.name} is larger than 10 MB`); continue; }
      toast(`Uploading ${f.name}…`, 1200);
      try {
        const r = await upload(f, state.projectId);
        state.attachments.push(r.file); renderChips();
        if (r.file.kind === 'image') toast('Image attached. Note: the current Nick text backend cannot see image pixels.', 4000);
        if (r.file.kind === 'document' || (r.file.kind === 'pdf' && !r.file.has_text)) toast('Attached. Text could not be extracted from this file type in v1.0.', 4000);
      } catch (e) { toast(`${f.name}: ${e.message}`, 4000); }
    }
    inp.remove(); after?.();
  });
  document.body.append(inp); inp.click();
}

function openPlusMenu(renderChips, ta) {
  sheet('Add to message', (s, close) => {
    const item = (ic, label, fn, note) => h('button', { class: 'menu-item', onclick: () => { close(); fn(); } }, icon(ic), label, note ? h('span', { class: 'soon' }, note) : null);
    s.append(h('div', { class: 'menu-grid' },
      item('file', 'File', () => pickFiles(ACCEPT.file, renderChips)),
      item('image', 'Image', () => pickFiles(ACCEPT.image, renderChips)),
      item('pdf', 'PDF', () => pickFiles(ACCEPT.pdf, renderChips)),
      item('doc', 'Document', () => pickFiles(ACCEPT.document, renderChips)),
      item('camera', 'Camera', () => pickFiles('image/*', renderChips, { capture: 'environment' })),
      item('data', 'Data analysis', () => pickFiles(ACCEPT.data, renderChips, { after: () => { if (!ta.value) { ta.value = 'Analyze this dataset: describe the columns, key statistics, notable patterns and data quality issues.'; ta.dispatchEvent(new Event('input')); } } })),
      item('search', 'Research', () => go('#/research')),
      item('code', 'Code (Fabbox)', () => go('#/code')),
      item('layers', 'Workspace', () => go('#/workspace')),
      item('folder', 'Projects', () => go('#/projects')),
      item('plug', 'Tools & connectors', showConnectors, 'Not yet available'),
    ));
  });
}
function showConnectors() {
  sheet('Tools & connectors', (s) => {
    s.append(h('div', { class: 'alert warn' }, 'Third-party connectors (Google Drive, GitHub, email, calendars) are not available in Approx AI 1.0. They require OAuth apps registered by Approx Technology, which have not been configured yet. Nothing is connected to your account.'),
      h('p', { class: 'muted small' }, 'Available built-in tools: file attachments, Research (URL sources), Approx Workspace, Fabbox Code / Coeprox, Projects.'));
  });
}

export { api, toast, render };
render();
