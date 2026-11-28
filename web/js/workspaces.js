// Approx Work · Approx Code · Approx Education on the web — the same server-side architecture as Android (API 1.9):
// workspace → project → session (persistent ID, own context) → threads (each a full conversation, #/c/<id>)
// → tasks · files · outputs · logs; Code adds changes / commit / branches / runner, Education adds quiz / progress.
import { api } from './api.js';
import { h, icon, toast, sheet, confirmDialog, promptDialog, fmtTime, fmtBytes } from './ui.js';
import { go, setMain, setHeaderTitle } from './app.js';

const TITLE = { work: 'Approx Work', code: 'Approx Code', education: 'Education' };
const NEW = { work: 'New session', code: 'New session', education: 'New study session' };
const PROJECTS = { work: 'Projects', code: 'Repositories', education: 'Courses & subjects' };
const ICON = { work: 'work', code: 'code', education: 'doc' };
const errBox = (e) => h('div', { class: 'alert error' }, e.message);
const skel = (n = 3) => h('div', { class: 'skeleton-list' }, Array.from({ length: n }, () => h('div', { class: 'skeleton line' })));
const section = (t, action) => h('div', { class: 'ws-section' }, h('h2', { class: 'section grow' }, t), action || null);
const empty = (t) => h('p', { class: 'muted empty' }, t);

function sessionItem(s, showKind) {
  const meta = [s.project?.name, `${s.thread_count} thread${s.thread_count === 1 ? '' : 's'}`, s.open_tasks ? `${s.open_tasks} open task${s.open_tasks === 1 ? '' : 's'}` : null, fmtTime(s.updated_at)].filter(Boolean).join(' · ');
  return h('a', { class: 'list-item', href: `#/s/${s.id}` }, icon(ICON[s.kind] || 'chat'),
    h('div', { class: 'grow' }, h('div', { class: 'title' }, `${showKind ? TITLE[s.kind] + ' · ' : ''}${s.title}`), h('div', { class: 'sub' }, meta)));
}

// ---------------------------------------------------------------- workspace home
export async function workspaceHome(kind, { extra } = {}) {
  setHeaderTitle(TITLE[kind]);
  const body = h('div', {}, skel(4));
  const results = h('div', { class: 'list' });
  const q = h('input', { class: 'input', type: 'search', placeholder: 'Search sessions', 'aria-label': 'Search sessions' });
  let t; q.addEventListener('input', () => { clearTimeout(t); t = setTimeout(async () => {
    if (!q.value.trim()) return results.replaceChildren();
    const r = await api(`/api/work-sessions?workspace=${kind}&q=${encodeURIComponent(q.value.trim())}`);
    results.replaceChildren(...(r.sessions.length ? r.sessions.map((s) => sessionItem(s)) : [empty('No session matches.')]));
  }, 250); });
  setMain(h('div', { class: 'page ws-page' },
    h('div', { class: 'page-head' }, h('div', { class: 'grow' }, h('h1', {}, TITLE[kind]),
      h('p', { class: 'muted small' }, 'Each session has its own context and threads. Pick up any session exactly where you left it.'))),
    h('button', { class: 'btn primary block ws-new', onclick: () => newSessionSheet(kind) }, icon('plus'), NEW[kind]),
    q, results, body, extra || null));
  try {
    const o = await api(`/api/workspaces/${kind}`);
    const parts = [];
    if (o.progress) {
      parts.push(section('Progress'), h('div', { class: 'card' }, h('b', {}, `${o.progress.quiz_attempts} quiz attempts`), ' · ',
        o.progress.average_percent == null ? 'no quizzes yet' : `${o.progress.average_percent}% average`,
        ...o.progress.by_course.map((c) => h('div', { class: 'small muted' }, `${c.name}: ${c.quiz_attempts} quizzes · ${c.average_percent == null ? '–' : c.average_percent + '%'} · assignments ${c.assignments_done}/${c.assignments_total}`))));
    }
    parts.push(section('Recent sessions', h('a', { href: `#/sessions/${kind}`, class: 'small' }, 'Session history')),
      h('div', { class: 'list' }, ...(o.sessions.length ? o.sessions.map((s) => sessionItem(s)) : [empty('No sessions yet. Start one above.')])));
    parts.push(section(PROJECTS[kind], h('button', { class: 'btn small', onclick: () => newProject(kind) }, icon('plus'), 'New')),
      h('div', { class: 'list' }, ...(o.projects.length ? o.projects.map((p) => h('a', { class: 'list-item', href: `#/sessions/${kind}/active/${p.id}` }, icon('folder'),
        h('div', { class: 'grow' }, h('div', { class: 'title' }, p.name), h('div', { class: 'sub' }, `${p.session_count} sessions`)))) : [empty('None yet.')])));
    parts.push(section(kind === 'education' ? 'Assignments & tasks' : 'Active tasks'),
      h('div', { class: 'list' }, ...(o.active_tasks.length ? o.active_tasks.map((x) => h('a', { class: 'list-item', href: `#/s/${x.session_id}` }, icon(x.kind === 'assignment' ? 'doc' : 'check'),
        h('div', { class: 'grow' }, h('div', { class: 'title' }, x.title), h('div', { class: 'sub' }, x.status.replace('_', ' '))))) : [empty('Nothing open.')])));
    parts.push(section(kind === 'education' ? 'Documents & notes' : 'Files'),
      h('div', { class: 'list' }, ...(o.files.length ? o.files.map((f) => h('a', { class: 'list-item', href: `#/s/${f.session_id}` }, icon('file'),
        h('div', { class: 'grow' }, h('div', { class: 'title' }, f.filename), h('div', { class: 'sub' }, `${f.kind} · ${fmtBytes(f.size)}`)))) : [empty('Files you add to a session appear here.')])));
    parts.push(section('Outputs'),
      h('div', { class: 'list' }, ...(o.artifacts.length ? o.artifacts.map((a) => h('a', { class: 'list-item', href: `#/workspace/${a.id}` }, icon('layers'),
        h('div', { class: 'grow' }, h('div', { class: 'title' }, a.title), h('div', { class: 'sub' }, `${a.kind} · ${fmtTime(a.updated_at)}`)))) : [empty('Outputs of your sessions appear here.')])));
    parts.push(section('Connected apps'), h('div', { class: 'list' }, ...o.connectors.map((c) => h('div', { class: 'list-item' }, icon('link'),
      h('div', { class: 'grow' }, h('div', { class: 'title' }, c.name), h('div', { class: 'sub' }, c.status === 'connected' ? 'Connected' : 'Not configured on this server'))))));
    body.replaceChildren(...parts);
  } catch (e) { body.replaceChildren(errBox(e)); }
}

export async function sessionsPage(kind, status = 'active', projectId) {
  setHeaderTitle('Sessions');
  const list = h('div', { class: 'list' }, skel(3));
  setMain(h('div', { class: 'page' }, h('div', { class: 'page-head' }, h('div', { class: 'grow' }, h('h1', {}, `${kind ? TITLE[kind] + ' · ' : ''}${status === 'archived' ? 'Archived sessions' : 'Sessions'}`))),
    kind ? h('button', { class: 'btn primary block ws-new', onclick: () => newSessionSheet(kind, projectId) }, icon('plus'), NEW[kind]) : null, list));
  try {
    const r = await api(`/api/work-sessions?status=${status}${kind ? `&workspace=${kind}` : ''}${projectId ? `&project_id=${projectId}` : ''}`);
    list.replaceChildren(...(r.sessions.length ? r.sessions.map((s) => sessionItem(s, !kind)) : [empty('No sessions.')]));
  } catch (e) { list.replaceChildren(errBox(e)); }
}

async function newProject(kind) {
  const name = await promptDialog(kind === 'code' ? 'New repository' : kind === 'education' ? 'New course' : 'New project', 'Name');
  if (!name) return;
  await api(`/api/workspaces/${kind}/projects`, { method: 'POST', body: { name } });
  toast(`Created ${name}`); workspaceHome(kind);
}

/** New Session = a new server-side session (new ID) with its own first thread. */
async function newSessionSheet(kind, presetProject) {
  const o = await api(`/api/workspaces/${kind}`);
  sheet(NEW[kind], (s, close) => {
    const title = h('input', { class: 'input', placeholder: kind === 'education' ? 'e.g. Class 11 Computer Science — Chapter 4' : 'Optional', maxlength: '120' });
    const sel = h('select', { class: 'input' }, kind === 'code' ? null : h('option', { value: '' }, 'None'),
      o.projects.map((p) => h('option', { value: p.id, selected: p.id === presetProject }, p.name)));
    const file = h('input', { type: 'file', accept: kind === 'education' ? '.pdf,.txt,.md' : undefined });
    const msg = h('div', {});
    s.append(h('div', { class: 'field' }, h('label', {}, 'Title'), title),
      kind === 'code' && !o.projects.length ? h('div', { class: 'alert' }, 'A coding session needs a repository. Create one first.') : h('div', { class: 'field' }, h('label', {}, PROJECTS[kind]), sel),
      h('div', { class: 'field' }, h('label', {}, kind === 'education' ? 'Study material (PDF, optional)' : 'File (optional)'), file), msg,
      h('button', { class: 'btn primary block', onclick: async (e) => {
        e.currentTarget.disabled = true;
        try {
          if (kind === 'code' && !o.projects.length) { close(); return newProject('code'); }
          let fileId;
          if (file.files[0]) fileId = (await api('/api/files', { method: 'POST', raw: true, body: file.files[0], headers: { 'X-Filename': encodeURIComponent(file.files[0].name), 'Content-Type': 'application/octet-stream' } })).file.id;
          const r = await api('/api/work-sessions', { method: 'POST', body: { workspace: kind, title: title.value.trim() || undefined, project_id: sel.value || undefined, file_id: fileId } });
          close(); go(`#/s/${r.session.id}`);
        } catch (err) { msg.replaceChildren(errBox(err)); e.currentTarget.disabled = false; }
      } }, 'Start session'));
  });
}

// ---------------------------------------------------------------- session page
export async function sessionPage(id, tab) {
  const main = h('div', { class: 'page ws-session' }, skel(4));
  setMain(main);
  let s;
  try { s = (await api(`/api/work-sessions/${id}`)).session; } catch (e) { return main.replaceChildren(errBox(e)); }
  setHeaderTitle(s.title);
  const pid = s.project?.id;
  const tabs = s.kind === 'code' ? ['Threads', 'Agent', 'Files', 'Changes', 'Branches', 'Run', 'Tasks', 'Logs']
    : s.kind === 'education' ? ['Threads', 'Documents', 'Quiz', 'Flashcards', 'Plan', 'Assignments', 'Notes', 'Logs'] : ['Threads', 'Tasks', 'Files', 'Outputs', 'Logs'];
  const active = tabs.includes(tab) ? tab : 'Threads';
  const panel = h('div', { class: 'ws-panel' });
  const reload = (t = active) => go(`#/s/${id}/${t}`);
  main.replaceChildren(
    h('div', { class: 'page-head' }, h('a', { class: 'icon-btn', href: s.kind === 'work' ? '#/work' : `#/w/${s.kind}`, 'aria-label': 'Back' }, icon('back')),
      h('div', { class: 'grow' }, h('h1', {}, s.title), h('p', { class: 'muted small' }, [TITLE[s.kind], s.project?.name, s.status === 'archived' ? 'archived' : null].filter(Boolean).join(' · '))),
      h('button', { class: 'icon-btn', 'aria-label': 'Session options', onclick: () => sessionMenu(s) }, icon('more'))),
    h('div', { class: 'tabs', role: 'tablist' }, tabs.map((t) => h('button', { role: 'tab', 'aria-selected': String(t === active), onclick: () => reload(t) }, t))),
    panel);
  const P = {
    Threads: () => [h('button', { class: 'btn block', onclick: async () => {
      const title = await promptDialog('New thread', 'Title (each thread is its own conversation in this session)', 'New thread');
      if (!title) return;
      const r = await api(`/api/work-sessions/${id}/threads`, { method: 'POST', body: { title } });
      go(`#/c/${r.thread.id}`);
    } }, icon('plus'), 'New thread'),
    h('div', { class: 'list' }, s.threads.map((t) => h('a', { class: 'list-item', href: `#/c/${t.id}` }, icon('chat'),
      h('div', { class: 'grow' }, h('div', { class: 'title' }, t.title), h('div', { class: 'sub' }, `${t.message_count} messages · ${fmtTime(t.updated_at)}`))))),
    s.kind === 'work' ? h('button', { class: 'btn block', onclick: async () => {
      const goal = await promptDialog('Plan with Approx', 'Goal — Approx creates tasks, each with its own thread');
      if (!goal) return;
      const r = await api(`/api/work-sessions/${id}/plan`, { method: 'POST', body: { goal } });
      toast(`${r.tasks.length} tasks planned`); reload('Tasks');
    } }, icon('spark'), 'Plan a goal into tasks') : null],
    Tasks: () => taskPanel(s, 'task', reload), Assignments: () => taskPanel(s, 'assignment', reload),
    Files: () => (s.kind === 'code' ? codeFiles(pid) : filePanel(s, reload)), Documents: () => filePanel(s, reload),
    Outputs: () => outputPanel(s, reload, false), Notes: () => outputPanel(s, reload, true),
    Logs: () => [h('div', { class: 'list' }, s.logs.length ? s.logs.map((l) => h('div', { class: 'list-item' }, icon(l.status === 'ok' ? 'check' : 'flag'),
      h('div', { class: 'grow' }, h('div', { class: 'title' }, `${l.tool} · ${l.status}`), h('div', { class: 'sub' }, `${l.input} → ${l.output} · ${fmtTime(l.created_at)}`)))) : [empty('No tool runs yet.')])],
    Changes: () => changesPanel(pid, id, reload), Branches: () => branchPanel(pid, reload), Run: () => runPanel(pid, id, reload), Quiz: () => quizPanel(s),
    Agent: () => agentPanel(s, pid, reload), Flashcards: () => flashcardsPanel(s), Plan: () => planPanel(s, reload),
  };
  panel.append(...(await P[active]()).filter(Boolean));
}

async function sessionMenu(s) {
  sheet(s.title, (el, close) => {
    const act = (label, fn) => h('button', { class: 'btn block', onclick: async () => { close(); await fn(); } }, label);
    el.append(
      act('Rename', async () => { const t = await promptDialog('Rename session', 'Title', s.title); if (t) { await api(`/api/work-sessions/${s.id}`, { method: 'PATCH', body: { title: t } }); go(`#/s/${s.id}`); } }),
      act('Session notes', async () => { const t = await promptDialog('Session notes', 'Notes shared by every thread of this session', s.context); if (t !== null) { await api(`/api/work-sessions/${s.id}`, { method: 'PATCH', body: { context: t } }); toast('Saved'); } }),
      act('Duplicate', async () => { const r = await api(`/api/work-sessions/${s.id}/duplicate`, { method: 'POST', body: {} }); toast('Duplicated'); go(`#/s/${r.session.id}`); }),
      act(s.status === 'archived' ? 'Unarchive' : 'Archive', async () => { await api(`/api/work-sessions/${s.id}`, { method: 'PATCH', body: { status: s.status === 'archived' ? 'active' : 'archived' } }); go(`#/s/${s.id}`); }),
      act('Delete', async () => { if (await confirmDialog('Delete session?', 'Its threads and messages are deleted. Files stay in Files.', 'Delete', true)) { await api(`/api/work-sessions/${s.id}`, { method: 'DELETE' }); go(s.kind === 'work' ? '#/work' : `#/w/${s.kind}`); } }));
  });
}

function taskPanel(s, kind, reload) {
  const inp = h('input', { class: 'input', placeholder: kind === 'assignment' ? 'New assignment (e.g. Exercise 4.2)' : 'New task' });
  const items = s.tasks.filter((t) => kind === 'task' || t.kind === 'assignment');
  return [h('div', { class: 'row' }, inp, h('button', { class: 'btn primary', onclick: async () => {
    if (!inp.value.trim()) return;
    await api(`/api/work-sessions/${s.id}/tasks`, { method: 'POST', body: { title: inp.value.trim(), kind } }); reload(kind === 'assignment' ? 'Assignments' : 'Tasks');
  } }, 'Add')),
  h('div', { class: 'list' }, items.length ? items.map((t) => h('div', { class: 'list-item' },
    h('input', { type: 'checkbox', checked: t.status === 'done', 'aria-label': `Done: ${t.title}`, onchange: async (e) => { await api(`/api/tasks/${t.id}`, { method: 'PATCH', body: { status: e.target.checked ? 'done' : 'todo' } }); } }),
    h('div', { class: 'grow' }, h('div', { class: 'title' }, t.title), h('div', { class: 'sub' }, [t.status.replace('_', ' '), t.created_by === 'agent' ? 'planned by Approx' : null].filter(Boolean).join(' · '),
      t.overdue ? h('span', { class: 'badge error' }, ' overdue') : null)),
    h('input', { type: 'date', class: 'input due', 'aria-label': `Due date: ${t.title}`, value: t.due_at ? new Date(t.due_at - new Date(t.due_at).getTimezoneOffset() * 60000).toISOString().slice(0, 10) : '',
      onchange: async (e) => { await api(`/api/tasks/${t.id}`, { method: 'PATCH', body: { due_at: e.target.value ? new Date(`${e.target.value}T23:59:00`).getTime() : null } }); toast(e.target.value ? 'Due date saved' : 'Due date cleared'); reload(kind === 'assignment' ? 'Assignments' : 'Tasks'); } }),
    t.thread_id ? h('a', { class: 'btn small', href: `#/c/${t.thread_id}` }, 'Open thread') : null)) : [empty('Nothing here yet.')])];
}

function filePanel(s, reload) {
  const file = h('input', { type: 'file', 'aria-label': 'Add a file to this session' });
  return [h('p', { class: 'muted small' }, 'Every thread of this session reads its files.'),
    h('div', { class: 'row' }, file, h('button', { class: 'btn primary', onclick: async () => {
      if (!file.files[0]) return;
      await api('/api/files', { method: 'POST', raw: true, body: file.files[0], headers: { 'X-Filename': encodeURIComponent(file.files[0].name), 'X-Session-Id': s.id, 'Content-Type': 'application/octet-stream' } });
      toast('Added'); reload(s.kind === 'education' ? 'Documents' : 'Files');
    } }, 'Upload')),
    h('div', { class: 'list' }, s.files.length ? s.files.map((f) => h('div', { class: 'list-item' }, icon('file'), h('div', { class: 'grow' }, h('div', { class: 'title' }, f.filename),
      h('div', { class: 'sub' }, `${fmtBytes(f.size)} · ${f.has_text ? 'readable' : 'not readable as text'}`)),
      h('button', { class: 'btn small', onclick: async () => { await api(`/api/work-sessions/${s.id}/files/${f.id}`, { method: 'DELETE' }); toast('Removed from this session (still in Files)'); reload(s.kind === 'education' ? 'Documents' : 'Files'); } }, 'Remove'))) : [empty('No files yet.')])];
}

function outputPanel(s, reload, notes) {
  const title = h('input', { class: 'input', placeholder: 'Title' });
  const content = h('textarea', { class: 'input', rows: '5', placeholder: 'Content (Markdown)' });
  return [h('details', {}, h('summary', {}, notes ? 'New note' : 'New document'), title, content, h('button', { class: 'btn primary', onclick: async () => {
    await api('/api/workspace/artifacts', { method: 'POST', body: { title: title.value.trim() || 'Untitled', kind: 'markdown', content: content.value, session_id: s.id } });
    reload(notes ? 'Notes' : 'Outputs');
  } }, 'Save')),
  h('div', { class: 'list' }, s.artifacts.length ? s.artifacts.map((a) => h('a', { class: 'list-item', href: `#/workspace/${a.id}` }, icon('layers'),
    h('div', { class: 'grow' }, h('div', { class: 'title' }, a.title), h('div', { class: 'sub' }, `${a.kind} · v${a.current_version}`)))) : [empty('No outputs yet.')])];
}

async function codeFiles(pid) {
  const r = await api(`/api/fabbox/${pid}/files`);
  return [h('a', { class: 'btn block', href: `#/code/${pid}` }, icon('code'), 'Open the editor'),
    h('div', { class: 'list' }, r.files.length ? r.files.map((f) => h('a', { class: 'list-item mono', href: `#/code/${pid}` }, icon('file'), h('div', { class: 'grow' }, h('div', { class: 'title' }, f.path), h('div', { class: 'sub' }, `${f.size} B`)))) : [empty('The repository is empty.')])];
}

async function changesPanel(pid, sid, reload) {
  const st = await api(`/api/code/${pid}/status`);
  const d = await api(`/api/code/${pid}/diff`);
  const msg = h('input', { class: 'input', placeholder: 'Commit message' });
  return [h('p', { class: 'muted small' }, `Branch ${st.branch} · ${st.changes.length} changed file(s)`),
    h('div', { class: 'row' }, msg, h('button', { class: 'btn primary', disabled: !st.changes.length, onclick: async () => {
      const r = await api(`/api/code/${pid}/commit`, { method: 'POST', body: { message: msg.value.trim() || 'Update', session_id: sid } });
      toast(`Committed ${r.commit.files.length} file(s) to ${r.commit.branch}`); reload('Changes');
    } }, 'Commit')),
    ...(d.diffs.length ? d.diffs.map((x) => h('div', { class: 'card' }, h('b', {}, `${x.status.toUpperCase()} ${x.path}`), h('pre', { class: 'diff' }, x.diff))) : [empty('Working tree clean.')])];
}

async function branchPanel(pid, reload) {
  const b = await api(`/api/code/${pid}/branches`);
  const log = await api(`/api/code/${pid}/log`);
  const name = h('input', { class: 'input', placeholder: 'New branch (e.g. feature/login)' });
  return [h('div', { class: 'row' }, name, h('button', { class: 'btn', onclick: async () => { await api(`/api/code/${pid}/branches`, { method: 'POST', body: { name: name.value.trim() } }); reload('Branches'); } }, 'Create')),
    h('div', { class: 'list' }, b.branches.map((x) => h('div', { class: 'list-item' }, icon('code'), h('div', { class: 'grow' }, h('div', { class: 'title' }, x.name + (x.name === b.current ? ' (current)' : ''))),
      x.name === b.current ? null : h('button', { class: 'btn small', onclick: async () => { await api(`/api/code/${pid}/checkout`, { method: 'POST', body: { branch: x.name } }); toast(`Switched to ${x.name}`); reload('Branches'); } }, 'Switch')))),
    section(`History of ${b.current}`), h('div', { class: 'list' }, log.commits.length ? log.commits.map((c) => h('div', { class: 'list-item' }, h('code', {}, c.id.slice(4, 11)),
      h('div', { class: 'grow' }, h('div', { class: 'title' }, c.message), h('div', { class: 'sub' }, fmtTime(c.created_at))))) : [empty('No commits yet.')])];
}

function runPanel(pid, sid, reload) {
  const cmd = h('input', { class: 'input', placeholder: 'npm test' });
  const kind = h('select', { class: 'input' }, ['terminal', 'run', 'test', 'build'].map((k) => h('option', { value: k }, k)));
  const out = h('div', {});
  return [h('p', { class: 'muted small' }, 'Terminal, run, test and build need an isolated sandbox runner. Attempts are logged in this session.'),
    h('div', { class: 'row' }, kind, cmd, h('button', { class: 'btn primary', onclick: async () => {
      try { await api(`/api/code/${pid}/run`, { method: 'POST', body: { command: cmd.value.trim() || 'npm test', kind: kind.value, session_id: sid } }); }
      catch (e) { out.replaceChildren(h('div', { class: 'alert' }, e.message)); }
    } }, 'Run')), out];
}

function quizPanel(s) {
  const topic = h('input', { class: 'input', placeholder: 'Topic (optional — default: the whole material)' });
  const out = h('div', {});
  return [h('div', { class: 'row' }, topic, h('button', { class: 'btn primary', onclick: async (e) => {
    e.currentTarget.disabled = true;
    try {
      const { quiz } = await api(`/api/work-sessions/${s.id}/quiz`, { method: 'POST', body: { count: 5, topic: topic.value.trim() } });
      const form = h('form', { onsubmit: async (ev) => {
        ev.preventDefault();
        const answers = quiz.questions.map((_, i) => Number(new FormData(form).get(`q${i}`) ?? -1));
        const r = await api(`/api/work-sessions/${s.id}/quiz/${quiz.artifact_id}/attempt`, { method: 'POST', body: { answers } });
        out.append(h('div', { class: 'alert ok' }, `Score ${r.score}/${r.total} (${r.percent}%)`), ...r.results.map((x, i) => h('p', { class: 'small' }, `${i + 1}. ${x.correct ? '✓' : `✗ answer ${'ABCD'[x.answer]}`} ${x.explanation}`)));
      } }, h('h3', {}, quiz.title), ...quiz.questions.map((q, i) => h('fieldset', { class: 'card' }, h('legend', {}, `${i + 1}. ${q.question}`),
        ...q.options.map((o, j) => h('label', { class: 'row' }, h('input', { type: 'radio', name: `q${i}`, value: String(j) }), `${'ABCD'[j]}. ${o}`)))), h('button', { class: 'btn primary', type: 'submit' }, 'Submit'));
      out.replaceChildren(form);
    } catch (err) { out.replaceChildren(errBox(err)); } finally { e.currentTarget.disabled = false; }
  } }, 'Create quiz')), out];
}

/** All the person's files (uploads, session documents), with upload. */
export async function filesPage() {
  setHeaderTitle('Files');
  const list = h('div', { class: 'list' }, skel(3));
  const file = h('input', { type: 'file', 'aria-label': 'Upload a file' });
  const load = async () => {
    try {
      const r = await api('/api/files');
      list.replaceChildren(...(r.files.length ? r.files.map((f) => h('a', { class: 'list-item', href: `/api/files/${f.id}/download` }, icon('file'),
        h('div', { class: 'grow' }, h('div', { class: 'title' }, f.filename), h('div', { class: 'sub' }, `${f.kind} · ${fmtBytes(f.size)} · ${f.scan_status} · ${fmtTime(f.created_at)}`)))) : [empty('No files yet.')]));
    } catch (e) { list.replaceChildren(errBox(e)); }
  };
  setMain(h('div', { class: 'page' }, h('div', { class: 'page-head' }, h('div', { class: 'grow' }, h('h1', {}, 'Files'), h('p', { class: 'muted small' }, 'Everything you uploaded, including session documents.'))),
    h('div', { class: 'row' }, file, h('button', { class: 'btn primary', onclick: async () => {
      if (!file.files[0]) return;
      await api('/api/files', { method: 'POST', raw: true, body: file.files[0], headers: { 'X-Filename': encodeURIComponent(file.files[0].name), 'Content-Type': 'application/octet-stream' } });
      toast('Uploaded'); load();
    } }, 'Upload')), list));
  load();
}

// ---------------------------------------------------------------- code agent (Settings → Approx Code permissions decide review vs. apply)
function agentPanel(s, pid, reload) {
  const ins = h('textarea', { class: 'input', rows: '3', placeholder: 'What should Approx change? e.g. Add input validation to src/app.js', 'aria-label': 'Agent instruction' });
  const msg = h('div', {});
  return [ins, h('button', { class: 'btn primary', onclick: async (e) => {
    e.currentTarget.disabled = true;
    try {
      const r = await api(`/api/fabbox/${pid}/agent`, { method: 'POST', body: { instruction: ins.value.trim(), session_id: s.id } });
      toast(r.proposal.status === 'applied' ? 'Applied (automatic permissions) — see Changes' : 'Proposal ready for review'); reload('Agent');
    } catch (err) { msg.replaceChildren(errBox(err)); e.currentTarget.disabled = false; }
  } }, 'Propose changes'), msg,
  h('p', { class: 'small muted' }, 'Settings → Workspaces → Agent permissions: Manual = review here first; Automatic = applied at once.'),
  h('div', { class: 'list' }, s.proposals.length ? s.proposals.map((p) => h('div', { class: 'list-item' }, icon('code'),
    h('div', { class: 'grow' }, h('div', { class: 'title' }, `${p.status.toUpperCase()} · ${p.summary}`), h('pre', { class: 'diff' }, p.files.join('\n'))),
    p.status === 'pending' ? h('div', { class: 'row' },
      h('button', { class: 'btn small primary', onclick: async () => { await api(`/api/fabbox/${pid}/proposals/${p.id}/approve`, { method: 'POST' }); toast('Applied — see Changes'); reload('Agent'); } }, 'Approve & apply'),
      h('button', { class: 'btn small', onclick: async () => { await api(`/api/fabbox/${pid}/proposals/${p.id}/reject`, { method: 'POST' }); toast('Rejected'); reload('Agent'); } }, 'Reject')) : null))
    : [empty('No proposals yet.')])];
}

// ---------------------------------------------------------------- education: flashcards + study plan
function flashcardsPanel(s) {
  const topic = h('input', { class: 'input', placeholder: 'Topic (optional)' });
  const out = h('div', {});
  const show = (set) => {
    let i = 0; let back = false;
    const face = h('button', { class: 'card flashcard', type: 'button', onclick: () => { back = !back; draw(); } });
    const counter = h('p', { class: 'small muted' });
    const draw = () => { const c = set.cards[i]; face.textContent = back ? c.back : c.front; counter.textContent = `Card ${i + 1} of ${set.cards.length} · ${back ? 'answer' : 'tap to flip'}`; };
    out.replaceChildren(h('h3', {}, set.title), face, counter, h('button', { class: 'btn', onclick: () => { i = (i + 1) % set.cards.length; back = false; draw(); } }, 'Next card'));
    draw();
  };
  const saved = s.artifacts.filter((a) => a.language === 'flashcards');
  return [h('div', { class: 'row' }, topic, h('button', { class: 'btn primary', onclick: async (e) => {
    e.currentTarget.disabled = true;
    try { show((await api(`/api/work-sessions/${s.id}/flashcards`, { method: 'POST', body: { count: 12, topic: topic.value.trim() } })).flashcards); }
    catch (err) { out.replaceChildren(errBox(err)); } finally { e.currentTarget.disabled = false; }
  } }, 'Create flashcards')), out,
  saved.length ? section('Saved sets') : null,
  saved.length ? h('div', { class: 'list' }, saved.map((a) => h('button', { class: 'list-item', onclick: async () => {
    const r = await api(`/api/workspace/artifacts/${a.id}`); show(JSON.parse(r.artifact.content));
  } }, icon('layers'), h('span', { class: 'grow' }, a.title)))) : null];
}

function planPanel(s, reload) {
  const days = h('input', { class: 'input', type: 'number', min: '1', max: '30', value: '7', 'aria-label': 'Days' });
  const msg = h('div', {});
  return [h('p', { class: 'muted small' }, 'Approx plans this material day by day and adds one dated assignment per day (see Assignments and Progress).'),
    h('div', { class: 'row' }, days, h('button', { class: 'btn primary', onclick: async (e) => {
      e.currentTarget.disabled = true;
      try { const r = await api(`/api/work-sessions/${s.id}/study-plan`, { method: 'POST', body: { days: Number(days.value) || 7 } }); toast(`${r.plan.assignments} daily assignments added`); reload('Assignments'); }
      catch (err) { msg.replaceChildren(errBox(err)); e.currentTarget.disabled = false; }
    } }, 'Create study plan')), msg];
}

// ================================================================= navigation hub (API 1.10)
const ago = (t) => (t ? fmtTime(t) : '');
function sessionRow2(s) {
  const meta = [s.project?.name, s.branch ? `⎇ ${s.branch}` : null, s.device?.name, s.workspace, ago(s.last_activity)].filter(Boolean).join(' · ');
  return h('a', { class: 'list-item', href: `#/s/${s.id}` }, icon(ICON[s.kind] || 'chat'),
    h('div', { class: 'grow' }, h('div', { class: 'title' }, s.title), h('div', { class: 'sub' }, meta)), h('span', { class: `badge ${s.status === 'running' ? 'green' : ''}` }, s.status));
}

/** Code: Devices (+ Add device → pairing) and Sessions (search, filter), + New session. */
export async function codePage(filter = 'all') {
  setHeaderTitle('Approx Code');
  const devices = h('div', { class: 'list' }, skel(1));
  const perm = h('span', { class: 'badge', title: 'Approx Code agent permissions (Settings → Approx Code)' }, '…');
  api('/api/settings').then((r) => { const m = r.settings.permissions_mode; perm.textContent = m === 'auto' ? 'Auto-apply changes' : 'Review before applying'; perm.className = `badge ${m === 'auto' ? 'warn' : 'green'}`; }).catch(() => { perm.remove(); });
  const list = h('div', { class: 'list' }, skel(2));
  const q = h('input', { class: 'input', type: 'search', placeholder: 'Search sessions', 'aria-label': 'Search sessions' });
  const load = async () => {
    const view = filter === 'all' ? 'recent' : filter;
    const r = await api(`/api/session-history?workspace=code&view=${view}${q.value.trim() ? `&q=${encodeURIComponent(q.value.trim())}` : ''}`);
    list.replaceChildren(...(r.sessions.length ? r.sessions.map(sessionRow2) : [empty(q.value.trim() ? `No session matches “${q.value.trim()}”.` : 'No sessions yet')]));
  };
  let t; q.addEventListener('input', () => { clearTimeout(t); t = setTimeout(load, 250); });
  setMain(h('div', { class: 'page ws-page' },
    h('div', { class: 'page-head' }, h('div', { class: 'grow' }, h('h1', {}, 'Approx Code')), h('a', { class: 'icon-btn', href: '#/sessions/code', 'aria-label': 'Session history', title: 'Session history' }, icon('history'))),
    h('div', { class: 'code-topbar' }, h('button', { class: 'btn primary', onclick: () => newSessionSheet('code') }, icon('plus'), 'New session'),
      h('button', { class: 'btn', onclick: connectClaude }, icon('link'), 'Connect with Claude'), h('a', { class: 'btn', href: '#/code' }, icon('folder'), 'Repositories'), perm),
    h('h2', { class: 'section' }, 'Devices'), devices,
    h('h2', { class: 'section' }, 'Sessions'), q,
    h('div', { class: 'tabs', role: 'tablist' }, [['all', 'All'], ['active', 'Active'], ['archived', 'Archived']].map(([k, l]) => h('button', { role: 'tab', 'aria-selected': String(k === filter), onclick: () => codePage(k) }, l))),
    list, h('button', { class: 'btn primary fab', onclick: () => newSessionSheet('code') }, icon('plus'), 'New session')));
  const dr = await api('/api/devices');
  devices.replaceChildren(...(dr.devices.length ? dr.devices.map((d) => h('div', { class: 'list-item' }, icon('code'),
    h('div', { class: 'grow' }, h('div', { class: 'title' }, d.name), h('div', { class: 'sub' }, [d.hostname, d.last_seen_at ? `seen ${ago(d.last_seen_at)}` : 'not seen yet'].filter(Boolean).join(' · '))),
    h('span', { class: `badge ${d.online ? 'green' : ''}` }, d.status === 'pending' ? 'pending' : d.online ? 'online' : 'offline'),
    h('button', { class: 'icon-btn', 'aria-label': `Remove ${d.name}`, onclick: async () => { if (await confirmDialog(`Remove ${d.name}?`, 'It stops receiving commands; its token is revoked.', 'Remove', true)) { await api(`/api/devices/${d.id}`, { method: 'DELETE' }); codePage(filter); } } }, icon('trash'))))
    : [empty('No devices connected')]), h('button', { class: 'list-item', onclick: addDevice }, icon('plus'), h('span', { class: 'grow' }, 'Add device')));
  await load();
}

async function addDevice() {
  const name = await promptDialog('Add device', 'Device name (e.g. Work laptop)');
  if (!name) return;
  const p = await api('/api/devices', { method: 'POST', body: { name } });
  const status = h('p', { class: 'muted' }, 'Waiting for the device to connect…');
  sheet('Add device', (s) => {
    const win = /Windows/i.test(navigator.userAgent);
    const cmd = win && p.command_windows ? p.command_windows : p.command;
    s.append(h('p', {}, `1. On the computer (Node.js 18+ installed), run in ${win ? 'PowerShell' : 'a terminal'}:`), h('pre', { class: 'diff' }, cmd),
      h('button', { class: 'btn', onclick: () => navigator.clipboard?.writeText(cmd).then(() => toast('Copied')) }, 'Copy command'),
      p.command_windows ? h('details', { class: 'small' }, h('summary', {}, win ? 'macOS / Linux command' : 'Windows (PowerShell) command'), h('pre', { class: 'diff' }, win ? p.command : p.command_windows)) : null,
      h('p', {}, 'Pairing code (valid 10 minutes, works once):'), h('div', { class: 'pair-code' }, p.pairing_code), status);
    const until = Date.now() + 600_000;
    const poll = async () => {
      if (!status.isConnected) return;
      const d = (await api('/api/devices')).devices.find((x) => x.id === p.device.id);
      if (d?.status === 'connected') { status.textContent = `✓ Connected: ${d.name}${d.hostname ? ` (${d.hostname})` : ''}`; status.className = 'alert ok'; return; }
      if (Date.now() < until) setTimeout(poll, 2500); else status.textContent = 'The code expired. Add the device again.';
    };
    setTimeout(poll, 2500);
  }, { onClose: () => { if (location.hash.startsWith('#/w/code')) codePage(); } });
}

/** Sessions: Recent / Active / Archived across Co Approx, Code and Education, with search and a workspace filter. */
export async function historyPage(kind = null, view = 'recent') {
  setHeaderTitle('Sessions');
  const list = h('div', { class: 'list' }, skel(3));
  const q = h('input', { class: 'input', type: 'search', placeholder: 'Search sessions and messages', 'aria-label': 'Search sessions' });
  const load = async () => {
    const r = await api(`/api/session-history?view=${view}${kind ? `&workspace=${kind}` : ''}${q.value.trim() ? `&q=${encodeURIComponent(q.value.trim())}` : ''}`);
    list.replaceChildren(...(r.sessions.length ? r.sessions.map(sessionRow2) : [empty(view === 'archived' ? 'No archived sessions' : 'No sessions yet')]));
  };
  let t; q.addEventListener('input', () => { clearTimeout(t); t = setTimeout(load, 250); });
  const tabs = (items, cur, go2) => h('div', { class: 'tabs', role: 'tablist' }, items.map(([k, l]) => h('button', { role: 'tab', 'aria-selected': String(k === cur), onclick: () => go2(k) }, l)));
  setMain(h('div', { class: 'page' }, h('div', { class: 'page-head' }, h('div', { class: 'grow' }, h('h1', {}, 'Sessions'))),
    tabs([['recent', 'Recent'], ['active', 'Active'], ['archived', 'Archived']], view, (v) => historyPage(kind, v)), q,
    tabs([[null, 'All'], ['work', 'Approx Work'], ['code', 'Approx Code'], ['education', 'Education']], kind, (k) => historyPage(k, view)),
    list, h('a', { class: 'small', href: '#/history' }, 'Conversations (chat history)')));
  await load();
}

const FREQS = [['once', 'Once'], ['hourly', 'Hourly'], ['daily', 'Daily'], ['weekdays', 'Weekdays'], ['weekly', 'Weekly']];
/** Scheduled: tasks that run on their own schedule; each run is a real Co Approx session. */
export async function scheduledPage() {
  setHeaderTitle('Scheduled');
  const list = h('div', { class: 'list' }, skel(2));
  setMain(h('div', { class: 'page' }, h('div', { class: 'page-head' }, h('div', { class: 'grow' }, h('h1', {}, 'Scheduled'))), list,
    h('button', { class: 'btn primary fab', onclick: newTaskSheet }, icon('plus'), 'New task')));
  const r = await api('/api/scheduled');
  list.replaceChildren(...(r.tasks.length ? r.tasks.map((t) => h('div', { class: 'list-item' }, icon('calendar'),
    h('div', { class: 'grow' }, h('div', { class: 'title' }, t.name), h('div', { class: 'sub' }, [FREQS.find((f) => f[0] === t.frequency)?.[1], t.enabled && t.next_run_at ? `next ${new Date(t.next_run_at).toLocaleString()}` : 'paused',
      t.last_run ? `last run ${t.last_run.status}` : null].filter(Boolean).join(' · ')), t.last_run?.session_id ? h('a', { class: 'small', href: `#/s/${t.last_run.session_id}` }, 'Open last run') : null),
    h('input', { type: 'checkbox', role: 'switch', checked: t.enabled, 'aria-label': `Enabled: ${t.name}`, onchange: async (e) => { await api(`/api/scheduled/${t.id}`, { method: 'PATCH', body: { enabled: e.target.checked } }); scheduledPage(); } }),
    h('button', { class: 'btn small', onclick: async (e) => { e.currentTarget.disabled = true; const x = await api(`/api/scheduled/${t.id}/run`, { method: 'POST' }); toast(`Run ${x.run.status}`); if (x.run.session_id) location.hash = `#/s/${x.run.session_id}`; } }, 'Run now'),
    h('button', { class: 'icon-btn', 'aria-label': `Delete ${t.name}`, onclick: async () => { if (await confirmDialog('Delete this scheduled task?', 'Its past sessions stay in Approx Work.', 'Delete', true)) { await api(`/api/scheduled/${t.id}`, { method: 'DELETE' }); scheduledPage(); } } }, icon('trash'))))
    : [h('div', { class: 'empty-state' }, h('h3', {}, 'No scheduled tasks yet'), h('p', { class: 'muted' }, 'Scheduled tasks run automatically on their configured schedule.'))]));
}

function newTaskSheet() {
  sheet('Create scheduled task', (s, close) => {
    const name = h('input', { class: 'input', 'aria-label': 'Task name', maxlength: '100' });
    const ins = h('textarea', { class: 'input', rows: '3', 'aria-label': 'Instructions' });
    const freq = h('select', { class: 'input', 'aria-label': 'Frequency' }, FREQS.map(([v, l]) => h('option', { value: v, selected: v === 'daily' }, l)));
    const d = new Date(Date.now() + 3600_000); d.setMinutes(0);
    const start = h('input', { class: 'input', type: 'datetime-local', 'aria-label': 'Starts', value: new Date(d - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16) });
    const tz = h('input', { class: 'input', 'aria-label': 'Time zone', value: Intl.DateTimeFormat().resolvedOptions().timeZone });
    const ws = h('select', { class: 'input', 'aria-label': 'Workspace' }, [['work', 'Approx Work'], ['code', 'Approx Code'], ['education', 'Education']].map(([v, l]) => h('option', { value: v }, l)));
    const tools = [['session_files', 'Session files'], ['research_urls', 'Research (URL sources)'], ['artifacts', 'Artifacts'], ['code_repository', 'Code repository']].map(([v, l]) => [v, h('input', { type: 'checkbox', 'aria-label': l }), l]);
    const en = h('input', { type: 'checkbox', checked: true, 'aria-label': 'Enabled' });
    const msg = h('div', {});
    const field = (l, el) => h('div', { class: 'field' }, h('label', {}, l), el);
    s.append(field('Task name', name), field('Instructions', ins), field('Frequency', freq), field('Starts', start), field('Time zone', tz), field('Workspace', ws),
      h('div', { class: 'field' }, h('label', {}, 'Tools'), ...tools.map(([, c, l]) => h('label', { class: 'row' }, c, l))),
      h('label', { class: 'row' }, en, 'Enabled'), h('p', { class: 'small muted' }, 'Connected services (Gmail, Drive…) are not configured on this server yet.'), msg,
      h('button', { class: 'btn primary block', onclick: async () => {
        try {
          await api('/api/scheduled', { method: 'POST', body: { name: name.value.trim(), instructions: ins.value.trim(), frequency: freq.value, start_at: start.value, timezone: tz.value.trim(),
            workspace: ws.value, enabled: en.checked, tools: tools.filter(([, c]) => c.checked).map(([v]) => v) } });
          close(); toast('Scheduled task saved'); scheduledPage();
        } catch (e) { msg.replaceChildren(errBox(e)); }
      } }, 'Save'));
  });
}

/** Artifacts: everything Approx produced, searchable; open / edit / rename / share / delete. */
export async function artifactsPage() {
  setHeaderTitle('Artifacts');
  const list = h('div', { class: 'list' }, skel(2));
  const q = h('input', { class: 'input', type: 'search', placeholder: 'Search artifacts', 'aria-label': 'Search artifacts' });
  const load = async () => {
    const r = await api(`/api/artifacts${q.value.trim() ? `?q=${encodeURIComponent(q.value.trim())}` : ''}`);
    list.replaceChildren(...(r.artifacts.length ? r.artifacts.map((a) => h('div', { class: 'list-item' }, icon('layers'),
      h('a', { class: 'grow', href: `#/workspace/${a.id}` }, h('div', { class: 'title' }, a.title), h('div', { class: 'sub' }, [a.language === 'quiz' ? 'quiz' : a.language === 'flashcards' ? 'flashcards' : a.kind, `v${a.current_version}`, a.session_title, ago(a.updated_at)].filter(Boolean).join(' · '))),
      a.shared ? h('span', { class: 'badge green' }, 'shared') : null,
      h('button', { class: 'icon-btn', 'aria-label': `Rename ${a.title}`, onclick: async () => { const t2 = await promptDialog('Rename', 'Title', a.title); if (t2) { await api(`/api/artifacts/${a.id}`, { method: 'PATCH', body: { title: t2 } }); load(); } } }, icon('edit')),
      h('button', { class: 'icon-btn', 'aria-label': `Share ${a.title}`, onclick: async () => { const x = await api(`/api/artifacts/${a.id}/share`, { method: 'POST' }); await navigator.clipboard?.writeText(x.url).catch(() => {}); toast('Share link copied'); load(); } }, icon('share')),
      h('button', { class: 'icon-btn', 'aria-label': `Delete ${a.title}`, onclick: async () => { if (await confirmDialog('Delete artifact?', 'All versions are deleted.', 'Delete', true)) { await api(`/api/workspace/artifacts/${a.id}`, { method: 'DELETE' }); load(); } } }, icon('trash'))))
      : [h('div', { class: 'empty-state' }, h('h3', {}, q.value.trim() ? 'No artifact matches' : 'No artifacts yet'))]));
  };
  let t; q.addEventListener('input', () => { clearTimeout(t); t = setTimeout(load, 250); });
  setMain(h('div', { class: 'page' }, h('div', { class: 'page-head' }, h('div', { class: 'grow' }, h('h1', {}, 'Artifacts'))), q, list,
    h('button', { class: 'btn primary fab', onclick: async () => {
      const title = await promptDialog('Create artifact', 'Title');
      if (!title) return;
      const r = await api('/api/workspace/artifacts', { method: 'POST', body: { title, kind: 'markdown', content: `# ${title}\n` } });
      location.hash = `#/workspace/${r.artifact.id}`;
    } }, icon('plus'), 'Create artifact')));
  await load();
}

/** "Connect with Claude": the honest state of the two different things this can mean. */
async function connectClaude() {
  const st = await api('/api/integrations').catch(() => null);
  sheet('Connect with Claude', (s) => {
    s.append(
      h('h3', {}, 'Claude as a model inside Approx Code'),
      st?.claude?.configured
        ? h('p', { class: 'alert ok' }, 'Configured on this server: an operator has added an Anthropic API key (it stays on the server).')
        : h('p', {}, 'Not connected. An Approx administrator must add an Anthropic API key to the server configuration (ANTHROPIC_API_KEY on Vercel). The key is never stored in the app or the browser.'),
      h('h3', {}, 'Claude Code (separate product)'),
      h('p', { class: 'small muted' }, 'Claude Code by Anthropic works on your own GitHub repository in its own cloud sessions. It is separate from Approx and from Approx\u2019s own models; signing in happens on claude.ai.'),
      h('a', { class: 'btn block', href: 'https://claude.ai/code', target: '_blank', rel: 'noopener' }, 'Open Claude Code'));
  });
}
