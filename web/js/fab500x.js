// FAB 500X Code — Approx's private coding workspace (explorer · editor · FAB 500X assistant · panels).
// Everything is stored and authorized on the server (/api/fab500x/*): this file only renders it. Commands never run
// in the browser or on the Approx server; the Terminal shows the server's honest answer (sandbox runner or 501).
import { api } from './api.js';
import { h, icon, toast, confirmDialog, promptDialog, fmtTime } from './ui.js';
import { state, go } from './app.js';

const B = '/api/fab500x';

// ---------------- project list (inside the normal shell) ----------------
export async function projectsPage() {
  const main = document.getElementById('main');
  main.replaceChildren(h('div', { class: 'page' }, h('p', { class: 'muted' }, 'Loading…')));
  let caps; let list;
  try { [caps, list] = await Promise.all([api(`${B}/capabilities`), api(`${B}/projects`)]); }
  catch (e) { main.replaceChildren(h('div', { class: 'page' }, h('div', { class: 'alert error' }, e.status === 404 ? 'FAB 500X Code is available only to accounts an administrator has granted access.' : e.message))); return; }
  const name = h('input', { class: 'input', placeholder: 'Project name', maxlength: 80, 'aria-label': 'Project name' });
  main.replaceChildren(h('div', { class: 'page fx-home' },
    h('div', { class: 'fx-hero' }, h('div', { class: 'fx-badge' }, icon('shield'), 'Private · admin-granted'), h('h2', {}, 'FAB 500X Code'),
      h('p', { class: 'muted' }, 'A coding workspace with the FAB 500X agent: plan, edit and review multi-file projects. Changes are shown as diffs before they are applied in Manual mode.')),
    h('div', { class: 'card' }, h('h3', {}, 'New project'), h('div', { class: 'row' }, name, h('button', { class: 'btn primary', onclick: async () => {
      if (!name.value.trim()) return toast('Enter a project name');
      try { const r = await api(`${B}/projects`, { method: 'POST', body: { name: name.value.trim() } }); go(`#/fab500x/${r.project.id}`); } catch (e) { toast(e.message); }
    } }, icon('plus'), 'Create'))),
    h('h3', {}, 'Projects'),
    list.projects.length ? h('div', { class: 'list' }, list.projects.map((p) => h('a', { class: 'list-item', href: `#/fab500x/${p.id}` }, icon('code'),
      h('div', { class: 'grow' }, h('div', { class: 'title' }, p.name), h('div', { class: 'sub' }, `${p.files} files · updated ${fmtTime(p.updated_at)}`)), icon('chevron'))))
      : h('p', { class: 'muted small' }, 'No projects yet.'),
    h('div', { class: 'card fx-caps' }, h('h3', {}, 'What is connected'), h('dl', {}, ...['agent', 'terminal', 'problems', 'git', 'image_generation', 'video_generation'].flatMap((k) => [h('dt', {}, k.replace('_', ' ')), h('dd', {}, caps[k])])))));
}

// ---------------- syntax highlighting (small tokenizer; DOM only, CSP-safe) ----------------
const KW = {
  js: 'await break case catch class const continue debugger default delete do else export extends finally for from function if import in instanceof let new of return static super switch this throw try typeof var void while with yield async true false null undefined interface type enum implements',
  py: 'and as assert async await break class continue def del elif else except False finally for from global if import in is lambda None nonlocal not or pass raise return True try while with yield',
  css: 'important media import from to',
  sql: 'select from where insert into values update set delete create table index primary key foreign references join left right inner outer on group by order having limit and or not null as distinct',
};
const LANG = { js: 'js', mjs: 'js', cjs: 'js', ts: 'js', tsx: 'js', jsx: 'js', json: 'json', py: 'py', css: 'css', scss: 'css', html: 'html', htm: 'html', md: 'md', sql: 'sql', sh: 'sh', yml: 'yaml', yaml: 'yaml', env: 'sh' };
export const langOf = (path) => LANG[(/\.([a-z0-9]+)$/i.exec(path)?.[1] || (/(^|\/)\.env/.test(path) ? 'env' : '')).toLowerCase()] || 'text';
const RULES = {
  js: [['com', /\/\/[^\n]*|\/\*[\s\S]*?\*\//y], ['str', /`(?:\\[\s\S]|[^`\\])*`|'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"/y], ['num', /\b\d[\d_.]*(?:e[+-]?\d+)?\b/iy], ['word', /[A-Za-z_$][\w$]*/y]],
  json: [['str', /"(?:\\.|[^"\\\n])*"(?=\s*:)/y, 'key'], ['str', /"(?:\\.|[^"\\\n])*"/y], ['num', /-?\b\d[\d.]*(?:e[+-]?\d+)?\b/iy], ['kw', /\b(?:true|false|null)\b/y]],
  py: [['com', /#[^\n]*/y], ['str', /"""[\s\S]*?"""|'''[\s\S]*?'''|'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"/y], ['num', /\b\d[\d_.]*\b/y], ['word', /[A-Za-z_]\w*/y]],
  css: [['com', /\/\*[\s\S]*?\*\//y], ['str', /'[^'\n]*'|"[^"\n]*"/y], ['num', /#[0-9a-f]{3,8}\b|\b\d[\d.]*(px|rem|em|%|vh|vw|s|ms)?\b/iy], ['key', /[a-z-]+(?=\s*:)/y]],
  html: [['com', /<!--[\s\S]*?-->/y], ['kw', /<\/?[A-Za-z][\w-]*|\/?>/y], ['key', /\b[a-z-]+(?==)/y], ['str', /"[^"]*"|'[^']*'/y]],
  md: [['kw', /^#{1,6} [^\n]*/my], ['str', /`[^`\n]+`/y], ['com', /^>[^\n]*/my]],
  sql: [['com', /--[^\n]*/y], ['str', /'(?:''|[^'])*'/y], ['num', /\b\d+\b/y], ['word', /[A-Za-z_]\w*/y]],
  sh: [['com', /#[^\n]*/y], ['str', /'[^']*'|"(?:\\.|[^"\\])*"/y], ['key', /\$\{?\w+\}?/y], ['num', /\b\d+\b/y]],
  yaml: [['com', /#[^\n]*/y], ['key', /^[ \t-]*[\w.-]+(?=:)/my], ['str', /'[^'\n]*'|"[^"\n]*"/y], ['num', /\b\d[\d.]*\b/y]],
};
export function highlight(code, lang) {
  const frag = document.createDocumentFragment();
  const rules = RULES[lang];
  if (!rules || code.length > 200_000) { frag.append(code); return frag; }
  const kws = new Set((KW[lang] || '').split(' ').map((w) => (lang === 'sql' ? w.toLowerCase() : w)));
  let i = 0; let plain = '';
  const flush = () => { if (plain) { frag.append(plain); plain = ''; } };
  outer: while (i < code.length) {
    for (const [cls, re, alt] of rules) {
      re.lastIndex = i;
      const m = re.exec(code);
      if (m && m.index === i && m[0].length) {
        let c = alt || cls;
        if (cls === 'word') { const w = lang === 'sql' ? m[0].toLowerCase() : m[0]; if (!kws.has(w)) { plain += m[0]; i += m[0].length; continue outer; } c = 'kw'; }
        flush(); const s = document.createElement('span'); s.className = `tk-${c}`; s.textContent = m[0]; frag.append(s); i += m[0].length; continue outer;
      }
    }
    plain += code[i++];
  }
  flush();
  return frag;
}

// ---------------- IDE ----------------
export async function ideView(app, pid) {
  const S = { pid, project: null, files: [], open: [], active: null, buffers: new Map(), dirty: new Set(), masked: new Set(), panel: 'problems', side: 'explorer',
    collapsed: new Set(), autosave: true, mode: state.settings?.permissions_mode === 'automatic' ? 'automatic' : 'manual', mobile: 'editor', output: [], caps: null };
  const el = (id) => root.querySelector(`[data-id="${id}"]`);
  const log = (msg, kind = 'info') => { S.output.push({ at: Date.now(), msg, kind }); if (S.panel === 'output') renderPanel(); };

  // layout
  const tabsEl = h('div', { class: 'fx-tabs', role: 'tablist', 'data-id': 'tabs' });
  const gutter = h('pre', { class: 'fx-gutter', 'aria-hidden': 'true' });
  const hl = h('pre', { class: 'fx-hl', 'aria-hidden': 'true' }, h('code', {}));
  const ta = h('textarea', { class: 'fx-ta', spellcheck: 'false', autocapitalize: 'off', autocomplete: 'off', wrap: 'off', 'aria-label': 'Code editor', 'data-id': 'editor' });
  const findBar = h('div', { class: 'fx-find hidden', 'data-id': 'find' });
  const editorWrap = h('div', { class: 'fx-editor' }, gutter, h('div', { class: 'fx-code' }, hl, ta));
  const emptyEd = h('div', { class: 'fx-empty' }, h('p', {}, 'Open a file from the Explorer, or create one.'), h('p', { class: 'small muted' }, 'Ctrl+S save · Ctrl+F find · Ctrl+H replace · Ctrl+Z / Ctrl+Y undo / redo'));
  const status = h('div', { class: 'fx-status', 'data-id': 'status' });
  const sideEl = h('aside', { class: 'fx-side', 'data-id': 'side' });
  const asstEl = h('aside', { class: 'fx-asst', 'data-id': 'asst' });
  const panelEl = h('section', { class: 'fx-panel', 'data-id': 'panel' });
  const mobileNav = h('nav', { class: 'fx-mnav', 'aria-label': 'Workspace sections' }, [['files', 'folder', 'Files'], ['editor', 'code', 'Editor'], ['asst', 'spark', 'FAB 500X'], ['panel', 'tasks', 'Panel']].map(([k, ic, l]) =>
    h('button', { 'data-m': k, 'aria-pressed': String(k === S.mobile), onclick: () => { S.mobile = k; root.dataset.mobile = k; for (const b of mobileNav.children) b.setAttribute('aria-pressed', String(b.dataset.m === k)); } }, icon(ic), h('span', {}, l))));
  const root = h('div', { class: 'fx', 'data-mobile': S.mobile },
    h('header', { class: 'fx-top' },
      h('a', { class: 'fx-brand', href: '#/fab500x', title: 'All projects' }, h('img', { src: '/assets/logo-mark-64.png', alt: '' }), h('span', {}, 'Approx'), h('span', { class: 'fx-sep' }, '/'), h('b', {}, 'FAB 500X')),
      h('span', { class: 'fx-proj', 'data-id': 'pname' }, '…'),
      h('div', { class: 'spacer' }),
      h('button', { class: 'fx-tbtn', onclick: () => { S.panel = 'terminal'; renderPanel(); showMobile('panel'); setTimeout(() => panelEl.querySelector('input')?.focus(), 50); } }, icon('send'), h('span', {}, 'Run')),
      h('button', { class: 'fx-tbtn', onclick: () => toast('Deploy is not connected: no deployment provider is configured for FAB 500X workspaces.') }, icon('share'), h('span', {}, 'Deploy')),
      h('a', { class: 'fx-tbtn', href: '#/', title: 'Back to Approx' }, icon('close'))),
    h('div', { class: 'fx-body' }, sideEl, h('div', { class: 'fx-center' }, tabsEl, findBar, editorWrap, emptyEd, status), asstEl),
    panelEl, mobileNav);
  app.replaceChildren(root);
  document.title = 'FAB 500X Code · Approx';
  const showMobile = (k) => mobileNav.querySelector(`[data-m="${k}"]`)?.click();

  // ---------- data ----------
  async function loadTree() {
    const t = await api(`${B}/projects/${pid}/tree`);
    S.project = t.project; S.files = t.files;
    el('pname').textContent = t.project.name;
    renderSide();
  }
  async function openFile(path, { reveal = false } = {}) {
    if (!S.buffers.has(path) || reveal) {
      const r = await api(`${B}/projects/${pid}/file?path=${encodeURIComponent(path)}${reveal ? '&reveal=1' : ''}`);
      S.buffers.set(path, { content: r.file.content, saved: r.file.content });
      if (r.file.masked) S.masked.add(path); else S.masked.delete(path);
    }
    if (!S.open.includes(path)) S.open.push(path);
    S.active = path; renderTabs(); renderEditor(); showMobile('editor');
  }
  async function save(path = S.active, quiet = false) {
    if (!path || !S.dirty.has(path)) return;
    if (S.masked.has(path)) { toast('Reveal this secret file before editing it'); return; }
    const buf = S.buffers.get(path);
    try { await api(`${B}/projects/${pid}/file`, { method: 'PUT', body: { path, content: buf.content } }); buf.saved = buf.content; S.dirty.delete(path); renderTabs(); if (!quiet) toast('Saved'); log(`saved ${path}`); }
    catch (e) { toast(e.message); log(`save failed: ${path}: ${e.message}`, 'error'); }
  }

  // ---------- explorer / search / source control ----------
  function renderSide() {
    const views = { explorer: explorerView, search: searchView, git: gitView };
    sideEl.replaceChildren(h('div', { class: 'fx-sidetabs' }, [['explorer', 'folder', 'Explorer'], ['search', 'search', 'Search'], ['git', 'branch', 'Source control']].map(([k, ic, l]) =>
      h('button', { title: l, 'aria-label': l, 'aria-pressed': String(S.side === k), onclick: () => { S.side = k; renderSide(); } }, icon(ic)))), views[S.side]());
  }
  function explorerView() {
    const tree = {};
    for (const f of S.files) { let node = tree; const parts = f.path.split('/'); parts.slice(0, -1).forEach((d) => { node = node[d + '/'] ||= {}; }); node[parts.at(-1)] = f; }
    const rows = [];
    const walk = (node, prefix, depth) => {
      for (const k of Object.keys(node).sort((a, b) => (a.endsWith('/') === b.endsWith('/') ? a.localeCompare(b) : a.endsWith('/') ? -1 : 1))) {
        if (k.endsWith('/')) {
          const dir = prefix + k.slice(0, -1); const closed = S.collapsed.has(dir);
          rows.push(h('div', { class: 'fx-row dir', style: undefined, 'data-depth': depth, onclick: () => { closed ? S.collapsed.delete(dir) : S.collapsed.add(dir); renderSide(); } },
            h('span', { class: `fx-caret${closed ? ' closed' : ''}` }, icon('chevron')), h('span', { class: 'grow' }, k.slice(0, -1)), rowMenu(dir, true)));
          if (!closed) walk(node[k], dir + '/', depth + 1);
        } else {
          const path = prefix + k;
          rows.push(h('div', { class: `fx-row file${S.active === path ? ' active' : ''}`, 'data-depth': depth, title: path, onclick: () => openFile(path).catch((e) => toast(e.message)) },
            h('span', { class: `fx-dot l-${langOf(path)}` }), h('span', { class: 'grow' }, k), S.dirty.has(path) ? h('span', { class: 'fx-mod' }, '●') : null, rowMenu(path, false)));
        }
      }
    };
    walk(tree, '', 0);
    for (const r of rows) r.style.paddingLeft = `${8 + Number(r.dataset.depth) * 14}px`;
    const fileInput = h('input', { type: 'file', multiple: true, class: 'hidden', onchange: async (e) => {
      const files = [];
      for (const f of e.target.files) { if (f.size > 400_000) { toast(`${f.name} is larger than 400 KB`); continue; } files.push({ path: f.name, content: await f.text() }); }
      if (!files.length) return;
      try { const r = await api(`${B}/projects/${pid}/upload`, { method: 'POST', body: { files } }); toast(`Uploaded ${r.saved.length}`); await loadTree(); } catch (err) { toast(err.message); }
    } });
    return h('div', { class: 'fx-pane' }, h('div', { class: 'fx-pane-h' }, h('span', { class: 'grow' }, 'Explorer'),
      h('button', { class: 'fx-ib', title: 'New file', 'aria-label': 'New file', onclick: newFile }, icon('plus')),
      h('button', { class: 'fx-ib', title: 'Upload files', 'aria-label': 'Upload files', onclick: () => fileInput.click() }, icon('download')),
      h('button', { class: 'fx-ib', title: 'Refresh', 'aria-label': 'Refresh', onclick: () => loadTree() }, icon('refresh')), fileInput),
    rows.length ? h('div', { class: 'fx-tree' }, rows) : h('p', { class: 'small muted fx-pad' }, 'Empty project. Create a file or ask FAB 500X to scaffold one.'));
  }
  function rowMenu(path, isDir) {
    return h('span', { class: 'fx-rowacts' },
      h('button', { class: 'fx-ib', title: 'Rename / move', 'aria-label': `Rename ${path}`, onclick: async (e) => {
        e.stopPropagation();
        const to = await promptDialog(isDir ? 'Rename folder' : 'Rename or move', 'New path', path); if (!to || to === path) return;
        try { await api(`${B}/projects/${pid}/rename`, { method: 'POST', body: { from: path, to } }); remapOpen(path, to); await loadTree(); toast('Moved'); } catch (err) { toast(err.message); }
      } }, icon('edit')),
      isDir ? null : h('button', { class: 'fx-ib', title: 'Delete', 'aria-label': `Delete ${path}`, onclick: async (e) => {
        e.stopPropagation();
        if (!(await confirmDialog('Delete file?', `${path} will be deleted. Its history is kept.`, 'Delete', true))) return;
        try { await api(`${B}/projects/${pid}/file?path=${encodeURIComponent(path)}&confirm=1`, { method: 'DELETE' }); closeTab(path, true); await loadTree(); } catch (err) { toast(err.message); }
      } }, icon('trash')));
  }
  function remapOpen(from, to) {
    for (const [p, b] of [...S.buffers]) if (p === from || p.startsWith(from + '/')) { const np = to + p.slice(from.length); S.buffers.delete(p); S.buffers.set(np, b); S.open = S.open.map((x) => (x === p ? np : x)); if (S.active === p) S.active = np; }
    renderTabs();
  }
  async function newFile() {
    const path = await promptDialog('New file', 'Path (folders are created automatically)', 'src/index.js'); if (!path) return;
    try { await api(`${B}/projects/${pid}/file`, { method: 'PUT', body: { path, content: '' } }); await loadTree(); await openFile(path); } catch (e) { toast(e.message); }
  }
  function searchView() {
    const q = h('input', { class: 'input fx-in', type: 'search', placeholder: 'Search in project', 'aria-label': 'Search in project' });
    const cs = h('input', { type: 'checkbox', 'aria-label': 'Match case' });
    const out = h('div', { class: 'fx-results' });
    const run = async () => {
      if (q.value.trim().length < 2) return;
      try {
        const r = await api(`${B}/projects/${pid}/search?q=${encodeURIComponent(q.value)}&case=${cs.checked ? 1 : 0}`);
        out.replaceChildren(...(r.results.length ? r.results.map((f) => h('div', { class: 'fx-res' }, h('div', { class: 'fx-res-f', onclick: () => openFile(f.path) }, f.path),
          f.matches.map((m) => h('div', { class: 'fx-res-l', onclick: async () => { await openFile(f.path); gotoLine(m.line); } }, h('span', { class: 'muted' }, `${m.line}`), ' ', m.text.trim())))) : [h('p', { class: 'small muted' }, 'No results.')]));
      } catch (e) { toast(e.message); }
    };
    q.addEventListener('keydown', (e) => { if (e.key === 'Enter') run(); });
    return h('div', { class: 'fx-pane' }, h('div', { class: 'fx-pane-h' }, 'Search'), h('div', { class: 'fx-pad' }, q, h('label', { class: 'small fx-chk' }, cs, ' Match case')), out);
  }
  function gitView() {
    const box = h('div', { class: 'fx-pad' }, h('p', { class: 'small muted' }, 'Loading…'));
    (async () => {
      try {
        const r = await api(`${B}/projects/${pid}/changes`);
        const msg = h('input', { class: 'input fx-in', placeholder: 'Checkpoint message', 'aria-label': 'Checkpoint message' });
        box.replaceChildren(h('p', { class: 'small muted' }, 'Approx checkpoints (snapshots of this project) — not a Git repository.'),
          h('p', { class: 'small' }, r.checkpoint ? `Last: “${r.checkpoint.message}” · ${fmtTime(r.checkpoint.created_at)}` : 'No checkpoint yet.'),
          r.changes.length ? h('div', {}, r.changes.map((c) => h('div', { class: 'fx-row file', onclick: () => c.status !== 'deleted' && openFile(c.path) }, h('span', { class: `fx-st ${c.status}` }, c.status[0].toUpperCase()), h('span', { class: 'grow' }, c.path)))) : h('p', { class: 'small muted' }, 'No changes.'),
          msg, h('button', { class: 'btn primary block', onclick: async () => {
            if (!msg.value.trim()) return toast('Enter a message');
            for (const p of [...S.dirty]) await save(p, true);
            try { await api(`${B}/projects/${pid}/checkpoints`, { method: 'POST', body: { message: msg.value.trim() } }); toast('Checkpoint saved'); renderSide(); } catch (e) { toast(e.message); }
          } }, 'Create checkpoint'));
      } catch (e) { box.replaceChildren(h('div', { class: 'alert error small' }, e.message)); }
    })();
    return h('div', { class: 'fx-pane' }, h('div', { class: 'fx-pane-h' }, 'Source control'), box);
  }

  // ---------- tabs + editor ----------
  function renderTabs() {
    tabsEl.replaceChildren(...S.open.map((p) => h('div', { class: `fx-tab${p === S.active ? ' active' : ''}`, role: 'tab', 'aria-selected': String(p === S.active), title: p, onclick: () => { S.active = p; renderTabs(); renderEditor(); } },
      h('span', { class: `fx-dot l-${langOf(p)}` }), h('span', {}, p.split('/').at(-1)), S.masked.has(p) ? h('span', { class: 'fx-lock', title: 'Secret values masked' }, icon('lock')) : null,
      h('button', { class: 'fx-x', 'aria-label': `Close ${p}`, onclick: (e) => { e.stopPropagation(); closeTab(p); } }, S.dirty.has(p) ? '●' : '×'))));
    if (S.side === 'explorer') renderSide();
  }
  async function closeTab(p, force = false) {
    if (!force && S.dirty.has(p) && !(await confirmDialog('Unsaved changes', `Close ${p} without saving?`, 'Close', true))) return;
    S.open = S.open.filter((x) => x !== p); S.dirty.delete(p); S.buffers.delete(p);
    if (S.active === p) S.active = S.open.at(-1) || null;
    renderTabs(); renderEditor();
  }
  function paint() {
    const buf = S.buffers.get(S.active); if (!buf) return;
    const code = hl.firstChild; code.replaceChildren(highlight(buf.content + '\n', langOf(S.active)));
    const n = buf.content.split('\n').length; gutter.textContent = Array.from({ length: n }, (_, i) => i + 1).join('\n');
    const pos = ta.value.slice(0, ta.selectionStart).split('\n');
    status.replaceChildren(h('span', {}, S.active), h('span', {}, `Ln ${pos.length}, Col ${pos.at(-1).length + 1}`), h('span', {}, langOf(S.active)),
      h('span', {}, S.masked.has(S.active) ? 'secrets masked' : S.dirty.has(S.active) ? 'unsaved' : 'saved'),
      h('label', { class: 'fx-chk' }, h('input', { type: 'checkbox', checked: S.autosave, onchange: (e) => { S.autosave = e.target.checked; } }), ' Auto-save'));
  }
  function renderEditor() {
    const has = !!S.active && S.buffers.has(S.active);
    editorWrap.classList.toggle('hidden', !has); emptyEd.classList.toggle('hidden', has); status.classList.toggle('hidden', !has);
    if (!has) return;
    const buf = S.buffers.get(S.active);
    if (ta.value !== buf.content) ta.value = buf.content;
    ta.readOnly = S.masked.has(S.active);
    if (S.masked.has(S.active)) findBar.classList.add('hidden');
    editorWrap.querySelector('.fx-reveal')?.remove();
    if (S.masked.has(S.active)) editorWrap.prepend(h('div', { class: 'fx-reveal' }, icon('lock'), 'Secret values are masked. ', h('button', { class: 'btn', onclick: async () => {
      if (!(await confirmDialog('Reveal secrets?', 'The real values will be shown in the editor. This is recorded in the audit log.', 'Reveal'))) return;
      await openFile(S.active, { reveal: true });
    } }, 'Reveal to edit')));
    paint();
  }
  let saveTimer; let raf;
  ta.addEventListener('input', () => {
    const buf = S.buffers.get(S.active); if (!buf) return;
    buf.content = ta.value; if (buf.content !== buf.saved) S.dirty.add(S.active); else S.dirty.delete(S.active);
    cancelAnimationFrame(raf); raf = requestAnimationFrame(paint);
    if (!tabsEl.querySelector('.fx-tab.active .fx-x')?.textContent.includes('●') && S.dirty.has(S.active)) renderTabs();
    clearTimeout(saveTimer); if (S.autosave) saveTimer = setTimeout(() => save(S.active, true), 1500);
  });
  ta.addEventListener('scroll', () => { hl.scrollTop = ta.scrollTop; hl.scrollLeft = ta.scrollLeft; gutter.scrollTop = ta.scrollTop; });
  ta.addEventListener('keyup', () => paint());
  ta.addEventListener('click', () => paint());
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Tab' && !e.ctrlKey && !e.metaKey) { e.preventDefault(); document.execCommand('insertText', false, '  '); }
  });
  function gotoLine(n) {
    const lines = ta.value.split('\n'); const idx = lines.slice(0, n - 1).reduce((s, l) => s + l.length + 1, 0);
    ta.focus(); ta.setSelectionRange(idx, idx + (lines[n - 1] || '').length); ta.scrollTop = Math.max(0, (n - 5) * 20); paint();
  }

  // ---------- find / replace ----------
  const fIn = h('input', { class: 'fx-in', placeholder: 'Find', 'aria-label': 'Find' });
  const rIn = h('input', { class: 'fx-in', placeholder: 'Replace', 'aria-label': 'Replace' });
  const fCount = h('span', { class: 'small muted' });
  const findNext = () => {
    if (!fIn.value) return; const from = ta.selectionEnd; let i = ta.value.indexOf(fIn.value, from); if (i < 0) i = ta.value.indexOf(fIn.value);
    fCount.textContent = `${ta.value.split(fIn.value).length - 1} matches`;
    if (i >= 0) { ta.focus(); ta.setSelectionRange(i, i + fIn.value.length); paint(); }
  };
  const replaceOne = () => { if (ta.readOnly || !fIn.value) return; if (ta.value.slice(ta.selectionStart, ta.selectionEnd) === fIn.value) { ta.focus(); document.execCommand('insertText', false, rIn.value); } findNext(); };
  const replaceAll = () => { if (ta.readOnly || !fIn.value) return; const n = ta.value.split(fIn.value).length - 1; ta.focus(); ta.select(); document.execCommand('insertText', false, ta.value.split(fIn.value).join(rIn.value)); fCount.textContent = `Replaced ${n}`; };
  fIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); findNext(); } if (e.key === 'Escape') findBar.classList.add('hidden'); });
  findBar.append(fIn, h('button', { class: 'fx-ib', title: 'Next', 'aria-label': 'Find next', onclick: findNext }, icon('chevron')), rIn,
    h('button', { class: 'btn', onclick: replaceOne }, 'Replace'), h('button', { class: 'btn', onclick: replaceAll }, 'All'), fCount,
    h('button', { class: 'fx-ib', 'aria-label': 'Close find', onclick: () => findBar.classList.add('hidden') }, icon('close')));
  const keyHandler = (e) => {
    if (!document.body.contains(root)) { window.removeEventListener('keydown', keyHandler); return; }
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); save(); }
    if (mod && (e.key.toLowerCase() === 'f' || e.key.toLowerCase() === 'h') && S.active) { e.preventDefault(); findBar.classList.remove('hidden'); (e.key.toLowerCase() === 'h' ? rIn : fIn).focus(); }
  };
  window.addEventListener('keydown', keyHandler);

  // ---------- bottom panel ----------
  function renderPanel() {
    const tabs = [['problems', 'Problems'], ['output', 'Output'], ['terminal', 'Terminal'], ['logs', 'Logs']];
    const body = h('div', { class: 'fx-pbody' });
    panelEl.replaceChildren(h('div', { class: 'fx-ptabs' }, tabs.map(([k, l]) => h('button', { 'aria-pressed': String(S.panel === k), onclick: () => { S.panel = k; renderPanel(); } }, l))), body);
    if (S.panel === 'problems') {
      body.append(h('p', { class: 'small muted' }, 'Checking…'));
      api(`${B}/projects/${pid}/problems`).then((r) => body.replaceChildren(h('p', { class: 'small muted' }, r.note), ...(r.problems.length ? r.problems.map((p) =>
        h('div', { class: `fx-prob ${p.severity}`, onclick: async () => { await openFile(p.path); gotoLine(p.line); } }, h('b', {}, p.severity), ` ${p.path}:${p.line} `, h('span', { class: 'muted' }, `[${p.source}]`), ` ${p.message}`)) : [h('p', { class: 'small' }, 'No problems found.')])))
        .catch((e) => body.replaceChildren(h('div', { class: 'alert error small' }, e.message)));
    } else if (S.panel === 'output') {
      body.append(...(S.output.length ? S.output.map((o) => h('div', { class: `fx-log ${o.kind}` }, h('span', { class: 'muted' }, new Date(o.at).toLocaleTimeString()), ' ', o.msg)) : [h('p', { class: 'small muted' }, 'No output yet.')]));
    } else if (S.panel === 'terminal') {
      const term = h('div', { class: 'fx-term', 'aria-live': 'polite' }, h('div', { class: 'muted' }, S.caps?.terminal || ''));
      const inp = h('input', { class: 'fx-in fx-cmd', placeholder: '$ command (runs only in a connected sandbox runner)', 'aria-label': 'Terminal command' });
      inp.addEventListener('keydown', async (e) => {
        if (e.key !== 'Enter' || !inp.value.trim()) return;
        const cmd = inp.value.trim(); inp.value = ''; term.append(h('div', { class: 'fx-cmdl' }, `$ ${cmd}`));
        try { const r = await api(`${B}/projects/${pid}/run`, { method: 'POST', body: { command: cmd } }); term.append(h('pre', {}, r.stdout || ''), r.stderr ? h('pre', { class: 'err' }, r.stderr) : null, h('div', { class: 'muted' }, `exit ${r.exit_code}`)); }
        catch (err) { term.append(h('div', { class: 'err' }, `${err.code || 'error'}: ${err.message}`)); log(`command not run: ${cmd} (${err.code})`, 'error'); }
        term.scrollTop = term.scrollHeight;
      });
      body.append(term, inp);
    } else {
      body.append(h('p', { class: 'small muted' }, 'Agent and file actions in this session. Security-relevant actions are also written to your account audit log.'),
        ...S.output.filter((o) => o.kind !== 'info' || /agent|applied|rejected|deleted/.test(o.msg)).map((o) => h('div', { class: `fx-log ${o.kind}` }, new Date(o.at).toLocaleTimeString(), ' ', o.msg)));
    }
  }

  // ---------- assistant ----------
  function renderAsst() {
    const instr = h('textarea', { class: 'input fx-ask', rows: 4, placeholder: 'Ask FAB 500X to build, fix, refactor, review security, write tests…', 'aria-label': 'Instruction for FAB 500X' });
    const modeSel = h('div', { class: 'mode-toggle fx-mode', role: 'group', 'aria-label': 'Permission' }, ['manual', 'automatic'].map((m) =>
      h('button', { type: 'button', 'aria-pressed': String(S.mode === m), onclick: (e) => { S.mode = m; for (const b of modeSel.children) b.setAttribute('aria-pressed', String(b === e.currentTarget)); } }, m === 'manual' ? 'Manual' : 'Automatic')));
    const feed = h('div', { class: 'fx-feed', 'data-id': 'feed' });
    const send = h('button', { class: 'btn primary block', onclick: async () => {
      if (instr.value.trim().length < 3) return toast('Describe what FAB 500X should do');
      for (const p of [...S.dirty]) await save(p, true);
      send.disabled = true; send.textContent = 'FAB 500X is working…';
      feed.prepend(h('div', { class: 'fx-msg you' }, instr.value));
      log(`agent: ${instr.value.slice(0, 80)}`);
      try {
        const r = await api(`${B}/projects/${pid}/agent`, { method: 'POST', body: { instruction: instr.value, permission: S.mode, open_files: S.open } });
        instr.value = '';
        if (r.refused) feed.prepend(h('div', { class: 'fx-msg ai' }, r.message)); else feed.prepend(proposalCard(r.proposal));
        if (r.proposal?.auto_applied?.length) { await reloadOpen(); await loadTree(); log(`agent auto-applied: ${r.proposal.auto_applied.join(', ')}`); }
      } catch (e) { feed.prepend(h('div', { class: 'alert error small' }, e.message)); log(`agent error: ${e.message}`, 'error'); }
      send.disabled = false; send.textContent = 'Send';
    } }, 'Send');
    asstEl.replaceChildren(h('div', { class: 'fx-pane-h' }, icon('spark'), h('span', { class: 'grow' }, 'FAB 500X Assistant'), modeSel),
      h('p', { class: 'small muted fx-pad' }, S.mode === 'manual' ? 'Manual: every change waits for your approval with a diff.' : 'Automatic: file edits apply immediately; deletions and commands still wait for approval.'),
      S.caps && !/^available/.test(S.caps.agent) ? h('div', { class: 'alert warn small' }, S.caps.agent) : (S.caps && /simulator/.test(S.caps.agent) ? h('div', { class: 'alert warn small' }, 'Development simulator: proposals are examples, not FAB 500X output.') : null),
      h('div', { class: 'fx-pad' }, instr, send), feed);
    api(`${B}/projects/${pid}/proposals`).then((r) => { for (const p of r.proposals.slice(0, 10)) feed.append(proposalCard({ ...p, pending_changes: (p.pending || []).length }, true)); }).catch(() => {});
  }
  function proposalCard(p, old = false) {
    const diffs = p.diffs || [];
    const card = h('div', { class: `fx-prop ${p.status}` },
      h('div', { class: 'row' }, h('b', { class: 'grow' }, p.summary), h('span', { class: `badge ${p.status === 'applied' ? 'green' : p.status === 'rejected' ? '' : 'warn'}` }, p.status)),
      (p.plan || []).length ? h('ol', { class: 'small' }, p.plan.map((s) => h('li', {}, s))) : null,
      p.explanation ? h('p', { class: 'small muted' }, p.explanation) : null,
      diffs.map((d) => h('details', { open: !old && diffs.length <= 3 }, h('summary', {}, h('span', { class: `fx-op ${d.op}` }, d.op), ' ', d.path || `${d.from} → ${d.to}`, d.added !== undefined ? h('span', { class: 'small muted' }, `  +${d.added} −${d.removed}`) : null),
        h('pre', { class: 'fx-diff' }, ...String(d.diff || '').split('\n').map((l) => h('span', { class: l.startsWith('+') && !l.startsWith('+++') ? 'add' : l.startsWith('-') && !l.startsWith('---') ? 'del' : l.startsWith('@@') ? 'hunk' : '' }, l + '\n'))))),
      (p.commands || []).length ? h('div', { class: 'small' }, h('b', {}, 'Proposed commands (not run): '), p.commands.map((c) => h('code', { class: c.dangerous ? 'danger-text' : '' }, c.command, c.dangerous ? ' ⚠ unsafe' : '')).flatMap((x, i) => (i ? [' ', x] : [x]))) : null,
      (p.auto_applied || []).length ? h('p', { class: 'small' }, `Applied automatically: ${p.auto_applied.join(', ')}`) : null);
    if (p.status === 'pending') {
      const act = h('div', { class: 'row' },
        h('button', { class: 'btn primary', onclick: async () => {
          try { const r = await api(`${B}/projects/${pid}/proposals/${p.id}/approve`, { method: 'POST' }); toast('Applied'); log(`proposal applied: ${p.summary.slice(0, 60)}`); if (r.note) log(r.note); act.remove(); await reloadOpen(); await loadTree(); }
          catch (e) { toast(e.message); }
        } }, p.pending_changes ? `Apply ${p.pending_changes} change${p.pending_changes > 1 ? 's' : ''}` : 'Acknowledge'),
        h('button', { class: 'btn', onclick: async () => { try { await api(`${B}/projects/${pid}/proposals/${p.id}/reject`, { method: 'POST' }); log(`proposal rejected: ${p.summary.slice(0, 60)}`); act.remove(); } catch (e) { toast(e.message); } } }, 'Reject'));
      card.append(act);
    }
    return card;
  }
  async function reloadOpen() {
    for (const p of [...S.open]) {
      if (S.dirty.has(p)) continue;
      try { const r = await api(`${B}/projects/${pid}/file?path=${encodeURIComponent(p)}`); S.buffers.set(p, { content: r.file.content, saved: r.file.content }); if (r.file.masked) S.masked.add(p); }
      catch { S.open = S.open.filter((x) => x !== p); S.buffers.delete(p); if (S.active === p) S.active = S.open.at(-1) || null; }
    }
    renderTabs(); renderEditor();
  }

  // ---------- start ----------
  try {
    S.caps = await api(`${B}/capabilities`);
    await loadTree();
  } catch (e) {
    root.replaceChildren(h('div', { class: 'page' }, h('div', { class: 'alert error' }, e.status === 404 ? 'This FAB 500X project does not exist or your account has no FAB 500X access.' : e.message), h('a', { class: 'btn', href: '#/' }, 'Back to Approx')));
    return;
  }
  renderTabs(); renderEditor(); renderPanel(); renderAsst();
  window.addEventListener('beforeunload', (e) => { if (S.dirty.size && document.body.contains(root)) { e.preventDefault(); e.returnValue = ''; } });
}
