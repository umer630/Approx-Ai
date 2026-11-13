# Approx AI — Free Deployment (no paid hosting, no domain, no card)

This gets you a **real, public, free HTTPS backend** and an **online APK that auto-connects** to it with no
server-address field. It is honest about one hard limit: **real AI model responses need a GPU**, and no service
offers a free *continuous* GPU, so chat reports "model unavailable" until you connect a model endpoint — it never
fakes answers.

## Why I could not deploy it for you from here
This build environment's network proxy blocks every hosting provider (`render.com`, `fly.io`, `api.cloudflare.com`
all return `403 CONNECT rejected`); only GitHub/npm/PyPI are reachable. I also have no account on any host and this
container is ephemeral. So deployment needs **one free account authorization from you** (which you approved). After
that single step, a URL exists and the rest is automatic.

## Step 1 — Deploy the backend free on Render (one authorization, ~3 min)
Render's free web service: no credit card, auto HTTPS URL like `https://approx-ai.onrender.com`, no custom domain.

1. Make sure this repo is on your GitHub (it is: `umer630/Approx-Ai`).
2. Go to **render.com → New → Blueprint**, sign in with GitHub (free), pick this repo, click **Apply**.
   Render reads `render.yaml` and builds `deploy/Dockerfile` (Node 22, the backend + web app).
3. Wait for the first build. Render shows your public URL, e.g. `https://approx-ai.onrender.com`.
4. Open it in a browser — you should see the Approx AI web app and be able to **sign up and log in**.

Honest notes about the free tier (all real, none faked):
- The service **sleeps after ~15 min idle**; the next request **cold-starts in ~30–60 s**. It is operational, just
  slow on the first hit. (The app shows a loading state; it is not "down".)
- The free disk is **ephemeral** — the SQLite DB resets on redeploy/restart. Fine for testing. For durable
  accounts later, attach a disk or a managed Postgres.
- `REQUIRE_VERIFIED_EMAIL=false` is preset so sign-up works **without** a mail provider. To require verification,
  set it `true` and configure a free email API (e.g. Resend free tier) via `MAIL_HTTP_ENDPOINT` / `MAIL_HTTP_API_KEY`.

## Step 2 — Get the APK that auto-connects (no server field), built for you by CI
No local commands needed.

1. In your GitHub repo: **Settings → Secrets and variables → Actions → Variables → New variable**
   - Name: `APPROX_SERVER_URL`
   - Value: your Render URL, e.g. `https://approx-ai.onrender.com`
2. **Actions → "Build Approx AI APK" → Run workflow.**
3. When it finishes, open the run and download the **`ApproxAI-Online-apk`** artifact. That APK has your backend
   URL baked in: users see only **Email + Password** — no server field — and it connects automatically.

(Or, if you prefer, paste me the Render URL and I'll build + sign the baked APK and hand it to you directly.)

## Step 3 — Make chat actually answer (free options, honestly labeled)
The backend is fully working, but a model needs an inference endpoint. Pick one:

**A. Free LLM API (working chat in minutes, but a generic model — NOT the trained Nick 4.8).**
Several providers are OpenAI-compatible and have a genuinely free tier (e.g. OpenRouter free models, Groq). In
Render → your service → **Environment**, add, for example:
```
APPROX_MODEL_NICK_URL   = https://<provider>/v1
APPROX_MODEL_NICK_KEY   = <your free api key>
APPROX_MODEL_NICK_NAME  = <the provider's model id>
```
Chat then works immediately. Be clear with your users that this is a general assistant, **not** the trained Nick
4.8 — the app shows the configured model id honestly.

**B. The real trained Nick 4.8 (needs a GPU host).**
Run `inference/server.py` with the recovered Nick 4.8 adapter on a GPU (Colab/Kaggle for testing, or any GPU host),
expose it over HTTPS, and point `APPROX_MODEL_NICK_URL` at it (leave `_NAME` unset so it serves `nick-4.8@<version>`
from the registry). This serves the actual adapter. There is **no free continuous GPU**, so this is not a
"set-and-forget free" option — it runs while your GPU session runs.

Hike 6.5 / Sona 9.0 / FAB 500X are **not trained yet**, so they stay unavailable until their adapters exist — the
app reports this honestly and never substitutes another model for them.

## What works for free, today, with zero GPU
- Public HTTPS backend + web app (Render free).
- Sign up / log in / sessions / logout / password reset.
- Model catalog + selector, efficiency modes, chat history, settings, admin console.
- The online APK, auto-connecting, with the full chat UI (three-dot menu, +, voice, send/stop, markdown).
- Honest "model unavailable" until you connect a model endpoint — **no fake responses, ever.**
