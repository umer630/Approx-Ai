// Local emulation of the Vercel deployment topology defined in vercel.json, for frontend regression tests:
//   • static files from the outputDirectory (web/), minus paths excluded by .vercelignore
//   • rewrites /healthz and /api/* → the serverless function api/index.js (invoked with Node req/res, VERCEL=1)
//   • the response headers declared in vercel.json
// It is a test harness only; it is not deployed. Usage: PORT=8080 VERCEL=1 node web/test/vercel-emulator.mjs
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const vc = JSON.parse(fs.readFileSync(path.join(root, 'vercel.json'), 'utf8'));
const outDir = path.join(root, vc.outputDirectory);
const ignored = fs.readFileSync(path.join(root, '.vercelignore'), 'utf8').split('\n').map((l) => l.trim())
  .filter((l) => l && !l.startsWith('#') && l.startsWith(vc.outputDirectory + '/')).map((l) => '/' + l.slice(vc.outputDirectory.length + 1));
const { default: fn } = await import(path.join(root, 'api/index.js'));
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };

const toRe = (src) => new RegExp('^' + src.replace(/\(\.\*\)/g, '.*').replace(/\/:path\*/g, '(?:/.*)?') + '$');
function applyHeaders(res, pathname) {
  for (const rule of vc.headers || []) if (toRe(rule.source).test(pathname)) for (const { key, value } of rule.headers) res.setHeader(key, value);
}

const server = http.createServer((req, res) => {
  const { pathname } = new URL(req.url, 'http://x');
  applyHeaders(res, pathname);
  if ((vc.rewrites || []).some((r) => r.destination === '/api/index' && toRe(r.source).test(pathname))) return fn(req, res);
  let rel = decodeURIComponent(pathname);
  if (ignored.some((p) => rel === p || rel.startsWith(p + '/'))) { res.writeHead(404); return res.end('NOT_FOUND'); }
  let file = path.join(outDir, rel);
  if (!file.startsWith(outDir)) { res.writeHead(404); return res.end(); }
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
  if (!fs.existsSync(file)) { res.writeHead(404); return res.end('NOT_FOUND'); }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
server.listen(Number(process.env.PORT || 0), '127.0.0.1', () => console.log(`PORT ${server.address().port}`));
