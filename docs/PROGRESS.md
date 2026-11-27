# Approx AI — progress and continuity record

Single source of truth for picking work up in a new session. Update it at every checkpoint.
Branch: `ccr-b9e70091-57vl48` (push only here). Production: https://approx-ai.vercel.app (auto-deploys this branch).

## Training (Nick 4.8) — do NOT restart

| Item | State (read from Google Drive, 2026-11-22; re-checked 2026-11-27: unchanged) |
|---|---|
| Run | `approx-nick-r1`, Colab T4, Phi-4-mini-instruct @ `cfbefacb…`, QLoRA, 3 epochs, `max_steps` 5,286 |
| Latest valid checkpoint | `MyDrive/ApproxAI/pipeline/nick-4.8/…/train_output/checkpoint-200` (saved 2026-11-21 06:35 UTC), eval loss 1.4316 |
| Live? | **No evidence of a live run**: `train_phases.jsonl` last written 2026-11-21 11:26 UTC, no newer checkpoint |
| Resume | `MyDrive/ApproxAI/Approx_Nick48_T4_Training.ipynb` → T4 GPU → Run all. Same `RUN_ID` resumes from the newest checkpoint; cell 6b refuses to start while another runtime is writing the run. |
| Rules | Never start a new run, never overwrite a newer checkpoint, never fall back to CPU or a paid GPU without the owner's permission. |
| Colab MCP | Connector calls return **403 Forbidden** in this session (list_runtimes, get_subscription); not usable until a fresh session with a working grant. |

## Completed (with commits)

- `d920f66` Login bug fix (Supabase keeps the first password of a repeated unconfirmed sign-up → password set at verification) + workspace/session/thread/task backend (API 1.9).
- `e52e512` Work / Code / Education UI on Android + web. `aa79a9b` APK 1.5.0 (vc 11).
- `7763ffe` Settings enforced on the server: language → prompt; notifications (security always, task/code updates + email copies); Approx Code agent permissions; data controls (retention, archive all, delete all); text size; start screen; workspace prefs (quiz length/difficulty, explanation style, default branch, planning threads); **two-step verification** (Supabase MFA TOTP) for client and admin sign-in.
- `304ab37` Web Settings pages for all of the above (+ Low mode in model preferences).
- `150f161` Android Settings parity (SettingsMore.java) + end-to-end Robolectric test against a real local backend.

## Settings audit (all sections)

| Section | Web | Android | Server behaviour |
|---|---|---|---|
| Profile (name, language) | ✓ | ✓ | language changes the reply-language instruction |
| Personalization | ✓ | ✓ | in every prompt |
| Notifications + inbox | ✓ | ✓ | notify.js; security always emailed |
| Appearance (theme, text size, start screen) | ✓ | ✓ (light theme only on Android) | persisted; applied by clients |
| Security (password, 2FA, devices, email change) | ✓ | ✓ | Supabase MFA; per-device revoke |
| Workspaces (education/code/work prefs, code permissions) | ✓ | ✓ | used by quiz, study prompts, repo creation, planning, code agent |
| Memory | ✓ | ✓ | existing |
| Privacy / training consent / export | ✓ | ✓ (export opens web) | existing |
| Data controls | ✓ | ✓ | retention enforced on access; typed DELETE |
| Model preferences (model + Low/Medium/High) | ✓ | ✓ | default for new chats |
| Usage | ✓ | ✓ | existing |
| Billing | honest: no payment provider | honest | **not implementable without a payment provider account** |
| Connectors | honest: none configured | honest | **needs OAuth apps (GitHub/Google) registered by the owner** |
| Developer API | web console | opens web | existing |
| Help | ✓ | ✓ | existing |

## Tests (last run)

(2026-11-27, commit after 947b6ae) Backend 170 pass / 0 fail / 3 skipped (APK auth probes need javac + APPROX_JSON_JAR) · Vercel 13/13 · web regression 232/232 · FAB 500X UI 26/26 · Robolectric 7/7 (at d7a4dfa; Android source unchanged since) · JVM StartupJvmTest pass.
Earlier: Robolectric 6/6 · live Supabase 14/14 · production APK probe 7/7 (incl. Android settings E2E against a local backend).

How to run:
- `cd backend && APPROX_JSON_JAR=<org.json jar> npm test`
- `S=<shots dir> node web/test/regression-vercel.cjs`
- Android: `ANDROID_JAR=… bash android/build.sh`; E2E: start `node backend/test/serve-for-android.mjs`, pass its first line as `APPROX_E2E`, then `MVN_SETTINGS=… bash android/robotest/run.sh <shots>`.

## Since the last checkpoint
- `fe9b60e` Code agent review in sessions, due dates, file removal, output editing, flashcards, study plans, unread badge (Android + web).
- `ebf1eaf` Supabase: Auth verified live against project `uyatvhgngzrrvelahebi` (14/14, non-mutating); Postgres schema + RLS
  migration `supabase/migrations/20261127000000_approx_core.sql` verified in PGlite (not applied: needs a privileged credential);
  GPT/OpenAI usable per model through the provider abstraction (needs `OPENAI_API_KEY` + per-model URL/NAME on the server).
- APK 1.6.0 (versionCode 12).

## Navigation redesign (1.7.0, API contract 1.10)
- `6cc1b13` Backend: devices + device agent (`web/tools/approx-device.mjs`, pairing code → device token, jobs run on the user's computer),
  scheduled tasks + runs (each run = a real session; triggers: Run now, opportunistic on GET, Vercel cron daily `0 6 * * *` — Hobby limit),
  `/api/recents`, `/api/session-history`, Co Approx background runs, artifact sharing, quiz practice. Migration `2026-11-devices-scheduled`.
- `d7a4dfa` Android: menu is the only navigation (Home, Projects, Code, Co Approx, Education, Artifacts, Scheduled, Sessions, Files, Settings + Recents);
  no bottom/mode bar; composer [+] [Type or hold to talk] [mic] [send]; plain greeting; Code devices/sessions; Scheduled; Artifacts.
- `947b6ae` Web: same menu, no bottom nav, Code/Scheduled/Artifacts/Sessions pages, Recents, Co Approx naming.
- APK 1.7.0 (versionCode 13).

## Remaining (next tasks, in order)
0. Owner-provided: Supabase SQL Editor run of the migration (or `supabase db push`), `DATABASE_URL` + approval to copy data from
   Turso before the backend can use Supabase Postgres; `OPENAI_API_KEY` + which Approx model(s) GPT should serve.

1. Work / Code / Education gaps (task #34): code agent edits from inside a code session (session-linked proposals review on Android/web), remove/rename session files, edit artifacts inside sessions, task due dates + assignment deadlines, flashcards/study plan for Education, notification badge in the menu.
2. APK release 1.6.0 with the settings + workspace changes; update this file.
3. Blocked on the owner: payment provider (billing), OAuth apps (connectors), sandbox runner (terminal/run/test/build), Colab connector 403, phone testing.
