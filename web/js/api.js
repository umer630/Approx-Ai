// API client shared by the main app and the developer console.
let csrf = '';
export const setCsrf = (t) => { csrf = t || ''; };

export class ApiError extends Error {
  constructor(status, body) {
    super(body?.error?.message || `Request failed (${status})`);
    this.status = status; this.code = body?.error?.code; this.body = body;
  }
}

export async function api(path, { method = 'GET', body, headers = {}, raw } = {}) {
  const h = { ...headers };
  if (method !== 'GET' && csrf) h['X-CSRF-Token'] = csrf;
  let payload = body;
  if (body !== undefined && !raw) { h['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  let res;
  try {
    // A timeout guarantees no request can leave a button spinning forever (uploads get longer).
    res = await fetch(path, { method, headers: h, body: payload, credentials: 'same-origin', signal: AbortSignal.timeout(raw ? 120_000 : 30_000) });
  } catch (e) {
    throw new ApiError(0, { error: { code: e.name === 'TimeoutError' ? 'timeout' : 'network_error',
      message: e.name === 'TimeoutError' ? 'Approx AI is taking too long to respond. Please try again.' : "Can't reach Approx AI. Check your internet connection and try again." } });
  }
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('application/json') ? await res.json() : await res.text();
  if (!res.ok) {
    const friendly = res.status >= 500 && !(typeof data === 'object' && data?.error?.message)
      ? 'Approx AI is having trouble right now. Please try again in a moment.' : String(data).slice(0, 200);
    throw new ApiError(res.status, typeof data === 'object' ? data : { error: { message: friendly } });
  }
  return data;
}

/** POST that returns an SSE stream. handlers: {route, delta, done, error} */
export async function stream(path, body, handlers, signal) {
  const res = await fetch(path, {
    method: 'POST', credentials: 'same-origin', signal,
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf, Accept: 'text/event-stream' },
    body: JSON.stringify(body),
  });
  if (!res.ok || !(res.headers.get('content-type') || '').includes('text/event-stream')) {
    let data = null; try { data = await res.json(); } catch { /* ignore */ }
    throw new ApiError(res.status, data);
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, i); buf = buf.slice(i + 2);
      let ev = 'message'; let data = '';
      for (const line of block.split('\n')) {
        if (line.startsWith('event:')) ev = line.slice(6).trim();
        else if (line.startsWith('data:')) data += line.slice(5).trim();
      }
      if (data) handlers[ev]?.(JSON.parse(data));
    }
  }
}

export async function upload(file, projectId) {
  const headers = { 'X-Filename': encodeURIComponent(file.name), 'Content-Type': 'application/octet-stream' };
  if (projectId) headers['X-Project-Id'] = projectId;
  return api('/api/files', { method: 'POST', body: file, headers, raw: true });
}

// ---- small stale-while-revalidate cache for read-only GETs (instant navigation; fresh data follows) ----
const CACHE = new Map(); // path → { at, value, inflight }
/**
 * cached(path, ttlMs, onFresh?) → Promise of the value. A cached value (even stale) resolves immediately; when it is
 * older than ttlMs a background refresh runs and onFresh(newValue) is called once it arrives.
 */
export function cached(path, ttlMs = 30_000, onFresh) {
  const e = CACHE.get(path);
  const refresh = () => {
    if (e?.inflight) return e.inflight;
    const p = api(path).then((v) => { CACHE.set(path, { at: Date.now(), value: v }); return v; })
      .catch((err) => { const cur = CACHE.get(path); if (cur) delete cur.inflight; throw err; });
    CACHE.set(path, { ...(e || {}), inflight: p });
    return p;
  };
  if (e && 'value' in e) {
    if (Date.now() - e.at > ttlMs) refresh().then((v) => onFresh?.(v)).catch(() => {});
    return Promise.resolve(e.value);
  }
  return refresh();
}
/** Drop cached entries whose path starts with any of the prefixes (call after a write). */
export function invalidate(...prefixes) { for (const k of [...CACHE.keys()]) if (prefixes.some((p) => k.startsWith(p))) CACHE.delete(k); }
export function clearCache() { CACHE.clear(); }
