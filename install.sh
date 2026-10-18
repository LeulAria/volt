#!/usr/bin/env bash
#---------------------------------------------------------------------------------------------
#  Copyright (c) Volt ADK. All rights reserved.
#  Licensed under the MIT License. See License.txt in the project root for license information.
#---------------------------------------------------------------------------------------------

# Installs Volt from its GitHub release.
#
#   curl -fsSL https://raw.githubusercontent.com/LeulAria/VOLT/main/install.sh | bash
#
# macOS: downloads the disk image for your chip, checks its SHA-256 against the release feed and copies Volt.app into
#        /Applications (or ~/Applications when that is not writable).
# Linux: unpacks the tar.gz into ~/.local/share/volt and links ~/.local/bin/volt. No root needed. For a system package use
#        the .deb or .rpm from the release page instead.
#
# Environment:
#   VOLT_VERSION      install this version instead of the latest, for example 0.0.2
#   VOLT_INSTALL_DIR  macOS: where Volt.app goes. Linux: where the files are unpacked.
#
# Read this file before you run it; it is short on purpose. Nothing here needs sudo.

set -euo pipefail

REPO="LeulAria/volt"
FEED="https://raw.githubusercontent.com/LeulAria/VOLT/volt-update-feed/stable/latest.json"

say() { printf '%s\n' "$*"; }
fail() { printf 'error: %s\n' "$*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || fail "'$1' is required but was not found"; }

need curl

if command -v sha256sum >/dev/null 2>&1; then
	sha256() { sha256sum "$1" | cut -d ' ' -f 1; }
elif command -v shasum >/dev/null 2>&1; then
	sha256() { shasum -a 256 "$1" | cut -d ' ' -f 1; }
else
	fail "sha256sum or shasum is required to check the download"
fi

case "$(uname -s)" in
	Darwin) OS=darwin ;;
	Linux) OS=linux ;;
	*) fail "this script supports macOS and Linux. On Windows, download the installer from https://github.com/$REPO/releases/latest" ;;
esac

case "$(uname -m)" in
	arm64 | aarch64) ARCH=arm64 ;;
	x86_64 | amd64) ARCH=x64 ;;
	armv7l | armv8l) ARCH=armhf ;;
	*) fail "unsupported processor: $(uname -m)" ;;
esac

if [ "$OS" = darwin ]; then
	EXT=dmg
else
	EXT=tar.gz
fi

# The feed lists every asset of the newest stable release with its SHA-256, and pins a version.
FEED_JSON="$(curl -fsSL "$FEED")" || fail "could not read the release feed at $FEED"

if [ -n "${VOLT_VERSION:-}" ]; then
	VERSION="$VOLT_VERSION"
else
	VERSION="$(printf '%s\n' "$FEED_JSON" | sed -n 's/^[[:space:]]*"version": "\(.*\)",\{0,1\}$/\1/p' | head -n 1)"
	[ -n "$VERSION" ] || fail "could not work out the latest version"
fi

ASSET="volt-stable-$VERSION-$OS-$ARCH.$EXT"
URL="https://github.com/$REPO/releases/download/v$VERSION/$ASSET"

# Only the feed's own version has a checksum on record; for another version we say so and carry on.
EXPECTED="$(printf '%s\n' "$FEED_JSON" | grep -A4 "\"name\": \"$ASSET\"" | sed -n 's/^[[:space:]]*"sha256": "\([0-9a-f]\{64\}\)".*$/\1/p' | head -n 1)"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

say "Downloading Volt $VERSION for $OS ($ARCH)"
curl -fL --progress-bar -o "$TMP/$ASSET" "$URL" || fail "could not download $URL"

if [ -n "$EXPECTED" ]; then
	ACTUAL="$(sha256 "$TMP/$ASSET")"
	[ "$ACTUAL" = "$EXPECTED" ] || fail "checksum mismatch for $ASSET (expected $EXPECTED, got $ACTUAL); nothing was installed"
	say "Checksum OK"
else
	say "Note: no checksum on record for $ASSET (it is not the latest release); skipping the check"
fi

if [ "$OS" = darwin ]; then
	DEST="${VOLT_INSTALL_DIR:-/Applications}"
	if [ ! -d "$DEST" ] || [ ! -w "$DEST" ]; then
		[ -z "${VOLT_INSTALL_DIR:-}" ] || fail "$DEST is not a writable folder"
		DEST="$HOME/Applications"
		mkdir -p "$DEST"
	fi
	MOUNT="$TMP/mount"
	mkdir -p "$MOUNT"
	hdiutil attach "$TMP/$ASSET" -nobrowse -readonly -quiet -mountpoint "$MOUNT" || fail "could not open the disk image"
	detach() { hdiutil detach "$MOUNT" -quiet >/dev/null 2>&1 || true; }
	trap 'detach; rm -rf "$TMP"' EXIT
	[ -d "$MOUNT/Volt.app" ] || fail "Volt.app was not found in the disk image"
	if [ -d "$DEST/Volt.app" ]; then
		say "Replacing the Volt.app in $DEST"
		rm -rf "$DEST/Volt.app"
	fi
	cp -R "$MOUNT/Volt.app" "$DEST/"
	# A download made with curl is not quarantined; this only matters if the file came from somewhere else.
	xattr -dr com.apple.quarantine "$DEST/Volt.app" 2>/dev/null || true
	say ""
	say "Installed $DEST/Volt.app"
	say "Open it with:  open -a Volt"
	say "For the 'volt' command, run 'Shell Command: Install volt command in PATH' from Volt's command palette."
else
	DEST="${VOLT_INSTALL_DIR:-$HOME/.local/share/volt}"
	BIN="$HOME/.local/bin"
	rm -rf "$DEST"
	mkdir -p "$DEST" "$BIN"
	tar -xzf "$TMP/$ASSET" -C "$DEST" --strip-components=1 || fail "could not unpack $ASSET"
	LAUNCHER="$DEST/bin/volt"
	[ -x "$LAUNCHER" ] || LAUNCHER="$DEST/volt"
	[ -x "$LAUNCHER" ] || fail "did not find the volt launcher in the archive"
	ln -sf "$LAUNCHER" "$BIN/volt"
	say ""
	say "Installed to $DEST and linked $BIN/volt"
	case ":$PATH:" in
		*":$BIN:"*) ;;
		*) say "Add $BIN to your PATH to run 'volt' from anywhere." ;;
	esac
fi
