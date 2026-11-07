# Approx AI — by Approx Technology

<img src="web/assets/logo-192.png" width="72" alt="Approx AI logo">

Approx AI is a mobile-first, multilingual (English · اردو · Roman Urdu) AI assistant platform:
web app, native Android app, developer API platform, Master Router over the Nick / Hike / Sona / FAB
model family, and a QLoRA training pipeline for **Nick 4.8** (base `Qwen/Qwen2.5-3B-Instruct`).

| Part | Path | Status (see `docs/FINAL_REPORT.md` for evidence) |
|---|---|---|
| Backend + API (Node 22, zero npm deps, SQLite) | `backend/` | Built, 27/27 automated tests pass |
| Web app (chat, history, settings, projects, workspace, Fabbox, research, admin) | `web/` | Built, browser-tested (Playwright) |
| Developer console | `web/developers/` | Built, browser-tested |
| Android app (native Java, no WebView) | `android/` | Release APK built + signed; network layer tested on JVM; **not run on a device** |
| Training pipeline (Nick 4.8 QLoRA) | `training/` | Data pipeline runs; **training blocked (no GPU / Hugging Face access in build env)** |
| Deployment | `deploy/` | Docker + compose ready; **not deployed (no credentials)** |

## Quick start (local development)

```bash
cd backend
npm run dev          # http://localhost:8080 — dev simulator ON (replies are clearly labelled as simulated)
npm test             # 27 integration tests
```
Verification and reset emails are printed to the console in development (outbox transport).
Promote yourself to superadmin: `node src/cli.js promote you@example.com superadmin`.

## Production

See `docs/DEPLOYMENT.md`. In short: build `deploy/Dockerfile`, put it behind HTTPS, set
`APPROX_MODEL_NICK_URL` to an OpenAI-compatible server (vLLM with the Nick adapter), and configure
a transactional mail provider. Without a model backend the API returns `503 model_backend_unavailable` —
it never fabricates answers.

## Documentation
- `docs/ARCHITECTURE.md` — system design, data model, Master Router, policies
- `docs/API.md` — public API reference
- `docs/SECURITY_AUDIT.md` — findings by severity and fixes
- `docs/LEGAL_RISK_REVIEW.md` — technical legal-risk review (not legal advice)
- `docs/QA_REPORT.md` — what was tested and how
- `docs/RELEASE_NOTES.md` — versions and changelog
- `docs/FINAL_REPORT.md` — complete implementation report (A–Z), artifacts and blockers
