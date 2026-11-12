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
