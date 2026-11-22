# Release notes

## Approx AI 1.5.0 — APK 1.5.0 (versionCode 11), API contract 1.9 (2026-11-22)
- **Login after verification fixed.** Root cause: Supabase keeps the first password of an address signed up twice
  without verifying. The password is now set together with the verification code (web + Android) — see SUPABASE_AUTH.md.
- **Workspaces → sessions → threads → tasks** for Approx Work, Approx Code and Approx Education, persisted server-side
  (organizations, workspaces, work_sessions, tasks, agent_runs, tool_executions, connectors, code_commits,
  code_branches, study_attempts). New Session = new server ID; sessions resume exactly; threads are isolated
  conversations sharing the session context; rename/archive/duplicate/delete/search.
- Approx Code: repositories, code sessions, files/editor, changes (diff), commit, history, branches/checkout; terminal /
  run / test / build report honestly that no sandbox runner is configured. Approx Education: courses, study sessions,
  documents, quizzes with server-side answer keys, practice scores, assignments, progress. Approx Work: tasks, agent
  planning (one thread per task), files, outputs, logs.
- Android: Home/Work/Code/Education/Projects/Sessions/Files/Profile in the menu, session bar with thread chips and tools.
  Web: bottom nav Home/Work/Code/Education/Profile, workspace and session pages, Files page.

## Approx AI 1.4.0 — APK 1.4.0 (versionCode 10), API contract 1.8 (2026-11-21)
- Android Home: personalized time-of-day greeting (Good morning/afternoon/evening/night, Night owl), three primary
  actions (Education, Approx Code, Approx Work) and the chat input. Bottom tab bar removed; ☰ side menu holds New
  chat, the workspaces, History (+ recent chats), Account, Settings and Help; ✎ starts a new chat / session.
- Education: upload a PDF (or text) → a study session grounded in the document (teach step by step, summaries,
  tests with answer keys, MCQs, difficult topics, study plans). New `/api/sessions`; real PDF text extraction
  (pdf.js via unpdf — the previous extractor read nothing from embedded-font PDFs); whole-document retrieval.
- Approx Code / Approx Work: clean landing with "Start new session" and recent sessions; each session is isolated.
- APK sign-up: proved request-for-request identical to the browser (backend/test/apkauth.test.js runs the APK's
  Api.java); the sign-up answer now stays on the verify screen and resend waits out the 60 s email cooldown.

## Unreleased — Nick 4.8 Kaggle training handoff (2026-11-07)
Training status: **NOT TRAINED** — no adapter exists yet. Model/adapter versions unchanged.
- Kaggle notebook rebuilt: clones the correct branch, fails fast, stage runner (preflight → data → train → verify → package → status).
- Preflight runs a real bitsandbytes 4-bit kernel on the GPU and confirms `Qwen/Qwen2.5-3B-Instruct` is reachable (no substitution).
- Checkpoint/resume within a session and across Kaggle sessions (`/kaggle/input`), with dataset-identity check.
- Verification: identity, English, Urdu, Roman Urdu, maths, reasoning, executed coding test, safety + over-refusal, malformed input, LoRA-weights-changed, base-vs-adapter perplexity → `verification.json`.
- Packaging: `nick-4.8-adapter-1.0.0.tar.gz`, `verification.json`, `SHA256SUMS` (deterministic, self-checked).
- Dataset builder: malformed-line rejection, license enforcement, time-sensitive filter, reproducibility fingerprint, `production_ready` verdict (seed set: false).
- Adapter registry hardened (rejects smoke, failed safety, wrong base model, hash mismatch, duplicates).
- **Fixed:** `training/data/seed/` was excluded by `.gitignore` (`data/`) and missing from the repository and from
  `release/approx-ai-1.0.0-source.zip`. Now committed; the 1.0.0 source ZIP is known to lack these two files.

## Approx AI 1.0.0 — 2026-11-07 (first release, built from zero)

| Component | Version |
|---|---|
| Product | 1.0.0 |
| Frontend (web + developer console) | 1.0.0 |
| Backend | 1.0.0 |
| API | v1 (1.0.0) |
| Android APK | 1.0.0 (versionCode 1) — `ApproxAI-1.0.0-release.apk` |
| Dataset | nick-sft-0.1.0 (seed only: 41 train / 4 eval) |
| Model | Nick 4.8 — base `Qwen/Qwen2.5-3B-Instruct` |
| Adapter | none — training blocked (no GPU in build environment) |

### Added
- Authentication: signup, email verification, login, logout, password change/reset, email change,
  session list/revoke, lockout, rate limiting, audit + security event logs, account deletion, data export.
- Chat: streaming (SSE), Master Router (auto), Nick 4.8 / Hike 6.5 / Sona 9.0 / FAB 100x / FAB 500x,
  Medium/High modes, regenerate, copy, retry, stop, timestamps, attachments, safety policy.
- History (search, archive, trash/restore/purge, rename), Projects (instructions, knowledge files),
  Memory (explicit, editable, disable), Personalization, Usage & quota (100/60 min, 2-day cycle).
- Approx Workspace (versioned artifacts, export), Approx Research (cited, SSRF-safe source fetching),
  Approx FABBOX Code (approval-gated agent edits), COEPROX (scaffolding templates).
- Developer platform: API keys (scopes, rotation, revocation), `/api/v1/chat/completions` (+ streaming),
  `/api/v1/models`, `/api/v1/usage`, request logs, docs, console.
- Admin: model access grants (FAB superadmin-only), plans, audit view, consented training export,
  adapter registry (requires verification).
- Android: native app with auth, chat streaming, model + mode, Plus menu uploads, history, settings,
  memory, privacy consent, projects, files, usage, delete account; HTTPS-only; Keystore-encrypted token.
- Training: dataset build pipeline with provenance, QLoRA trainer with resume, verifier, Kaggle notebook.
- Docs: architecture, API, deployment, security audit, legal-risk review, QA report.

### Known limitations
See `docs/FINAL_REPORT.md` → "Remaining blockers".
