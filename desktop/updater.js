// Approx for Windows — updater. Reads the same release information as Android and the web (/api/releases/latest),
// downloads the new Approx.exe installer, verifies its SHA-256 against the release manifest, and only then runs it.
// An unverified or partially downloaded file is deleted and never executed.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

function cmpVer(a, b) {
  const x = String(a).split('.').map(Number); const y = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0);
  return 0;
}

/** { status: 'none'|'available'|'error', latest?, current, notes?, url?, sha256?, published_at?, reason? } */
async function check({ server, current, fetchImpl = fetch }) {
  try {
    const r = await fetchImpl(`${server}/api/releases/latest`, { signal: AbortSignal.timeout(15000) });
    if (!r.ok) return { status: 'error', current, reason: `HTTP ${r.status}` };
    const rel = await r.json();
    if (!rel.available) return { status: 'none', current, reason: rel.reason };
    if (!rel.windows?.url || !/^[0-9a-f]{64}$/.test(rel.windows.sha256 || '')) return { status: 'none', current, latest: rel.version, reason: 'This release has no verified Windows build.' };
    if (cmpVer(rel.version, current) <= 0) return { status: 'none', current, latest: rel.version };
    return { status: 'available', current, latest: rel.version, notes: rel.notes, url: rel.windows.url, sha256: rel.windows.sha256, published_at: rel.published_at };
  } catch (e) { return { status: 'error', current, reason: e.message }; }
}

/** Downloads to dir/Approx-<version>.exe.part, verifies, renames. Returns the verified path or throws. */
async function download({ url, sha256, version, dir, fetchImpl = fetch, onProgress }) {
  fs.mkdirSync(dir, { recursive: true });
  const part = path.join(dir, `Approx-${version}.exe.part`);
  const final = path.join(dir, `Approx-${version}.exe`);
  fs.rmSync(part, { force: true });
  const r = await fetchImpl(url, { redirect: 'follow', signal: AbortSignal.timeout(30 * 60_000) });
  if (!r.ok || !r.body) throw new Error(`Download failed: HTTP ${r.status}`);
  const total = Number(r.headers.get('content-length')) || 0;
  const hash = crypto.createHash('sha256');
  const out = fs.createWriteStream(part);
  let got = 0;
  try {
    for await (const chunk of r.body) { hash.update(chunk); got += chunk.length; if (!out.write(chunk)) await new Promise((res) => out.once('drain', res)); onProgress?.(total ? got / total : null); }
    await new Promise((res, rej) => out.end((e) => (e ? rej(e) : res())));
  } catch (e) { out.destroy(); fs.rmSync(part, { force: true }); throw e; }
  const digest = hash.digest('hex');
  if (digest !== sha256) { fs.rmSync(part, { force: true }); throw new Error(`Checksum mismatch — the download was discarded (expected ${sha256.slice(0, 12)}…, got ${digest.slice(0, 12)}…)`); }
  fs.renameSync(part, final);
  return final;
}

module.exports = { check, download, cmpVer };
