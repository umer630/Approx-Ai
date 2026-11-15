# Approx AI API v1

Base URL: `https://<your-approx-server>/api/v1` · Auth: `Authorization: Bearer apx_…` (create keys in
the developer console at `/developers/`). Every response has an `X-Request-Id` header.

## POST /chat/completions  (scope `chat`)
```json
{ "model": "auto | nick-4.8 | hike-6.5 | sona-9.0 | fab-100x | fab-500x",
  "mode": "medium | high",
  "messages": [{ "role": "system|user|assistant", "content": "..." }],
  "stream": false }
```
Response:
```json
{ "id": "req_…", "object": "chat.completion", "created": 1794057224, "model": "nick-4.8", "mode": "medium",
  "route_reason": "user-selected",
  "choices": [{ "index": 0, "message": { "role": "assistant", "content": "…" }, "finish_reason": "stop" }],
  "usage": { "prompt_tokens": 0, "completion_tokens": 0 } }
```
`finish_reason: "content_filter"` when the safety policy refused. With `"stream": true` the response is
Server-Sent Events: `event: chunk` (`choices[0].delta.content`) … then `event: done` (full object) or
`event: error`.

## GET /models  (scope `models:read`) · GET /usage  (scope `usage:read`)

## Errors
`{"error": {"code": "...", "message": "...", "request_id": "..."}}`

| HTTP | code |
|---|---|
| 400 | invalid_request, unknown_model |
| 401 | unauthorized |
| 403 | insufficient_scope, model_access_denied, email_not_verified |
| 429 | rate_limited, quota_exceeded, cycle_quota_exceeded (with `Retry-After`) |
| 502 / 503 | model_backend_error / model_backend_unavailable |

## Key management (session-authenticated, used by the console)
`GET/POST /api/developer/keys`, `POST /api/developer/keys/:id/rotate` (old key revoked immediately),
`DELETE /api/developer/keys/:id`, `GET /api/developer/requests`, `GET /api/developer/overview`.
Keys are stored as SHA-256 hashes; the secret is shown once. API keys cannot call account endpoints.
Never embed API keys in mobile apps or browser code.

## Efficiency modes & model versions (1.1)
- **Efficiency modes** are a separate parameter from the model: `low` | `medium` | `high` (default from the
  user's settings). They change real inference parameters (max tokens, temperature, top_p, frequency penalty,
  context budget). Details: `GET /api/models` → `mode_details`.
- **Model versions**: `POST /api/v1/chat/completions` accepts an optional `version` (e.g. `"1.0.0"`) alongside an
  explicit `model`. Without it, the active version is used. Responses and the `route` SSE event include
  `model_version`. A request for a model with no active version returns `503 model_version_not_active`; an unknown
  version returns `404 unknown_model_version`.

## Platform & admin endpoints (1.1)
- `GET /api/health`, `GET /api/v1/health` — liveness (no auth).
- `GET /api/status` — models, inference health, modes, pipelines (admins also see GPU workers + training jobs).
- `GET /api/capabilities`, `GET /api/v1/models/:id`.
- Admin registry: `GET /api/admin/registry`, `POST /api/admin/registry/rescan`,
  `GET /api/admin/registry/:model/:version`, `POST /api/admin/registry/activate` (superadmin),
  `POST /api/admin/registry/deactivate`, `POST /api/admin/registry/import` (raw tar.gz, `X-Artifact-Sha256`).
- Compute: `GET /api/admin/compute`, `POST /api/admin/compute/jobs`, `GET /api/admin/compute/jobs/:id`,
  `POST /api/admin/compute/jobs/:id/stop`. Worker API: `POST /api/v1/worker/claim|jobs|jobs/:id/report`
  (privileged `training:worker` key).
- Media (FAB 500X): `POST /api/v1/media/video/generations`, `/api/v1/media/video/understanding`,
  `/api/v1/media/storyboard`. Video endpoints answer `501 capability_unavailable` until a pipeline URL is set;
  storyboard is text planning only.

## Model registry, status and access (1.7) — shared contract for Web and Android

Clients (web and Android) call **only the Approx backend**; they never call an inference/GPU server and hold no
model or GPU credentials. Every request is authenticated with the Supabase-backed Approx session
(`approx_session` cookie on web, `Authorization: Bearer <session token>` on Android).

`GET /api/models` → `{ models: [...] }`, each:

| field | meaning |
|---|---|
| `id`, `name`, `description` | `nick-4.8`, `hike-6.5`, `sona-9.0`, `fab-100x`, `fab-500x` (canonical IDs) |
| `role` | `everyday` · `complex` · `web-security-analytics` · `advanced-general` · `private-ultra` |
| `access` | `standard` · `advanced` · `restricted` · `admin-granted` |
| `capabilities` | e.g. `general, coding, education…` (Nick) · `webdev, security-audit, analytics…` (Sona) |
| `available` | this account may use the model (plan / grant / admin restriction — decided server-side) |
| `status` | `configured` · `training` · `trained` · `packaged` · `deploying` · `online` · `offline` · `failed` |
| `selectable` | `available && status === "online"` — only these may be offered for normal inference |
| `simulator` | `true` when a development simulator answers (never a trained model) |
| `private`, `workspace` | FAB 500X: listed **only** for accounts holding an admin grant; `workspace: "fab500x-code"` |

Sending a message: `POST /api/chats/:id/messages {content, model, mode}` → SSE `route` (`model_id`, `model_version`,
`reason`), `delta` (`text`), `done`. Errors: `400 unknown_model` (also returned for FAB 500X without a grant — no
existence oracle), `403 model_access_denied`, `503 model_disabled` (administrator), `503 model_version_not_active` /
`model_unavailable` (not online), `429 quota_exceeded` / `model_quota_exceeded`.

Routing (`model: "auto"`): web/security/analytics → Sona 9.0; complex → Hike 6.5; very advanced security → FAB 100X;
everyday → the user's default (Nick 4.8) — only among models the account may use and that are online. FAB 500X is
never auto-routed.

## FAB 500X Code workspace (1.7) — `/api/fab500x/*`

Only for accounts holding the FAB 500X grant; otherwise every route answers `404`. All operations are scoped to the
caller's own projects (another user's project id is a 404).

| method & path | purpose |
|---|---|
| `GET /api/fab500x/capabilities` | what is connected now (agent/model status, terminal runner, image/video pipelines) |
| `GET/POST /api/fab500x/projects` · `DELETE /api/fab500x/projects/:pid?confirm=<name>` | list / create / delete |
| `GET /projects/:pid/tree` · `GET/PUT/DELETE /projects/:pid/file?path=` | files (`.env`/secret files are masked; `reveal=1` is audited; delete needs `confirm=1`) |
| `POST /projects/:pid/rename {from,to}` · `POST /projects/:pid/upload {files:[{path,content}]}` | move/rename files or folders · upload text files |
| `GET /projects/:pid/search?q=&case=` · `GET /projects/:pid/history?path=` · `POST /projects/:pid/history/:vid/restore` | search · per-file history |
| `GET /projects/:pid/changes` · `POST /projects/:pid/checkpoints {message}` | Approx checkpoints (snapshot/status), not Git |
| `GET /projects/:pid/problems` | static checks: JSON/JS syntax, hard-coded secrets (nothing executed) |
| `POST /projects/:pid/run {command}` | sandbox runner only (`APPROX_RUNNER_URL`); otherwise `501 runner_not_configured`; destructive commands `403` |
| `POST /projects/:pid/agent {instruction, permission: manual\|automatic, open_files}` | FAB 500X proposes plan + changes + commands with unified diffs. Manual: nothing applied until approval. Automatic: writes/renames apply at once; deletes and commands still wait |
| `GET /projects/:pid/proposals` · `POST /projects/:pid/proposals/:id/approve\|reject` | review and apply/reject (audited) |

## Admin model control (admin session, `/api/admin/*`)

`GET /api/admin/models-overview` (status, version, availability, visibility, usage, failures) ·
`GET /api/admin/models/:id/health` (live inference health) · `GET /api/admin/models/:id/failures` ·
`GET /api/admin/models/:id/grants` · `PUT /api/admin/models/:id/availability {available, visibility}` (superadmin) ·
`PUT /api/admin/clients/:id/models/:modelId {access: enabled|restricted|default}` (FAB grants: superadmin) ·
`POST /api/admin/models/:id/verify-deployment` (superadmin: health + SHA-256 + a real generation → ACTIVE).
