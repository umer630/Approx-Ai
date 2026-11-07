# QA Report — Approx AI 1.0.0

Environment: Linux container, Node 22.23.4, Python 3.13, OpenJDK 21, Chromium (Playwright), Ubuntu
Android build tools (aapt, dx 1.16, zipalign, apksigner). No GPU, no Android emulator/device,
no access to Hugging Face / Kaggle / Google SDK hosts.

**PASS** = executed and passed. **NOT TESTED** = could not be executed here (reason given).
Model responses during tests came from the labelled dev simulator, or from a mock OpenAI-compatible
upstream in the provider test — not from a trained model.

## 1. Backend integration suite — `cd backend && npm test` → **27 / 27 PASS**
| # | Test | Result |
|---|---|---|
| 1 | Signup password policy; no account enumeration | PASS |
| 2 | Email verification (single-use); unverified users cannot chat | PASS |
| 3 | Wrong password rejected; lockout after repeated failures | PASS |
| 4 | Password hashes are scrypt | PASS |
| 5 | Password reset revokes all sessions | PASS |
| 6 | Cookie sessions require CSRF token | PASS |
| 7 | Tenant isolation (chats, search, projects, files, downloads, memory, artifacts, attachments) | PASS |
| 8 | Chat SSE stream route → delta → done; history persisted | PASS |
| 9 | Modes validated; modes are not models | PASS |
| 10 | Free users blocked from Sona/FAB; router never routes there | PASS |
| 11 | FAB superadmin-only grants; FAB never trainable (API + DB constraint); no memory | PASS |
| 12 | Safety refusal for harmful requests (FAB too); refusals don't consume quota | PASS |
| 13 | Quota 100/60 min enforced with Retry-After; 2-day cycle reported | PASS |
| 14 | Memory: "remember that", edit, disable, clear | PASS |
| 15 | History: rename, archive, trash, restore, purge, search | PASS |
| 16 | Regenerate | PASS |
| 17 | Uploads: allow-list, magic bytes, executables, EICAR, PDF JS, path stripping, 413 | PASS |
| 18 | Attachment text reaches model context | PASS |
| 19 | API keys: hashing, scopes, completions, streaming, logs, rotation, revocation | PASS |
| 20 | API cannot reach FAB without grant | PASS |
| 21 | Projects, workspace versions/restore, Coeprox scaffold, Fabbox approval gate, path traversal | PASS |
| 22 | SSRF guard (private, loopback, metadata, IPv6, mapped, file://) | PASS |
| 23 | Training export: consent only, FAB excluded, PII scrubbed, no user IDs, withdrawal | PASS |
| 24 | PII scrubber + router classifier units | PASS |
| 25 | Account deletion | PASS |
| 26 | Security headers, traversal, unknown endpoints, content-type enforcement | PASS |
| 27 | Real provider path against mock OpenAI-compatible SSE upstream; 503 when unconfigured | PASS |

## 2. Web E2E (Playwright, Chromium, 390×844 mobile viewport) → **PASS, 0 console errors**
Signup → verification via emailed code → login → welcome screen → send message (streaming) →
"remember that…" memory toast → second message → model picker → Plus menu → History sheet →
Settings → Memory → Fabbox/Coeprox page → developer console: create API key (secret shown once).
Screenshots reviewed for layout; fixed: unsized icons, toast overlap, inline-backtick rendering.

## 3. Android
| Check | Result |
|---|---|
| Release APK compiles, dexes, packages, zipaligns, signs (v2 + v3) | PASS |
| `apksigner verify` | PASS |
| `aapt dump badging`: package `com.approxtech.ai`, versionName 1.0.0, minSdk 26, targetSdk 33, only INTERNET permission, launcher activity | PASS |
| Network layer (`Api.java`, the class shipped in the APK) on JVM vs. live backend: https enforcement, version probe, bad login, mobile login, models, SSE chat, High mode, upload, exe blocked, history search, rename, memory, usage, FAB locked, logout → **15 / 15** | PASS |
| UI on a device/emulator (screens, Keystore encryption, file picker) | **NOT TESTED** — no emulator/device; Android system images are hosted on dl.google.com (blocked) |

## 4. Training pipeline (`cd training && python -m unittest discover -s tests`) → **5 / 5 PASS**
PII scrub, language detection, schema/quality filters, exact + near dedupe, unapproved sources
excluded, real seed dataset build, `train_qlora.py --dry-run` validates config + dataset hashes.
| Check | Result |
|---|---|
| QLoRA training run | **NOT TESTED / BLOCKED** — no NVIDIA GPU; Hugging Face (base model) and Kaggle unreachable |
| Adapter files exist / load / inference / verification | **NOT TESTED / BLOCKED** — depends on training |

## 5. Production configuration
| Check | Result |
|---|---|
| Production mode refuses to fabricate answers when no model backend is configured (503) | PASS (test 27) |
| No secrets in repository / APK / ZIP | PASS (grep + archive listing) |
| Docker image build | **NOT TESTED** — no Docker daemon in the build container |
| Live deployment, real email delivery, HTTPS | **NOT TESTED** — no credentials / domain |
