// Central configuration. All secrets come from the environment — never from source.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const env = process.env;
const bool = (v, d = false) => (v === undefined ? d : ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase()));
const int = (v, d) => (v === undefined || v === '' ? d : Number.parseInt(v, 10));

// Software versions. Model/adapter versions are NOT listed here: they come from the model registry
// (verified release artifacts) at run time — see registry.js and GET /api/status.
export const VERSIONS = Object.freeze({
  product: '1.1.0',
  backend: '1.1.0',
  frontend: '1.1.0',
  api: 'v1 (1.1.0)',
  apk: '1.1.0 (versionCode 2)',
});

export const config = {
  env: env.APPROX_ENV || 'production',
  port: int(env.PORT, 8080),
  host: env.HOST || '0.0.0.0',
  // Prefer an explicit APPROX_PUBLIC_URL; otherwise auto-detect the host's injected external URL
  // (Render sets RENDER_EXTERNAL_URL) so free deployments need no manual public-URL configuration.
  publicUrl: (env.APPROX_PUBLIC_URL || env.RENDER_EXTERNAL_URL || '').replace(/\/$/, ''),
  dataDir: env.APPROX_DATA_DIR || path.resolve(here, '../../data'),
  webDir: path.resolve(here, '../../web'),
  buildId: env.APPROX_BUILD_ID || 'local',
  trustProxy: bool(env.APPROX_TRUST_PROXY, false),
  // CORS: explicit allow-list only (comma separated). Same-origin web app needs none.
  corsOrigins: (env.APPROX_CORS_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean),

  // Quota (spec §25): 100 AI requests per rolling 60 minutes; usage cycle renews every 2 days.
  quota: {
    windowMinutes: int(env.QUOTA_WINDOW_MINUTES, 60),
    windowLimit: int(env.QUOTA_WINDOW_LIMIT, 100),
    cycleDays: int(env.QUOTA_CYCLE_DAYS, 2),
    cycleLimit: int(env.QUOTA_CYCLE_LIMIT, 0), // 0 = no extra per-cycle cap (only window limit)
  },

  auth: {
    sessionDays: int(env.SESSION_DAYS, 14),
    maxFailedLogins: int(env.MAX_FAILED_LOGINS, 8),
    lockMinutes: int(env.LOCK_MINUTES, 15),
    requireVerifiedEmailForChat: bool(env.REQUIRE_VERIFIED_EMAIL, true),
  },

  files: {
    maxBytes: int(env.MAX_UPLOAD_BYTES, 10 * 1024 * 1024),
    clamdscan: env.CLAMDSCAN_PATH || '', // optional external AV
  },

  mail: {
    transport: env.MAIL_TRANSPORT || 'outbox', // outbox | http
    httpEndpoint: env.MAIL_HTTP_ENDPOINT || '', // e.g. a transactional mail provider API
    httpApiKey: env.MAIL_HTTP_API_KEY || '',
    from: env.MAIL_FROM || 'Approx AI <no-reply@approx.invalid>',
  },

  // Dev simulator provider — NEVER a real model. Only for local development / automated tests.
  devProvider: bool(env.APPROX_DEV_PROVIDER, false),

  // Model registry: versioned, verified release artifacts produced by the training pipeline.
  //   <modelsDir>/<model-id>/versions/<x.y.z>/{adapter/, release.json, metadata.json, SHA256SUMS, …}
  //   <modelsDir>/active.json   ← which version of each model is live (shared with the inference server)
  registry: {
    dir: path.resolve(env.APPROX_MODELS_DIR || path.join(env.APPROX_DATA_DIR || path.resolve(here, '../../data'), 'models')),
    // off (default): a superadmin activates versions explicitly.
    // production: the newest verified release with production_ready=true is activated automatically.
    // validated: the newest verified, validated release is activated automatically (even if not production-ready).
    autoActivate: ['off', 'production', 'validated'].includes(env.APPROX_AUTO_ACTIVATE) ? env.APPROX_AUTO_ACTIVATE : 'off',
    // Smoke-test artifacts (tiny random models from the CPU test pipeline) can only ever be used outside production.
    allowSmoke: bool(env.APPROX_ALLOW_SMOKE_MODELS, false) && (env.APPROX_ENV || 'production') !== 'production',
    scanSeconds: int(env.APPROX_REGISTRY_SCAN_SECONDS, 60),
    maxArtifactBytes: int(env.APPROX_MAX_ARTIFACT_BYTES, 3 * 1024 * 1024 * 1024),
    // Optional HMAC key shared with the training pipeline: when set, releases must carry a valid SIGNATURE.
    signingKey: env.APPROX_RELEASE_SIGNING_KEY || '',
    // Optional: our inference server's admin endpoint, told to reload right after an activation.
    inferenceAdminUrl: (env.APPROX_INFERENCE_ADMIN_URL || '').replace(/\/$/, ''),
    inferenceAdminKey: env.APPROX_INFERENCE_ADMIN_KEY || '',
  },

  search: {
    endpoint: env.SEARCH_API_ENDPOINT || '', // optional web search backend
    apiKey: env.SEARCH_API_KEY || '',
  },
};

export const isProd = () => config.env === 'production';
