#!/usr/bin/env bash
set -e

if [[ "$OSTYPE" == "darwin"* ]]; then
	realpath() { [[ $1 = /* ]] && echo "$1" || echo "$PWD/${1#./}"; }
	ROOT=$(dirname $(dirname $(realpath "$0")))
else
	ROOT=$(dirname $(dirname $(readlink -f $0)))
fi

cd $ROOT

if [[ "$OSTYPE" == "darwin"* ]]; then
	NAME=`node -p "require('./product.json').nameLong"`
	CODE="./.build/electron/$NAME.app/Contents/MacOS/Electron"
else
	NAME=`node -p "require('./product.json').applicationName"`
	CODE=".build/electron/$NAME"
fi

VSCODECRASHDIR=$ROOT/.build/crashes

# Node modules
test -d node_modules || npm i

# Get electron
npm run electron

# Unit Tests
if [[ "$OSTYPE" == "darwin"* ]]; then
	# The macOS sandbox backend needs its native helper: tests run without VSCODE_DEV, so it goes
	# into out/volt-helpers and the helper manifest, as a packaged build carries it.
	node build/volt/sandbox-helper/build.mjs --install out >/dev/null
	cd $ROOT ; ulimit -n 4096 ; \
		ELECTRON_ENABLE_LOGGING=1 \
		"$CODE" \
		test/unit/electron/index.js --crash-reporter-directory=$VSCODECRASHDIR "$@"
else
	cd $ROOT ; \
		ELECTRON_ENABLE_LOGGING=1 \
		"$CODE" \
		test/unit/electron/index.js --crash-reporter-directory=$VSCODECRASHDIR "$@"
fi
