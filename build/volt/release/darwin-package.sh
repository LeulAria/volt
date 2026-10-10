#!/usr/bin/env bash
#---------------------------------------------------------------------------------------------
#  Copyright (c) Volt ADK. All rights reserved.
#  Licensed under the MIT License. See License.txt in the project root for license information.
#---------------------------------------------------------------------------------------------

# Signs (Developer ID when MACOS_CERTIFICATE is set, ad-hoc otherwise), notarizes (when the Apple
# ID secrets are set) and packages ../VSCode-darwin-<arch>/<App>.app into a zip (what the updater
# installs) and a dmg (what people download), named for the release.
# Usage: build/volt/release/darwin-package.sh <x64|arm64|universal>   env: CHANNEL, VOLT_VERSION
set -euo pipefail

ARCH="$1"
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
BUILD_DIR="$(dirname "$ROOT")"
APP_ROOT="$BUILD_DIR/VSCode-darwin-$ARCH"
APP_NAME="$(ls "$APP_ROOT" | grep '\.app$' | head -n 1)"
APP="$APP_ROOT/$APP_NAME"
NAME="${APP_NAME%.app}"
OUT="$ROOT/.build/volt-assets"
BASE="volt-$CHANNEL-$VOLT_VERSION-darwin-$ARCH"
TMP="${RUNNER_TEMP:-$(mktemp -d)}"
mkdir -p "$OUT"

echo "Packaging $APP"

IDENTITY=""
if [ -n "${MACOS_CERTIFICATE:-}" ]; then
	KEYCHAIN="$TMP/buildagent.keychain"
	KEYCHAIN_PASSWORD="$(openssl rand -hex 16)"
	security create-keychain -p "$KEYCHAIN_PASSWORD" "$KEYCHAIN"
	security set-keychain-settings -lut 21600 "$KEYCHAIN"
	security unlock-keychain -p "$KEYCHAIN_PASSWORD" "$KEYCHAIN"
	security list-keychains -d user -s "$KEYCHAIN" $(security list-keychains -d user | tr -d '"')
	echo "$MACOS_CERTIFICATE" | base64 --decode > "$TMP/cert.p12"
	security import "$TMP/cert.p12" -k "$KEYCHAIN" -P "${MACOS_CERTIFICATE_PASSWORD:-}" -T /usr/bin/codesign
	rm -f "$TMP/cert.p12"
	security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$KEYCHAIN_PASSWORD" "$KEYCHAIN" > /dev/null
	IDENTITY="$(security find-identity -v -p codesigning "$KEYCHAIN" | grep -oE '[0-9A-F]{40}' | head -n 1)"
	echo "Signing with Developer ID $IDENTITY"
	AGENT_TEMPDIRECTORY="$TMP" CODESIGN_IDENTITY="$IDENTITY" VSCODE_ARCH="$ARCH" node "$ROOT/build/darwin/sign.js" "$BUILD_DIR"
else
	echo "::warning::MACOS_CERTIFICATE is not set: ad-hoc signing $NAME (Gatekeeper will ask users to confirm the first launch)."
	# build/darwin/sign.js adds these usage descriptions when it signs, and it does not run here.
	# Without NSSpeechRecognitionUsageDescription macOS kills the speech helper on the first dictation.
	INFO_PLIST="$APP/Contents/Info.plist"
	plutil -replace NSAppleEventsUsageDescription -string "An application in $NAME wants to use AppleScript." "$INFO_PLIST"
	plutil -replace NSMicrophoneUsageDescription -string "An application in $NAME wants to use the Microphone." "$INFO_PLIST"
	plutil -replace NSSpeechRecognitionUsageDescription -string "Volt turns your dictation into text for the agent composer." "$INFO_PLIST"
	plutil -replace NSCameraUsageDescription -string "An application in $NAME wants to use the Camera." "$INFO_PLIST"
	codesign --force --deep --sign - "$APP"
fi
codesign --verify --deep --strict --verbose=2 "$APP" || echo "::warning::codesign --verify reported problems"

NOTARIZE=""
if [ -n "$IDENTITY" ] && [ -n "${APPLE_ID:-}" ] && [ -n "${APPLE_APP_SPECIFIC_PASSWORD:-}" ] && [ -n "${APPLE_TEAM_ID:-}" ]; then
	NOTARIZE=1
fi

ditto -c -k --sequesterRsrc --keepParent "$APP" "$OUT/$BASE.zip"
if [ -n "$NOTARIZE" ]; then
	echo "Notarizing the app"
	xcrun notarytool submit "$OUT/$BASE.zip" --apple-id "$APPLE_ID" --password "$APPLE_APP_SPECIFIC_PASSWORD" --team-id "$APPLE_TEAM_ID" --wait
	xcrun stapler staple "$APP"
	rm "$OUT/$BASE.zip"
	ditto -c -k --sequesterRsrc --keepParent "$APP" "$OUT/$BASE.zip"
elif [ -n "$IDENTITY" ]; then
	echo "::warning::APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID not set: skipping notarization."
fi

STAGE="$TMP/dmg-$ARCH"
rm -rf "$STAGE" && mkdir -p "$STAGE"
ditto "$APP" "$STAGE/$APP_NAME"
ln -s /Applications "$STAGE/Applications"
# Build a read-write image, then compress it to ULMO (LZMA): ~40% smaller than UDZO for this app
# (177MB -> 105MB for darwin-arm64) and readable on macOS 10.15+ (Electron needs 11+).
# `hdiutil create -srcfolder` fails with "Resource busy" now and then, so it gets a few tries.
RW_DMG="$TMP/$BASE-rw.dmg"
for ATTEMPT in 1 2 3 4 5; do
	rm -f "$RW_DMG"
	if hdiutil create -volname "$NAME" -srcfolder "$STAGE" -ov -format UDRW "$RW_DMG"; then
		break
	fi
	if [ "$ATTEMPT" -eq 5 ]; then
		echo "hdiutil create failed $ATTEMPT times" >&2
		exit 1
	fi
	echo "hdiutil create failed (attempt $ATTEMPT), retrying"
	sleep $((ATTEMPT * 5))
done
hdiutil convert "$RW_DMG" -format ULMO -ov -o "$OUT/$BASE.dmg"
rm -f "$RW_DMG"
rm -rf "$STAGE"
if [ -n "$IDENTITY" ]; then
	codesign --force --sign "$IDENTITY" --timestamp "$OUT/$BASE.dmg"
fi
if [ -n "$NOTARIZE" ]; then
	echo "Notarizing the dmg"
	xcrun notarytool submit "$OUT/$BASE.dmg" --apple-id "$APPLE_ID" --password "$APPLE_APP_SPECIFIC_PASSWORD" --team-id "$APPLE_TEAM_ID" --wait
	xcrun stapler staple "$OUT/$BASE.dmg"
fi

ls -la "$OUT"
