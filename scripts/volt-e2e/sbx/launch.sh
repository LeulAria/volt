#!/bin/bash
# Usage: launch.sh <worktree> <profile> <cdp-port> [folder]
# A Volt dev test instance with a fresh profile and its OWN extensions folder (<profile>-ext), so an
# extension installed for a test never lands in the shared ~/.vscode-oss-dev/extensions.
WT=$(cd "$1" && pwd); UD=$2; PORT=$3; FOLDER=${4:-}
mkdir -p "$UD/User" "$UD-ext"
[ -f "$UD/User/settings.json" ] || echo '{ "window.dialogStyle": "custom", "security.workspace.trust.enabled": false }' > "$UD/User/settings.json"
cd "$WT"
env -u ELECTRON_RUN_AS_NODE NODE_ENV=development VSCODE_DEV=1 VSCODE_CLI=1 VSCODE_SKIP_PRELAUNCH=1 \
	nohup ./.build/electron/VOLT.app/Contents/MacOS/Electron . --disable-extension=vscode.vscode-api-tests \
	--user-data-dir "$UD" --extensions-dir "$UD-ext" --remote-debugging-port=$PORT \
	--disable-backgrounding-occluded-windows --disable-renderer-backgrounding --disable-features=CalculateNativeWinOcclusion \
	$FOLDER > "$UD.log" 2>&1 &
echo $! > "$UD.pid"; echo "pid $(cat $UD.pid) cdp $PORT log $UD.log"
