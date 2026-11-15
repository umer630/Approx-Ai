# Approx AI Admin panel

The Admin panel is a separate web app at **`/admin`**. The client web app and the Android app have no admin entry
any more. Clients never see it, and nothing they can send gets them in.

## How access works (all server-side)

| Layer | Rule |
|---|---|
| Who can be an admin | Only emails in the server env var `APPROX_ADMIN_EMAILS`. If it is unset, admin sign-in is off (`503 admin_not_configured`). |
| Identity | The admin's **existing Supabase Auth account** (same email + password as their client account). No second password database. The email must be verified. |
| Role | On the first successful admin sign-in, an allowlisted account with role `user` gets role `admin` (audited as `admin.role_granted_by_allowlist`). `superadmin` is unchanged. Superadmin-only actions: changing roles, granting FAB models, the "require approval" platform setting, deploying models, starting/stopping GPU jobs. |
| Session | `POST /api/admin/auth/login` creates a row in `admin_sessions` and sets cookie `approx_admin` (`HttpOnly; SameSite=Strict; Secure` on https; **`Path=/api/admin`**). The cookie holds a random token; only its SHA-256 is stored. It has an absolute lifetime (`APPROX_ADMIN_SESSION_HOURS`, default 8) and an idle timeout (`APPROX_ADMIN_IDLE_MINUTES`, default 30). |
| CSRF | Every admin write needs header `X-Admin-CSRF` matching the session's own CSRF token. |
| Every request | The dispatcher **never resolves client sessions on `/api/admin/*`**. It accepts only an admin session, or a scoped `Bearer apx_…` API key for the training worker/CI routes. The admin session is checked on every request: not expired or idle, account active and approved, role admin/superadmin, **email still on the allowlist**. If any check fails, the session is revoked. |
| Brute force | Login is rate-limited per IP (10 / 15 min) and per email (5 / 15 min). Every failure returns the same `401 invalid_admin_credentials` ("Invalid administrator credentials") and writes a high-severity security event and an audit entry. |
| Ignored inputs | Role fields in requests, `localStorage`, URL parameters (`?isAdmin=true`), hidden buttons, client cookies and client bearer tokens. |

## Client approval states (enforced on every client request)

`users.approval_status` takes one of: `pending`, `approved`, `suspended`, `rejected` or `disabled`.

- **pending**: may sign in and use only auth, settings, notifications, feedback, export and delete. All workspace APIs return `403 account_pending`.
- **suspended / rejected / disabled**: new sign-ins are refused (`403 account_<status>`). The admin action revokes every client session at once. Only `/api/auth/me` and `/api/auth/logout` still answer.
- New sign-ups start as `pending` only when a superadmin turns on **Require admin approval for new sign-ups** (dashboard → Platform). Otherwise they start as `approved`. Existing accounts were migrated as `approved`.

## Pages and API

| Page | API |
|---|---|
| `/admin/login` | `POST /api/admin/auth/login`, `POST /api/admin/auth/logout`, `GET /api/admin/auth/me` |
| `/admin` (dashboard) | `GET /api/admin/overview`, `GET/PUT /api/admin/platform-settings` |
| `/admin/clients` | `GET /api/admin/clients?q=&status=&verified=&country=&plan=&model=&sort=newest\|oldest\|last_login\|usage&limit=&offset=` |
| `/admin/clients/:id` | `GET /api/admin/clients/:id`, `POST …/:id/status {status, reason}`, `PATCH …/:id {plan, role}`, `PUT …/:id/models/:modelId {access: enabled\|restricted\|default}`, `PUT …/:id/limits {window_limit, cycle_limit, model_limits}` |
| `/admin/usage` | `GET /api/admin/usage` |
| `/admin/models` | `GET /api/admin/models-overview`, `GET /api/admin/models/lifecycle`, `GET /api/admin/compute` (plus the existing superadmin lifecycle/registry/compute endpoints) |
| `/admin/activity` | `GET /api/admin/activity?before=` |
| `/admin/audit` | `GET /api/admin/audit-log?before=` |

Model access: **restricted** (an explicit deny) overrides plan, tier and superadmin rules in the chat router (`canUseModel`). Quotas are per-client overrides of the platform window and cycle limits, plus per-model cycle limits, enforced in `consumeQuota`.

Country is the ISO code from the hosting edge's IP-geolocation header (`x-vercel-ip-country`), recorded at sign-in and read only behind a trusted proxy. It is never GPS and never guessed. It shows **Unknown** until the client next signs in.

The audit log (`audit_logs`) is append-only. Database triggers reject `UPDATE` and `DELETE`. The panel never returns passwords, password hashes, tokens, Supabase IDs or IP addresses.

## Create and activate the first administrator

1. **Create the account the normal way.** Sign up at the client app with the email the admin will use, then confirm it from the Supabase verification email. This sets the password; it is never stored in Approx config.
2. **Allowlist it on the server.** In Vercel → Project → Settings → Environment Variables (Production), add `APPROX_ADMIN_EMAILS` = that email. For several admins, separate them with commas. Do not commit this value or put it in the APK.
3. **Redeploy** so the function picks up the variable: Deployments → ⋯ → Redeploy.
4. **Sign in** at `https://<your-domain>/admin/login` with that email and its Supabase password. The account becomes `admin`. If it was the bootstrap account, it stays `superadmin`.
5. **Optional: superadmin.** Promote another admin from a superadmin session with `PATCH /api/admin/clients/:id {"role":"superadmin"}`, or use the operator CLI (`npm run admin:grant`) on a trusted machine.

To remove an admin, delete the email from `APPROX_ADMIN_EMAILS` and redeploy. Once the new deployment is live, every existing admin session for that email stops working on its next request. You can also suspend the account from another admin session for an immediate cut-off.
