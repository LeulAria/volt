#!/usr/bin/env bash
#---------------------------------------------------------------------------------------------
#  Copyright (c) Volt ADK. All rights reserved.
#  Licensed under the MIT License. See License.txt in the project root for license information.
#---------------------------------------------------------------------------------------------

# Collects the Linux build into release assets: a tar.gz of ../VSCode-linux-<arch> plus the deb
# and rpm the gulp tasks wrote under .build/linux.
# Usage: build/volt/release/linux-package.sh <x64|arm64|armhf>   env: CHANNEL, VOLT_VERSION
set -euo pipefail

ARCH="$1"
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
BUILD_DIR="$(dirname "$ROOT")"
OUT="$ROOT/.build/volt-assets"
BASE="volt-$CHANNEL-$VOLT_VERSION-linux-$ARCH"
mkdir -p "$OUT"

case "$ARCH" in
	x64) DEB_ARCH=amd64; RPM_ARCH=x86_64 ;;
	arm64) DEB_ARCH=arm64; RPM_ARCH=aarch64 ;;
	armhf) DEB_ARCH=armhf; RPM_ARCH=armv7hl ;;
	*) echo "Unknown arch $ARCH" >&2; exit 1 ;;
esac

APP_NAME="$(node -p "require('$ROOT/product.json').applicationName")"
NAME="$(node -p "require('$ROOT/product.json').nameShort.replace(/ /g, '-')")"

# Archive with a top-level folder, like VS Code's tarballs.
STAGE="$(mktemp -d)"
cp -a "$BUILD_DIR/VSCode-linux-$ARCH" "$STAGE/$NAME-linux-$ARCH"
tar -czf "$OUT/$BASE.tar.gz" -C "$STAGE" "$NAME-linux-$ARCH"
rm -rf "$STAGE"

DEB="$(ls "$ROOT"/.build/linux/deb/$DEB_ARCH/deb/*.deb | head -n 1)"
RPM="$(ls "$ROOT"/.build/linux/rpm/$RPM_ARCH/*.rpm | head -n 1)"
cp "$DEB" "$OUT/$BASE.deb"
cp "$RPM" "$OUT/$BASE.rpm"

echo "Packaged $APP_NAME:"
ls -la "$OUT"
