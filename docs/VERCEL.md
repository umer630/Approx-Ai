# Approx AI on Vercel — honest compatibility report

**Verdict: the Approx AI backend cannot run on Vercel Hobby (free) as it is built, and cannot be made to without
a major rewrite to an external database.** This document explains exactly why, with evidence from the code, and
lists the genuinely zero-cost options. No `vercel.json` that pretends to deploy the backend has been created,
because it would silently break (which you explicitly forbade).

## Why — the evidence (from this repo)

Vercel Hobby runs **serverless functions**: each request is a short-lived, stateless invocation, with an
**ephemeral filesystem** that is **not shared** between invocations or instances, and **no long-running process**.

The Approx AI backend is the opposite of that:

| Backend reality | File / line | Breaks on Vercel because |
|---|---|---|
| **`node:sqlite` local-file database** (`DatabaseSync`, synchronous) | `backend/src/db.js:3,458` | The SQLite file lives on local disk. On Vercel the filesystem is ephemeral and per-invocation, so the DB would be **empty on every cold start and never shared** → all accounts, sessions and data vanish. `node:sqlite` is also an experimental flagged feature, not supported on Vercel's serverless runtime. |
| **Long-running HTTP server** (`http.createServer().listen()`) | `backend/src/server.js:59,95` | Serverless has no process to `listen()`; you export a handler, not a server. |
| **Background timer** (`setInterval` registry watcher) | `backend/src/registry.js:602` | Serverless functions are frozen between requests; timers don't run. |
| **Local-filesystem uploads** (`fs.writeFileSync` to `data/uploads`) | `backend/src/routes/files.js:124` | Uploaded files would not persist and would not be visible to other invocations. |
| **222 synchronous DB calls** (`one/all/run` → `.prepare().get/all/run`) across the routes | everywhere | Any real database on Vercel is an **async network call**. Converting 222 synchronous call sites to `await` cascades through the entire codebase — a large, risky rewrite, not a config change. |

So a `vercel.json` that "deploys the backend" would either (a) use the ephemeral filesystem — silently replacing
persistent storage with temporary storage (forbidden), or (b) fail at runtime the moment anyone signs up. Neither
is a genuine deployment.

## What Vercel Hobby *can* host for free (honestly)

- **The static web frontend** (`web/` — plain HTML/CSS/JS). That is real and legitimate. But it is only useful
  if it can reach a running backend API, and the backend must live on a host that fits its architecture.

## Genuinely zero-cost options that actually work

**Option A — Keep the backend on a host that runs stateful servers (recommended, least work).**
The backend is a normal Node server with a local database and background jobs. It belongs on a host that gives a
**persistent process + a small persistent disk**, for free, no card. The repo already has the config for this
(`deploy/Dockerfile`, `render.yaml`, `docs/DEPLOY_FREE.md`). Free hosts that fit this shape: Render free web
service (already configured here), or Fly.io's free allowance with a small volume, or Koyeb's free instance.
Vercel can additionally host the static `web/` frontend pointing at that backend (CORS configured via
`APPROX_CORS_ORIGINS`) — a legitimate split, if you want Vercel in the picture.

**Option B — Rewrite the backend for Vercel + a free serverless database (real work, I can do it if you choose).**
To genuinely run on Vercel the backend must become serverless and use an **external free database**:
- Database: Turso / libSQL (SQLite-compatible, free tier, no card) or Neon Postgres (free, no card).
- Convert the DB layer (`db.js`) and all 222 call sites from synchronous `node:sqlite` to the async external
  client (`await` throughout), rework schema/migrations, move uploads to free object storage (e.g. a Vercel Blob
  free allowance or an external bucket), and replace the `listen()` server + `setInterval` with a serverless
  handler and an external scheduler.
- This is a substantial, multi-file re-architecture (not a deployment config). I will only do it as explicit,
  tested work — not as a quietly-broken `vercel.json`.

## What I did NOT do, and why
- I did **not** create a backend `vercel.json` — it would not genuinely work (see the table) and would violate
  your rule against silently using temporary storage or faking success.
- I did **not** change the working backend, Android app, model registry, or Nick 4.8 adapter pinning. All remain
  intact (Render/Docker/GPU configs untouched).
- Nick 4.8 GPU serving is unchanged: still a separate GPU host, still hard-pinned to
  `2faae21620ef0aea6140b296b43ab5fcf5ba2c5b721067f91797b288a09c34c4`, still returns an honest "model unavailable"
  when no GPU endpoint is connected.
