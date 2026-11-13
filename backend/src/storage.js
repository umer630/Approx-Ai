// Persistent blob storage for user uploads and training exports.
//   fs  (default for local / Docker / Render): files under APPROX_DATA_DIR/<namespace>/<key> — unchanged paths.
//   db  (default when the database is remote, e.g. Turso, or on Vercel): bytes in the `file_blobs` table of the
//       same database, so serverless deployments keep files across invocations without another service.
// Selected by APPROX_FILE_STORAGE=fs|db (see config.files.storage). Keys are random hex or fixed safe names.
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { one, run, now } from './db.js';

const SAFE = /^[A-Za-z0-9._-]{1,200}$/;
const NAMESPACES = new Set(['uploads', 'training/exports']);

function check(ns, key) {
  if (!NAMESPACES.has(ns)) throw new Error(`unknown storage namespace: ${ns}`);
  if (!SAFE.test(key) || key.startsWith('.')) throw new Error('invalid storage key');
}
const fsPath = (ns, key) => path.join(config.dataDir, ns, key);

export function backend() { return config.files.storage; }

export async function put(ns, key, buf) {
  check(ns, key);
  if (backend() === 'db') {
    await run('INSERT OR REPLACE INTO file_blobs (storage_key, data, size, created_at) VALUES (?,?,?,?)', `${ns}/${key}`, buf, buf.length, now());
    return;
  }
  fs.mkdirSync(path.join(config.dataDir, ns), { recursive: true });
  fs.writeFileSync(fsPath(ns, key), buf, { mode: 0o600 });
}

/** Returns a Buffer, or null when the blob does not exist. */
export async function get(ns, key) {
  check(ns, key);
  if (backend() === 'db') {
    const r = await one('SELECT data FROM file_blobs WHERE storage_key = ?', `${ns}/${key}`);
    return r ? Buffer.from(r.data) : null;
  }
  try { return fs.readFileSync(fsPath(ns, key)); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}

export async function del(ns, key) {
  check(ns, key);
  if (backend() === 'db') { await run('DELETE FROM file_blobs WHERE storage_key = ?', `${ns}/${key}`); return; }
  try { fs.unlinkSync(fsPath(ns, key)); } catch (e) { if (e.code !== 'ENOENT') throw e; }
}
