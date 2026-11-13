// Secure file handling: size limit, type allow-list, magic-byte sniffing, executable blocking,
// heuristic + optional ClamAV scanning, per-user authorization, random storage keys.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { one, all, run, now } from '../db.js';
import { readBody, sendJson, bad, notFound, newId, HttpError, securityHeaders } from '../http.js';
import { requireUser, rateLimit } from '../security.js';
import { config } from '../config.js';
import * as storage from '../storage.js';


// extension → [kind, mime, sniff(buf)]
const TEXT_EXT = ['txt', 'md', 'csv', 'tsv', 'json', 'xml', 'yaml', 'yml', 'log', 'py', 'js', 'ts', 'tsx', 'jsx', 'java', 'kt', 'c', 'cpp', 'h', 'cs', 'go', 'rs', 'rb', 'php', 'swift', 'sql', 'html', 'css', 'sh', 'toml', 'ini'];
const TYPES = {
  pdf: ['pdf', 'application/pdf', (b) => b.subarray(0, 5).toString('latin1') === '%PDF-'],
  png: ['image', 'image/png', (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))],
  jpg: ['image', 'image/jpeg', (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff],
  jpeg: ['image', 'image/jpeg', (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff],
  webp: ['image', 'image/webp', (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP'],
  gif: ['image', 'image/gif', (b) => b.subarray(0, 4).toString('latin1') === 'GIF8'],
  docx: ['document', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', (b) => b[0] === 0x50 && b[1] === 0x4b],
  xlsx: ['document', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', (b) => b[0] === 0x50 && b[1] === 0x4b],
  pptx: ['document', 'application/vnd.openxmlformats-officedocument.presentationml.presentation', (b) => b[0] === 0x50 && b[1] === 0x4b],
};
for (const e of TEXT_EXT) TYPES[e] = [e === 'csv' || e === 'tsv' ? 'data' : ['md', 'txt', 'log'].includes(e) ? 'text' : 'code', 'text/plain; charset=utf-8', (b) => isUtf8Text(b)];

function isUtf8Text(b) {
  if (b.includes(0)) return false;
  try { new TextDecoder('utf-8', { fatal: true }).decode(b); return true; } catch { return false; }
}

const EICAR = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';
function heuristicScan(buf, ext) {
  const head = buf.subarray(0, 4);
  if (head.subarray(0, 2).toString('latin1') === 'MZ') return 'Windows executable content';
  if (head.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) return 'ELF executable content';
  if (head.equals(Buffer.from([0xca, 0xfe, 0xba, 0xbe])) || head.equals(Buffer.from([0xcf, 0xfa, 0xed, 0xfe]))) return 'Mach-O / Java class content';
  if (buf.includes(Buffer.from(EICAR))) return 'EICAR test signature';
  if (ext === 'pdf') {
    const s = buf.toString('latin1');
    if (/\/JavaScript|\/JS\s*[(<]|\/Launch|\/EmbeddedFile/.test(s)) return 'PDF with active content (JavaScript/Launch/EmbeddedFile)';
  }
  if (['docx', 'xlsx', 'pptx'].includes(ext) && buf.includes(Buffer.from('vbaProject.bin'))) return 'Office document with macros';
  if (['html', 'svg'].includes(ext) && /<script/i.test(buf.toString('utf8'))) return null; // stored as text only; never served inline
  return null;
}

function clamScan(file) {
  if (!config.files.clamdscan) return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile(config.files.clamdscan, ['--no-summary', file], { timeout: 30_000 }, (err, stdout) => {
      if (!err) return resolve(null);
      if (err.code === 1) return resolve('ClamAV: ' + String(stdout).trim().slice(0, 200));
      resolve('scanner_error');
    });
  });
}

// Best-effort PDF text extraction (FlateDecode + text operators). Not a full PDF parser.
export function extractPdfText(buf) {
  const s = buf.toString('latin1');
  const out = [];
  const re = /stream\r?\n/g;
  let m;
  while ((m = re.exec(s)) && out.join('').length < 200_000) {
    const start = m.index + m[0].length;
    const end = s.indexOf('endstream', start);
    if (end < 0) break;
    let data = buf.subarray(start, end);
    try { data = zlib.inflateSync(data, { maxOutputLength: 4 * 1024 * 1024 }); } catch { /* uncompressed, or exceeds bomb limit */ }
    const txt = data.toString('latin1');
    const parts = [];
    for (const t of txt.matchAll(/\((?:\\.|[^\\)])*\)\s*Tj|\[(?:[^\]]*)\]\s*TJ/g)) {
      for (const lit of t[0].matchAll(/\(((?:\\.|[^\\)])*)\)/g)) parts.push(lit[1].replace(/\\([nrt()\\])/g, (_, c) => ({ n: '\n', r: '', t: '\t' }[c] ?? c)));
    }
    if (parts.length) out.push(parts.join(' '));
    re.lastIndex = end;
  }
  const text = out.join('\n').replace(/[^\x09\x0a\x0d\x20-\x7e -ÿ]/g, '').trim();
  return text || null;
}

export async function removeFileBlobs(rows) {
  for (const f of rows) await storage.del('uploads', f.storage_key); // blocked files were never stored: no-op
}
export async function removeUserFiles(userId) {
  await removeFileBlobs(await all('SELECT storage_key FROM files WHERE user_id = ?', userId));
}

function fileView(f) {
  return { id: f.id, filename: f.filename, mime: f.mime, kind: f.kind, size: f.size, sha256: f.sha256, project_id: f.project_id,
    scan_status: f.scan_status, scan_detail: f.scan_detail, has_text: !!f.extracted_text, created_at: f.created_at };
}

export function registerFileRoutes(r) {
  // Upload: raw body; filename in X-Filename (URL-encoded); optional X-Project-Id.
  r.post('/api/files', async (req, res, ctx) => {
    const u = requireUser(ctx);
    await rateLimit(`upload:${u.id}`, 60, 3600_000);
    let rawName;
    try { rawName = decodeURIComponent(String(req.headers['x-filename'] || '')); } catch { throw bad('X-Filename must be URL-encoded'); }
    const filename = path.basename(rawName).replace(/[^\p{L}\p{N}._ -]/gu, '_').slice(0, 150);
    if (!filename || filename.startsWith('.')) throw bad('X-Filename header is required');
    const ext = (filename.split('.').pop() || '').toLowerCase();
    const type = TYPES[ext];
    if (!type) throw new HttpError(415, 'unsupported_type', `File type .${ext} is not allowed`);
    const projectId = req.headers['x-project-id'] ? String(req.headers['x-project-id']) : null;
    if (projectId && !await one('SELECT id FROM projects WHERE id = ? AND user_id = ?', projectId, u.id)) throw notFound('Project not found');
    const total = (await one('SELECT COALESCE(SUM(size),0) s FROM files WHERE user_id = ?', u.id)).s;
    if (total > 500 * 1024 * 1024) throw new HttpError(507, 'storage_full', 'Storage limit (500 MB) reached');

    const buf = await readBody(req, config.files.maxBytes);
    if (!buf.length) throw bad('Empty file');
    const [kind, mime, sniff] = type;
    if (!sniff(buf)) throw new HttpError(415, 'type_mismatch', 'File content does not match its extension');

    const key = crypto.randomBytes(16).toString('hex');
    let threat = heuristicScan(buf, ext);
    if (!threat && config.files.clamdscan) {
      // ClamAV needs a file path: scan a private temp copy (works on serverless /tmp too), then remove it.
      const tmp = path.join(os.tmpdir(), `approx-scan-${key}`);
      fs.writeFileSync(tmp, buf, { mode: 0o600 });
      try { threat = await clamScan(tmp); } finally { fs.rmSync(tmp, { force: true }); }
    }
    const scan_status = threat ? (threat === 'scanner_error' ? 'error' : 'blocked') : 'clean';
    if (scan_status !== 'blocked') await storage.put('uploads', key, buf); // blocked content is never stored

    let extracted = null;
    if (scan_status === 'clean') {
      if (['text', 'code', 'data'].includes(kind)) extracted = buf.toString('utf8').slice(0, 500_000);
      else if (kind === 'pdf') extracted = extractPdfText(buf);
    }
    const id = newId('fil_');
    await run(`INSERT INTO files (id,user_id,project_id,filename,mime,kind,size,sha256,storage_key,scan_status,scan_detail,extracted_text,created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, id, u.id, projectId, filename, mime, kind, buf.length,
    crypto.createHash('sha256').update(buf).digest('hex'), key, scan_status, threat || '', extracted, now());
    const f = await one('SELECT * FROM files WHERE id = ?', id);
    sendJson(res, scan_status === 'blocked' ? 422 : 201, { file: fileView(f) });
  });

  r.get('/api/files', async (req, res, ctx, p, url) => {
    const u = requireUser(ctx);
    const proj = url.searchParams.get('project_id');
    const rows = proj ? await all('SELECT * FROM files WHERE user_id = ? AND project_id = ? ORDER BY created_at DESC', u.id, proj)
      : await all('SELECT * FROM files WHERE user_id = ? ORDER BY created_at DESC LIMIT 500', u.id);
    sendJson(res, 200, { files: rows.map(fileView) });
  });

  r.get('/api/files/:id', async (req, res, ctx, p) => {
    const u = requireUser(ctx);
    const f = await one('SELECT * FROM files WHERE id = ? AND user_id = ?', p.id, u.id);
    if (!f) throw notFound('File not found');
    sendJson(res, 200, { file: fileView(f), preview: f.extracted_text ? f.extracted_text.slice(0, 5000) : null });
  });

  // Download: always as attachment, sandboxed CSP — uploaded content is never rendered inline as HTML.
  r.get('/api/files/:id/download', async (req, res, ctx, p) => {
    const u = requireUser(ctx);
    const f = await one("SELECT * FROM files WHERE id = ? AND user_id = ? AND scan_status = 'clean'", p.id, u.id);
    if (!f) throw notFound('File not found');
    const data = await storage.get('uploads', f.storage_key);
    if (!data) throw notFound('File content not found');
    securityHeaders(res);
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    res.writeHead(200, {
      'Content-Type': f.kind === 'image' ? f.mime : 'application/octet-stream',
      'Content-Disposition': `${f.kind === 'image' ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(f.filename)}`,
      'Content-Length': f.size,
      'Cache-Control': 'private, no-store',
    });
    res.end(data);
  });

  r.delete('/api/files/:id', async (req, res, ctx, p) => {
    const u = requireUser(ctx);
    const f = await one('SELECT * FROM files WHERE id = ? AND user_id = ?', p.id, u.id);
    if (!f) throw notFound('File not found');
    await storage.del('uploads', f.storage_key); // blocked files are not stored: no-op
    await run('DELETE FROM files WHERE id = ?', f.id);
    sendJson(res, 200, { status: 'deleted' });
  });
}
