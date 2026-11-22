# Sign-in with Supabase Auth

Supabase Auth (project `uyatvhgngzrrvelahebi`) is the authoritative identity provider for email + password accounts:
it stores the passwords, sends the verification and password-reset emails, and decides whether an address is
confirmed. The Approx backend never stores those passwords (linked accounts carry `password_hash = '!'`).

```
web app / Android app ──► Approx backend /api/auth/* ──► Supabase Auth (GoTrue REST, publishable key only)
                               │  after Supabase confirms the identity
                               └─► Approx session (HttpOnly cookie + CSRF for web, bearer token for Android)
```

Keeping the existing `/api/auth/*` endpoints means the installed Android app keeps working without a new APK, and
roles, plans, quota, CSRF and session revocation are unchanged. Google sign-in stays a separate backend flow (Google
ID token), because the Google provider is not enabled in this Supabase project.

| Flow | What happens |
|---|---|
| Sign up | `POST /api/auth/signup` → Supabase `/signup` (redirect `…/?auth=callback`) → Supabase emails the confirmation link. Existing addresses get the same answer (no enumeration); an unconfirmed address gets a fresh link. |
| Verify | The link goes to Supabase, which redirects to `https://approx-ai.vercel.app/?auth=callback#access_token=…&type=signup`; the web app sends the token to `POST /api/auth/verify-email`, which checks it with Supabase, marks the account verified and signs the person in. A pasted code (token hash, used by the Android app) works too. |
| Resend | `POST /api/auth/resend-verification` → Supabase `/resend`. Also offered on the sign-in page when an unverified account tries to sign in. |
| Sign in | `POST /api/auth/login` → Supabase password grant → Approx session. Unconfirmed → `403 email_not_verified`. |
| Reset | `POST /api/auth/forgot-password` → Supabase `/recover`; the link lands on `/?auth=callback#…type=recovery` → "Choose a new password" → `POST /api/auth/reset-password` updates the password in Supabase and signs out all Approx sessions. |
| Change password / email | Re-authenticates with Supabase (current password), then updates the Supabase user. |
| Sign out | Revokes the Approx session (cookie cleared). The Supabase session used to prove identity is closed right after sign-in. |
| Accounts from the earlier system | First sign-in with the old (correct) password creates the Supabase account and Supabase emails a confirmation link (`409 account_migration_required`); after confirming, the same Approx account (chats, files, role) is linked. |

## Environment variables (Vercel → Project → Settings → Environment Variables)

| Name | Value | Notes |
|---|---|---|
| `SUPABASE_URL` | `https://uyatvhgngzrrvelahebi.supabase.co` | public |
| `SUPABASE_PUBLISHABLE_KEY` | `sb_publishable_…` from Supabase → Project Settings → API Keys | public by design |
| `SUPABASE_SECRET_KEY` | optional `sb_secret_…` | **server-only**; only used to delete the Supabase user when someone deletes their account. Never in the web app, the APK, GitHub or a `NEXT_PUBLIC_`/`VITE_` variable. |
| `APPROX_PUBLIC_URL` | `https://approx-ai.vercel.app` | email links return to `<this>/?auth=callback` |

Without `SUPABASE_URL` / `SUPABASE_PUBLISHABLE_KEY` the auth endpoints answer `503 auth_not_configured` (no account
is created). `/api/health` shows `auth_provider`, `auth_configured` and `auth_callback_url` (never a key).

## Supabase dashboard settings (manual — these cannot be set from the repository)

Read from the live project on 2026-11-14 via the public settings endpoint: email sign-in **enabled**, sign-ups
**enabled**, "Confirm email" **on** (`mailer_autoconfirm: false`), Google provider **off**. Everything below still
has to be checked or set by you in the dashboard.

1. **Authentication → URL Configuration**
   - **Site URL:** `https://approx-ai.vercel.app`
   - **Redirect URLs → Add URL:** `https://approx-ai.vercel.app/?auth=callback`
     (Supabase only redirects to listed URLs; anything else falls back to the Site URL. If the Site URL is still the
     default `http://localhost:3000`, links would open localhost — that is the usual cause of "verification link
     doesn't work".)
2. **Authentication → Emails → SMTP Settings → Enable custom SMTP** — required for real users. Supabase's built-in
   email service only delivers to members of your Supabase team and only a few emails per hour, so a second sign-up
   (any address outside your team) never receives its email without this. Use the SMTP account you already use:
   - Gmail: host `smtp.gmail.com`, port `465`, username = your Gmail address, password = the 16-letter Google App
     Password (no spaces), sender email = the same Gmail address, sender name `Approx AI`.
   - or Brevo: host `smtp-relay.brevo.com`, port `587`, username = your Brevo SMTP login, password = a Brevo SMTP
     key, sender email = your verified Brevo sender, sender name `Approx AI`.
3. **Authentication → Rate Limits** (after custom SMTP is on): raise **Rate limit for sending emails** to e.g.
   `30` per hour. All sign-in requests reach Supabase from the backend's servers, so if many people sign in at once,
   raise **Rate limit for sign-ups and sign-ins** (per 5 minutes per IP) as well.
4. **Authentication → Sign In / Providers → Email:** keep **Confirm email** on and **Secure email change** on. Set
   **Minimum password length** to `10` and **Password requirements** to "Letters and digits" so Supabase enforces the
   same rule as the app.
5. **Authentication → Emails → Templates** (recommended — needed for typing a code in the Android app): in
   **Confirm signup** and **Reset password**, keep the link and add the code line, e.g.

   ```html
   <h2>Confirm your Approx AI email</h2>
   <p><a href="{{ .ConfirmationURL }}">Confirm your email</a></p>
   <p>Or enter this code in the app: <code>{{ .TokenHash }}</code></p>
   ```

   (Use the same pattern with "Reset your Approx AI password" for the reset template.) Without this line the
   emailed link still works everywhere; only the "paste a code" screens have nothing to paste.

## How to verify after deploying

1. Open `https://approx-ai.vercel.app/api/health` → `auth_provider: "supabase"`, `auth_configured: true`,
   `auth_callback_url: "https://approx-ai.vercel.app/?auth=callback"`.
2. **Second sign-up:** create an account with an address that is **not** a member of your Supabase team (e.g. a
   second Gmail). The email must arrive from your SMTP sender. Signing in before confirming shows "Please verify your
   email first" with **Resend link**.
3. Click the link → you land on `https://approx-ai.vercel.app/` showing "Email verified" and are signed in; the
   address bar no longer contains a token. In Supabase → Authentication → Users the user shows as confirmed.
4. **Password reset:** Sign in → Forgot password → open the email → "Choose a new password" → sign in with the new
   password; the old password no longer works and other devices are signed out.
5. Sign out, reload: you stay signed out. Sign in, reload: you stay signed in (session persistence).
6. Android app (existing APK): sign in with the confirmed account; "Forgot password" sends the reset email; if you
   added the code line to the templates, the code from the email works on the app's code screens.

## Verification CODE (6 digits) — where it comes from and how it is checked

* **Generated by:** Supabase Auth, on sign-up / resend (`POST /auth/v1/signup`, `/resend`) and on Forgot password
  (`/recover`). Every email carries one one-time password in two forms: the link (`{{ .ConfirmationURL }}`, a
  `token_hash`) and the numeric code (`{{ .Token }}`).
* **Sent by:** Supabase's mailer through the SMTP settings in Supabase → Authentication → Emails. Approx never sends
  or stores the code.
* **Shown in the email only if the template contains `{{ .Token }}`.** Supabase's default "Confirm signup" and
  "Reset password" templates contain only the link — that is why no code ever arrived. Add to both templates
  (Authentication → Emails → Templates), e.g. `<p>Your Approx AI code: <strong>{{ .Token }}</strong></p>`.
* **Validated by:** Approx backend `POST /api/auth/verify-email` (and `/api/auth/reset-password`) →
  Supabase `POST /auth/v1/verify` with `{type, email, token}` for a typed code, or `{type, token_hash}` for the link.
  Supabase checks the code, its expiry and single use; wrong/expired → `400 invalid_token`.
* **Bug fixed (2026-11-16):** the backend used to send a typed code as `token_hash`, which Supabase always rejects, so
  a code could never verify even when it arrived. The web and Android code screens now send the email with the code.

## Troubleshooting

**"Verification sent" but nothing arrives, then "Too many attempts" on Resend** — measured on the production project
on 2026-11-15 (diagnostic `@example.com` address, no personal data):
1. A new address: Supabase accepted the confirmation email (HTTP 202). SMTP now hands mail over; the earlier
   `Error sending confirmation email` failure is no longer happening.
2. An immediate Resend: Supabase answered `429 over_email_send_rate_limit` (per-address cooldown). After ~60 s the
   same Resend was accepted. The old app allowed instant retries and showed a vague "wait a few minutes"; it now shows
   the exact seconds and disables the button for that long (web + Android).
3. An address that is **already registered and confirmed**: Supabase deliberately answers like a success but sends
   **no email** (anti-enumeration). The old message said "a verification link has been sent"; it now says that
   existing accounts get no new link and should sign in or use Forgot password. This is the most common reason for
   "the link never came" when re-testing with the same Gmail.
Inbox delivery after Supabase accepts the email (Gmail spam filtering, sender reputation) is not visible to Approx:
check Supabase → **Logs → Auth** and the Gmail Spam folder. Admin → `GET /api/admin/diagnostics` shows the last 24 h
of email-request outcomes (`accepted_by_supabase`, `existing_account_no_email`, `email_cooldown`, …).


**Sign-up / resend / reset answer `email_delivery_failed` ("We couldn't send the email…")** — Supabase itself
returned `500 unexpected_failure: Error sending confirmation email` (or `…recovery email`): its SMTP settings cannot
deliver, and Supabase rolled the sign-up back (no half-created account). Verified on 2026-11-15 against this project
with a diagnostic address. Saving the SMTP form does not test it. Check in Supabase → Authentication → Emails → SMTP:

| Field | Gmail value |
|---|---|
| Host | `smtp.gmail.com` |
| Port | `465` (or `587`) |
| Username | the full Gmail address |
| Password | a 16-character **App Password** (Google Account → Security → 2-Step Verification must be on → App passwords), typed **without spaces** — not the normal Gmail password |
| Sender email | exactly the same Gmail address (Gmail rejects or rewrites other senders) |
| Sender name | `Approx AI` |

The exact SMTP error is in Supabase → **Logs → Auth** (search for "Error sending" or the `error_id` from the Vercel
function log line `{"event":"supabase_auth_error",…}`), e.g. `535 5.7.8 Username and Password not accepted` = wrong
App Password / username. After fixing, test from Supabase → Authentication → Users → **Add user → Send invitation**
(or "Send password recovery") to your own address before retrying sign-up. The "personal email provider" warning is
informational; Gmail allows about 500 emails a day.

**Existing account says "Incorrect email or password"** — accounts created before the Supabase migration are not in
Supabase yet. With the correct old password the first sign-in creates the Supabase account and needs to send one
confirmation email; while SMTP is failing this answers `email_delivery_failed` ("…your account needs a one-time
confirmation email…"). "Incorrect email or password" means the old password did not match (or the account signs in
with Google). Data is never lost: after confirming, the same Approx account is linked.

Every unexpected Supabase error is logged server-side as one JSON line (`supabase_auth_error`: path, status, code,
message, error_id) — never request bodies, emails, passwords or tokens.

## "Verified, but Incorrect email or password" (fixed in 1.5.0 / API 1.9)

**Root cause.** Supabase Auth never updates an existing *unconfirmed* user when the same address signs up again
(`supabase/auth` `internal/api/signup.go`: "do not update the user because we can't be sure of their claimed identity").
It sends a fresh confirmation email, but keeps the password from the FIRST sign-up. So: sign up → no verification → sign
up again with a new password → enter the new code (verification succeeds) → sign in with the new password →
`invalid_credentials` → "Incorrect email or password". The test double used to overwrite the password, hiding this.

**Fix.** The verify screens (web and Android) send the password with the code; `/api/auth/verify-email` sets it on that
Supabase identity only after the code/link proves the mailbox, revokes older sessions and signs the person in. Nothing is
stored in plain text, nothing bypasses Supabase's password check, and the test double now behaves like Supabase.
Covered by `backend/test/authlifecycle.test.js` (reproduces the bug, then the fixed flow) and `backend/test/apkauth.test.js`
(the APK's own `Api.java`).
