# Approx AI 1.0.0 — Security Audit

Scope: `backend/`, `web/`, `android/`, `training/`, `deploy/` at release 1.0.0. Method: manual code
review of every route and client, plus automated tests that exercise the controls (backend suite
27/27, Android network-layer JVM suite 15/15, browser E2E). Severity: CRITICAL / HIGH / MEDIUM / LOW / INFO.

## Summary
| Severity | Found | Fixed before release | Accepted / open |
|---|---|---|---|
| CRITICAL | 0 | – | – |
| HIGH | 1 | 1 | 0 |
| MEDIUM | 6 | 4 | 2 (documented) |
| LOW | 6 | 2 | 4 (documented) |
| INFO | 6 | – | 6 |

## Findings fixed during the audit
| ID | Sev | Area | Finding | Fix | Evidence |
|---|---|---|---|---|---|
| F-01 | HIGH | Uploads / HTTP | An oversized upload left the keep-alive socket with an unread body, corrupting the next request on that connection | Reject on `Content-Length` before reading; `Connection: close` on 413 | test "uploads…" + following test pass |
| F-02 | MEDIUM | Signup | "Account already exists" notification could be used to mail-bomb a victim (only IP-limited) | Per-email rate limit applied *before* lookup (no enumeration side channel) | code `routes/auth.js` |
| F-03 | MEDIUM | Uploads | PDF text extraction used unbounded `inflateSync` → decompression bomb | `maxOutputLength` 4 MB per stream | code `routes/files.js` |
| F-04 | MEDIUM | Chat | Upstream generation continued after the client disconnected (GPU/cost exhaustion) | Abort upstream fetch on response close | code `routes/chat.js` |
| F-05 | MEDIUM | Uploads | Malformed `X-Filename` threw → 500 | Return 400 | code `routes/files.js` |
| F-06 | LOW | Android | JVM `HttpURLConnection` rejects PATCH (rename/settings would fail on some stacks) | Fallback POST + `X-HTTP-Method-Override: PATCH` (server honours PATCH only; CSRF still enforced) | Android JVM suite 15/15 |
| F-07 | LOW | Web | Inline triple-backticks rendered as a code block with the first word as language | Code fence requires a newline | browser QA |

## Controls verified (PASS = covered by an automated test)
| Area | Control | Result |
|---|---|---|
| Authentication | scrypt hashing, no plaintext; policy (≥10 chars, letters+digits); generic errors; dummy hash for unknown users | PASS |
| | Lockout after 8 failures; IP + email rate limits; security events logged | PASS |
| | Email verification tokens: hashed, single-use, 24 h; reset tokens 1 h; chat blocked until verified | PASS |
| Sessions | 256-bit random tokens stored hashed; rotation on login; revoke others on password change; all revoked on reset; logout revokes | PASS |
| CSRF | Cookie auth requires per-session `X-CSRF-Token`; `SameSite=Strict`; JSON-only bodies block form posts | PASS |
| Authorization | Tenant isolation for chats, messages, search, projects, files, downloads, memory, artifacts, attachments | PASS |
| | Sona/FAB access server-enforced; router never escalates; admins cannot grant FAB; API keys cannot reach account routes | PASS |
| FAB policy | FAB chats never training-eligible (API + DB CHECK constraint); no memory injection or capture | PASS |
| Input validation | Type/length checks on every body field; SQL fully parameterised (LIKE escaped); static path traversal guard | PASS |
| XSS | Safe Markdown renderer (escape-first, http(s)-only links, `rel=noopener`); strict CSP; no inline JS; uploads never rendered inline as HTML | PASS (CSP header test + review) |
| SSRF | Public-IP check at socket `lookup` (DNS-rebinding safe), ports 80/443, no credentials in URL, redirects re-validated | PASS |
| Uploads | Allow-list by extension + magic bytes; executables (MZ/ELF/Mach-O) blocked; EICAR; PDF JS/Launch/EmbeddedFile; Office macros; 10 MB limit; 500 MB per user; random storage keys, 0600 perms; downloads as attachment with sandbox CSP | PASS |
| Quota / rate limits | Server-side window quota with Retry-After; burst limits per user; refusals don't consume quota | PASS |
| API keys | SHA-256 at rest, shown once, scopes, rotation revokes old key, request log with request IDs | PASS |
| Secrets | No secrets in source, APK, or ZIP; env-only config; `.gitignore` covers `.env`, keystores, data | PASS (grep + `unzip -l`) |
| CORS | Off by default; explicit allow-list only; no credentialed CORS | Review |
| Headers | CSP, X-Frame-Options DENY, nosniff, Referrer-Policy no-referrer, COOP, HSTS when https | PASS |
| Privacy | Data export, account deletion (content hard-deleted, user row anonymised), training consent withdrawal clears eligibility | PASS |
| Android | HTTPS-only (manifest + network security config, system CAs only), `allowBackup=false`, token AES-GCM in Android Keystore, no API keys embedded, exported only launcher activity | Review + JVM tests |

## Open / accepted findings
| ID | Sev | Finding | Mitigation / recommendation |
|---|---|---|---|
| O-01 | MEDIUM | Safety policy is regex-based and bypassable; real safety relies on model alignment of the served model | Keep the policy as a first-line filter; add a classifier model and red-team the trained adapter (`verify_adapter.py` safety probes) before launch |
| O-02 | MEDIUM | No malware scanning engine beyond heuristics unless ClamAV is configured | Set `CLAMDSCAN_PATH` in production (hook implemented) |
| O-03 | LOW | Lockout / per-email login limit can be abused to temporarily lock a victim (account-lock DoS) | Accepted trade-off vs brute force; reset-password unlocks; consider CAPTCHA after N failures |
| O-04 | LOW | Quota is charged before the provider call; upstream failures still consume one request | Accepted; consider refund on 5xx |
| O-05 | LOW | Rate limiting keys on client IP — behind a proxy set `APPROX_TRUST_PROXY=1` or all users share one IP | Documented in `approx.env.example` |
| O-06 | LOW | APK is signed with a locally generated key (not Approx Technology's release key); v1 signature disabled (minSdk 26 doesn't need it) | Re-sign with the protected release key before distribution |

## INFO
- `node:sqlite` is marked experimental in Node 22; pin the Node version (Dockerfile uses 22.13).
- Single-process design: rate-limit/quota state is per-database; scale-out needs a shared store.
- Session tokens on Android are bearer tokens: device compromise = session compromise; users can revoke sessions in Settings → Security.
- Research fetches third-party pages server-side; output is untrusted text and is only passed to the model, never rendered as HTML.
- Dependency audit: backend and web have **zero third-party runtime dependencies**; Android uses only the Android framework + `org.json` (platform). Training uses pinned PyPI packages (`training/requirements.txt`) that run only on the training machine.
- No penetration test by an independent party has been performed; recommended before public launch.
