# Release notes

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
