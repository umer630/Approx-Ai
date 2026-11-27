# Supabase: what is connected, and the Postgres schema

Project: `uyatvhgngzrrvelahebi` (https://uyatvhgngzrrvelahebi.supabase.co). Verified 2026-11-27.

## Connected today
| Part | Where it lives | Status |
|---|---|---|
| Sign-up, email verification (code or link), password set at verification, login, password reset, two-step verification (TOTP) | **Supabase Auth** of this project, called only by the Approx backend | live; checked against the real project with `backend/test/live/live-supabase.mjs` (14/14, no account created, no email sent) |
| Approx data (users/profiles, settings, organizations, workspaces, projects, sessions, threads, messages, tasks, files, artifacts, agent runs, tool executions, connectors, code, education) | the backend's libSQL/Turso database (`APPROX_DB_URL`) | live; ownership checked on every API route |
| Supabase Postgres (`public` schema) | — | **empty**: none of the Approx tables exist there yet (checked through the Data API) |

The web app and the APK never talk to Supabase directly: they call the Approx backend, which holds the keys
(publishable key: public; `SUPABASE_SECRET_KEY`: optional, server-only). One Supabase user maps to one Approx user
(`users.supabase_uid`); emails are lower-cased everywhere.

## The Postgres schema for this project
`supabase/migrations/20261127000000_approx_core.sql` — all Approx tables with foreign keys, indexes and millisecond
timestamps (same IDs as today, so existing rows copy over unchanged), the `threads` view, and **Row Level Security on
every table**:
- `authenticated`: each policy limits rows to the caller (`public.approx_uid()` = the Approx user whose
  `supabase_uid = auth.uid()`); child rows must point at parents the caller owns (no ID swapping into someone else's
  thread, session, workspace or project); organizations/workspaces readable by members, membership changed by owners.
- `anon`: no grants, no policies — nothing.
- Idempotent (`if not exists`, `drop policy if exists`): never drops a table or deletes data.

Verified in real Postgres (PGlite) by `backend/test/supabase-rls.test.js`: applies twice, RLS on every table,
SELECT/UPDATE/DELETE/INSERT isolation for every table, unique normalized email, one Approx user per Supabase user.

### Applying it (needs a privileged credential — not available to this repository)
The publishable key cannot create tables. Apply with either:
- Supabase Dashboard → SQL Editor → paste the migration → Run; or
- `supabase link --project-ref uyatvhgngzrrvelahebi && supabase db push` (Supabase access token + database password).

### Moving the live data store to Supabase Postgres (not done)
Switching the backend from libSQL to Postgres also needs: a server-only `DATABASE_URL` (Supabase → Project Settings →
Database → connection string, pooled), a Postgres driver in `backend/src/db.js` (the SQL is SQLite dialect today), and a
one-time copy of the production rows from Turso (needs the Turso credentials). None of this is done; production data
stays where it is until the owner provides these and approves the copy.
