# Approx AI — Architecture

## 1. System overview

```
 Android app (native Java) ─┐            ┌──────────── Approx backend (Node 22, single process) ─────────────┐
 Web app (vanilla JS SPA) ──┼─ HTTPS ──▶ │ http.js (router, headers, CORS) → security.js (auth, CSRF, limits) │
 Developer console ─────────┤            │ routes/: auth · chat · files · account · workspace · developer ·  │
 API clients (apx_ keys) ───┘            │          admin                                                     │
                                         │ engine.js (context assembly) → models.js (Master Router, policy)   │
                                         │ quota.js (server-side quota) → providers/ (OpenAI-compatible SSE)  │
                                         │ db.js (SQLite via node:sqlite, WAL)  · netguard.js (SSRF-safe fetch)│
                                         └───────────────┬───────────────────────────────┬────────────────────┘
                                                         │                               │
                                       vLLM / TGI: Qwen2.5-3B-Instruct            data/ (db, uploads,
                                       + Nick 4.8 LoRA adapter (GPU)              training exports)
```

Design choices:
- **Zero runtime dependencies** in the backend (Node built-ins only: `node:http`, `node:sqlite`,
  `node:crypto`). Minimises supply-chain risk; nothing to `npm install`.
- **No build step** for the web app: ES modules served from `web/` under a strict CSP
  (`script-src 'self'`, no inline script/style, `frame-ancestors 'none'`).
- **Provider abstraction**: every model family maps to an OpenAI-compatible endpoint configured by
  environment variables. Unconfigured → `503 model_backend_unavailable`. The dev simulator is
  opt-in (`APPROX_DEV_PROVIDER=1`) and every simulated reply is labelled as such.

## 2. UI architecture
- Top bar: logo, current model + mode indicator (opens model picker), avatar (account), settings.
- Main: conversation with streaming, typing indicator, Markdown (safe renderer), code blocks with
  copy, per-message copy / regenerate / save-to-Workspace, model+mode tag, timestamp, error + retry.
- Composer: **+** (Plus menu), textarea ("Ask Approx AI anything..."), model selector, Medium/High
  toggle, send/stop. Shows remaining hourly quota.
- **Three-button navigation**: New chat · History · Settings.
- Plus menu: File, Image, PDF, Document, Camera, Data analysis, Research, Code (Fabbox), Workspace,
  Projects, Tools & connectors (explicit "not yet available" state).

## 3. Models, modes, Master Router

| Model | Tier | Access | History training |
|---|---|---|---|
| Nick 4.8 (default) | default | all users | allowed with consent |
| Hike 6.5 | advanced | all users | allowed with consent |
| Sona 9.0 | premium | Pro/Enterprise plan, admin, or grant | allowed with consent |
| FAB 100x / 500x | restricted | explicit superadmin grant only | **never** |

Modes (`medium`, `high`) are a separate parameter: High → 4096 max tokens, temperature 0.4 and a
deliberate-reasoning instruction; Medium → 1024 tokens, temperature 0.7. Unknown modes are rejected;
passing a mode name as a model is rejected (`unknown_model`).

Master Router (`models.js#route`): classifies task type (security, code, math, research, creative,
Urdu/Roman Urdu) and complexity, then picks the best model **the caller is permitted to use**
(FAB for complex security only when granted → Sona for complexity ≥4 → Hike for complex/code/math →
user default → Nick). An explicitly selected model is access-checked and never silently substituted.
A safety policy blocks clearly harmful offensive requests (malware, credential theft, DDoS, AV
evasion, weapons) for all models before quota is charged.

## 4. Data model (SQLite)
users, profiles, settings, sessions, email_tokens, subscriptions, models, model_access, projects,
chats, messages, files, memories, usage_events, api_keys, api_requests, artifacts,
artifact_versions, code_files, code_proposals, training_datasets, training_jobs, model_versions,
adapters, audit_logs, security_events, notifications, mail_outbox, rate_buckets.

Tenant isolation: every user-owned row has `user_id`; every route query filters by the
authenticated user id (tested for chats, messages, search, projects, files, memory, artifacts,
attachments). FAB chats carry `is_fab=1` and a CHECK constraint makes `training_eligible=1`
impossible for them.

## 5. Auth & sessions
scrypt (N=2¹⁵, r=8, p=1) password hashing; random 256-bit session tokens stored as SHA-256;
web: `HttpOnly; SameSite=Strict` cookie + per-session CSRF token header; Android: bearer session
token encrypted at rest with an Android Keystore AES-GCM key. Email verification and reset tokens are
single-use, hashed, expiring. Lockout after 8 failures (15 min), IP + email rate limits, timing-safe
comparisons and dummy hashing to avoid account enumeration, audit + security event logs. Password
change/reset/email change revoke other sessions.

## 6. Quota
100 AI requests per rolling 60 minutes, usage cycle renewing every 2 days (anchored at signup),
optional per-cycle cap (`QUOTA_CYCLE_LIMIT`). Shared across chat, research, Fabbox, API. Enforced in
`quota.js` before the provider call; `429 quota_exceeded` with `Retry-After`.

## 7. Memory, projects, history
Memory: explicit only (settings UI or "remember that …" / "yaad rakho …" in chat), view/edit/delete/
clear/disable; injected into Nick/Hike/Sona prompts only — never FAB. Projects: instructions + knowledge
files (keyword retrieval over extracted text) + chats; strictly per-user. History: search (titles and
message text), recent/archived/trash, rename, archive, soft delete, restore, purge.

## 8. Research
User-supplied source URLs (or a configured search backend) are fetched through an SSRF-safe client
(public IPs only — checked at connect time — http(s), ports 80/443, max 1 MB, 3 redirects
re-validated), converted to text, and passed to the model as retrieval context with numbered
citations. Retrieval knowledge is used at answer time and never written into weights.

## 9. Workspace, Fabbox Code, Coeprox
Workspace: artifacts (document/code/table/markdown/json/html) with immutable version history, restore,
export (download as file, sandbox CSP). Fabbox Code: per-project virtual file tree; the agent returns
a JSON change set that is stored as a **pending proposal** and only applied after explicit user
approval. Coeprox: same engine plus deterministic scaffolding templates (Node API, static web,
Python CLI). Command execution, git/GitHub and CI/CD are reported as *unavailable* (they need an
isolated sandbox runner and OAuth apps that are not configured) — nothing runs on the API server.

## 10. Training system
See `training/README.md`. Consented-history export (server) → offline pipeline (approved sources only,
schema validation, PII scrub, quality filter, exact + near dedupe, domain balancing, provenance
manifest with SHA-256) → QLoRA training with resume → adapter manifest → verification (files, hashes,
load, inference, identity/language/safety probes, perplexity) → adapter registration endpoint, which
rejects adapters without `verification_passed=true`.
