# Approx AI for Android

Native Java app (no WebView, no third-party libraries). Package `com.approxtech.ai`, minSdk 26,
targetSdk 33.

- `src/com/approxtech/ai/MainActivity.java` — all screens: login, signup, email verification (the sign-up answer
  stays on screen; resend waits out the 60 s email cooldown), password reset, Home (personalized greeting + three
  primary actions: Education, Approx Code, Approx Work + the chat input), chat (SSE streaming), model picker,
  Low/Medium/High mode, Plus menu (file/image/PDF/document/camera/data uploads; Research opens the web app),
  workspaces with one "Start new session" action and their recent sessions (`/api/sessions`, API 1.8):
  Education (upload a PDF → a study session grounded in it: teach, summarize, tests, MCQs, study plan),
  Approx Code and Approx Work; history (search, recent/archived/trash, rename/archive/delete/restore), settings.
  Navigation: ☰ side menu (New chat, Education, Approx Code, Approx Work, History + recent chats, Account,
  Settings, Help) and ✎ (new chat / new session). There is no bottom tab bar.

Versioning: one source tree, one version line. Every APK build bumps `android:versionCode` (+1) and
`android:versionName` (semantic) in `AndroidManifest.xml`, and `backend/src/config.js` `VERSIONS.apk` is updated
to match; `build.sh` stamps the git commit into `BuildInfo.BUILD_ID`. Current: 1.4.0 (versionCode 10).
- `Api.java` — HTTPS client (JSON, SSE streaming, uploads). Pure java.net + org.json, so it is
  tested on the JVM against the real backend: `jvmtest/ApiJvmTest.java` (15/15 pass).
- `SecureStore.java` — session token encrypted with an Android Keystore AES-256-GCM key.
- `res/xml/network_security_config.xml` — HTTPS only, system CAs only.

## Build
```bash
sudo apt-get install aapt apksigner zipalign dalvik-exchange android-sdk-platform-23
ANDROID_JAR=/path/to/platforms/android-33/android.jar \
APPROX_SERVER_URL=https://your-approx-server \
KEYSTORE=/secure/approx-release.jks KEYSTORE_PASS=… ./build.sh
```
Without `KEYSTORE` a throwaway local key is generated in `keystore/` (gitignored). Distribute only
builds signed with Approx Technology's protected release key. Without `APPROX_SERVER_URL` the app asks
for the server address on first launch (must be `https://`).

Not yet verified on a device or emulator (none available in the build environment).
