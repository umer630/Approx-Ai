# Frontend inventory (feature freeze record)

This was recorded before and during the serverless backend migration. **No frontend source file was changed**
by the migration. `git diff 65cb2a2~1 -- web/js web/index.html web/styles.css web/developers android/src
android-standalone` is empty. Compatibility was kept entirely in the backend, with the API contracts unchanged.

## Web app (`web/`, hash routing in `web/js/app.js`)

| Route | View | Purpose |
|---|---|---|
| `#/login` `#/signup` `#/forgot` | `authView` | sign in / create account / forgot password |
| `#/verify` `#/reset` `#/confirm-email` | `tokenView` | email verification code, password reset, email change |
| `#/` `#/c/:id` | `chatView` | chat (new / existing) |
| `#/projects` `#/projects/:id` | `projectsView` / `projectView` | projects with instructions and knowledge files |
| `#/workspace` `#/workspace/:id` | `workspaceView` / `artifactView` | **Workspace**: versioned artifacts (edit / preview / restore) |
| `#/code` `#/code/:id` | `codeProjectsView` / `codeView` | **Code (Fabbox / Coeprox)**: code projects, scaffolds, agent proposals that need approval |
| `#/research` | `researchView` | URL-source research (SSRF-guarded) |
| `#/admin` | `adminView` | users, model-access grants, audit, training export, model registry, compute |
| `/developers/` | `developers/dev.js` | developer console: API keys, request logs, OpenAI-compatible `/api/v1` |

**Shell and controls:** top bar (logo, model pill `Current model`, `Account`, `Settings`); composer (`Message`
textarea, `Add attachments and tools` plus button, `Select model` chip, Low / Medium / High mode toggle,
`Send`, which becomes `Stop` while streaming); bottom nav (New chat / History / Settings).
**Messages:** markdown (`web/js/md.js`), code blocks with **Copy**, message **Copy**, **Regenerate**, Save to
Workspace, model · mode badge. **Model selector:** Master Router (Auto), Nick 4.8, Hike 6.5, Sona 9.0, FAB 100x,
FAB 500X, each with availability / active version. **Plus menu:** File, Image, PDF, Document, Camera,
Data analysis, Research, Code (Fabbox), Workspace, Projects, Tools & connectors ("Not yet available").
**History sheet:** `Search conversations`, tabs, rename / archive / delete. **Settings sections:** Account &
profile, Security & password, Email, Notifications, Privacy & data controls, Memory, Personalization,
Model preferences, Usage & quota, Subscription, API, Connected tools, Delete account, Admin console (admins),
Log out.

## Android online app (`android/`)

The Android app is unchanged by the migration. Its network layer (`android/src/com/approxtech/ai/Api.java`, the
class shipped in the APK) passes 24/24 checks against the serverless topology (`android/jvmtest/ApiJvmTest.java`).
It covers login, model list, SSE chat, Low / Medium / High, uploads, history search, rename, memory, quota,
the FAB lock, the status console and logout. UI features (three-dot menu, mic voice input, model selector with
Free indicators, plus button, send/stop, markdown with code copy) live in the unchanged Android sources.
The backend URL is baked in at build time and verified live by the CI workflow.

## "Approx Code" and "Approx Work"

No feature with these exact names exists in the repository. The existing equivalents are:

- **Approx Code (Claude Code equivalent)** → **Code (Fabbox / Coeprox)**, `#/code`. Backend: `/api/fabbox/*`
  and `/api/coeprox/*`. It does project files, path-traversal-safe edits, templates, and agent *proposals* that
  apply only after the user approves. It does **not** do terminal or command execution:
  `/api/fabbox/capabilities` reports `command_execution: unavailable…`, and the UI says so.
- **Approx Work (Claude Cowork equivalent)** → **Workspace** (`#/workspace`, `/api/workspace/artifacts`) plus
  **Research** (`#/research`). No browser automation or desktop control is implemented, and none is claimed.

Both keep their existing names, because renaming them would break the freeze. Both pass on the serverless backend
(`backend/test/api.test.js` test 21 and `web/test/regression-vercel.cjs`).

## API endpoints consumed by the frontends

`/api/auth/{signup,login,logout,me,verify-email,resend-verification,forgot-password,reset-password,change-password,change-email,confirm-email-change,sessions,sessions/revoke-others}`,
`/api/chats[/:id[/messages|/regenerate]]`, `/api/models`, `/api/settings`, `/api/usage`, `/api/memory[/:id]`,
`/api/projects[/:id]`, `/api/files[/:id[/download]]`, `/api/notifications`, `/api/account/{export,delete}`,
`/api/workspace/artifacts[/:id]`, `/api/fabbox/*`, `/api/coeprox/*`, `/api/research[/capabilities]`,
`/api/developer/{keys,requests,overview}`, `/api/v1/*`, `/api/status`, `/api/version`, `/api/health`,
`/api/admin/{users,model-access,audit,training/*,registry/*,compute/*}`.
All are served by the same handler on both runtimes (`backend/src/server.js#createHandler`).
