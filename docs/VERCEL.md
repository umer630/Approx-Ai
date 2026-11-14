# Approx AI on Vercel (free Hobby plan)

The backend now runs on Vercel serverless functions. This replaces the earlier "cannot run on Vercel" report,
which was true of the old synchronous, file-based backend. Docker / Render deployment is unchanged and still
works (`deploy/`, `render.yaml`).

**Status: prepared and tested locally. Not deployed yet.** Deploying needs your sign-in to three free
services. Nothing below needs a terminal, and everything can be done from a phone browser.

## Architecture

```
Phone APK / browser ──HTTPS──► Vercel (free Hobby)
                                ├─ web/            static frontend (unchanged)
                                └─ api/index.js    one serverless function = the same backend handler
                                       │
                                       ├──► Turso (free)   libSQL database: users, sessions, chats, projects,
                                       │                   model permissions, quotas, API keys/logs, audit,
                                       │                   uploaded file bytes, training exports
                                       ├──► Gmail SMTP (free) verification / password-reset emails
                                       └──► GPU inference server (separate; NOT on Vercel)
                                            serves Nick 4.8 only if the adapter SHA-256 equals
                                            2faae21620ef0aea6140b296b43ab5fcf5ba2c5b721067f91797b288a09c34c4
```

| Concern | Before (Docker/Render) | On Vercel |
|---|---|---|
| Database | SQLite file on a disk | Turso libSQL (same SQL, same `@libsql/client` code path) |
| Uploads | `data/uploads/` | `file_blobs` table in the database (`APPROX_FILE_STORAGE=db`, automatic) |
| Background timers | registry watcher in the server process | none. The function asks the inference server `/health` (cached 10 s) on demand |
| Model registry | `active.json` on a shared volume | the inference server is the source of truth (`APPROX_REGISTRY_SOURCE=inference`, automatic) |
| Missing database | n/a | **fails closed**: every data request returns 503 `database_not_configured`. It never falls back to `/tmp` |

## Step 1: Turso database (free)

1. Open **turso.tech** and tap **Sign up**. Sign in with GitHub.
2. In the dashboard, tap **Create Database**. Name it `approx-ai` and pick the region closest to you. Tap **Create**.
3. Open the database. Copy the **URL**, which starts with `libsql://`.
4. Tap **Create Token** (Generate token). Choose read & write and no expiry, then copy the token.
   Keep it private. It goes only into Vercel's environment variables (Step 3).

If Turso asks for a credit card or a paid plan at any point, **stop**: don't enter it, and tell me.

## Step 2: Email (Gmail, free)

Email verification and password reset stay switched on. Codes are sent from your Gmail account over Gmail
SMTP (`smtp.gmail.com`, port 465, TLS) using a **Google App Password**: a 16-letter password Google
generates for one app. It is not your Google password. Create one at **myaccount.google.com → Security →
2-Step Verification → App passwords**. 2-Step Verification must be on.

Gmail's free sending limit is about 500 emails a day. Brevo (`MAIL_TRANSPORT=brevo`) still works if you
prefer it.

## Step 3: Vercel project (free Hobby)

1. Open **vercel.com**, tap **Sign up → Hobby**, and **Continue with GitHub**.
2. Tap **Add New… → Project**, then find **Approx-Ai** and tap **Import**.
   (If it isn't listed, tap **Adjust GitHub App Permissions** and allow the repository.)
3. **Framework Preset**: Other. Leave Root Directory, Build and Output settings as they are, because
   `vercel.json` sets them.
4. Open **Environment Variables** and add:

| Name | Value | Secret? |
|---|---|---|
| `APPROX_DB_URL` | the `libsql://…` URL from Step 1 | no |
| `APPROX_DB_AUTH_TOKEN` | the Turso token from Step 1 | **yes** |
| `APPROX_BOOTSTRAP_SUPERADMIN_EMAIL` | your Gmail address (also the SMTP username; becomes superadmin once, after you verify it) | no |
| `MAIL_TRANSPORT` | `smtp` | no |
| `MAIL_SMTP_PASS` | the 16-letter Google App Password from Step 2 | **yes** |
| `APPROX_ENV` | `production` | no |
| `APPROX_MODEL_NICK_URL` | only when a GPU inference server is running: `https://<gpu-host>/v1` | no |
| `APPROX_MODEL_NICK_KEY` | that inference server's `INFERENCE_API_KEY` | **yes** |

   Leave the `APPROX_MODEL_*` variables out until a GPU host exists. Nick 4.8 then shows as unavailable and
   never answers with a different model.
5. Tap **Deploy**. When it finishes, Vercel shows your address, for example `https://approx-ai-xxxx.vercel.app`.

If Vercel asks for a card or a paid plan, stop and tell me.

## Step 4: Check that it really works

Open `https://<your-address>/api/health` in the phone browser. It must show:

```
"database":"ok", "runtime":"serverless", "registry_source":"inference", "file_storage":"db"
```

`"mail_configured": true` must also appear. `"database":"not_configured"` means Step 1's variables are missing or misspelled. Then open the main address,
create an account with the email from `APPROX_BOOTSTRAP_SUPERADMIN_EMAIL`, enter the emailed code, and sign in.
Settings should now show **Admin console**.

Send me the address once `/api/health` shows `database: ok`, and I'll run the live checks against it.

## Step 5: Android APK pointed at the real backend

GitHub → **Approx-Ai → Settings → Secrets and variables → Actions → Variables → New repository variable**:
name `APPROX_SERVER_URL`, value your Vercel address. Then **Actions → Build APK → Run workflow**.
The workflow refuses to build unless `<address>/api/health` is a live Approx AI backend with `database: ok`,
so a wrong or placeholder address can't end up inside the APK. Download the APK from the run's **Artifacts**.

## Free-plan limits (honest)

- **Request body 4.5 MB**: uploads are capped at 4 MB on Vercel (10 MB on Docker/Render).
- **Function duration 60 s** (`maxDuration`): a very long High-mode reply that streams for more than
  60 s is cut off. The GPU server's speed decides this.
- **Cold starts**: the first request after idle takes about 1–2 s longer.
- **Rate limits and quotas** are stored in the database, so they hold across function instances.
- **Model registry imports and activation** happen on the GPU inference host (`cli.js` there). On Vercel these
  admin buttons return 409 `registry_managed_by_inference_server`. Showing them as working would be dishonest.
- Free-tier quotas (Turso storage and reads, Gmail about 500 emails a day, Vercel invocations) are
  published by each provider and can change. I could not check them from the build environment.

## How this was tested (without a live deployment)

- `backend/test/vercel.test.js` runs the real `api/index.js` with `VERCEL=1`. It covers fail-closed without a
  database, refusing a local file database in production, Gmail-style SMTP over TLS and Brevo mail, superadmin bootstrap, Nick 4.8 routed to
  the version the (mock) GPU host serves, honest 503s when it is not served or unreachable, uploads stored in the
  database, and data surviving a simulated cold start.
- `web/test/regression-vercel.cjs` (Playwright) runs the unchanged web app through `web/test/vercel-emulator.mjs`
  (static `web/` + `vercel.json` rewrites + headers) and checks every frozen feature.
- The database in these tests is a scratch libSQL file (`APPROX_TEST_EPHEMERAL_DB`, ignored in production)
  because no Turso server is reachable from the build sandbox. Production uses the same client over `libsql://`.
