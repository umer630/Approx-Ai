import { api, upload, setCsrf } from './api.js';
import { h, icon, toast, sheet, confirmDialog, promptDialog, fmtTime, fmtBytes } from './ui.js';
import { markdown } from './md.js';
import { state, go, setMain, hideComposer, refreshUsage, newChat } from './app.js';

const modelName = (id) => state.models.find((m) => m.id === id)?.name || id;
const back = (hash, label) => h('a', { href: hash, class: 'row small', }, icon('back'), label);

// ================= HISTORY =================
export function openHistory() {
  sheet('History', (s, close) => {
    let view = 'active';
    const q = h('input', { class: 'input', type: 'search', placeholder: 'Search conversations', 'aria-label': 'Search conversations' });
    const list = h('div', { class: 'list' });
    const tabs = h('div', { class: 'tabs', role: 'tablist' });
    const load = async () => {
      list.replaceChildren(h('p', { class: 'muted' }, 'Loading…'));
      try {
        const r = await api(`/api/chats?view=${view}&q=${encodeURIComponent(q.value)}`);
        if (!r.chats.length) return list.replaceChildren(h('p', { class: 'muted' }, view === 'trash' ? 'Trash is empty.' : 'No conversations yet.'));
        const groups = {};
        const day = 86400000; const now = Date.now();
        for (const c of r.chats) {
          const age = now - c.updated_at;
          const g = age < day ? 'Today' : age < 7 * day ? 'Previous 7 days' : age < 30 * day ? 'Previous 30 days' : 'Older';
          (groups[g] ||= []).push(c);
        }
        list.replaceChildren(...Object.entries(groups).flatMap(([g, chats]) => [h('h3', {}, g), ...chats.map((c) => chatRow(c))]));
      } catch (e) { list.replaceChildren(h('div', { class: 'alert error' }, e.message)); }
    };
    const chatRow = (c) => h('div', { class: 'list-item' },
      h('button', { class: 'grow list-open', onclick: () => { if (view !== 'trash') { close(); go(`#/c/${c.id}`); } }, 'aria-label': `Open ${c.title}` },
        h('div', { class: 'title' }, c.title), h('div', { class: 'sub' }, `${modelName(c.model_id)} · ${c.mode === 'high' ? 'High' : 'Medium'} · ${fmtTime(c.updated_at)}${c.is_fab ? ' · FAB (never trained)' : ''}`)),
      view === 'trash'
        ? [h('button', { class: 'icon-btn', title: 'Restore', 'aria-label': 'Restore', onclick: async () => { await api(`/api/chats/${c.id}`, { method: 'PATCH', body: { restore: true } }); load(); } }, icon('restore')),
          h('button', { class: 'icon-btn', title: 'Delete forever', 'aria-label': 'Delete forever', onclick: async () => { if (await confirmDialog('Delete forever?', 'This permanently deletes the conversation.', 'Delete', true)) { await api(`/api/chats/${c.id}?purge=1`, { method: 'DELETE' }); load(); } } }, icon('trash'))]
        : [h('button', { class: 'icon-btn', title: 'Rename', 'aria-label': 'Rename', onclick: async () => { const t = await promptDialog('Rename chat', 'Title', c.title); if (t) { await api(`/api/chats/${c.id}`, { method: 'PATCH', body: { title: t } }); load(); } } }, icon('edit')),
          h('button', { class: 'icon-btn', title: view === 'archived' ? 'Unarchive' : 'Archive', 'aria-label': 'Archive', onclick: async () => { await api(`/api/chats/${c.id}`, { method: 'PATCH', body: { archived: view !== 'archived' } }); toast(view === 'archived' ? 'Unarchived' : 'Archived'); load(); } }, icon('archive')),
          h('button', { class: 'icon-btn', title: 'Move to trash', 'aria-label': 'Delete', onclick: async () => { await api(`/api/chats/${c.id}`, { method: 'DELETE' }); if (state.chat?.id === c.id) newChat(); toast('Moved to trash'); load(); } }, icon('trash'))]);
    for (const [k, label] of [['active', 'Recent'], ['archived', 'Archived'], ['trash', 'Trash']]) {
      tabs.append(h('button', { role: 'tab', 'aria-selected': String(k === view), onclick: (e) => { view = k; for (const b of tabs.children) b.setAttribute('aria-selected', String(b === e.currentTarget)); load(); } }, label));
    }
    let t; q.addEventListener('input', () => { clearTimeout(t); t = setTimeout(load, 250); });
    s.append(q, tabs, list);
    load();
  });
}

// ================= SETTINGS =================
const SECTIONS = [
  ['account', 'Account & profile'], ['security', 'Security & password'], ['email', 'Email'], ['notifications', 'Notifications'],
  ['privacy', 'Privacy & data controls'], ['memory', 'Memory'], ['personalization', 'Personalization'], ['models', 'Model preferences'],
  ['usage', 'Usage & quota'], ['subscription', 'Subscription'], ['api', 'API'], ['tools', 'Connected tools'], ['delete', 'Delete account'],
];
export function openSettings(section) {
  sheet('Settings', (s, close) => {
    const body = h('div');
    const nav = h('div', { class: 'list' }, SECTIONS.map(([k, label]) => h('button', { class: 'list-item', onclick: () => show(k) }, h('span', { class: 'grow' }, label), icon('chevron'))),
      state.user.role !== 'user' ? h('button', { class: 'list-item', onclick: () => { close(); go('#/admin'); } }, h('span', { class: 'grow' }, 'Admin console'), icon('shield')) : null,
      h('button', { class: 'list-item', onclick: async () => { await api('/api/auth/logout', { method: 'POST' }); state.user = null; setCsrf(''); close(); go('#/login'); } }, h('span', { class: 'grow' }, 'Log out')));
    const show = async (k) => {
      body.replaceChildren(h('button', { class: 'btn', onclick: () => body.replaceChildren(nav) }, icon('back'), 'All settings'), h('h3', {}, SECTIONS.find((x) => x[0] === k)[1]));
      try { await SETTINGS[k](body, close); } catch (e) { body.append(h('div', { class: 'alert error' }, e.message)); }
    };
    s.append(body);
    if (section) show(section); else body.replaceChildren(nav);
  });
}

async function saveSettings(patch) {
  const r = await api('/api/settings', { method: 'PATCH', body: patch });
  state.settings = { ...state.settings, ...patch };
  toast('Saved'); return r;
}
function toggle(label, desc, checked, onChange) {
  const inp = h('input', { type: 'checkbox', role: 'switch', checked, 'aria-label': label });
  inp.addEventListener('change', () => onChange(inp.checked).catch((e) => { toast(e.message); inp.checked = !inp.checked; }));
  return h('label', { class: 'switch' }, h('div', {}, h('div', {}, label), desc ? h('div', { class: 'small muted' }, desc) : null), inp);
}
function form(fields, submitLabel, onSubmit) {
  const msg = h('div', { class: 'hidden', role: 'alert' });
  const inputs = {};
  const f = h('form', { onsubmit: async (e) => {
    e.preventDefault();
    try { const r = await onSubmit(Object.fromEntries(Object.entries(inputs).map(([k, el]) => [k, el.value]))); msg.className = 'alert ok'; msg.textContent = r || 'Saved'; f.reset(); }
    catch (err) { msg.className = 'alert error'; msg.textContent = err.message; }
  } }, fields.map(([k, label, type = 'text', extra = {}]) => { inputs[k] = h(type === 'textarea' ? 'textarea' : 'input', { class: 'input', type, id: `f-${k}`, ...extra }); return h('div', { class: 'field' }, h('label', { for: `f-${k}` }, label), inputs[k]); }),
  msg, h('button', { class: 'btn primary', type: 'submit' }, submitLabel));
  return f;
}

const SETTINGS = {
  async account(b) {
    const r = await api('/api/settings');
    const name = h('input', { class: 'input', value: r.user.display_name, maxlength: '80', id: 'dn' });
    const lang = h('select', { class: 'input', id: 'lang' }, [['auto', 'Automatic'], ['en', 'English'], ['ur', 'اردو (Urdu)'], ['roman-ur', 'Roman Urdu']].map(([v, l]) => h('option', { value: v, selected: r.user.language === v }, l)));
    b.append(h('div', { class: 'card' }, h('div', {}, r.user.email), h('div', { class: 'small muted' }, `${r.user.email_verified ? 'Verified' : 'Not verified'} · Plan: ${r.user.plan} · Role: ${r.user.role} · Member since ${new Date(r.user.created_at).toLocaleDateString()}`),
      !r.user.email_verified ? h('a', { href: '#/verify' }, 'Verify email') : null),
    h('div', { class: 'field' }, h('label', { for: 'dn' }, 'Display name'), name), h('div', { class: 'field' }, h('label', { for: 'lang' }, 'Preferred language'), lang),
    h('div', { class: 'field' }, h('label', {}, 'Theme'), h('select', { class: 'input', onchange: (e) => { document.documentElement.dataset.theme = e.target.value === 'light' ? 'light' : 'dark'; saveSettings({ theme: e.target.value }); } },
      ['dark', 'light'].map((t) => h('option', { value: t, selected: state.settings.theme === t }, t[0].toUpperCase() + t.slice(1))))),
    h('button', { class: 'btn primary', onclick: async () => { await saveSettings({ display_name: name.value, language: lang.value }); state.user.display_name = name.value; } }, 'Save profile'));
  },
  async security(b) {
    b.append(form([['current_password', 'Current password', 'password', { autocomplete: 'current-password' }], ['new_password', 'New password', 'password', { autocomplete: 'new-password' }]], 'Change password',
      async (v) => { await api('/api/auth/change-password', { method: 'POST', body: v }); return 'Password changed. Other sessions were signed out.'; }));
    const r = await api('/api/auth/sessions');
    b.append(h('h3', {}, 'Active sessions'), h('div', { class: 'list' }, r.sessions.map((x) => h('div', { class: 'list-item' },
      h('div', { class: 'grow' }, h('div', { class: 'title' }, `${x.client === 'mobile' ? 'Android app' : 'Web'}${x.current ? ' (this device)' : ''}`), h('div', { class: 'sub' }, `${(x.user_agent || '').slice(0, 60)} · last active ${fmtTime(x.last_seen_at)}`)),
      !x.current ? h('button', { class: 'btn', onclick: async (e) => { await api(`/api/auth/sessions/${x.id}`, { method: 'DELETE' }); e.target.closest('.list-item').remove(); } }, 'Revoke') : null))),
    h('button', { class: 'btn', onclick: async () => { await api('/api/auth/sessions/revoke-others', { method: 'POST' }); toast('Signed out everywhere else'); } }, 'Sign out all other sessions'));
  },
  async email(b) {
    b.append(h('p', { class: 'muted small' }, `Current: ${state.user.email}. A confirmation link will be sent to the new address.`),
      form([['new_email', 'New email', 'email'], ['password', 'Current password', 'password', { autocomplete: 'current-password' }]], 'Change email',
        async (v) => { await api('/api/auth/change-email', { method: 'POST', body: v }); return 'Check the new inbox to confirm.'; }));
  },
  async notifications(b) {
    b.append(toggle('Security & account emails', 'Password changes, new access grants.', state.settings.notifications_email, (v) => saveSettings({ notifications_email: v })));
    const r = await api('/api/notifications');
    b.append(h('h3', {}, 'Inbox'), r.notifications.length ? h('div', { class: 'list' }, r.notifications.map((n) => h('div', { class: 'list-item' }, h('div', { class: 'grow' }, h('div', { class: 'title' }, n.title), h('div', { class: 'sub' }, `${n.body} · ${fmtTime(n.created_at)}`))))) : h('p', { class: 'muted' }, 'No notifications.'));
  },
  async privacy(b) {
    b.append(
      toggle('Help improve Nick, Hike & Sona', 'Allow conversations you mark as eligible to be used for model adaptation after PII removal, quality and safety filtering. FAB conversations are never used. Off by default.',
        state.settings.training_opt_in, async (v) => { await saveSettings({ training_opt_in: v }); }),
      h('p', { class: 'small muted' }, 'Withdrawing consent immediately removes all your conversations from future training exports.'),
      h('button', { class: 'btn', onclick: () => { location.href = '/api/account/export'; } }, 'Export my data (JSON)'));
  },
  async memory(b) {
    const r = await api('/api/memory');
    const list = h('div', { class: 'list' });
    const draw = (mems) => list.replaceChildren(...(mems.length ? mems.map((m) => h('div', { class: 'list-item' }, h('div', { class: 'grow' }, h('div', {}, m.content), h('div', { class: 'sub' }, `${m.source} · ${fmtTime(m.updated_at)}`)),
      h('button', { class: 'icon-btn', 'aria-label': 'Edit memory', onclick: async () => { const t = await promptDialog('Edit memory', 'Memory', m.content); if (t) { await api(`/api/memory/${m.id}`, { method: 'PATCH', body: { content: t } }); reload(); } } }, icon('edit')),
      h('button', { class: 'icon-btn', 'aria-label': 'Delete memory', onclick: async () => { await api(`/api/memory/${m.id}`, { method: 'DELETE' }); reload(); } }, icon('trash')))) : [h('p', { class: 'muted' }, 'No memories saved. Say “remember that …” in a chat, or add one below.')]));
    const reload = async () => draw((await api('/api/memory')).memories);
    const add = h('input', { class: 'input', placeholder: 'e.g. I prefer answers in Roman Urdu', maxlength: '500' });
    b.append(toggle('Memory enabled', 'Approx AI uses saved memories in Nick, Hike and Sona chats. Never shared with other users; never used by FAB.', r.enabled, (v) => saveSettings({ memory_enabled: v })),
      h('div', { class: 'row' }, add, h('button', { class: 'btn', onclick: async () => { if (!add.value.trim()) return; await api('/api/memory', { method: 'POST', body: { content: add.value } }); add.value = ''; reload(); } }, 'Add')),
      list, h('button', { class: 'btn danger', onclick: async () => { if (await confirmDialog('Clear all memory?', 'This deletes every saved memory.', 'Clear', true)) { await api('/api/memory', { method: 'DELETE' }); reload(); } } }, 'Clear all memory'));
    draw(r.memories);
  },
  async personalization(b) {
    const ta = h('textarea', { class: 'input', rows: '5', maxlength: '1500', placeholder: 'How should Approx AI respond? e.g. “Keep answers short. Use metric units. I am a medical student.”' });
    ta.value = state.settings.personalization || '';
    b.append(ta, h('button', { class: 'btn primary', onclick: () => saveSettings({ personalization: ta.value }) }, 'Save'));
  },
  async models(b) {
    const sel = h('select', { class: 'input' }, state.models.filter((m) => m.available).map((m) => h('option', { value: m.id, selected: state.settings.default_model === m.id }, m.name)));
    const mode = h('select', { class: 'input' }, [['medium', 'Medium'], ['high', 'High']].map(([v, l]) => h('option', { value: v, selected: state.settings.default_mode === v }, l)));
    b.append(h('div', { class: 'field' }, h('label', {}, 'Default model (used by the router as the baseline)'), sel), h('div', { class: 'field' }, h('label', {}, 'Default mode'), mode),
      h('button', { class: 'btn primary', onclick: () => saveSettings({ default_model: sel.value, default_mode: mode.value }) }, 'Save'),
      h('h3', {}, 'Your models'), h('div', { class: 'list' }, state.models.map((m) => h('div', { class: 'list-item' }, h('div', { class: 'grow' }, h('div', { class: 'title' }, m.name), h('div', { class: 'sub' }, m.description)), h('span', { class: `badge ${m.available ? 'green' : ''}` }, m.available ? 'Available' : 'Locked')))));
  },
  async usage(b) {
    await refreshUsage();
    const u = state.usage;
    const pct = Math.round((u.window.used / u.window.limit) * 100);
    b.append(h('div', { class: 'card' }, h('div', { class: 'row' }, h('b', { class: 'grow' }, 'Hourly requests'), `${u.window.used} / ${u.window.limit}`),
      h('div', { class: 'meter', role: 'progressbar', 'aria-valuenow': String(pct), 'aria-valuemin': '0', 'aria-valuemax': '100' }, meterFill(pct)),
      h('div', { class: 'small muted' }, u.window.resets_at ? `Next slot frees at ${new Date(u.window.resets_at).toLocaleTimeString()}` : 'Full quota available')),
    h('div', { class: 'card' }, h('div', { class: 'row' }, h('b', { class: 'grow' }, `Usage cycle (${u.cycle.days} days)`), `${u.cycle.used} requests${u.cycle.limit ? ` / ${u.cycle.limit}` : ''}`),
      h('div', { class: 'small muted' }, `Renews ${new Date(u.cycle.renews_at).toLocaleString()}`)),
    h('p', { class: 'small muted' }, 'Quota is enforced by the Approx server; this page only displays it.'));
  },
  async subscription(b) {
    b.append(h('div', { class: 'card' }, h('b', {}, `Current plan: ${state.user.plan}`), h('p', { class: 'small muted' }, 'Free: Nick 4.8 + Hike 6.5. Pro: adds Sona 9.0. FAB is granted individually by Approx Technology.')),
      h('div', { class: 'alert warn' }, 'Online payments are not enabled in Approx AI 1.0 (no payment provider is configured). Plan upgrades are applied by an administrator.'));
  },
  async api(b, close) {
    b.append(h('p', { class: 'muted' }, 'Create API keys, view requests and read the docs in the Approx AI developer console.'), h('a', { class: 'btn primary', href: '/developers/' }, 'Open developer console'));
    void close;
  },
  async tools(b) {
    b.append(h('div', { class: 'alert warn' }, 'No third-party connectors are available yet. Built-in tools: attachments, Research, Workspace, Fabbox Code, Coeprox, Projects.'));
  },
  async delete(b) {
    b.append(h('div', { class: 'alert error' }, 'Deleting your account permanently removes your chats, memory, projects, files, workspace artifacts and API keys. This cannot be undone.'),
      form([['password', 'Password', 'password', { autocomplete: 'current-password' }], ['confirm', 'Type DELETE to confirm']], 'Delete my account', async (v) => {
        await api('/api/account/delete', { method: 'POST', body: v }); state.user = null; setTimeout(() => { location.hash = '#/login'; location.reload(); }, 800); return 'Account deleted.';
      }));
  },
};
function meterFill(pct) { const i = h('i'); i.style.width = `${Math.min(100, pct)}%`; return i; }

// ================= PROJECTS =================
export async function projectsView() {
  hideComposer();
  const r = await api('/api/projects?kind=knowledge');
  setMain(h('div', { class: 'page' }, h('div', { class: 'row' }, h('h2', { class: 'grow' }, 'Projects'),
    h('button', { class: 'btn primary', onclick: async () => { const n = await promptDialog('New project', 'Project name'); if (n) { const p = await api('/api/projects', { method: 'POST', body: { name: n } }); go(`#/projects/${p.project.id}`); } } }, icon('plus'), 'New')),
  h('p', { class: 'muted' }, 'Projects keep instructions, knowledge files and chats together. Only you can access your projects.'),
  r.projects.length ? h('div', { class: 'list' }, r.projects.map((p) => h('a', { class: 'list-item', href: `#/projects/${p.id}` }, icon('folder'), h('div', { class: 'grow' }, h('div', { class: 'title' }, p.name), h('div', { class: 'sub' }, `${p.chat_count} chats · ${p.file_count} files · ${fmtTime(p.updated_at)}`))))) : h('p', { class: 'muted' }, 'No projects yet.')));
}

export async function projectView(id) {
  hideComposer();
  const r = await api(`/api/projects/${id}`);
  const p = r.project;
  const instr = h('textarea', { class: 'input', rows: '5', maxlength: '8000', placeholder: 'Instructions every chat in this project follows…' }); instr.value = p.instructions;
  const desc = h('input', { class: 'input', value: p.description, maxlength: '1000', placeholder: 'Description' });
  const fileInput = h('input', { type: 'file', class: 'hidden', multiple: true });
  fileInput.addEventListener('change', async () => { for (const f of fileInput.files) { try { await upload(f, p.id); } catch (e) { toast(`${f.name}: ${e.message}`); } } projectView(id); });
  setMain(h('div', { class: 'page' }, back('#/projects', 'Projects'),
    h('div', { class: 'row' }, h('h2', { class: 'grow' }, p.name), h('button', { class: 'btn danger', onclick: async () => { if (await confirmDialog('Delete project?', 'Deletes the project and its knowledge files. Chats are kept in history.', 'Delete', true)) { await api(`/api/projects/${id}`, { method: 'DELETE' }); go('#/projects'); } } }, icon('trash'))),
    h('div', { class: 'field' }, h('label', {}, 'Description'), desc),
    h('div', { class: 'field' }, h('label', {}, 'Instructions'), instr),
    h('button', { class: 'btn', onclick: async () => { await api(`/api/projects/${id}`, { method: 'PATCH', body: { instructions: instr.value, description: desc.value } }); toast('Saved'); } }, 'Save'),
    h('h3', {}, 'Knowledge files'), h('div', { class: 'list' }, r.files.map((f) => h('div', { class: 'list-item' }, icon('file'), h('div', { class: 'grow' }, h('div', { class: 'title' }, f.filename), h('div', { class: 'sub' }, `${fmtBytes(f.size)} · scan: ${f.scan_status}`)),
      h('button', { class: 'icon-btn', 'aria-label': 'Delete file', onclick: async () => { await api(`/api/files/${f.id}`, { method: 'DELETE' }); projectView(id); } }, icon('trash'))))),
    h('button', { class: 'btn', onclick: () => fileInput.click() }, icon('plus'), 'Add files'), fileInput,
    h('h3', {}, 'Chats'), h('div', { class: 'list' }, r.chats.map((c) => h('a', { class: 'list-item', href: `#/c/${c.id}` }, icon('chat'), h('div', { class: 'grow' }, h('div', { class: 'title' }, c.title), h('div', { class: 'sub' }, fmtTime(c.updated_at)))))),
    h('button', { class: 'btn primary', onclick: () => { state.chat = null; state.messages = []; state.projectId = id; location.hash = '#/'; } }, icon('chat'), 'New chat in project')));
  // keep projectId when the new chat route renders
}

// ================= WORKSPACE =================
export async function workspaceView() {
  hideComposer();
  const r = await api('/api/workspace/artifacts');
  setMain(h('div', { class: 'page' }, h('div', { class: 'row' }, h('h2', { class: 'grow' }, 'Approx Workspace'),
    h('button', { class: 'btn primary', onclick: async () => { const t = await promptDialog('New document', 'Title'); if (t) { const a = await api('/api/workspace/artifacts', { method: 'POST', body: { title: t, kind: 'document', content: `# ${t}\n` } }); go(`#/workspace/${a.artifact.id}`); } } }, icon('plus'), 'New')),
  h('p', { class: 'muted' }, 'Documents, code and tables generated in chat. Editable, versioned and exportable.'),
  r.artifacts.length ? h('div', { class: 'list' }, r.artifacts.map((a) => h('a', { class: 'list-item', href: `#/workspace/${a.id}` }, icon(a.kind === 'code' ? 'code' : a.kind === 'table' ? 'data' : 'doc'),
    h('div', { class: 'grow' }, h('div', { class: 'title' }, a.title), h('div', { class: 'sub' }, `${a.kind}${a.language ? ' · ' + a.language : ''} · v${a.current_version} · ${fmtTime(a.updated_at)}`))))) : h('p', { class: 'muted' }, 'Nothing here yet. Use the save icon on any answer to add it.')));
}

export async function artifactView(id) {
  hideComposer();
  const r = await api(`/api/workspace/artifacts/${id}`);
  const a = r.artifact;
  const editor = h('textarea', { class: 'input code', 'aria-label': 'Artifact content' }); editor.value = a.content;
  const preview = h('div', { class: 'card md hidden' });
  const tabs = h('div', { class: 'tabs' },
    h('button', { 'aria-selected': 'true', onclick: (e) => { editor.classList.remove('hidden'); preview.classList.add('hidden'); for (const b of tabs.children) b.setAttribute('aria-selected', String(b === e.currentTarget)); } }, 'Edit'),
    h('button', { 'aria-selected': 'false', onclick: (e) => { preview.innerHTML = a.kind === 'code' ? markdown('```' + a.language + '\n' + editor.value + '\n```') : markdown(editor.value); editor.classList.add('hidden'); preview.classList.remove('hidden'); for (const b of tabs.children) b.setAttribute('aria-selected', String(b === e.currentTarget)); } }, 'Preview'));
  setMain(h('div', { class: 'page' }, back('#/workspace', 'Workspace'),
    h('div', { class: 'row' }, h('h2', { class: 'grow' }, a.title), h('span', { class: 'badge' }, `v${a.current_version}`)),
    tabs, editor, preview,
    h('div', { class: 'row' },
      h('button', { class: 'btn primary', onclick: async () => { await api(`/api/workspace/artifacts/${id}`, { method: 'PUT', body: { content: editor.value } }); toast('New version saved'); artifactView(id); } }, icon('save'), 'Save version'),
      h('a', { class: 'btn', href: `/api/workspace/artifacts/${id}/export` }, 'Export'),
      h('button', { class: 'btn danger', onclick: async () => { if (await confirmDialog('Delete artifact?', 'All versions will be deleted.', 'Delete', true)) { await api(`/api/workspace/artifacts/${id}`, { method: 'DELETE' }); go('#/workspace'); } } }, icon('trash'))),
    h('h3', {}, 'Version history'), h('div', { class: 'list' }, r.versions.map((v) => h('div', { class: 'list-item' }, h('div', { class: 'grow' }, h('div', { class: 'title' }, `v${v.version} — ${v.note}`), h('div', { class: 'sub' }, `${fmtBytes(v.size)} · ${fmtTime(v.created_at)}`)),
      v.version !== a.current_version ? h('button', { class: 'btn', onclick: async () => { await api(`/api/workspace/artifacts/${id}/restore/${v.version}`, { method: 'POST' }); artifactView(id); } }, 'Restore') : h('span', { class: 'badge green' }, 'current'))))));
}

// ================= FABBOX CODE / COEPROX =================
export async function codeProjectsView() {
  hideComposer();
  const [fb, co, caps, tpl] = await Promise.all([api('/api/projects?kind=fabbox'), api('/api/projects?kind=coeprox'), api('/api/fabbox/capabilities'), api('/api/coeprox/templates')]);
  const create = (kind) => async () => {
    const n = await promptDialog(kind === 'fabbox' ? 'New Fabbox Code workspace' : 'New Coeprox project', 'Name'); if (!n) return;
    const p = await api('/api/projects', { method: 'POST', body: { name: n, kind } }); go(`#/code/${p.project.id}`);
  };
  const row = (p) => h('a', { class: 'list-item', href: `#/code/${p.id}` }, icon('code'), h('div', { class: 'grow' }, h('div', { class: 'title' }, p.name), h('div', { class: 'sub' }, `${p.kind.toUpperCase()} · ${fmtTime(p.updated_at)}`)));
  setMain(h('div', { class: 'page' },
    h('h2', {}, 'Approx FABBOX Code'), h('p', { class: 'muted' }, 'Agentic coding workspace: the agent reads your files and proposes edits; nothing changes until you approve.'),
    h('button', { class: 'btn primary', onclick: create('fabbox') }, icon('plus'), 'New Fabbox workspace'),
    h('div', { class: 'list' }, fb.projects.map(row)),
    h('h2', {}, 'COEPROX'), h('p', { class: 'muted' }, `AI software-building workspace with templates: ${tpl.templates.map((t) => t.name).join(', ')}.`),
    h('button', { class: 'btn primary', onclick: create('coeprox') }, icon('plus'), 'New Coeprox project'),
    h('div', { class: 'list' }, co.projects.map(row)),
    h('h3', {}, 'Capabilities in this build'), h('div', { class: 'card small' }, Object.entries(caps).map(([k, v]) => h('div', {}, h('b', {}, k.replace(/_/g, ' ')), ': ', h('span', { class: v.startsWith('unavailable') ? 'muted' : '' }, v))))));
}

export async function codeView(pid) {
  hideComposer();
  const [r, props, tpl] = await Promise.all([api(`/api/fabbox/${pid}/files`), api(`/api/fabbox/${pid}/proposals`), api('/api/coeprox/templates')]);
  const editor = h('textarea', { class: 'input code', 'aria-label': 'File editor', spellcheck: 'false' });
  const pathInput = h('input', { class: 'input', placeholder: 'path/to/file.ext', 'aria-label': 'File path' });
  const open = async (path) => { const f = await api(`/api/fabbox/${pid}/file?path=${encodeURIComponent(path)}`); pathInput.value = f.file.path; editor.value = f.file.content; };
  const instr = h('textarea', { class: 'input', rows: '3', placeholder: 'Tell the agent what to do, e.g. “Add input validation to src/server.js and a test”' });
  const out = h('div');
  const propEl = (p) => h('div', { class: 'card diff' }, h('div', { class: 'row' }, h('b', { class: 'grow' }, p.summary), h('span', { class: `badge ${p.status === 'applied' ? 'green' : ''}` }, p.status)),
    p.changes.map((c) => h('details', {}, h('summary', {}, `${c.op === 'delete' ? 'Delete' : 'Write'} ${c.path}`), c.content !== undefined ? h('pre', { class: 'block' }, c.content.slice(0, 20000)) : null)),
    p.status === 'pending' ? h('div', { class: 'row' },
      h('button', { class: 'btn primary', onclick: async () => { if (await confirmDialog('Apply changes?', `${p.changes.length} file change(s) will be written to this workspace.`, 'Apply')) { await api(`/api/fabbox/${pid}/proposals/${p.id}/approve`, { method: 'POST' }); codeView(pid); } } }, 'Approve & apply'),
      h('button', { class: 'btn', onclick: async () => { await api(`/api/fabbox/${pid}/proposals/${p.id}/reject`, { method: 'POST' }); codeView(pid); } }, 'Reject')) : null);
  const tplSel = h('select', { class: 'input' }, tpl.templates.map((t) => h('option', { value: t.id }, t.name)));
  setMain(h('div', { class: 'page' }, back('#/code', 'Code projects'),
    h('h2', {}, `${r.project.name}`), h('span', { class: 'badge' }, r.project.kind.toUpperCase()),
    h('h3', {}, 'Agent'), instr,
    h('div', { class: 'row' }, h('button', { class: 'btn primary', onclick: async (e) => {
      e.target.disabled = true; out.replaceChildren(h('p', { class: 'muted' }, 'Agent is working…'));
      try { const p = await api(`/api/fabbox/${pid}/agent`, { method: 'POST', body: { instruction: instr.value, model: state.model, mode: 'high' } }); if (p.refused) out.replaceChildren(h('div', { class: 'alert error' }, p.message)); else codeView(pid); }
      catch (err) { out.replaceChildren(h('div', { class: 'alert error' }, err.message)); } finally { e.target.disabled = false; }
    } }, 'Run agent'), h('span', { class: 'small muted' }, 'Proposals require your approval.')), out,
    props.proposals.map(propEl),
    h('h3', {}, 'Files'), r.files.length ? h('div', { class: 'list file-tree' }, r.files.map((f) => h('button', { class: 'list-item', onclick: () => open(f.path) }, h('span', { class: 'grow' }, f.path), h('span', { class: 'sub' }, fmtBytes(f.size))))) : h('p', { class: 'muted' }, 'No files yet.'),
    h('div', { class: 'row' }, tplSel, h('button', { class: 'btn', onclick: async () => { await api(`/api/coeprox/${pid}/scaffold`, { method: 'POST', body: { template: tplSel.value } }); codeView(pid); } }, 'Scaffold template')),
    h('h3', {}, 'Editor'), pathInput, editor,
    h('div', { class: 'row' }, h('button', { class: 'btn primary', onclick: async () => { await api(`/api/fabbox/${pid}/file`, { method: 'PUT', body: { path: pathInput.value, content: editor.value } }); toast('Saved'); codeView(pid); } }, 'Save file'),
      h('button', { class: 'btn danger', onclick: async () => { if (pathInput.value && await confirmDialog('Delete file?', pathInput.value, 'Delete', true)) { await api(`/api/fabbox/${pid}/file?path=${encodeURIComponent(pathInput.value)}`, { method: 'DELETE' }); codeView(pid); } } }, 'Delete file'))));
}

// ================= RESEARCH =================
export async function researchView() {
  hideComposer();
  const caps = await api('/api/research/capabilities');
  const q = h('textarea', { class: 'input', rows: '3', placeholder: 'Research question…' });
  const urls = h('textarea', { class: 'input', rows: '4', placeholder: 'Source URLs (one per line, up to 6)' });
  const out = h('div');
  setMain(h('div', { class: 'page' }, h('h2', {}, 'Approx Research'),
    h('p', { class: 'muted' }, 'Collects sources, validates them, and writes a cited report. Retrieved information is used at answer time only — it is never trained into model weights.'),
    caps.web_search.startsWith('unavailable') ? h('div', { class: 'alert warn' }, 'Automatic web search is not configured on this server. Add the source URLs you want analysed.') : null,
    h('div', { class: 'field' }, h('label', {}, 'Question'), q), h('div', { class: 'field' }, h('label', {}, 'Sources'), urls),
    h('button', { class: 'btn primary', onclick: async (e) => {
      e.target.disabled = true; out.replaceChildren(h('p', { class: 'muted' }, 'Collecting sources and writing report…'));
      try {
        const r = await api('/api/research', { method: 'POST', body: { query: q.value, urls: urls.value.split('\n').map((s) => s.trim()).filter(Boolean), model: state.model, mode: 'high' } });
        out.replaceChildren(h('div', { class: 'card md', html: markdown(r.report) }), h('h3', {}, 'Sources'),
          h('ol', {}, r.sources.map((s) => h('li', {}, h('a', { href: s.url, target: '_blank', rel: 'noopener noreferrer' }, s.title), h('div', { class: 'small muted' }, `retrieved ${s.retrieved_at}`)))),
          r.failed.length ? h('div', { class: 'alert warn' }, `Could not retrieve: ${r.failed.map((f) => `${f.url} (${f.error})`).join('; ')}`) : null,
          h('button', { class: 'btn', onclick: async () => { const a = await api('/api/workspace/artifacts', { method: 'POST', body: { title: `Research: ${q.value.slice(0, 80)}`, kind: 'document', content: `${r.report}\n\n## Sources\n${r.sources.map((s) => `${s.n}. [${s.title}](${s.url})`).join('\n')}` } }); go(`#/workspace/${a.artifact.id}`); } }, icon('save'), 'Save report to Workspace'));
      } catch (err) { out.replaceChildren(h('div', { class: 'alert error' }, err.message)); } finally { e.target.disabled = false; }
    } }, icon('search'), 'Research'), out));
}

// ================= ADMIN =================
export async function adminView() {
  hideComposer();
  if (state.user.role === 'user') return setMain(h('div', { class: 'page' }, h('div', { class: 'alert error' }, 'Admins only.')));
  const r = await api('/api/admin/users');
  const email = h('input', { class: 'input', type: 'email', placeholder: 'user@example.com' });
  const model = h('select', { class: 'input' }, state.models.map((m) => h('option', { value: m.id }, m.name)));
  const reason = h('input', { class: 'input', placeholder: 'Reason (required, audited)' });
  const msg = h('div');
  const isSuper = state.user.role === 'superadmin';
  setMain(h('div', { class: 'page' }, h('h2', {}, 'Admin console'),
    h('div', { class: 'card' }, h('h3', {}, 'Grant model access'), h('p', { class: 'small muted' }, 'FAB grants require superadmin. All grants are audit-logged.'), email, model, reason,
      h('button', { class: 'btn primary', onclick: async () => { try { await api('/api/admin/model-access', { method: 'POST', body: { email: email.value, model_id: model.value, reason: reason.value } }); msg.replaceChildren(h('div', { class: 'alert ok' }, 'Granted')); } catch (e) { msg.replaceChildren(h('div', { class: 'alert error' }, e.message)); } } }, 'Grant'), msg),
    h('h3', {}, 'Users'), h('div', { class: 'list' }, r.users.map((u) => h('div', { class: 'list-item' }, h('div', { class: 'grow' }, h('div', { class: 'title' }, u.email), h('div', { class: 'sub' }, `${u.role} · ${u.plan} · ${u.email_verified ? 'verified' : 'unverified'} · grants: ${u.grants.map((g) => g.model_id).join(', ') || 'none'}`)),
      h('select', { class: 'input', 'aria-label': 'Plan', onchange: async (e) => { await api(`/api/admin/users/${u.id}`, { method: 'PATCH', body: { plan: e.target.value } }); toast('Plan updated'); } }, ['free', 'pro', 'enterprise'].map((p) => h('option', { value: p, selected: u.plan === p }, p)))))),
    isSuper ? h('button', { class: 'btn', onclick: async () => { try { const d = await api('/api/admin/training/export-consented', { method: 'POST', body: { target_model: 'nick-4.8' } }); toast(`Dataset ${d.dataset.version}: ${d.dataset.stats.pairs} pairs → kept after filters`); } catch (e) { toast(e.message); } } }, 'Export consented Nick dataset') : null,
    h('h3', {}, 'Model registry'), h('div', { id: 'admin-registry' }, h('p', { class: 'muted small' }, 'Loading…')),
    h('h3', {}, 'Compute (GPU training)'), h('div', { id: 'admin-compute' }, h('p', { class: 'muted small' }, 'Loading…'))));
  renderRegistry(isSuper);
  renderCompute(isSuper);
}

async function renderRegistry(isSuper) {
  const box = document.getElementById('admin-registry');
  if (!box) return;
  let r;
  try { r = await api('/api/admin/registry'); } catch (e) { box.replaceChildren(h('div', { class: 'alert error' }, e.message)); return; }
  const rows = [];
  for (const m of r.models) {
    rows.push(h('div', { class: 'list-item' }, h('div', { class: 'grow' },
      h('div', { class: 'title' }, `${m.id} `, m.active_version ? h('span', { class: 'badge green' }, `active v${m.active_version}`) : h('span', { class: 'badge warn' }, 'no active version'),
        m.active_problem ? h('span', { class: 'badge error' }, m.active_problem) : null),
      h('div', { class: 'sub' }, m.versions.length ? m.versions.map((v) => `v${v.version} (${v.status}${v.production_ready ? ', production' : ''}${v.activatable ? '' : ', not activatable'})`).join(' · ') : 'no releases imported'))));
    for (const v of m.versions) {
      const canActivate = isSuper && v.activatable && m.active_version !== v.version;
      rows.push(h('div', { class: 'list-item sub-row' }, h('div', { class: 'grow small' }, h('code', {}, `${m.id}@${v.version}`), ` — ${v.status}`, v.errors && v.errors.length ? h('span', { class: 'muted' }, ` · ${v.errors[0]}`) : null),
        canActivate ? h('button', { class: 'btn', onclick: async () => {
          const body = { model_id: m.id, version: v.version };
          if (!v.production_ready && !confirm(`v${v.version} is not production-ready. Activate anyway? (audited)`)) return;
          if (!v.production_ready) { body.allow_non_production = true; body.reason = prompt('Reason (audited):') || 'manual activation'; }
          try { const res = await api('/api/admin/registry/activate', { method: 'POST', body }); toast(`Activated v${v.version} · inference: ${res.inference?.status || 'n/a'}`); renderRegistry(isSuper); } catch (e) { toast(e.message); }
        } }, v.production_ready ? 'Activate' : 'Activate (override)') : (m.active_version === v.version && isSuper ? h('button', { class: 'btn', onclick: async () => { try { await api('/api/admin/registry/deactivate', { method: 'POST', body: { model_id: m.id } }); toast('Deactivated'); renderRegistry(isSuper); } catch (e) { toast(e.message); } } }, 'Deactivate') : null)));
    }
  }
  box.replaceChildren(h('div', { class: 'row' }, h('button', { class: 'btn', onclick: async () => { await api('/api/admin/registry/rescan', { method: 'POST' }); toast('Rescanned'); renderRegistry(isSuper); } }, 'Rescan'),
      h('span', { class: 'muted small' }, `dir: ${r.dir || '—'} · auto-activate: ${r.auto_activate}`)),
    h('div', { class: 'list' }, rows.length ? rows : h('p', { class: 'muted small' }, 'No releases yet. Import with the training pipeline or `cli.js models import`.')),
    isSuper ? h('p', { class: 'muted small' }, 'Import happens from the training pipeline (POST /api/admin/registry/import with the artifact tar.gz) or the operator CLI. Only verified, validated releases can be activated.') : null);
}

async function renderCompute(isSuper) {
  const box = document.getElementById('admin-compute');
  if (!box) return;
  let r;
  try { r = await api('/api/admin/compute'); } catch (e) { box.replaceChildren(h('div', { class: 'alert error' }, e.message)); return; }
  const workers = r.workers || [];
  const online = workers.filter((w) => w.online);
  const start = isSuper ? h('button', { class: 'btn primary', onclick: async () => {
    const which = prompt('Models to train ("all" or space-separated ids):', 'nick-4.8');
    if (!which) return;
    try { const res = await api('/api/admin/compute/jobs', { method: 'POST', body: { models: which.trim() === 'all' ? 'all' : which.trim().split(/\s+/) } }); toast(res.note || `Job ${res.job.id} queued`); renderCompute(isSuper); } catch (e) { toast(e.message); }
  } }, 'Start training job') : null;
  box.replaceChildren(
    h('div', { class: 'row' }, start, h('span', { class: 'muted small' }, `${online.length} worker${online.length === 1 ? '' : 's'} online`)),
    h('div', { class: 'card' }, h('h4', {}, 'GPU workers'), online.length ? h('div', { class: 'list' }, online.map((w) => h('div', { class: 'list-item' },
      h('div', { class: 'grow' }, h('div', { class: 'title' }, w.name || w.id), h('div', { class: 'sub' }, `${w.gpu?.name || 'GPU'} · ${w.gpu?.vram_gb || '?'} GB · job: ${w.current_job_id || 'idle'}`))))) : h('p', { class: 'muted small' }, 'No GPU worker is connected. Start one with `run_all_training.py --worker` on a GPU runtime (Colab/NEBIUS).')),
    h('div', { class: 'card' }, h('h4', {}, 'Jobs'), (r.jobs && r.jobs.length) ? h('div', { class: 'list' }, r.jobs.slice(0, 10).map((j) => h('div', { class: 'list-item' },
      h('div', { class: 'grow' }, h('div', { class: 'title' }, `${j.models.join(', ')} `, h('span', { class: 'badge' }, j.status)), h('div', { class: 'sub' }, `${j.phase || ''} ${j.worker_id ? '· ' + j.worker_id : ''}`.trim() || '—')),
      (isSuper && ['queued', 'running', 'stop_requested'].includes(j.status)) ? h('button', { class: 'btn', onclick: async () => { try { await api(`/api/admin/compute/jobs/${j.id}/stop`, { method: 'POST' }); toast('Stop requested'); renderCompute(isSuper); } catch (e) { toast(e.message); } } }, 'Stop') : null))) : h('p', { class: 'muted small' }, 'No training jobs yet.')));
}
