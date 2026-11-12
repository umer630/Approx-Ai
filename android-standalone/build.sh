#!/usr/bin/env bash
# Builds the STANDALONE offline Approx AI APK (no server, no INTERNET permission) without Gradle.
#   sudo apt-get install aapt apksigner zipalign dalvik-exchange
# Usage:
#   ANDROID_JAR=/path/to/android-33/android.jar ./build.sh
#   (release: KEYSTORE=... KEYSTORE_PASS=... KEY_ALIAS=... ./build.sh)
set -euo pipefail
cd "$(dirname "$0")"

VERSION_NAME=$(grep -o 'versionName="[^"]*"' AndroidManifest.xml | cut -d'"' -f2)
ANDROID_JAR=${ANDROID_JAR:-/usr/lib/android-sdk/platforms/android-33/android.jar}
OUT=build
if [ -n "${KEYSTORE:-}" ]; then VARIANT=release; else VARIANT=debug; fi
APK_NAME="ApproxAI-Offline-${VARIANT}.apk"
[ -f "$ANDROID_JAR" ] || { echo "android.jar not found: $ANDROID_JAR"; exit 1; }

rm -rf "$OUT"; mkdir -p "$OUT/gen" "$OUT/classes"

echo "[1/6] aapt: R.java"
aapt package -f -m -J "$OUT/gen" -M AndroidManifest.xml -S res -I "$ANDROID_JAR"

echo "[1b] BuildInfo.java"
GIT_COMMIT=$(git rev-parse --short HEAD 2>/dev/null || echo unknown)
BUILT_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
BUILD_ID="${VERSION_NAME}+${GIT_COMMIT}.${VARIANT}"
mkdir -p "$OUT/gensrc/com/approxtech/ai"
cat > "$OUT/gensrc/com/approxtech/ai/BuildInfo.java" <<JAVA
package com.approxtech.ai;
public final class BuildInfo {
    public static final String BUILD_ID = "${BUILD_ID}";
    public static final String BUILT_AT = "${BUILT_AT}";
    public static final String GIT_COMMIT = "${GIT_COMMIT}";
    private BuildInfo() {}
}
JAVA

echo "[2/6] javac"
find src "$OUT/gen" "$OUT/gensrc" -name '*.java' ! -path 'src/com/approxtech/ai/BuildInfo.java' > "$OUT/sources.txt"
javac -nowarn -Xlint:-options -source 8 -target 8 -encoding UTF-8 -bootclasspath "$ANDROID_JAR" -classpath "$ANDROID_JAR" -d "$OUT/classes" @"$OUT/sources.txt"

echo "[3/6] dx: dex"
dalvik-exchange --dex --min-sdk-version=26 --output="$OUT/classes.dex" "$OUT/classes"

echo "[4/6] aapt: package"
aapt package -f -M AndroidManifest.xml -S res -I "$ANDROID_JAR" -F "$OUT/unaligned.apk"
(cd "$OUT" && aapt add unaligned.apk classes.dex >/dev/null)

echo "[5/6] zipalign"
zipalign -f -p 4 "$OUT/unaligned.apk" "$OUT/aligned.apk"

echo "[6/6] apksigner ($VARIANT)"
if [ "$VARIANT" = "release" ]; then
  : "${KEYSTORE_PASS:?set KEYSTORE_PASS for a release build}"
  KEY_ALIAS=${KEY_ALIAS:-approx}
  apksigner sign --ks "$KEYSTORE" --ks-pass "pass:$KEYSTORE_PASS" --ks-key-alias "$KEY_ALIAS" \
    --v1-signing-enabled true --v2-signing-enabled true --out "$OUT/$APK_NAME" "$OUT/aligned.apk"
else
  DEBUG_KS="$OUT/debug.keystore"
  keytool -genkeypair -keystore "$DEBUG_KS" -storepass android -keypass android -alias androiddebugkey \
    -keyalg RSA -keysize 2048 -validity 10000 -dname "CN=Android Debug,O=Android,C=US" >/dev/null 2>&1
  apksigner sign --ks "$DEBUG_KS" --ks-pass pass:android --ks-key-alias androiddebugkey \
    --v1-signing-enabled true --v2-signing-enabled true --out "$OUT/$APK_NAME" "$OUT/aligned.apk"
fi
apksigner verify --verbose "$OUT/$APK_NAME" | head -5
rm -f "$OUT/unaligned.apk" "$OUT/aligned.apk" "$OUT/$APK_NAME.idsig"
SHA=$(sha256sum "$OUT/$APK_NAME" | cut -d' ' -f1)
cat > "$OUT/$APK_NAME.buildinfo.json" <<JSON
{ "apk": "$APK_NAME", "variant": "$VARIANT", "version_name": "$VERSION_NAME",
  "version_code": $(grep -o 'versionCode="[^"]*"' AndroidManifest.xml | cut -d'"' -f2),
  "git_commit": "$GIT_COMMIT", "built_at": "$BUILT_AT", "build_id": "$BUILD_ID",
  "sha256": "$SHA", "min_sdk": 26, "target_sdk": 33, "network": "none (no INTERNET permission)",
  "signing": "$([ "$VARIANT" = release ] && echo "release keystore (operator-supplied)" || echo "android debug key (NOT for distribution)")" }
JSON
echo "$SHA  $APK_NAME" > "$OUT/$APK_NAME.sha256"
echo "Built $OUT/$APK_NAME"; echo "SHA-256: $SHA"; cat "$OUT/$APK_NAME.buildinfo.json"
