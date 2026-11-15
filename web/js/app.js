import { api, stream, upload, setCsrf, ApiError, cached, invalidate, clearCache } from './api.js';
import { h, icon, toast, sheet, fmtTime, fmtBytes, confirmDialog, promptDialog } from './ui.js';
import { markdown } from './md.js';
import { firstName } from './greeting.js';
import * as views from './views.js';
import * as pages from './pages.js';
import * as fab from './fab500x.js';

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
  [/^#\/fab500x$/, () => shell(() => fab.projectsPage(), { composer: false })],
  [/^#\/fab500x\/(prj_\w+)$/, (m) => { shellEl = null; return fab.ideView(app, m[1]); }],
  [/^#\/history$/, () => shell(() => pages.historyPage(), { composer: false })],
  [/^#\/work$/, () => shell(() => pages.workPage(), { composer: false })],
  [/^#\/schedule$/, () => shell(() => pages.schedulePage(), { composer: false })],
  [/^#\/settings$/, () => shell(() => pages.settingsHome(), { composer: false })],
  [/^#\/settings\/([\w-]+)$/, (m) => shell(() => pages.settingsSection(m[1]), { composer: false })],
  [/^#?\/?$/, () => shell(() => chatView(null))],
];
const PUBLIC = /^#\/(login|signup|forgot|verify|reset|confirm-email|google-mobile)/;

// ---------------- Supabase Auth email links ----------------
// Confirmation / reset / email-change links go to Supabase, which redirects to `/?auth=callback` with the result in
// the URL fragment (#access_token=…&type=signup, or #error=…&error_code=otp_expired) or, with custom email templates,
// in the query (?token_hash=…&type=…). Read it once at startup, then remove it from the address bar and history so a
// token is never kept in the URL or resubmitted on reload.
let authCallback = null;
(function captureAuthCallback() {
  const q = new URLSearchParams(location.search);
  if (q.get('auth') !== 'callback') return;
  const f = new URLSearchParams(location.hash.replace(/^#\/?/, ''));
  const get = (k) => f.get(k) || q.get(k) || '';
  authCallback = { access_token: get('access_token'), token_hash: get('token_hash'), type: get('type'),
    error: get('error_code') || get('error'), error_description: get('error_description').replace(/\+/g, ' ') };
  const route = authCallback.error ? '#/verify' : authCallback.type === 'recovery' ? '#/reset'
    : authCallback.type === 'email_change' ? '#/confirm-email' : '#/verify';
  history.replaceState(null, '', `${location.pathname}${route}`);
})();
const takeCallback = () => { const c = authCallback; authCallback = null; return c; };
const callbackBody = (c) => (c.access_token ? { access_token: c.access_token } : { token_hash: c.token_hash, type: c.type || undefined });

export function go(hash) { if (location.hash === hash) render(); else location.hash = hash; }
window.addEventListener('hashchange', render);

async function render() {
  const hash = location.hash || '#/';
  closeDrawer();
  if (!state.user && !PUBLIC.test(hash)) {
    // One session check per page load: a returning user goes straight to the workspace (no login screen).
    try { const me = await api('/api/auth/me'); state.user = me.user; setCsrf(me.csrf_token); await bootstrap(); } catch { hideSplash(); return go('#/login'); }
  }
  if (notApproved() && !PUBLIC.test(hash)) { hideSplash(); return accountStatusView(); }
  for (const [re, fn] of routes) {
    const m = re.exec(hash);
    if (m) { try { await fn(m); } finally { hideSplash(); } return; }
  }
  go('#/');
}

// ---------------- account approval status (server-enforced; this screen only explains it) ----------------
function accountStatusView() {
  shellEl = null;
  const st = state.user.approval_status;
  const title = { pending: 'Waiting for approval', suspended: 'Account suspended', rejected: 'Application not approved', disabled: 'Account disabled' }[st] || 'Account unavailable';
  const msg = h('div');
  app.replaceChildren(h('div', { class: 'auth' }, h('div', { class: 'auth-card status-card' },
    h('img', { src: '/assets/logo-mark-192.png', alt: '', width: 64, height: 64 }),
    h('h1', {}, title), h('p', { class: 'muted' }, state.user.status_message || ''),
    h('p', { class: 'small muted' }, `Signed in as ${state.user.email}`),
    st === 'pending' ? h('button', { class: 'btn primary', onclick: async () => {
      try { const me = await api('/api/auth/me'); state.user = me.user; if (!notApproved()) { await bootstrap(); go('#/'); } else msg.replaceChildren(h('div', { class: 'alert warn small' }, 'Still waiting for approval.')); }
      catch (e) { msg.replaceChildren(h('div', { class: 'alert error small' }, e.message)); }
    } }, 'Check again') : null,
    h('button', { class: 'btn', onclick: async () => { try { await api('/api/auth/logout', { method: 'POST' }); } catch { /* ignore */ } signOutLocal(); go('#/login'); } }, 'Sign out'), msg)));
}

// ---------------- splash ----------------
const BOOT = performance.now();
let splashGone = false;
function hideSplash() {
  if (splashGone) return; splashGone = true;
  const el = document.getElementById('splash'); if (!el) return;
  // Long enough to read "by Approx Technology", never a blocking wait: at most ~600 ms after start.
  const wait = Math.max(0, 600 - (performance.now() - BOOT));
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 320); }, wait);
}

const notApproved = () => state.user && (state.user.approval_status || 'approved') !== 'approved';
async function bootstrap() {
  if (notApproved()) return;   // pending / blocked accounts: the server refuses workspace APIs; show the status screen
  const [m, s, u] = await Promise.all([api('/api/models'), api('/api/settings'), api('/api/usage')]);
  state.models = m.models; state.modes = m.modes; state.modeDetails = m.mode_details || []; state.defaultMode = m.default_mode || 'medium'; state.settings = s.settings; state.usage = u;
  state.mode = s.settings.default_mode;
  state.model = 'auto';
  applyTheme(s.settings.theme);
}
/** light (default) | dark | system (follows the device). */
export function applyTheme(t) {
  const dark = t === 'dark' || (t === 'system' && window.matchMedia?.('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
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
    if (kind === 'signup' && !name.value.trim()) { showMsg(msg, 'Enter your name.'); name.focus(); return; }
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
        await api('/api/auth/signup', { method: 'POST', body: { email: email.value.trim(), password: pwf.input.value, display_name: name.value.trim() } });
        return checkEmailView(email.value.trim());
      } else {
        const r = await api('/api/auth/forgot-password', { method: 'POST', body: { email: email.value.trim() } });
        showMsg(msg, r.message, 'ok');
      }
    } catch (err) {
      if (err.code === 'account_migration_required') showMsg(msg, err.message, 'ok');
      else if (err.code === 'email_not_verified') {
        showMsg(msg, err.message);
        msg.append(' ', h('button', { class: 'btn small', type: 'button', onclick: async (ev) => {
          ev.target.disabled = true;
          const r = await api('/api/auth/resend-verification', { method: 'POST', body: { email: email.value.trim() } }).catch((e2) => ({ message: e2.message }));
          showMsg(msg, r.message, 'ok');
        } }, 'Resend link'));
      } else showMsg(msg, err.message);
    } finally { btn.disabled = false; btn.classList.remove('loading'); btn.removeAttribute('aria-busy'); btn.textContent = label; }
  } },
  kind === 'signup' ? h('div', { class: 'field' }, h('label', { for: 'name' }, 'Name'), name) : null,
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
  authFrame(kind === 'login' ? 'Welcome to Approx AI' : kind === 'signup' ? 'Create your Approx account' : 'Reset password',
    kind === 'login' ? 'Sign in to continue' : kind === 'signup' ? null : 'We’ll email you a link to choose a new password.', chooser, google, form, links);
}

/** After sign-up: one clear next step — open the email Supabase sent — with a resend button. No questionnaire. */
function checkEmailView(address) {
  const msg = formMsg();
  const resend = h('button', { class: 'btn block', type: 'button', onclick: async () => {
    resend.disabled = true; resend.classList.add('loading');
    try { const r = await api('/api/auth/resend-verification', { method: 'POST', body: { email: address } }); showMsg(msg, r.message, 'ok'); }
    catch (e) { showMsg(msg, e.message); } finally { resend.disabled = false; resend.classList.remove('loading'); }
  } }, 'Resend verification email');
  authFrame('Check your email', null,
    h('p', { class: 'center' }, 'We sent a verification link to ', h('b', {}, address), '. Open it to activate your account — you’ll go straight into Approx.'),
    h('p', { class: 'center small muted' }, 'Can’t find it? Check spam or promotions.'), msg, resend,
    h('div', { class: 'auth-links' }, h('a', { href: '#/login' }, 'Back to sign in'), h('a', { href: '#/verify' }, 'Have a code?')));
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
  const cb = takeCallback(); // set when the person arrived from a Supabase email link
  const msg = formMsg();
  const tok = h('input', { class: 'input', value: params.get('token') || '', id: 'token', autocomplete: 'one-time-code' });
  const pw = h('input', { class: 'input', type: 'password', autocomplete: 'new-password', id: 'newpw' });
  const resendEmail = h('input', { class: 'input', type: 'email', placeholder: 'you@example.com' });
  const btn = h('button', { class: 'btn primary block', type: 'submit' }, kind === 'reset' ? 'Set new password' : 'Confirm');
  const linkProof = cb && !cb.error && (cb.access_token || cb.token_hash) ? callbackBody(cb) : null;
  const form = h('form', { onsubmit: async (e) => {
    e.preventDefault();
    if (btn.disabled) return;
    const label = btn.textContent;
    btn.disabled = true; btn.classList.add('loading'); btn.setAttribute('aria-busy', 'true'); btn.textContent = 'Please wait…';
    try {
      const proof = linkProof || { token: tok.value.trim() };
      if (kind === 'verify') {
        const r = await api('/api/auth/verify-email', { method: 'POST', body: { ...proof, sign_in: !!linkProof } });
        if (r.user) { state.user = r.user; setCsrf(r.csrf_token); rememberAccount(r.user); await bootstrap(); }
        if (state.user) state.user.email_verified = true;
        return done('Email verified', 'Your email address is confirmed. You can now use Approx AI.');
      } else if (kind === 'reset') {
        if (pw.value.length < 10 || !/[a-z]/i.test(pw.value) || !/\d/.test(pw.value)) { showMsg(msg, 'Use at least 10 characters with letters and numbers.'); return; }
        await api('/api/auth/reset-password', { method: 'POST', body: { ...proof, password: pw.value } });
        state.user = null;
        return done('Password updated', 'Your password has been changed. Sign in with your new password.');
      } else {
        const r = await api('/api/auth/confirm-email-change', { method: 'POST', body: proof });
        if (r.status === 'confirmation_pending') return done('Almost done', r.message);
        state.user = null;
        return done('Email changed', 'Your new email address is confirmed. Please sign in again.');
      }
    } catch (err) { showMsg(msg, err.message); } finally { btn.disabled = false; btn.classList.remove('loading'); btn.removeAttribute('aria-busy'); btn.textContent = label; }
  } },
  linkProof ? null : h('div', { class: 'field' }, h('label', { for: 'token' }, 'Code from your email'), tok),
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
  if (cb?.error) {
    showMsg(msg, cb.error === 'otp_expired' || /expired|invalid/i.test(cb.error_description)
      ? 'This email link is invalid or has expired. Request a new one below (or reset your password again).'
      : `This email link could not be used: ${cb.error_description || cb.error}.`);
    if (extra) extra.open = true;
  }
  // Opened from the email link: submit once automatically. Reset still needs the new password.
  if ((linkProof || params.get('token')) && kind !== 'reset') form.requestSubmit();
}

// ---------------- shell: top bar + main + composer + three-button nav ----------------
// ---------------- persistent app shell: drawer + header + main + composer + bottom nav ----------------
// Built once per sign-in and kept: navigating only swaps the main area (no full re-render, no reload).
let mainEl; let composerEl; let shellEl; let titleEl; let moreBtn; let drawerEl; let recentEl;
const NAV = [['#/', 'chat', 'Chat'], ['#/history', 'history', 'History'], ['#/work', 'work', 'Work'], ['#/settings', 'settings', 'Settings']];
const fabWorkspace = () => state.models.some((m) => m.workspace === 'fab500x-code' && m.available);
const DRAWER_LINKS = [['#/projects', 'folder', 'Projects'], ['#/code', 'code', 'Approx Code'], ['#/workspace', 'layers', 'Artifacts'], ['#/schedule', 'calendar', 'Schedule'], ['#/work', 'work', 'Approx Work']];

function buildShell() {
  const initials = (state.user.display_name || state.user.email).trim()[0].toUpperCase();
  titleEl = h('div', { class: 'head-title', id: 'chat-title' }, 'New chat');
  moreBtn = h('button', { class: 'icon-btn', 'aria-label': 'Session options', title: 'Session options', onclick: openChatMenu }, icon('more'));
  const top = h('header', { class: 'topbar' },
    h('button', { class: 'icon-btn drawer-toggle', 'aria-label': 'Open menu', 'aria-controls': 'drawer', onclick: openDrawer }, icon('menu')),
    h('a', { class: 'brand', href: '#/', 'aria-label': 'Approx AI home' }, h('img', { src: '/assets/logo-mark-64.png', alt: '' }),
      h('span', { class: 'brand-stack' }, h('span', { class: 'brand-name' }, 'Approx ', h('span', { class: 'ai' }, 'AI')), titleEl)),
    h('div', { class: 'spacer' }),
    h('button', { class: 'icon-btn', 'aria-label': 'New chat', title: 'New chat (Ctrl+K)', onclick: newChat }, icon('edit')),
    moreBtn);
  recentEl = h('div', { class: 'drawer-recent', id: 'drawer-recent' });
  drawerEl = h('aside', { class: 'drawer', id: 'drawer', 'aria-label': 'Approx navigation' },
    h('div', { class: 'drawer-head' }, h('img', { src: '/assets/logo-mark-64.png', alt: '' }), h('b', { class: 'grow' }, 'Approx'),
      h('button', { class: 'icon-btn drawer-close', 'aria-label': 'Close menu', onclick: closeDrawer }, icon('close'))),
    h('button', { class: 'btn primary block drawer-new', onclick: () => { closeDrawer(); newChat(); } }, icon('plus'), 'New chat'),
    h('nav', { class: 'drawer-nav' }, DRAWER_LINKS.map(([href, ic, label]) => h('a', { href, 'data-route': href }, icon(ic), h('span', {}, label))),
      // FAB 500X Code appears only for accounts holding the (server-checked) private grant.
      fabWorkspace() ? h('a', { href: '#/fab500x', 'data-route': '#/fab500x', class: 'drawer-fab' }, icon('shield'), h('span', {}, 'FAB 500X Code')) : null),
    h('div', { class: 'drawer-label' }, 'Recent'), recentEl,
    h('a', { class: 'drawer-more', href: '#/history' }, 'All history', icon('chevron')),
    h('a', { class: 'drawer-user', href: '#/settings/profile' }, h('span', { class: 'avatar' }, initials),
      h('span', { class: 'grow' }, h('b', {}, state.user.display_name || state.user.email.split('@')[0]), h('span', { class: 'small muted' }, `${state.user.plan} plan`))));
  const scrim = h('div', { class: 'drawer-scrim', onclick: closeDrawer });
  mainEl = h('main', { class: 'main', id: 'main' });
  composerEl = h('div', { class: 'composer-wrap' });
  const nav = h('nav', { class: 'bottom-nav', 'aria-label': 'Primary' },
    NAV.map(([href, ic, label]) => h('a', { href, 'data-route': href, 'aria-label': label }, icon(ic), h('span', {}, label))));
  shellEl = h('div', { class: 'shell' }, drawerEl, scrim, h('div', { class: 'workspace' }, top, mainEl, composerEl, nav));
  app.replaceChildren(shellEl);
  refreshRecent();
}

function shell(renderMain, { composer = true } = {}) {
  if (!shellEl || !app.contains(shellEl)) buildShell();
  composerEl.classList.toggle('hidden', !composer);
  const route = location.hash.startsWith('#/c/') || !location.hash || location.hash === '#/' ? '#/' : location.hash;
  for (const a of shellEl.querySelectorAll('[data-route]')) {
    const r = a.getAttribute('data-route');
    a.classList.toggle('active', r === '#/' ? route === '#/' : route.startsWith(r));
  }
  setHeaderTitle(composer ? (state.chat?.title || 'New chat') : pageTitle(route));
  mainEl.scrollTop = 0;
  return renderMain();
}
function pageTitle(route) {
  return { '#/history': 'History', '#/work': 'Approx Work', '#/schedule': 'Schedule', '#/projects': 'Projects', '#/code': 'Approx Code',
    '#/workspace': 'Artifacts', '#/research': 'Research' }[route] || (route.startsWith('#/settings') ? 'Settings' : '');
}
export function setHeaderTitle(t) { if (titleEl) titleEl.textContent = t; if (moreBtn) moreBtn.classList.toggle('hidden', !state.chat?.id || !location.hash.startsWith('#/c/')); }

export function openDrawer() { shellEl?.classList.add('drawer-open'); refreshRecent(); drawerEl?.querySelector('a, button')?.focus({ preventScroll: true }); }
export function closeDrawer() { shellEl?.classList.remove('drawer-open'); }

/** Recent sessions in the drawer: real chats from the backend, cached (instant) and refreshed in the background. */
export function refreshRecent(force = false) {
  if (!recentEl) return;
  if (force) invalidate('/api/chats?view=active&limit=15');
  const draw = (r) => recentEl.replaceChildren(...(r.chats.length ? r.chats.map((c) => h('a', { href: `#/c/${c.id}`, class: `recent-item${state.chat?.id === c.id ? ' active' : ''}`, title: c.title }, c.title))
    : [h('div', { class: 'small muted pad' }, 'No conversations yet.')]));
  if (!recentEl.childElementCount) recentEl.replaceChildren(...[1, 2, 3, 4].map(() => h('div', { class: 'skeleton line' })));
  cached('/api/chats?view=active&limit=15', 15_000, draw).then(draw).catch(() => recentEl.replaceChildren(h('div', { class: 'small muted pad' }, 'Could not load recent chats.')));
}
export function setMain(...nodes) { mainEl.replaceChildren(...nodes); }
export function hideComposer() { composerEl.classList.add('hidden'); }

export function modeLabel(mode = state.mode) {
  const d = state.modeDetails.find((x) => x.id === mode);
  return d ? d.label : (mode ? mode[0].toUpperCase() + mode.slice(1) : 'Medium');
}
export function modelLabel() {
  const m = state.models.find((x) => x.id === state.model);
  return m ? m.name : 'Auto';
}
function updateIndicator() {
  const el = document.getElementById('model-indicator'); if (el) el.textContent = modelLabel();
  const c = document.getElementById('model-chip'); if (c) c.replaceChildren(h('span', { class: 'dot' }), h('b', {}, modelLabel()), h('span', { class: 'mode-tag' }, modeLabel()), icon('chevron'));
  // Keep every mode toggle on screen (composer + model sheet) showing the same selected mode.
  for (const b of document.querySelectorAll('.mode-toggle button[data-mode]')) b.setAttribute('aria-pressed', String(b.dataset.mode === state.mode));
}

export function openModelPicker() {
  sheet('Model', (s, close) => {
    const opt = (id, name, desc, usable, badge) => h('button', { class: 'option', role: 'radio', 'aria-checked': String(state.model === id), disabled: !usable,
      onclick: () => { state.model = id; updateIndicator(); close(); } },
    h('div', { class: 'grow' }, h('div', { class: 'row' }, h('span', { class: 'name' }, name), badge), h('div', { class: 'small muted' }, desc)));
    s.append(opt('auto', 'Auto', 'Approx routes each message to the best model you have access to.', true, h('span', { class: 'badge green' }, 'Recommended')));
    // Only models this account is allowed to use are listed; a permitted model that is not being served right now is
    // shown as unavailable rather than hidden or faked.
    for (const m of state.models.filter((x) => x.available)) {
      const sub = [m.active_version ? `v${m.active_version}` : (m.lifecycle && m.lifecycle.state !== 'ACTIVE' ? m.lifecycle.label : null)].filter(Boolean).join(' · ');
      // Only models the server reports "online" are selectable (status comes from live serving evidence, never the catalog).
      const usable = m.selectable !== undefined ? m.selectable : (m.backend !== 'unavailable' && m.backend !== 'no_active_version');
      s.append(opt(m.id, m.name, m.description + (sub ? `  (${sub})` : '') + (!usable && m.status_reason ? ` — ${m.status_reason}` : ''), usable, modelBadge(m)));
    }
    const locked = state.models.filter((x) => !x.available).length;
    if (locked) s.append(h('p', { class: 'small muted' }, `${locked} more model${locked > 1 ? 's' : ''} need a different plan or access grant — see Settings → Capabilities.`));
    s.append(h('h3', {}, 'Response mode'), h('p', { class: 'small muted' }, 'How much effort the model spends on each reply. Separate from the model.'), modeToggle(close));
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
const STATUS_LABEL = { configured: 'Not trained', training: 'Training', trained: 'Trained', packaged: 'Packaged', deploying: 'Deploying', offline: 'Offline', failed: 'Failed' };
function modelBadge(m) {
  if (!m.available) return h('span', { class: 'badge' }, m.tier === 'restricted' ? 'Restricted' : 'Premium');
  if (m.private) { /* FAB 500X: only visible because this account holds a grant */ }
  if (m.status && m.status !== 'online') return h('span', { class: `badge ${m.status === 'failed' ? 'error' : 'warn'}` }, STATUS_LABEL[m.status] || m.status);
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
  setHeaderTitle(state.chat?.title || 'New chat');
  for (const a of document.querySelectorAll('.recent-item')) a.classList.toggle('active', a.getAttribute('href') === `#/c/${state.chat?.id}`);
  renderMessages();
  renderComposer();
}

// ---- conversation menu (⋯): rename, share, export, archive, delete ----
function conversationMarkdown() {
  return [`# ${state.chat?.title || 'Conversation'}`, ''].concat(state.messages.filter((m) => m.role !== 'system')
    .flatMap((m) => [`## ${m.role === 'user' ? 'You' : 'Approx AI'}`, '', m.content, ''])).join('\n');
}
function openChatMenu() {
  const c = state.chat; if (!c?.id) return;
  sheet('Session', (s, close) => {
    const item = (ic, label, fn, danger) => h('button', { class: `list-item${danger ? ' danger' : ''}`, onclick: async () => { close(); try { await fn(); } catch (e) { toast(e.message); } } }, icon(ic), h('span', { class: 'grow' }, label));
    s.append(h('div', { class: 'list' },
      item('branch', 'Copy branch', async () => {
        const r = await api(`/api/chats/${c.id}/branch`, { method: 'POST', body: {} });
        refreshRecent(true); toast(`Branch created (${r.copied_messages} messages)`); go(`#/c/${r.chat.id}`);
      }),
      item('tasks', 'Background tasks', () => pages.openTasksSheet()),
      item('share', 'Share', async () => {
        const text = conversationMarkdown();
        if (navigator.share) { try { await navigator.share({ title: c.title || 'Approx AI conversation', text }); return; } catch (e) { if (e.name === 'AbortError') return; } }
        await navigator.clipboard.writeText(text); toast('Conversation copied — paste it anywhere to share');
      }),
      item('edit', 'Rename', async () => {
        const t = await promptDialog('Rename session', 'Title', c.title); if (!t) return;
        await api(`/api/chats/${c.id}`, { method: 'PATCH', body: { title: t } }); c.title = t; setHeaderTitle(t); refreshRecent(true); toast('Renamed');
      }),
      item('archive', 'Archive', async () => { await api(`/api/chats/${c.id}`, { method: 'PATCH', body: { archived: true } }); refreshRecent(true); toast('Archived'); newChat(); }),
      item('flag', 'Send feedback', () => pages.openFeedbackSheet({ chatId: c.id })),
      item('download', 'Export as Markdown', async () => {
        const r = await fetch(`/api/chats/${c.id}/export?format=md`, { credentials: 'same-origin' });
        if (!r.ok) throw new Error('Export failed. Please try again.');
        const blob = await r.blob(); const a = h('a', { href: URL.createObjectURL(blob), download: `${(c.title || 'conversation').replace(/[^\p{L}\p{N} _-]+/gu, '').trim() || 'conversation'}.md` });
        document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 2000); toast('Exported');
      }),
      item('trash', 'Delete', async () => {
        if (!(await confirmDialog('Delete session?', 'It moves to Trash in History, where you can restore it.', 'Delete', true))) return;
        await api(`/api/chats/${c.id}`, { method: 'DELETE' }); refreshRecent(true); toast('Moved to trash'); newChat();
      }, true)));
  });
}

function renderMessages() {
  const list = h('div', { class: 'messages', id: 'messages' });
  if (!state.messages.length) {
    // Minimal welcome: a greeting and the composer. No questionnaire, no task categories — the person just types.
    const n = firstName({ displayName: state.user.display_name, email: state.user.email });
    list.append(h('div', { class: 'welcome' }, h('img', { src: '/assets/logo-mark-192.png', alt: '' }),
      h('h1', {}, n ? `Peace be upon you, ${n}` : 'Peace be upon you'),
      h('p', { class: 'lead' }, 'How can I help you today?'),
      !state.user.email_verified ? h('div', { class: 'alert warn' }, 'Verify your email to start chatting. ', h('a', { href: '#/verify' }, 'Enter code')) : null));
  }
  for (const m of state.messages) list.append(messageEl(m));
  setMain(list);
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
  const ta = h('textarea', { id: 'prompt', rows: '1', placeholder: 'Write your message…', 'aria-label': 'Message', dir: 'auto', maxlength: '100000', enterkeyhint: 'send' });
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
    h('div', { class: 'bar' }, plus, modelChip, h('div', { class: 'spacer' }), mic, send)),
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
      setHeaderTitle(r.chat.title);
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
        state.chat.title = d.title; setHeaderTitle(d.title); refreshRecent(true);
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
  sheet('Add', (s, close) => {
    const item = (ic, label, sub, fn) => h('button', { class: 'list-item', onclick: () => { close(); fn(); } }, h('span', { class: 'li-icon' }, icon(ic)),
      h('span', { class: 'grow' }, h('span', { class: 'title' }, label), sub ? h('span', { class: 'sub' }, sub) : null), icon('chevron'));
    const perm = state.settings?.permissions_mode === 'automatic' ? 'Automatic' : 'Manual';
    s.append(h('div', { class: 'list' },
      item('image', 'Photo', 'Choose images from your gallery', () => pickFiles('image/*', renderChips)),
      item('file', 'Files', 'Documents, code, data, PDFs', () => pickFiles(ACCEPT.file, renderChips)),
      item('camera', 'Camera', 'Take a photo', () => pickFiles('image/*', renderChips, { capture: 'environment' })),
      item('layers', 'Add to session', 'Attach files you uploaded before', () => addFromLibrary(renderChips)),
      item('folder', 'Add to project', state.projectId ? 'This session is in a project' : 'Keep this session in a project', () => addToProject()),
      item('shield', 'Permissions', `${perm} — how Approx applies changes`, () => openPermissions())));
    void ta;
  });
}
/** Re-use files already in the person's library (no re-upload). */
async function addFromLibrary(renderChips) {
  sheet('Add to session', async (s, close) => {
    const list = h('div', { class: 'list' }, h('div', { class: 'skeleton line' }), h('div', { class: 'skeleton line' }));
    s.append(list);
    try {
      const r = await api('/api/files');
      const files = (r.files || []).filter((f) => !state.attachments.some((a) => a.id === f.id));
      list.replaceChildren(...(files.length ? files.slice(0, 50).map((f) => h('button', { class: 'list-item', onclick: () => { state.attachments.push(f); renderChips(); close(); toast(`${f.filename} added`); } },
        icon(f.kind === 'image' ? 'image' : 'file'), h('span', { class: 'grow' }, h('span', { class: 'title' }, f.filename), h('span', { class: 'sub' }, `${fmtBytes(f.size)} · ${fmtTime(f.created_at)}`))))
        : [h('p', { class: 'muted' }, 'No uploaded files yet. Use Photo, Files or Camera to add one.')]));
    } catch (e) { list.replaceChildren(h('div', { class: 'alert error' }, e.message)); }
  });
}
/** Put this session (or the next new one) into a project; create a project inline if needed. */
async function addToProject() {
  sheet('Add to project', async (s, close) => {
    const list = h('div', { class: 'list' }, h('div', { class: 'skeleton line' }));
    const name = h('input', { class: 'input', placeholder: 'New project name', maxlength: '80', 'aria-label': 'New project name' });
    const apply = async (pid, pname) => {
      if (state.chat?.id) { await api(`/api/chats/${state.chat.id}`, { method: 'PATCH', body: { project_id: pid } }); state.chat.project_id = pid; }
      state.projectId = pid; invalidate('/api/projects'); close(); toast(`Added to ${pname}`);
    };
    s.append(list, h('div', { class: 'row' }, name, h('button', { class: 'btn', onclick: async () => {
      if (!name.value.trim()) return name.focus();
      try { const r = await api('/api/projects', { method: 'POST', body: { name: name.value.trim() } }); await apply(r.project.id, r.project.name); } catch (e) { toast(e.message); }
    } }, 'Create')));
    try {
      const r = await api('/api/projects');
      list.replaceChildren(...(r.projects.length ? r.projects.map((p) => h('button', { class: 'list-item', 'aria-checked': String(state.projectId === p.id), onclick: () => apply(p.id, p.name).catch((e) => toast(e.message)) },
        icon('folder'), h('span', { class: 'grow' }, h('span', { class: 'title' }, p.name), h('span', { class: 'sub' }, p.kind)), state.projectId === p.id ? icon('check') : null))
        : [h('p', { class: 'muted small' }, 'No projects yet — create one below.')]));
      if (state.projectId) list.append(h('button', { class: 'list-item', onclick: () => apply(null, 'no project').catch((e) => toast(e.message)) }, icon('close'), h('span', { class: 'grow' }, 'Remove from project')));
    } catch (e) { list.replaceChildren(h('div', { class: 'alert error' }, e.message)); }
  });
}
/** Manual: Approx Code agent changes wait for your review. Automatic: they are applied as soon as they are proposed. */
export function openPermissions() {
  sheet('Permissions', (s, close) => {
    const cur = state.settings?.permissions_mode || 'manual';
    const opt = (v, title, desc) => h('button', { class: 'option', role: 'radio', 'aria-checked': String(cur === v), onclick: async () => {
      try { await api('/api/settings', { method: 'PATCH', body: { permissions_mode: v } }); state.settings.permissions_mode = v; invalidate('/api/settings'); toast(`Permissions: ${title}`); close(); }
      catch (e) { toast(e.message); }
    } }, h('div', { class: 'grow' }, h('div', { class: 'name' }, title), h('div', { class: 'small muted' }, desc)));
    s.append(opt('manual', 'Manual', 'Approx asks before applying changes: Approx Code proposals wait for your review.'),
      opt('automatic', 'Automatic', 'Approx applies Approx Code changes as soon as they are proposed. You can still review the history.'));
  });
}

// Desktop shortcuts: Ctrl/⌘+K new chat · "/" focuses the composer · Esc closes the drawer.
document.addEventListener('keydown', (e) => {
  if (!state.user) return;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); newChat(); setTimeout(() => document.getElementById('prompt')?.focus(), 50); }
  else if (e.key === '/' && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName) && !document.querySelector('.scrim')) { const ta = document.getElementById('prompt'); if (ta) { e.preventDefault(); ta.focus(); } }
  else if (e.key === 'Escape') closeDrawer();
});
// Keyboard-aware layout: keep the composer above the on-screen keyboard where the browser doesn't resize the page.
if (window.visualViewport) {
  const fit = () => document.documentElement.style.setProperty('--vvh', `${window.visualViewport.height}px`);
  window.visualViewport.addEventListener('resize', fit); fit();
}
export function signOutLocal() { state.user = null; state.chat = null; state.messages = []; setCsrf(''); clearCache(); shellEl = null; }

export { api, toast, render };
render();
