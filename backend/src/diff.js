// Small, dependency-free line diff (Myers-style LCS on lines) producing unified-diff hunks.
// Used to show FAB 500X agent proposals before they are applied. Bounded so a huge file cannot exhaust memory.

const MAX_CELLS = 4_000_000;

/** Unified diff text between two strings for display ("--- a/path" / "+++ b/path"). */
export function unifiedDiff(path, before, after, context = 3) {
  const a = before == null ? [] : String(before).split('\n');
  const b = after == null ? [] : String(after).split('\n');
  const head = `--- ${before == null ? '/dev/null' : 'a/' + path}\n+++ ${after == null ? '/dev/null' : 'b/' + path}\n`;
  if (before === after) return '';
  let ops;
  if ((a.length + 1) * (b.length + 1) > MAX_CELLS) {
    // too large for an LCS table: whole-file replacement diff
    ops = [...a.map((l) => ['-', l]), ...b.map((l) => ['+', l])];
  } else ops = lcsOps(a, b);
  return head + hunks(ops, context);
}

function lcsOps(a, b) {
  const n = a.length; const m = b.length;
  const w = m + 1;
  const t = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) {
    t[i * w + j] = a[i] === b[j] ? t[(i + 1) * w + j + 1] + 1 : Math.max(t[(i + 1) * w + j], t[i * w + j + 1]);
  }
  const ops = []; let i = 0; let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { ops.push([' ', a[i]]); i++; j++; } else if (t[(i + 1) * w + j] >= t[i * w + j + 1]) { ops.push(['-', a[i]]); i++; } else { ops.push(['+', b[j]]); j++; }
  }
  while (i < n) ops.push(['-', a[i++]]);
  while (j < m) ops.push(['+', b[j++]]);
  return ops;
}

function hunks(ops, ctx) {
  const out = [];
  let ai = 1; let bi = 1;
  const pos = ops.map(([k]) => { const p = [ai, bi]; if (k !== '+') ai++; if (k !== '-') bi++; return p; });
  const changed = ops.map(([k]) => k !== ' ');
  let i = 0;
  while (i < ops.length) {
    if (!changed[i]) { i++; continue; }
    let start = Math.max(0, i - ctx); let end = i;
    while (end < ops.length) {
      let k = end; while (k < ops.length && !changed[k]) k++;
      if (k >= ops.length || k - end > ctx * 2) { end = Math.min(ops.length, end + ctx); break; }
      end = k + 1;
    }
    const seg = ops.slice(start, end);
    const aLen = seg.filter(([k]) => k !== '+').length; const bLen = seg.filter(([k]) => k !== '-').length;
    out.push(`@@ -${pos[start][0]},${aLen} +${pos[start][1]},${bLen} @@`);
    for (const [k, l] of seg) out.push(k + l);
    i = end;
  }
  return out.join('\n') + '\n';
}

/** {added, removed} line counts of a unified diff. */
export function diffStats(d) {
  let added = 0; let removed = 0;
  for (const l of d.split('\n')) { if (l.startsWith('+') && !l.startsWith('+++')) added++; else if (l.startsWith('-') && !l.startsWith('---')) removed++; }
  return { added, removed };
}
