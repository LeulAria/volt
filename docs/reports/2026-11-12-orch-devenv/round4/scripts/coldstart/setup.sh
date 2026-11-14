#!/bin/bash
# Round 4 coldstart rig (ADEMark method, unofficial). Everything that must survive a reboot is under ~/.volt-r4/coldstart.
#   setup.sh rig                  winwait, ADEMark replay server on 18948 (own log), arena copy
#   setup.sh app before|after <VOLT.app>   copy a minified build to ~/.volt-r4/coldstart/apps/<arm>/VOLT.app
#   setup.sh seed before|after    fresh profile: settings, Claude Opus 5.5 High, Full access, 5 seeded threads
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
R4=~/.volt-r4/coldstart
HOMES=$R4/h
R3SCRIPTS="$HERE/../../../round3/scripts/ademark"

home() { # isolated HOME: the same claude first on PATH, an API key helper, the replay server as base URL
	local N=$HOMES/$1
	mkdir -p "$N/.local/bin" "$N/.claude"
	ln -sfn "$(readlink -f ~/.local/bin/claude)" "$N/.local/bin/claude"
	printf '#!/bin/sh\necho sk-ant-replay-0000\n' > "$N/.claude/key.sh"; chmod +x "$N/.claude/key.sh"
	printf '{"apiKeyHelper":"%s/.claude/key.sh","env":{"ANTHROPIC_BASE_URL":"http://127.0.0.1:18948","DISABLE_AUTOUPDATER":"1"}}\n' "$N" > "$N/.claude/settings.json"
	echo '{"hasCompletedOnboarding":true,"theme":"dark","oauthAccount":{"emailAddress":"replay@ademark.invalid"}}' > "$N/.claude.json"
	printf 'export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"\n' | tee "$N/.zprofile" > "$N/.zshenv"
}

case "${1:-}" in
rig)
	[ -e /tmp/ademark ] || ln -sfn ~/.volt-r3/ademark /tmp/ademark
	[ -x $R4/winwait ] || swiftc -O -o $R4/winwait "$R3SCRIPTS/winwait.swift"
	mkdir -p $R4/replay
	[ -d $R4/arena ] || (cp -R /tmp/ademark/arena $R4/arena && cd $R4/arena && git init -q && git add -A && git -c user.email=a@b -c user.name=ademark commit -qm arena-v1)
	if ! lsof -nP -iTCP:18948 -sTCP:LISTEN >/dev/null; then
		(cd /tmp/ademark && nohup bun bench/replay/server.ts --port 18948 --sessions bench/replay/sessions --log $R4/replay/requests.jsonl > $R4/replay/server.log 2>&1 &)
	fi
	;;
app)
	ARM=$2; SRC=$3
	rm -rf "$R4/apps/$ARM"; mkdir -p "$R4/apps/$ARM"
	ditto "$SRC" "$R4/apps/$ARM/VOLT.app"
	;;
seed)
	ARM=$2; APP=$( [[ $ARM == dev-* ]] && echo $ARM || echo cold-$ARM ); UD=/tmp/v4-cold-ud-$ARM
	bun "$HERE/run.ts" --app $APP --kill
	rm -rf "$UD" "$HOMES/$ARM"; home $ARM
	mkdir -p "$UD/User" "$HOMES/$ARM/.volt"; date -u +%FT%TZ > "$HOMES/$ARM/.volt/setup-shown"
	cat > "$UD/User/settings.json" <<'EOF'
{
	"volt.agent.defaultModel": "agent:seed-claude-code:claude-opus-5-5",
	"security.workspace.trust.enabled": false,
	"update.mode": "none",
	"telemetry.telemetryLevel": "off",
	"window.dialogStyle": "custom"
}
EOF
	ADE_OPEN=$R4/arena bun "$HERE/run.ts" --app $APP --launch
	sleep 45
	bun "$HERE/run.ts" --app $APP --quit || true
	bun "$HERE/run.ts" --app $APP --kill
	DB="$UD/agentServer/application.vscdb"
	sqlite3 "$DB" "insert or replace into ItemTable(key,value) values('volt.runtime.accessMode','full-access')"
	sqlite3 "$DB" "insert or replace into ItemTable(key,value) values('volt.runtime.modelOptions','{\"agent:seed-claude-code:claude-opus-5-5\":{\"reasoning\":\"high\"}}')"
	rm -f "$DB.backup"
	ADE_KEEP_RENDERING=1 bun "$HERE/run.ts" --app $APP --launch
	sleep 40
	node "$R3SCRIPTS/volt-drive.mjs" 9944 seed 5
	bun "$HERE/run.ts" --app $APP --quit || true
	;;
*) echo "usage: setup.sh rig | app <arm> <VOLT.app> | seed <arm>"; exit 2 ;;
esac
