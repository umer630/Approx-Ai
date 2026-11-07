# Approx AI for Android

Native Java app (no WebView, no third-party libraries). Package `com.approxtech.ai`, minSdk 26,
targetSdk 33.

- `src/com/approxtech/ai/MainActivity.java` — all screens: server setup, login, signup, email
  verification, password reset, chat (SSE streaming), model picker (Master Router + models),
  Medium/High mode, Plus menu (file/image/PDF/document/camera/data uploads; Research/Code/Workspace
  open the web app), history (search, recent/archived/trash, rename/archive/delete/restore), settings
  (account, email change, security, memory, privacy/training consent, model preferences, usage,
  projects, files, subscription, API console, delete account, logout), three-button bottom navigation.
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
