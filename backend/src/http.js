// Minimal, dependency-free HTTP framework: routing, JSON bodies, errors, security headers, CORS.
import crypto from 'node:crypto';
import { config } from './config.js';

export class HttpError extends Error {
  constructor(status, code, message, extra = {}) { super(message); this.status = status; this.code = code; this.extra = extra; }
}
export const bad = (msg, code = 'invalid_request') => new HttpError(400, code, msg);
export const unauthorized = (msg = 'Authentication required') => new HttpError(401, 'unauthorized', msg);
export const forbidden = (msg = 'Forbidden', code = 'forbidden') => new HttpError(403, code, msg);
export const notFound = (msg = 'Not found') => new HttpError(404, 'not_found', msg);

export const newId = (prefix = '') => prefix + crypto.randomUUID().replace(/-/g, '').slice(0, 24);

export function clientIp(req) {
  if (config.trustProxy) {
    const xf = req.headers['x-forwarded-for'];
    if (xf) return String(xf).split(',')[0].trim();
  }
  return req.socket.remoteAddress || 'unknown';
}

export class Router {
  constructor() { this.routes = []; }
  add(method, pattern, ...handlers) {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/\//g, '\\/').replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '\\/?$');
    this.routes.push({ method, re, keys, handlers });
  }
  get(p, ...h) { this.add('GET', p, ...h); }
  post(p, ...h) { this.add('POST', p, ...h); }
  patch(p, ...h) { this.add('PATCH', p, ...h); }
  put(p, ...h) { this.add('PUT', p, ...h); }
  delete(p, ...h) { this.add('DELETE', p, ...h); }
  match(method, pathname) {
    let pathMatched = false;
    for (const r of this.routes) {
      const m = r.re.exec(pathname);
      if (!m) continue;
      pathMatched = true;
      if (r.method !== method) continue;
      const params = {};
      r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
      return { route: r, params };
    }
    return pathMatched ? 'method' : null;
  }
}

export async function readBody(req, limit) {
  const declared = Number(req.headers['content-length'] || 0);
  if (declared > limit) throw new HttpError(413, 'payload_too_large', `Body exceeds ${limit} bytes`);
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new HttpError(413, 'payload_too_large', `Body exceeds ${limit} bytes`);
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

/** Stream a request body to a file (large uploads). Returns { bytes, sha256 }. */
export async function readBodyToFile(req, file, limit) {
  const declared = Number(req.headers['content-length'] || 0);
  if (declared > limit) throw new HttpError(413, 'payload_too_large', `Body exceeds ${limit} bytes`);
  const fs = await import('node:fs');
  const hash = crypto.createHash('sha256');
  const out = fs.createWriteStream(file, { mode: 0o600 });
  let bytes = 0;
  try {
    for await (const c of req) {
      bytes += c.length;
      if (bytes > limit) throw new HttpError(413, 'payload_too_large', `Body exceeds ${limit} bytes`);
      hash.update(c);
      if (!out.write(c)) await new Promise((r) => out.once('drain', r));
    }
  } catch (e) { out.destroy(); throw e; }
  await new Promise((resolve, reject) => { out.on('error', reject); out.end(resolve); });
  return { bytes, sha256: hash.digest('hex') };
}

export async function readJson(req, limit = 1024 * 1024) {
  const ct = String(req.headers['content-type'] || '');
  if (!ct.includes('application/json')) throw bad('Content-Type must be application/json');
  const buf = await readBody(req, limit);
  if (!buf.length) return {};
  try {
    const v = JSON.parse(buf.toString('utf8'));
    if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new Error();
    return v;
  } catch { throw bad('Malformed JSON body'); }
}

export function securityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=(), geolocation=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
  if (config.publicUrl.startsWith('https://')) res.setHeader('Strict-Transport-Security', 'max-age=63072000; includeSubDomains');
}

export function applyCors(req, res) {
  const origin = req.headers.origin;
  if (origin && config.corsOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-CSRF-Token, X-Filename, X-Project-Id, X-Artifact-Sha256');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, PUT, DELETE');
    res.setHeader('Access-Control-Max-Age', '600');
  }
}

export function sendJson(res, status, body) {
  if (res.headersSent) return;
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(data);
}

export function sendError(res, err, requestId) {
  if (err instanceof HttpError) {
    if (err.status === 413) res.setHeader('Connection', 'close'); // unread body: don't reuse socket
    if (err.extra.retryAfter) res.setHeader('Retry-After', String(err.extra.retryAfter));
    return sendJson(res, err.status, { error: { code: err.code, message: err.message, request_id: requestId, ...err.extra } });
  }
  console.error(`[${requestId}]`, err);
  // `cause` is only the error's type/code (e.g. SQLITE_ERROR, TypeError) — never its message or any data — so a
  // failure can be diagnosed from the response without exposing internals.
  const cause = String(err?.code || err?.name || 'Error').replace(/[^A-Za-z0-9_]/g, '').slice(0, 40);
  // `at`: file:line of the first frame in Approx's own code (no message, no values).
  const frame = /\/(?:backend\/src|api)\/([\w/.-]+\.js):(\d+)/.exec(String(err?.stack || ''));
  const at = frame ? `${frame[1]}:${frame[2]}` : undefined;
  return sendJson(res, 500, { error: { code: 'internal_error', message: 'Something went wrong on our side. Please try again.', cause, at, request_id: requestId } });
}

// Server-Sent Events helper used by chat + API streaming.
export function startSse(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  return {
    send(event, data) { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); },
    end() { res.end(); },
  };
}

// Input validation helpers
export function str(v, name, { min = 0, max = 10000, required = true } = {}) {
  if (v === undefined || v === null) { if (required) throw bad(`${name} is required`); return undefined; }
  if (typeof v !== 'string') throw bad(`${name} must be a string`);
  const s = v.trim();
  if (s.length < min) throw bad(`${name} must be at least ${min} characters`);
  if (s.length > max) throw bad(`${name} must be at most ${max} characters`);
  return s;
}
export function oneOf(v, name, values, def) {
  if (v === undefined || v === null) return def;
  if (!values.includes(v)) throw bad(`${name} must be one of: ${values.join(', ')}`);
  return v;
}
export const isEmail = (e) => typeof e === 'string' && e.length <= 254 && /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[A-Za-z]{2,}$/.test(e);
