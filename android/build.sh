#!/usr/bin/env bash
# Builds a signed release APK for Approx AI without Gradle, using the Android build tools
# available from Ubuntu packages: aapt, dalvik-exchange (dx), zipalign, apksigner.
#
#   sudo apt-get install aapt apksigner zipalign dalvik-exchange android-sdk-platform-23
#
# Usage:
#   ANDROID_JAR=/path/to/android-33/android.jar \
#   APPROX_SERVER_URL=https://your-approx-server \
#   KEYSTORE=keystore/approx-release.jks KEYSTORE_PASS=... ./build.sh
#
# Without KEYSTORE a local signing key is generated in keystore/ (gitignored). Production
# releases must be signed with Approx Technology's own protected release key.
set -euo pipefail
cd "$(dirname "$0")"

VERSION_NAME=$(grep -o 'versionName="[^"]*"' AndroidManifest.xml | cut -d'"' -f2)
ANDROID_JAR=${ANDROID_JAR:-/usr/lib/android-sdk/platforms/android-23/android.jar}
OUT=build
APK_NAME="ApproxAI-${VERSION_NAME}-release.apk"
SERVER_URL=${APPROX_SERVER_URL:-}

[ -f "$ANDROID_JAR" ] || { echo "android.jar not found: $ANDROID_JAR"; exit 1; }
if [ -n "$SERVER_URL" ] && [[ "$SERVER_URL" != https://* ]]; then echo "APPROX_SERVER_URL must be https://"; exit 1; fi

rm -rf "$OUT"
mkdir -p "$OUT/gen" "$OUT/classes" "$OUT/res"

# Resources (inject default server URL into a build copy, never into source)
cp -r res/. "$OUT/res/"
python3 - "$OUT/res/values/strings.xml" "$SERVER_URL" <<'PY'
import sys, html
p, url = sys.argv[1], sys.argv[2]
s = open(p, encoding='utf-8').read()
s = s.replace('<string name="default_server_url"></string>', f'<string name="default_server_url">{html.escape(url)}</string>')
open(p, 'w', encoding='utf-8').write(s)
PY

echo "[1/6] aapt: generate R.java"
aapt package -f -m -J "$OUT/gen" -M AndroidManifest.xml -S "$OUT/res" -I "$ANDROID_JAR"

echo "[2/6] javac"
find src "$OUT/gen" -name '*.java' > "$OUT/sources.txt"
javac -nowarn -Xlint:-options -source 8 -target 8 -encoding UTF-8 -bootclasspath "$ANDROID_JAR" -classpath "$ANDROID_JAR" -d "$OUT/classes" @"$OUT/sources.txt"

echo "[3/6] dx: dex"
dalvik-exchange --dex --min-sdk-version=26 --output="$OUT/classes.dex" "$OUT/classes"

echo "[4/6] aapt: package"
aapt package -f -M AndroidManifest.xml -S "$OUT/res" -I "$ANDROID_JAR" -F "$OUT/unaligned.apk"
(cd "$OUT" && aapt add unaligned.apk classes.dex)

echo "[5/6] zipalign"
zipalign -f -p 4 "$OUT/unaligned.apk" "$OUT/aligned.apk"

echo "[6/6] apksigner"
KEYSTORE=${KEYSTORE:-keystore/approx-local-release.jks}
if [ ! -f "$KEYSTORE" ]; then
  mkdir -p "$(dirname "$KEYSTORE")"
  KEYSTORE_PASS=${KEYSTORE_PASS:-$(head -c 24 /dev/urandom | base64 | tr -d '/+=')}
  echo "$KEYSTORE_PASS" > "$(dirname "$KEYSTORE")/.pass"; chmod 600 "$(dirname "$KEYSTORE")/.pass"
  keytool -genkeypair -keystore "$KEYSTORE" -storepass "$KEYSTORE_PASS" -keypass "$KEYSTORE_PASS" -alias approx \
    -keyalg RSA -keysize 3072 -validity 10000 -dname "CN=Approx Technology (local build key), O=Approx Technology" >/dev/null 2>&1
fi
KEYSTORE_PASS=${KEYSTORE_PASS:-$(cat "$(dirname "$KEYSTORE")/.pass")}
apksigner sign --ks "$KEYSTORE" --ks-pass "pass:$KEYSTORE_PASS" --ks-key-alias approx --v1-signing-enabled true --v2-signing-enabled true \
  --out "$OUT/$APK_NAME" "$OUT/aligned.apk"
apksigner verify --verbose "$OUT/$APK_NAME" | head -5
rm -f "$OUT/unaligned.apk" "$OUT/aligned.apk" "$OUT/$APK_NAME.idsig"
sha256sum "$OUT/$APK_NAME" | tee "$OUT/$APK_NAME.sha256"
echo "Built $OUT/$APK_NAME"
