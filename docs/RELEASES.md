# Approx releases, updates and Lala 3.5

## One version, three platforms
- `backend/config/version.json` is the only version source (`version`, `versionCode`).
- `node scripts/bump-version.mjs patch|minor|major` advances it and writes it to Android (`versionName`, `versionCode` —
  always +1, never reused) and Windows (`desktop/package.json`). `node scripts/bump-version.mjs check` is run by CI.
- The backend reports it at `/api/version`; Settings → About & updates shows it on web, Android and Windows.

## Pipeline
| Workflow | When | What |
|---|---|---|
| `CI` (`.github/workflows/ci.yml`) | every push / PR | version agreement, syntax, secret scan, backend tests, Vercel simulation, desktop updater tests |
| `Release Approx` (`release.yml`) | owner runs it (Actions → Release Approx → Run workflow, choose patch/minor/major, write notes) | guard (production branch + signing secrets) → CI → `Approx.apk` (Linux) + `Approx.exe` (Windows) built and verified → only then: version commit + tag `vX.Y.Z` + GitHub Release with `Approx.apk`, `Approx.exe`, `SHA256SUMS`, `release-manifest.json` → stable links re-downloaded and checksum-checked → waits until Vercel serves the new version |

The version commit pushed by the release triggers the existing Vercel Git integration (no second deployment system).
Nothing is committed, tagged or published when any test or build fails. Old releases stay on GitHub (rollback = mark an
older release as "latest", or run a new patch release from the previous commit).

Stable links (always the latest release):
- https://github.com/umer630/Approx-Ai/releases/latest/download/Approx.apk
- https://github.com/umer630/Approx-Ai/releases/latest/download/Approx.exe

`/api/releases/latest` reads that release and its `release-manifest.json` (version, versionCode, SHA-256 of both files,
APK signer SHA-256, minimum supported versionCode). With no release it answers `{ "available": false }`.

## Owner setup (one time)
Repository → Settings → Secrets and variables → Actions:

| Secret | Value |
|---|---|
| `ANDROID_KEYSTORE_BASE64` | base64 of the permanent release keystore |
| `ANDROID_KEYSTORE_PASSWORD` | its password |
| `ANDROID_KEY_ALIAS` | key alias (e.g. `approx`) |
| `WINDOWS_CSC_LINK`, `WINDOWS_CSC_KEY_PASSWORD` | optional: base64 `.pfx` code-signing certificate + password |

Create the keystore once on your own computer and keep a backup — losing it means existing users can never update in
place again:
```
keytool -genkeypair -v -keystore approx-release.jks -alias approx -keyalg RSA -keysize 4096 -validity 10000
base64 -w0 approx-release.jks      # paste the output into ANDROID_KEYSTORE_BASE64 (PowerShell: [Convert]::ToBase64String([IO.File]::ReadAllBytes("approx-release.jks")))
```
Never commit the keystore. Optional variable `APPROX_PRODUCTION_BRANCH` (default `ccr-b9e70091-57vl48`, the branch Vercel deploys).

Every APK published before this (e.g. 1.7.0 vc13) was signed with a one-off debug key, so Android cannot update those
installs to a release-signed APK: those users uninstall once and install `Approx.apk`. From the first signed release on,
updates install in place (Settings → About & updates → Update now; Android asks for confirmation).

Windows: `Approx.exe` is an NSIS installer (Electron app in `desktop/`). Without `WINDOWS_CSC_LINK` it is **unsigned**
(Windows SmartScreen warns) and the manifest says `"signed": false`. The app checks for updates at start and every 6 h,
downloads the new `Approx.exe`, verifies its SHA-256 and runs it silently; a mismatching download is deleted, never run.

## Lala 3.5 (temporary default model)
Product name **Lala 3.5**; engine: Ollama on the owner's Windows computer.
1. Install Ollama, `ollama pull <model>` and note the exact tag from `ollama list`.
2. Sign in to Approx as an administrator → Approx Code → Add device; run the shown command on that computer
   (`node approx-device.mjs pair …`). Keep the agent running (`node approx-device.mjs run`). It connects outward over HTTPS
   only; port 11434 is never exposed. `node approx-device.mjs ollama` shows what it reports.
3. Admin panel → Models → Model router: choose the device and the installed tag → "Use for Lala 3.5", then
   "Test inference" / "Test streaming" / "Load" / "Unload".
If the backend runs on the same computer, set `APPROX_OLLAMA_URL=http://127.0.0.1:11434` and `APPROX_LALA_MODEL_TAG` instead.

Router policy (env): `APPROX_FALLBACK_FAILURES` (3), `APPROX_RECOVERY_SUCCESSES` (2), `APPROX_RECOVERY_COOLDOWN_MS`
(300000), `APPROX_SWITCH_MIN_DWELL_MS` (120000), `APPROX_LALA_TIMEOUT_MS` (50000).

Nick 4.8 replaces Lala 3.5 only after: registered artifact (version + adapter SHA-256) → lifecycle VERIFIED (manifest,
SHA-256, evaluation) → inference server serves the version → real generation test → lifecycle ACTIVE (deployment
verification) + health + rollback target. Lala is then hidden from the selector but kept as the emergency fallback.

## Environment checklist (Vercel → Project → Settings → Environment Variables)
| Variable | Status |
|---|---|
| `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY` | set (auth works in production) |
| `APPROX_ADMIN_EMAILS` | must list the owner's admin email(s) — check it is set |
| `ANTHROPIC_API_KEY` | not set → "Connect with Claude" shows Not connected |
| `OPENAI_API_KEY` | not set |
| `CRON_SECRET` | needed for `/api/cron/scheduled` (also runs the model health tick) |
| `GITHUB_RELEASES_TOKEN` | optional (raises GitHub API rate limit for `/api/releases/latest`) |
