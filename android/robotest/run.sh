#!/usr/bin/env bash
# Runs the real MainActivity headless (Robolectric) against the BUILT APK's resources and saves screenshots.
#   1) cd android && bash build.sh        2) bash robotest/run.sh [screenshot-dir]
# Needs Maven Central and Google Maven (androidx.test monitor/espresso-idling/annotation .aar → libs/*.jar).
set -euo pipefail
cd "$(dirname "$0")"
A="$(cd .. && pwd)"; SHOTS="${1:-$PWD/shots}"; mkdir -p "$SHOTS" libs src/test/resources/com/android/tools
for a in androidx/test/monitor/1.7.2/monitor-1.7.2 androidx/test/espresso/espresso-idling-resource/3.6.1/espresso-idling-resource-3.6.1 androidx/test/annotation/1.0.1/annotation-1.0.1; do
  n=$(basename "$a"); [ -f "libs/$n.jar" ] && continue
  curl -fsSL -o "libs/$n.aar" "https://dl.google.com/dl/android/maven2/$a.aar"; (cd libs && unzip -p "$n.aar" classes.jar > "$n.jar" && rm "$n.aar")
done
printf 'android_resource_apk=%s\nandroid_merged_manifest=%s\nandroid_custom_package=com.approxtech.ai\n' \
  "$A/build/ApproxAI-Online-debug.apk" "$A/AndroidManifest.xml" > src/test/resources/com/android/tools/test_config.properties
mvn -q -B ${MVN_SETTINGS:+-s "$MVN_SETTINGS"} test -Dapp.src="$A/src" -Dapp.gen="$A/build/gen" -Dshots="$SHOTS"
grep -h "Tests run" target/surefire-reports/*.txt
