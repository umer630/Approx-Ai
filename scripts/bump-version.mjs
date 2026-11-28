#!/usr/bin/env node
// Advances the ONE authoritative Approx version (backend/config/version.json) and writes it to every platform:
// Android (versionName + versionCode, monotonic), Windows desktop (package.json version). Used by the release workflow.
//   node scripts/bump-version.mjs patch|minor|major      → prints the new version
//   node scripts/bump-version.mjs check                  → verifies all platforms agree (CI)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VFILE = path.join(root, 'backend/config/version.json');
const MANIFEST = path.join(root, 'android/AndroidManifest.xml');
const DESKTOP = path.join(root, 'desktop/package.json');

export function bump(v, kind) {
  const [a, b, c] = v.split('.').map(Number);
  if (kind === 'major') return `${a + 1}.0.0`;
  if (kind === 'minor') return `${a}.${b + 1}.0`;
  if (kind === 'patch') return `${a}.${b}.${c + 1}`;
  throw new Error(`unknown bump kind: ${kind}`);
}
const read = () => JSON.parse(fs.readFileSync(VFILE, 'utf8'));
function platforms() {
  const m = fs.readFileSync(MANIFEST, 'utf8');
  return {
    android: { name: /android:versionName="([^"]+)"/.exec(m)?.[1], code: Number(/android:versionCode="(\d+)"/.exec(m)?.[1]) },
    desktop: fs.existsSync(DESKTOP) ? JSON.parse(fs.readFileSync(DESKTOP, 'utf8')).version : null,
  };
}

const kind = process.argv[2];
const v = read();
if (kind === 'check') {
  const p = platforms();
  const bad = [];
  if (p.android.name !== v.version) bad.push(`android versionName ${p.android.name} != ${v.version}`);
  if (p.android.code !== v.versionCode) bad.push(`android versionCode ${p.android.code} != ${v.versionCode}`);
  if (p.desktop !== null && p.desktop !== v.version) bad.push(`desktop version ${p.desktop} != ${v.version}`);
  if (bad.length) { console.error(`Version mismatch:\n  ${bad.join('\n  ')}`); process.exit(1); }
  console.log(`${v.version} (versionCode ${v.versionCode}) — all platforms agree`);
} else if (['patch', 'minor', 'major'].includes(kind)) {
  const p = platforms();
  const next = { ...v, version: bump(v.version, kind), versionCode: Math.max(v.versionCode, p.android.code) + 1 };   // never reused
  fs.writeFileSync(VFILE, JSON.stringify(next, null, 2) + '\n');
  fs.writeFileSync(MANIFEST, fs.readFileSync(MANIFEST, 'utf8')
    .replace(/android:versionCode="\d+"/, `android:versionCode="${next.versionCode}"`).replace(/android:versionName="[^"]+"/, `android:versionName="${next.version}"`));
  if (fs.existsSync(DESKTOP)) { const d = JSON.parse(fs.readFileSync(DESKTOP, 'utf8')); d.version = next.version; fs.writeFileSync(DESKTOP, JSON.stringify(d, null, 2) + '\n'); }
  console.log(next.version);
} else { console.error('usage: bump-version.mjs patch|minor|major|check'); process.exit(2); }
