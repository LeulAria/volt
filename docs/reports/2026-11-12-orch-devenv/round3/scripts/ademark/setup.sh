#!/bin/bash
# Rebuilds the round-3 ADEMark rig after a reboot (everything in /tmp is lost; homes live in ~/.volt-r3/ade/h).
#   setup.sh rig              clone ADEMark, build its native helper and winwait, copy the apps, arenas, homes, replay server
#   setup.sh volt-dev|volt-rel   fresh Volt profile: settings, Claude Opus 5.5 High, Full access, 5 seeded threads
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
R3=~/.volt-r3
H=/tmp/v3-ade-h
HOMES=$R3/ade/h
APPS=(volt-dev volt t3 paseo zeron monocode super claude-desktop)

home() { # isolated HOME: the same claude 2.1.322 first on PATH, an API key helper, the replay server as base URL
	local N=$HOMES/$1
	mkdir -p "$N/.local/bin" "$N/.claude"
	ln -sfn "$(readlink -f ~/.local/bin/claude)" "$N/.local/bin/claude"
	printf '#!/bin/sh\necho sk-ant-replay-0000\n' > "$N/.claude/key.sh"; chmod +x "$N/.claude/key.sh"
	printf '{"apiKeyHelper":"%s/.claude/key.sh","env":{"ANTHROPIC_BASE_URL":"http://127.0.0.1:18951","DISABLE_AUTOUPDATER":"1"}}\n' "$N" > "$N/.claude/settings.json"
	# oauthAccount is display data only: Volt lists Claude's models only when it can name an account (an API-key
	# login has none, see the report's open items). The CLI still authenticates with the key helper.
	echo '{"hasCompletedOnboarding":true,"theme":"dark","oauthAccount":{"emailAddress":"replay@ademark.invalid"}}' > "$N/.claude.json"
	printf 'export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"\n' | tee "$N/.zprofile" > "$N/.zshenv"
}

case "${1:-}" in
rig)
	[ -d $R3/ademark ] || git clone -q https://github.com/zqkra/ademark $R3/ademark
	ln -sfn $R3/ademark /tmp/ademark
	bash $R3/ademark/bench/native/build.sh --if-stale
	mkdir -p $H /tmp/v3-apps/se /tmp/v3-ade-arena /tmp/v3-ade-replay
	swiftc -O -o $H/winwait "$HERE/winwait.swift"
	ditto /Users/leularia/Desktop/VOLT/volt/.build/electron/VOLT.app $H/electron/VOLT.app
	for a in "Volt.app" "T3 Code (Nightly).app" "Paseo.app" "Claude.app" "Zeron.app" "MonoCode.app"; do
		[ -d "/tmp/v3-apps/$a" ] || ditto "/Applications/$a" "/tmp/v3-apps/$a"
	done
	if [ ! -d /tmp/v3-apps/se/super.engineering.app ]; then
		curl -sL -o /tmp/v3-apps/se/se.dmg 'https://super.engineering/api/download?arch=arm64'
		hdiutil attach -nobrowse -readonly -mountpoint /tmp/v3-apps/se/mnt /tmp/v3-apps/se/se.dmg >/dev/null
		ditto /tmp/v3-apps/se/mnt/Superconductor.app /tmp/v3-apps/se/super.engineering.app
		hdiutil detach /tmp/v3-apps/se/mnt >/dev/null
	fi
	for a in "${APPS[@]}"; do
		home "$a"
		[ -d /tmp/v3-ade-arena/$a ] || (cp -R $R3/ademark/arena /tmp/v3-ade-arena/$a && cd /tmp/v3-ade-arena/$a && git init -q && git add -A && git -c user.email=a@b -c user.name=ademark commit -qm arena-v1)
	done
	cp "$HERE/../../../round2/scripts/ui/cdp.mjs" $H/cdp.mjs
	(cd $R3/ademark && nohup bun bench/replay/server.ts --port 18951 --sessions bench/replay/sessions --log /tmp/v3-ade-replay/requests.jsonl > /tmp/v3-ade-replay/server.log 2>&1 &)
	;;
volt-dev|volt-rel)
	APP=$1
	if [ "$APP" = volt-dev ]; then UD=/tmp/v3-ade-ud-dev; NAME=volt-dev; else UD=/tmp/v3-ade-ud; NAME=volt; fi
	bun "$HERE/run.ts" --app $APP --kill
	rm -rf "$UD" "$HOMES/$NAME"; home $NAME
	mkdir -p "$UD/User" "$HOMES/$NAME/.volt"; date -u +%FT%TZ > "$HOMES/$NAME/.volt/setup-shown"
	cat > "$UD/User/settings.json" <<'EOF'
{
	"volt.agent.defaultModel": "agent:seed-claude-code:claude-opus-5-5",
	"security.workspace.trust.enabled": false,
	"update.mode": "none",
	"telemetry.telemetryLevel": "off"
}
EOF
	# First launch opens the arena and writes the agent server's storage; then the factory defaults ADEMark pins:
	# Opus 5.5 at high effort and the permission mode that never prompts (Full access).
	ADE_OPEN=/tmp/v3-ade-arena/$NAME bun "$HERE/run.ts" --app $APP --launch
	sleep 45
	bun "$HERE/run.ts" --app $APP --quit || true
	bun "$HERE/run.ts" --app $APP --kill
	DB="$UD/agentServer/application.vscdb"
	sqlite3 "$DB" "insert or replace into ItemTable(key,value) values('volt.runtime.accessMode','full-access')"
	sqlite3 "$DB" "insert or replace into ItemTable(key,value) values('volt.runtime.modelOptions','{\"agent:seed-claude-code:claude-opus-5-5\":{\"reasoning\":\"high\"}}')"
	if [ -n "${ADE_SANDBOX_OFF:-}" ]; then
		sqlite3 "$DB" "insert or replace into ItemTable(key,value) values('volt.runtime.sandbox','$ADE_SANDBOX_OFF')"
	fi
	rm -f "$DB.backup"
	bun "$HERE/run.ts" --app $APP --launch
	sleep 40
	node "$HERE/volt-drive.mjs" 9951 seed 5
	;;
*) echo "usage: setup.sh rig | volt-dev | volt-rel"; exit 2 ;;
esac
