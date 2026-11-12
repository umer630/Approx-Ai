# Approx AI — Standalone Offline App

A fully **standalone** Android app that runs **entirely on the device**: no server, no account, **no INTERNET
permission**. It never connects anywhere. There is deliberately **no server-address field**.

## What runs on-device
- **Text commands** and **voice** (device speech-to-text in, text-to-speech out — toggle with the 🔊 button).
- An **on-device command engine** (`OfflineBrain.java`) that returns **computed, correct** answers for:
  arithmetic, percentages, linear algebra (`solve 3x+7=22`), square roots, unit & temperature conversion,
  geometry (rectangle/circle/triangle/Pythagoras), date & time, and a small built-in fact set.

## Honest limits
A large conversational language model (Nick 4.8 — a multi-GB GPU model) **cannot run inside an APK**. This build
does not bundle one. For open-ended conversation the app says so clearly instead of inventing an answer. If you
later want full conversational AI on the phone, that requires either (a) the server build (`android/`), or (b) a
dedicated on-device ML runtime with a small bundled model — a separate, larger project.

## Build
```bash
ANDROID_JAR=/path/to/android-33/android.jar ./build.sh      # → build/ApproxAI-Offline-debug.apk
# release: KEYSTORE=... KEYSTORE_PASS=... KEY_ALIAS=... ./build.sh   (never invent signing credentials)
```
No Gradle; uses `aapt`, `javac`, `dalvik-exchange`, `zipalign`, `apksigner`.

## For a desktop Electron app
The same `OfflineBrain` logic is pure, dependency-free computation and can be reused in an Electron/Node build
(port the deterministic rules to JS). This app is the mobile, offline front end.
