// Release information (one source for the web, Android and Windows updaters) and integration status.
//
// /api/releases/latest reads the LATEST PUBLISHED GitHub Release of the Approx repository and its release-manifest.json
// asset (written by .github/workflows/release.yml with the SHA-256 of Approx.apk and Approx.exe). Nothing is invented:
// with no published release the answer is { available: false }.
import { one, all, now } from '../db.js';
import { sendJson } from '../http.js';
import { requireUser } from '../security.js';
import { VERSIONS, config } from '../config.js';

const REPO = () => (process.env.APPROX_RELEASE_REPO || 'umer630/Approx-Ai').trim();
const STABLE = (file) => `https://github.com/${REPO()}/releases/latest/download/${file}`;
let cache = { at: 0, value: null };

async function latestRelease() {
  if (cache.value && Date.now() - cache.at < 10 * 60_000) return cache.value;
  const gh = { accept: 'application/vnd.github+json', 'user-agent': 'approx-release-check', ...(process.env.GITHUB_RELEASES_TOKEN ? { authorization: `Bearer ${process.env.GITHUB_RELEASES_TOKEN}` } : {}) };
  let value;
  try {
    const r = await fetch(`https://api.github.com/repos/${REPO()}/releases/latest`, { headers: gh, signal: AbortSignal.timeout(8000) });
    if (r.status === 404) value = { available: false, reason: 'No release has been published yet.' };
    else if (!r.ok) value = { available: false, reason: `GitHub answered HTTP ${r.status}`, transient: true };
    else {
      const rel = await r.json();
      const asset = (name) => (rel.assets || []).find((a) => a.name === name);
      const mAsset = asset('release-manifest.json');
      let manifest = null;
      if (mAsset) {
        const m = await fetch(mAsset.browser_download_url, { headers: { 'user-agent': 'approx-release-check' }, signal: AbortSignal.timeout(8000) });
        if (m.ok) manifest = await m.json().catch(() => null);
      }
      if (!manifest || !manifest.version) value = { available: false, reason: 'The latest release has no valid release-manifest.json.' };
      else {
        value = {
          available: true, version: manifest.version, version_code: manifest.version_code, git_commit: manifest.git_commit || null,
          published_at: rel.published_at, html_url: rel.html_url, notes: String(rel.body || '').slice(0, 8000),
          min_supported_version_code: manifest.min_supported_version_code ?? VERSIONS.min_apk_version_code,
          android: asset('Approx.apk') ? { file: 'Approx.apk', url: STABLE('Approx.apk'), sha256: manifest.files?.['Approx.apk']?.sha256 || null, size: asset('Approx.apk').size,
            package: manifest.files?.['Approx.apk']?.package || null, signer_sha256: manifest.files?.['Approx.apk']?.signer_sha256 || null } : null,
          windows: asset('Approx.exe') ? { file: 'Approx.exe', url: STABLE('Approx.exe'), sha256: manifest.files?.['Approx.exe']?.sha256 || null, size: asset('Approx.exe').size,
            signed: !!manifest.files?.['Approx.exe']?.signed } : null,
        };
      }
    }
  } catch (e) { value = { available: false, reason: `Release check failed: ${e.message}`, transient: true }; }
  if (!value.transient) cache = { at: Date.now(), value };
  return value;
}
export function resetReleaseCache() { cache = { at: 0, value: null }; }

export function registerReleaseRoutes(r) {
  // Public (the updater runs before sign-in too). ?version_code=N (Android) or ?version=x.y.z marks mandatory updates.
  r.get('/api/releases/latest', async (req, res, ctx, p, url) => {
    const rel = await latestRelease();
    const vc = Number(url.searchParams.get('version_code')) || null;
    sendJson(res, 200, {
      ...rel, server_version: VERSIONS.product, server_version_code: VERSIONS.version_code, checked_at: now(),
      ...(rel.available && vc ? { update_available: rel.version_code > vc, mandatory: vc < (rel.min_supported_version_code || 0) } : {}),
    });
  });

  r.get('/api/integrations', async (req, res, ctx) => {
    const u = requireUser(ctx);
    const { lalaHealthCached } = await import('../providers/ollama.js');
    const lala = await lalaHealthCached(30_000).catch((e) => ({ ok: false, detail: e.message }));
    const devices = await one("SELECT COUNT(*) n FROM devices WHERE user_id = ? AND status = 'connected'", u.id);
    const out = {
      lala: { ok: !!lala.ok, detail: lala.ok ? 'Online' : (lala.detail || 'Unavailable') },
      claude: { configured: !!(process.env.ANTHROPIC_API_KEY || '').trim() },
      github: { configured: false },
      devices: { connected: devices.n },
    };
    if (['admin', 'superadmin'].includes(u.role)) {
      try {
        const h = await fetch(`${config.supabase.url}/auth/v1/health`, { headers: { apikey: config.supabase.publishableKey }, signal: AbortSignal.timeout(5000) });
        out.supabase = { ok: h.ok, detail: h.ok ? 'Auth reachable' : `Auth health HTTP ${h.status}` };
      } catch (e) { out.supabase = { ok: false, detail: `Auth unreachable: ${e.message}` }; }
    }
    sendJson(res, 200, out);
  });
}
void all;
