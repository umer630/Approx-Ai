import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { config, VERSIONS } from './config.js';
import { getDb } from './db.js';
import { Router, sendJson, sendError, securityHeaders, applyCors, newId, notFound, HttpError } from './http.js';
import { resolveAuth, enforceCsrf } from './security.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerChatRoutes } from './routes/chat.js';
import { registerFileRoutes } from './routes/files.js';
import { registerAccountRoutes } from './routes/account.js';
import { registerWorkspaceRoutes } from './routes/workspace.js';
import { registerDeveloperRoutes } from './routes/developer.js';
import { registerAdminRoutes } from './routes/admin.js';
import { registerPlatformRoutes } from './routes/platform.js';
import { backendStatus } from './providers/index.js';
import { listModels } from './models.js';
import { getActive, startRegistryWatcher } from './registry.js';

export function buildRouter() {
  const r = new Router();
  r.get('/healthz', async (req, res) => sendJson(res, 200, { ok: true }));
  r.get('/api/version', async (req, res) => sendJson(res, 200, {
    product: 'Approx AI', company: 'Approx Technology', versions: VERSIONS, build_id: config.buildId,
    models: Object.fromEntries(listModels().map((m) => [m.id, { backend: backendStatus(m), active_version: getActive(m.id)?.version ?? null }])),
  }));
  registerAuthRoutes(r);
  registerChatRoutes(r);
  registerFileRoutes(r);
  registerAccountRoutes(r);
  registerWorkspaceRoutes(r);
  registerDeveloperRoutes(r);
  registerAdminRoutes(r);
  registerPlatformRoutes(r);
  return r;
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8' };

function serveStatic(req, res, pathname) {
  const root = config.webDir;
  let rel = decodeURIComponent(pathname);
  if (rel.endsWith('/')) rel += 'index.html';
  const full = path.resolve(root, '.' + rel);
  if (!full.startsWith(root + path.sep)) return false; // traversal guard
  let file = full;
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    if (fs.existsSync(path.join(full, 'index.html'))) file = path.join(full, 'index.html');
    else if (!path.extname(rel)) file = path.join(root, rel.startsWith('/developers') ? 'developers/index.html' : 'index.html'); // SPA fallback
    else return false;
  }
  securityHeaders(res);
  const ext = path.extname(file);
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600' });
  fs.createReadStream(file).pipe(res);
  return true;
}

export function createServer() {
  getDb();
  const router = buildRouter();
  return http.createServer(async (req, res) => {
    const requestId = 'req_' + newId();
    res.setHeader('X-Request-Id', requestId);
    try {
      const url = new URL(req.url, 'http://local');
      const isApi = url.pathname.startsWith('/api/') || url.pathname === '/healthz';
      if (!isApi) {
        if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'method_not_allowed', 'Method not allowed');
        if (serveStatic(req, res, url.pathname)) return;
        throw notFound();
      }
      securityHeaders(res);
      applyCors(req, res);
      if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
      // Method override for clients whose HTTP stack lacks PATCH (POST → PATCH only; CSRF still applies).
      const method = req.method === 'POST' && String(req.headers['x-http-method-override'] || '').toUpperCase() === 'PATCH' ? 'PATCH' : req.method;
      const m = router.match(method, url.pathname);
      if (m === 'method') throw new HttpError(405, 'method_not_allowed', 'Method not allowed');
      if (!m) throw notFound('Unknown endpoint');
      const ctx = { requestId, auth: resolveAuth(req) };
      enforceCsrf(req, ctx.auth);
      for (const h of m.route.handlers) await h(req, res, ctx, m.params, url);
    } catch (err) {
      sendError(res, err, requestId);
    }
  });
}

if (process.argv[1] && process.argv[1].endsWith('server.js')) {
  const server = createServer();
  startRegistryWatcher();
  server.requestTimeout = 900_000; // large artifact uploads
  server.headersTimeout = 30_000;
  server.listen(config.port, config.host, () => {
    console.log(`Approx AI backend ${VERSIONS.backend} (${config.env}) listening on http://${config.host}:${config.port}`);
    if (config.devProvider) console.warn('WARNING: development simulator provider is enabled — responses are NOT from a real model.');
  });
}
