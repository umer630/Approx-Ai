// SSRF-safe outbound fetch for the Research module. The IP check runs inside the socket
// `lookup` hook, so the address that is validated is exactly the address connected to
// (defeats DNS-rebinding TOCTOU). Redirects are followed manually and re-validated.
import dns from 'node:dns';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';

export function isPublicIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
    if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT
    if (a === 169 && b === 254) return false;            // link-local / cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && (b === 168 || (b === 0))) return false;
    if (a === 198 && (b === 18 || b === 19)) return false;
    return true;
  }
  if (net.isIPv6(ip)) {
    const v = ip.toLowerCase();
    if (v === '::' || v === '::1') return false;
    if (v.startsWith('::ffff:')) return isPublicIp(v.slice(7));
    if (/^(fc|fd|fe8|fe9|fea|feb|ff)/.test(v)) return false;
    if (v.startsWith('64:ff9b') || v.startsWith('2001:db8')) return false;
    return true;
  }
  return false;
}

function guardedLookup(hostname, opts, cb) {
  dns.lookup(hostname, { all: true }, (err, addrs) => {
    if (err) return cb(err);
    const bad = addrs.find((a) => !isPublicIp(a.address));
    if (bad || !addrs.length) return cb(Object.assign(new Error(`Blocked non-public address for ${hostname}`), { code: 'EBLOCKED' }));
    if (opts && opts.all) return cb(null, addrs);
    cb(null, addrs[0].address, addrs[0].family);
  });
}

export async function safeFetchText(rawUrl, { maxBytes = 1_000_000, timeoutMs = 10_000, redirects = 3 } = {}) {
  let url;
  try { url = new URL(rawUrl); } catch { throw new Error('Invalid URL'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Only http(s) URLs are allowed');
  if (url.username || url.password) throw new Error('Credentials in URLs are not allowed');
  if (url.port && !['80', '443'].includes(url.port)) throw new Error('Only ports 80/443 are allowed');
  if (net.isIP(url.hostname.replace(/^\[|\]$/g, '')) && !isPublicIp(url.hostname.replace(/^\[|\]$/g, ''))) throw new Error('Blocked non-public address');

  const mod = url.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = mod.get(url, { lookup: guardedLookup, timeout: timeoutMs, headers: { 'User-Agent': 'ApproxResearch/1.0', Accept: 'text/html,text/plain;q=0.9' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        if (redirects <= 0) return reject(new Error('Too many redirects'));
        return resolve(safeFetchText(new URL(res.headers.location, url).toString(), { maxBytes, timeoutMs, redirects: redirects - 1 }));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
      const ct = String(res.headers['content-type'] || '');
      if (!/text\/(html|plain)|application\/xhtml/.test(ct)) { res.resume(); return reject(new Error(`Unsupported content type ${ct}`)); }
      let size = 0;
      const chunks = [];
      res.on('data', (c) => { size += c.length; if (size > maxBytes) { req.destroy(new Error('Response too large')); } else chunks.push(c); });
      res.on('end', () => resolve({ url: url.toString(), contentType: ct, body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('Timed out')));
    req.on('error', reject);
  });
}

export function htmlToText(html) {
  const title = (/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] || '').trim();
  const text = html
    .replace(/<(script|style|noscript|svg|nav|footer|header)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ').trim();
  return { title, text };
}
