#!/bin/bash
# Round 4 coldstart rig (ADEMark method, unofficial). Everything that must survive a reboot is under ~/.volt-r4/coldstart.
#   setup.sh rig                  winwait, ADEMark replay server on 18948 (own log), arena copy
#   setup.sh app before|after <VOLT.app> [commit]   copy a minified build to ~/.volt-r4/coldstart/apps/<arm>/VOLT.app (commit stamped)
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
	# A local worktree build has no commit (getVersion cannot read a linked worktree's .git), and without a commit the
	# window runs with no V8 code cache, unlike a shipped build. Stamp the source commit as a release build has it.
	COMMIT=${4:-}
	if [ -n "$COMMIT" ]; then
		python3 -c 'import json,sys; p=sys.argv[1]; d=json.load(open(p)); d.setdefault("commit", sys.argv[2]); json.dump(d, open(p,"w"), indent="\t")' \
			"$R4/apps/$ARM/VOLT.app/Contents/Resources/app/product.json" "$COMMIT"
	fi
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
	ADE_SERVER_DETACHED=1 ADE_KEEP_RENDERING=1 bun "$HERE/run.ts" --app $APP --launch
	sleep 40
	node "$R3SCRIPTS/volt-drive.mjs" 9944 seed 5
	bun "$HERE/run.ts" --app $APP --quit || true
	bun "$HERE/run.ts" --app $APP --kill
	;;
long)
	# A copy of a seeded arm whose last chat is ADEMark's long thread (A11 prompt, about 11 min of replay)
	ARM=$2; UD=/tmp/v4-cold-ud-$ARM; L=$ARM-long
	bun "$HERE/run.ts" --app cold-$ARM --quit || true
	bun "$HERE/run.ts" --app cold-$ARM --kill
	rm -rf /tmp/v4-cold-ud-$L "$HOMES/$L"
	cp -cR "$UD" /tmp/v4-cold-ud-$L 2>/dev/null || true
	cp -cR "$HOMES/$ARM" "$HOMES/$L"
	rm -f /tmp/v4-cold-ud-$L/agentServer/runtime.json /tmp/v4-cold-ud-$L/*.sock
	sed -i '' "s#v4-cold-ud-$ARM#v4-cold-ud-$L#g" /tmp/v4-cold-ud-$L/User/globalStorage/storage.json
	sed -i '' "s#h/$ARM#h/$L#g" "$HOMES/$L/.claude/settings.json"
	ADE_SERVER_DETACHED=1 ADE_KEEP_RENDERING=1 bun "$HERE/run.ts" --app cold-$L --launch
	sleep 30
	node "$R3SCRIPTS/volt-drive.mjs" 9944 send 'replay:long-2000' 1800000
	bun "$HERE/run.ts" --app cold-$L --quit || true
	bun "$HERE/run.ts" --app cold-$L --kill
	;;
*) echo "usage: setup.sh rig | app <arm> <VOLT.app> [commit] | seed <arm> | long <arm>"; exit 2 ;;
esac
