// Central configuration. All secrets come from the environment — never from source.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const env = process.env;
const bool = (v, d = false) => (v === undefined ? d : ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase()));
const int = (v, d) => (v === undefined || v === '' ? d : Number.parseInt(v, 10));

export const VERSIONS = Object.freeze({
  product: '1.0.0',
  backend: '1.0.0',
  frontend: '1.0.0',
  api: 'v1 (1.0.0)',
  apk: '1.0.0 (versionCode 1)',
  dataset: 'nick-sft-0.1.0 (seed, not yet trained)',
  model: 'nick-4.8 (base Qwen/Qwen2.5-3B-Instruct)',
  adapter: 'none — training blocked (no GPU in build env)',
});

export const config = {
  env: env.APPROX_ENV || 'production',
  port: int(env.PORT, 8080),
  host: env.HOST || '0.0.0.0',
  publicUrl: (env.APPROX_PUBLIC_URL || '').replace(/\/$/, ''),
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

  search: {
    endpoint: env.SEARCH_API_ENDPOINT || '', // optional web search backend
    apiKey: env.SEARCH_API_KEY || '',
  },
};

export const isProd = () => config.env === 'production';
