// Vercel serverless entry point. Every /api/* and /healthz request is rewritten here (see vercel.json).
// It runs exactly the same request handler as the long-running server (backend/src/server.js), so the
// API contract consumed by the web app and the Android app is unchanged. Static files are served by
// Vercel from web/ (outputDirectory) and never reach this function.
//
// Persistence: set APPROX_DB_URL (libsql://… Turso) and APPROX_DB_AUTH_TOKEN. Without them every
// request that needs data fails closed with 503 database_not_configured — the function never falls
// back to the ephemeral /tmp filesystem.
import { createHandler } from '../backend/src/server.js';

const handler = createHandler();

export default function approx(req, res) {
  return handler(req, res);
}
