// DOM helpers + icon set (inline SVG built via DOM, CSP-safe).
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v; // only used with sanitized markdown output
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

const P = {
  plus: 'M12 5v14M5 12h14',
  send: 'M5 12h14M13 6l6 6-6 6',
  stop: 'M7 7h10v10H7z',
  chat: 'M4 5h16v11H8l-4 4z',
  history: 'M12 8v4l3 2M3.05 11a9 9 0 1 1 .5 4M3 4v4h4',
  settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z',
  file: 'M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9zM14 3v6h6',
  image: 'M4 5h16v14H4zM8 11a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM20 15l-5-5L5 19',
  pdf: 'M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9zM14 3v6h6M8 13h2a1.5 1.5 0 0 1 0 3H8v-5M14 13v5M17 13h-2',
  doc: 'M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9zM14 3v6h6M8 13h8M8 17h6',
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM21 21l-5-5',
  code: 'M8 7l-5 5 5 5M16 7l5 5-5 5M14 4l-4 16',
  data: 'M4 20V10M10 20V4M16 20v-7M22 20H2',
  plug: 'M9 7V2M15 7V2M6 7h12v4a6 6 0 0 1-12 0zM12 17v5',
  camera: 'M4 7h3l2-3h6l2 3h3v12H4zM12 17a4 4 0 1 0 0-8 4 4 0 0 0 0 8z',
  folder: 'M3 6h6l2 2h10v11H3z',
  layers: 'M12 3l9 5-9 5-9-5zM3 13l9 5 9-5',
  copy: 'M9 9h11v11H9zM5 15H4V4h11v1',
  refresh: 'M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7',
  save: 'M5 3h11l3 3v15H5zM8 3v5h7M8 21v-7h8v7',
  trash: 'M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3',
  archive: 'M3 4h18v4H3zM5 8v12h14V8M10 12h4',
  edit: 'M4 20h4L19 9l-4-4L4 16zM14 6l4 4',
  close: 'M6 6l12 12M18 6L6 18',
  chevron: 'M6 9l6 6 6-6',
  back: 'M15 6l-6 6 6 6',
  shield: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z',
  restore: 'M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  mic: 'M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3zM19 11a7 7 0 0 1-14 0M12 18v3',
  share: 'M4 12v7a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-7M16 6l-4-4-4 4M12 2v14',
  download: 'M12 3v12M7 10l5 5 5-5M5 21h14',
  up: 'M7 10v11H4V10zM7 10l4-7a2 2 0 0 1 3 2l-1 5h6a2 2 0 0 1 2 2.3l-1.3 7A2 2 0 0 1 17.7 21H7',
  down: 'M17 14V3h3v11zM17 14l-4 7a2 2 0 0 1-3-2l1-5H5a2 2 0 0 1-2-2.3l1.3-7A2 2 0 0 1 6.3 3H17',
  flag: 'M5 21V4M5 4h11l-2 4 2 4H5',
  menu: 'M4 7h16M4 12h16M4 17h10',
  home: 'M4 11l8-7 8 7v9H4zM10 20v-6h4v6',
  user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0',
  card: 'M3 6h18v12H3zM3 10h18M7 15h3',
  gauge: 'M12 14l4-4M4 18a9 9 0 1 1 16 0',
  spark: 'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8z',
  bell: 'M6 9a6 6 0 1 1 12 0c0 6 2 7 2 7H4s2-1 2-7zM10 20a2 2 0 0 0 4 0',
  lock: 'M6 11h12v10H6zM8 11V8a4 4 0 0 1 8 0v3',
  palette: 'M12 3a9 9 0 1 0 0 18c1.1 0 1.5-.8 1.2-1.6-.4-1 .3-2.4 1.6-2.4H17a4 4 0 0 0 4-4c0-5.5-4-10-9-10zM7.5 12h.01M9.5 8h.01M14.5 8h.01',
  help: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM9.5 9a2.5 2.5 0 0 1 4.9.7c0 1.7-2.4 2-2.4 3.5M12 17h.01',
  info: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 11v6M12 7h.01',
  calendar: 'M4 6h16v15H4zM4 10h16M8 3v4M16 3v4',
  work: 'M4 8h16v12H4zM9 8V5h6v3M4 13h16',
  branch: 'M6 3v12M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM18 9a9 9 0 0 1-9 9',
  tasks: 'M9 6h11M9 12h11M9 18h11M4 6l1 1 2-2M4 12l1 1 2-2M4 18l1 1 2-2',
  check: 'M5 12l5 5 9-10',
  account: 'M3 5h18v14H3zM7 15a3 3 0 0 1 6 0M10 11a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM15 9h3M15 13h3',
  logout: 'M15 4h4v16h-4M10 16l-4-4 4-4M6 12h11',
  link: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1',
};
export function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.8');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('d', P[name] || P.file);
  svg.append(p);
  return svg;
}

export function toast(msg, ms = 2600) {
  const t = h('div', { class: 'toast', role: 'status' }, msg);
  document.body.append(t);
  setTimeout(() => t.remove(), ms);
}

export function sheet(title, build, { onClose } = {}) {
  const close = () => { scrim.remove(); document.removeEventListener('keydown', onKey); onClose?.(); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  const body = h('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
    h('div', { class: 'grab' }),
    h('div', { class: 'row' }, h('h2', { class: 'grow' }, title), h('button', { class: 'icon-btn', 'aria-label': 'Close', onclick: close }, icon('close'))));
  const scrim = h('div', { class: 'scrim', onclick: (e) => { if (e.target === scrim) close(); } }, body);
  document.addEventListener('keydown', onKey);
  document.body.append(scrim);
  build(body, close);
  return close;
}

export function confirmDialog(title, message, actionLabel = 'Confirm', danger = false) {
  return new Promise((resolve) => {
    let done = false;
    const close = sheet(title, (s, c) => {
      s.append(h('p', { class: 'muted' }, message), h('div', { class: 'row' },
        h('button', { class: 'btn grow', onclick: () => { done = true; resolve(false); c(); } }, 'Cancel'),
        h('button', { class: `btn grow ${danger ? 'danger' : 'primary'}`, onclick: () => { done = true; resolve(true); c(); } }, actionLabel)));
    }, { onClose: () => { if (!done) resolve(false); } });
    void close;
  });
}

export function promptDialog(title, label, value = '') {
  return new Promise((resolve) => {
    let done = false;
    sheet(title, (s, c) => {
      const inp = h('input', { class: 'input', value, 'aria-label': label, maxlength: '120' });
      const ok = () => { done = true; resolve(inp.value.trim() || null); c(); };
      inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') ok(); });
      s.append(h('div', { class: 'field' }, h('label', {}, label), inp), h('button', { class: 'btn primary block', onclick: ok }, 'Save'));
      setTimeout(() => inp.focus(), 50);
    }, { onClose: () => { if (!done) resolve(null); } });
  });
}

export const fmtTime = (t) => {
  const d = new Date(t); const now = new Date();
  return d.toDateString() === now.toDateString() ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : d.toLocaleDateString([], { month: 'short', day: 'numeric', year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric' });
};
export const fmtBytes = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);
