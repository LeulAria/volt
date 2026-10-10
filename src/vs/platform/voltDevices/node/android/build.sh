#!/usr/bin/env bash
# Builds volt-ui.jar (the dex Android runs with app_process) from UiServer.java.
# Needs a JDK (javac) and the Android SDK (build-tools d8, platforms/android-36/android.jar).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
SDK="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/Library/Android/sdk}}"
PLATFORM="$SDK/platforms/android-36/android.jar"
D8="$(ls -d "$SDK"/build-tools/*/ | sort -V | tail -1)d8"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
javac --release 8 -nowarn -cp "$PLATFORM" -d "$WORK/classes" "$HERE/UiServer.java"
"$D8" --release --min-api 26 --lib "$PLATFORM" --output "$WORK/volt-ui.jar" "$WORK/classes/volt/UiServer.class"
cp "$WORK/volt-ui.jar" "$HERE/volt-ui.jar"
echo "built $HERE/volt-ui.jar"
