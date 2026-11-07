import { api, stream, upload, setCsrf, ApiError } from './api.js';
import { h, icon, toast, sheet, fmtTime, fmtBytes } from './ui.js';
import { markdown } from './md.js';
import * as views from './views.js';

export const state = {
  user: null, models: [], modes: ['medium', 'high'], usage: null, settings: null,
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
const PUBLIC = /^#\/(login|signup|forgot|verify|reset|confirm-email)/;

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
  state.models = m.models; state.modes = m.modes; state.settings = s.settings; state.usage = u;
  state.mode = s.settings.default_mode;
  state.model = 'auto';
  document.documentElement.dataset.theme = s.settings.theme === 'light' ? 'light' : 'dark';
}
export async function refreshUsage() { try { state.usage = await api('/api/usage'); } catch { /* ignore */ } }

// ---------------- auth views ----------------
function authFrame(title, subtitle, ...content) {
  app.replaceChildren(h('div', { class: 'auth' }, h('div', { class: 'auth-card' },
    h('div', { class: 'logo' }, h('img', { src: '/assets/logo-192.png', alt: 'Approx AI logo' }), h('h1', {}, title), subtitle ? h('div', { class: 'muted' }, subtitle) : null),
    ...content,
    h('p', { class: 'muted small', }, '© Approx Technology'))));
}
function formMsg() { return h('div', { class: 'hidden', role: 'alert' }); }
function showMsg(el, text, kind = 'error') { el.className = `alert ${kind}`; el.textContent = text; }

function authView(kind) {
  const msg = formMsg();
  const email = h('input', { class: 'input', type: 'email', autocomplete: 'email', required: true, id: 'email', placeholder: 'you@example.com' });
  const pw = h('input', { class: 'input', type: 'password', autocomplete: kind === 'signup' ? 'new-password' : 'current-password', required: true, id: 'password', minlength: '10' });
  const name = h('input', { class: 'input', autocomplete: 'name', id: 'name', maxlength: '80' });
  const btn = h('button', { class: 'btn primary block', type: 'submit' }, kind === 'login' ? 'Sign in' : kind === 'signup' ? 'Create account' : 'Send reset link');
  const form = h('form', { onsubmit: async (e) => {
    e.preventDefault(); btn.disabled = true;
    try {
      if (kind === 'login') {
        const r = await api('/api/auth/login', { method: 'POST', body: { email: email.value, password: pw.value } });
        state.user = r.user; setCsrf(r.csrf_token); await bootstrap(); go('#/');
      } else if (kind === 'signup') {
        const r = await api('/api/auth/signup', { method: 'POST', body: { email: email.value, password: pw.value, display_name: name.value } });
        showMsg(msg, `${r.message} Check your inbox, then sign in.`, 'ok'); form.reset();
      } else {
        const r = await api('/api/auth/forgot-password', { method: 'POST', body: { email: email.value } });
        showMsg(msg, r.message, 'ok');
      }
    } catch (err) { showMsg(msg, err.message); } finally { btn.disabled = false; }
  } },
  kind === 'signup' ? h('div', { class: 'field' }, h('label', { for: 'name' }, 'Name (optional)'), name) : null,
  h('div', { class: 'field' }, h('label', { for: 'email' }, 'Email'), email),
  kind !== 'forgot' ? h('div', { class: 'field' }, h('label', { for: 'password' }, 'Password'), pw, kind === 'signup' ? h('span', { class: 'small muted' }, 'At least 10 characters with letters and numbers.') : null) : null,
  msg, btn);
  const links = h('div', { class: 'auth-links' },
    kind === 'login' ? h('a', { href: '#/signup' }, 'Create account') : h('a', { href: '#/login' }, 'Sign in'),
    kind !== 'forgot' ? h('a', { href: '#/forgot' }, 'Forgot password?') : null);
  if (kind === 'login') {
    links.append(h('a', { href: '#/verify' }, 'Have a code?'));
  }
  authFrame(kind === 'login' ? 'Welcome back' : kind === 'signup' ? 'Create your Approx AI account' : 'Reset password',
    kind === 'login' ? 'Sign in to Approx AI' : null, form, links);
}

function tokenView(kind) {
  const params = new URLSearchParams(location.hash.split('?')[1] || '');
  const msg = formMsg();
  const tok = h('input', { class: 'input', value: params.get('token') || '', id: 'token', autocomplete: 'one-time-code' });
  const pw = h('input', { class: 'input', type: 'password', autocomplete: 'new-password', id: 'newpw' });
  const resendEmail = h('input', { class: 'input', type: 'email', placeholder: 'you@example.com' });
  const btn = h('button', { class: 'btn primary block', type: 'submit' }, kind === 'reset' ? 'Set new password' : 'Confirm');
  const form = h('form', { onsubmit: async (e) => {
    e.preventDefault(); btn.disabled = true;
    try {
      if (kind === 'verify') { await api('/api/auth/verify-email', { method: 'POST', body: { token: tok.value.trim() } }); showMsg(msg, 'Email verified. You can sign in now.', 'ok'); if (state.user) state.user.email_verified = true; }
      else if (kind === 'reset') { const r = await api('/api/auth/reset-password', { method: 'POST', body: { token: tok.value.trim(), password: pw.value } }); showMsg(msg, r.message, 'ok'); }
      else { await api('/api/auth/confirm-email-change', { method: 'POST', body: { token: tok.value.trim() } }); showMsg(msg, 'Email changed. Please sign in again.', 'ok'); state.user = null; }
    } catch (err) { showMsg(msg, err.message); } finally { btn.disabled = false; }
  } },
  h('div', { class: 'field' }, h('label', { for: 'token' }, 'Code from your email'), tok),
  kind === 'reset' ? h('div', { class: 'field' }, h('label', { for: 'newpw' }, 'New password'), pw) : null, msg, btn);
  const extra = kind === 'verify' ? h('details', { class: 'small' }, h('summary', { class: 'muted' }, 'Resend verification email'),
    h('div', { class: 'row' }, resendEmail, h('button', { class: 'btn', type: 'button', onclick: async () => {
      const r = await api('/api/auth/resend-verification', { method: 'POST', body: { email: resendEmail.value } }).catch((e) => ({ message: e.message }));
      showMsg(msg, r.message, 'ok');
    } }, 'Send'))) : null;
  authFrame(kind === 'verify' ? 'Verify your email' : kind === 'reset' ? 'Choose a new password' : 'Confirm email change', null, form, extra,
    h('div', { class: 'auth-links' }, h('a', { href: state.user ? '#/' : '#/login' }, state.user ? 'Back to chat' : 'Sign in')));
}

// ---------------- shell: top bar + main + composer + three-button nav ----------------
let mainEl; let composerEl;
function shell(renderMain) {
  const initials = (state.user.display_name || state.user.email).trim()[0].toUpperCase();
  const top = h('header', { class: 'topbar' },
    h('a', { class: 'brand', href: '#/', 'aria-label': 'Approx AI home' }, h('img', { src: '/assets/logo-64.png', alt: '' }), h('span', {}, 'Approx ', h('span', { class: 'ai' }, 'AI'))),
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

export function modelLabel() {
  const m = state.models.find((x) => x.id === state.model);
  return `${m ? m.name : 'Auto'} · ${state.mode === 'high' ? 'High' : 'Medium'}`;
}
function updateIndicator() { const el = document.getElementById('model-indicator'); if (el) el.textContent = modelLabel(); const c = document.getElementById('model-chip'); if (c) c.replaceChildren(h('b', {}, (state.models.find((x) => x.id === state.model)?.name) || 'Auto'), icon('chevron')); }

export function openModelPicker() {
  sheet('Choose model', (s, close) => {
    s.append(h('p', { class: 'muted small' }, 'Models and modes are separate: the model decides who answers, the mode (Medium / High) decides how much effort it spends.'));
    const opt = (id, name, desc, available, badge) => h('button', { class: 'option', role: 'radio', 'aria-checked': String(state.model === id), disabled: !available,
      onclick: () => { state.model = id; updateIndicator(); close(); } },
    h('div', { class: 'grow' }, h('div', { class: 'row' }, h('span', { class: 'name' }, name), badge), h('div', { class: 'small muted' }, desc)));
    s.append(opt('auto', 'Master Router (Auto)', 'Picks the best model you have access to for each message.', true, h('span', { class: 'badge green' }, 'Recommended')));
    for (const m of state.models) {
      const badge = !m.available ? h('span', { class: 'badge' }, m.tier === 'restricted' ? 'Restricted' : 'Premium') : m.backend === 'unavailable' ? h('span', { class: 'badge warn' }, 'Backend offline') : m.backend === 'dev-simulator' ? h('span', { class: 'badge warn' }, 'Simulator') : null;
      s.append(opt(m.id, m.name, m.description, m.available, badge));
    }
    s.append(h('h3', {}, 'Mode'), modeToggle(close));
  });
}
function modeToggle(after) {
  const wrap = h('div', { class: 'mode-toggle', role: 'group', 'aria-label': 'Processing mode' });
  for (const m of state.modes) {
    wrap.append(h('button', { type: 'button', 'aria-pressed': String(state.mode === m), onclick: () => {
      state.mode = m; for (const b of wrap.children) b.setAttribute('aria-pressed', String(b.textContent.toLowerCase() === m)); updateIndicator(); after?.();
    } }, m === 'high' ? 'High' : 'Medium'));
  }
  return wrap;
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

function renderMessages() {
  const list = h('div', { class: 'messages', id: 'messages' });
  if (!state.messages.length) {
    const name = state.user.display_name ? `, ${state.user.display_name.split(' ')[0]}` : '';
    list.append(h('div', { class: 'welcome' }, h('img', { src: '/assets/logo-192.png', alt: '' }), h('h1', {}, `How can I help${name}?`),
      h('p', { class: 'muted' }, 'English · اردو · Roman Urdu — ask anything.'),
      !state.user.email_verified ? h('div', { class: 'alert warn' }, 'Verify your email to start chatting. ', h('a', { href: '#/verify' }, 'Enter code')) : null,
      h('div', { class: 'suggestions' }, SUGGESTIONS.map(([t, p]) => h('button', { class: 'suggestion', onclick: () => { const ta = document.getElementById('prompt'); ta.value = p; ta.dispatchEvent(new Event('input')); ta.focus(); } }, h('b', {}, t), h('div', { class: 'muted small' }, p))))));
  }
  for (const m of state.messages) list.append(messageEl(m));
  setMain(list);
  scrollDown();
}
function scrollDown() { requestAnimationFrame(() => { mainEl.scrollTop = mainEl.scrollHeight; }); }

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
    !isUser ? h('button', { 'aria-label': 'Save to Workspace', title: 'Save to Approx Workspace', onclick: () => saveToWorkspace(m) }, icon('save')) : null);
  const meta = h('div', { class: 'meta' }, actions,
    !isUser && m.model_id ? h('span', { class: 'tag', title: m.route_reason || '' }, `${state.models.find((x) => x.id === m.model_id)?.name || m.model_id} · ${m.mode === 'high' ? 'High' : 'Medium'}`) : null,
    m.created_at ? h('span', {}, fmtTime(m.created_at)) : null);
  return h('article', { class: `msg ${m.role} ${m.status === 'error' ? 'error' : ''}`, 'data-id': m.id || '' }, atts, bubble, meta);
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
  composerEl.replaceChildren(h('div', { class: 'composer' }, chips, ta,
    h('div', { class: 'bar' }, plus, modelChip, modeToggle(), h('div', { class: 'spacer' }), send)),
  h('div', { class: 'composer-note' }, usageNote()));
  updateIndicator();
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
  list.append(live); scrollDown();
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
