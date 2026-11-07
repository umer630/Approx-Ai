// Safe Markdown → HTML. Everything is HTML-escaped FIRST; only a small whitelist of
// constructs is produced, links are restricted to http(s), so model output cannot inject markup.
export const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const RTL = /[؀-ۿ]/;

function inline(s) {
  return s
    .replace(/`([^`]+)`/g, (_, c) => `<code>${c}</code>`)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, t, u) => `<a href="${u}" target="_blank" rel="noopener noreferrer nofollow">${t}</a>`);
}

export function markdown(src) {
  const codeBlocks = [];
  let text = esc(src).replace(/```([\w+#.-]*)\n([\s\S]*?)(```|$)/g, (_, lang, code) => {
    codeBlocks.push({ lang, code: code.replace(/\n$/, '') });
    return `\u0000${codeBlocks.length - 1}\u0000`;
  });
  const lines = text.split('\n');
  const out = [];
  let list = null; let para = [];
  const flushPara = () => { if (para.length) { const t = para.join('<br>'); out.push(`<p${RTL.test(t) ? ' dir="rtl"' : ''}>${inline(t)}</p>`); para = []; } };
  const flushList = () => { if (list) { out.push(`<${list.type}>${list.items.map((i) => `<li>${inline(i)}</li>`).join('')}</${list.type}>`); list = null; } };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let m;
    if ((m = /^\u0000(\d+)\u0000$/.exec(line.trim()))) { flushPara(); flushList(); out.push(line.trim()); continue; }
    if ((m = /^(#{1,3})\s+(.*)$/.exec(line))) { flushPara(); flushList(); out.push(`<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`); continue; }
    if ((m = /^\s*[-*•]\s+(.*)$/.exec(line))) { flushPara(); if (list?.type !== 'ul') { flushList(); list = { type: 'ul', items: [] }; } list.items.push(m[1]); continue; }
    if ((m = /^\s*\d+[.)]\s+(.*)$/.exec(line))) { flushPara(); if (list?.type !== 'ol') { flushList(); list = { type: 'ol', items: [] }; } list.items.push(m[1]); continue; }
    if ((m = /^&gt;\s?(.*)$/.exec(line))) { flushPara(); flushList(); out.push(`<blockquote>${inline(m[1])}</blockquote>`); continue; }
    if (/^\|.*\|$/.test(line.trim()) && /^\|[\s:|-]+\|$/.test((lines[i + 1] || '').trim())) {
      flushPara(); flushList();
      const cells = (l) => l.trim().slice(1, -1).split('|').map((c) => inline(c.trim()));
      let html = '<table><thead><tr>' + cells(line).map((c) => `<th>${c}</th>`).join('') + '</tr></thead><tbody>';
      i += 2;
      while (i < lines.length && /^\|.*\|$/.test(lines[i].trim())) { html += '<tr>' + cells(lines[i]).map((c) => `<td>${c}</td>`).join('') + '</tr>'; i++; }
      i--; out.push(html + '</tbody></table>'); continue;
    }
    if (!line.trim()) { flushPara(); flushList(); continue; }
    flushList(); para.push(line);
  }
  flushPara(); flushList();
  return out.join('\n').replace(/\u0000(\d+)\u0000/g, (_, n) => {
    const b = codeBlocks[+n];
    return `<pre><div class="code-head"><span>${b.lang || 'code'}</span><button type="button" data-copy-code>Copy</button></div><code>${b.code}</code></pre>`;
  });
}
