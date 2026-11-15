#!/bin/bash
# Round 6 launch rig (copied from round 4 coldstart; ADEMark method, unofficial). Everything is under ~/.volt-r6/launch.
#   setup.sh rig                  ADEMark replay server on 18994 (own log), arena copy
#   setup.sh app before|after <VOLT.app> [commit]   copy a minified build to ~/.volt-r6/launch/apps/<arm>/VOLT.app (commit stamped)
#   setup.sh clone <src> <dst>   copy a seeded profile + HOME to another arm
#   setup.sh seed <arm>           fresh profile: settings, Claude Opus 5.5 High, Full access, 5 seeded threads
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
R4=~/.volt-r6/launch
R4OLD=~/.volt-r4/coldstart
HOMES=$R4/h
R3SCRIPTS="$HERE/../../../round3/scripts/ademark"
PORT=9974; REPLAY=18994

home() { # isolated HOME: the same claude first on PATH, an API key helper, the replay server as base URL
	local N=$HOMES/$1
	mkdir -p "$N/.local/bin" "$N/.claude"
	ln -sfn "$(readlink -f ~/.local/bin/claude)" "$N/.local/bin/claude"
	printf '#!/bin/sh\necho sk-ant-replay-0000\n' > "$N/.claude/key.sh"; chmod +x "$N/.claude/key.sh"
	printf '{"apiKeyHelper":"%s/.claude/key.sh","env":{"ANTHROPIC_BASE_URL":"http://127.0.0.1:18994","DISABLE_AUTOUPDATER":"1"}}\n' "$N" > "$N/.claude/settings.json"
	echo '{"hasCompletedOnboarding":true,"theme":"dark","oauthAccount":{"emailAddress":"replay@ademark.invalid"}}' > "$N/.claude.json"
	printf 'export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"\n' | tee "$N/.zprofile" > "$N/.zshenv"
}

case "${1:-}" in
rig)
	[ -e /tmp/ademark ] || ln -sfn ~/.volt-r3/ademark /tmp/ademark
	[ -x $R4OLD/winwait ] || { echo "missing $R4OLD/winwait"; exit 1; }
	mkdir -p $R4/replay
	[ -d $R4/arena ] || (cp -R /tmp/ademark/arena $R4/arena && cd $R4/arena && git init -q && git add -A && git -c user.email=a@b -c user.name=ademark commit -qm arena-v1)
	if ! lsof -nP -iTCP:$REPLAY -sTCP:LISTEN >/dev/null; then
		(cd /tmp/ademark && nohup bun bench/replay/server.ts --port $REPLAY --sessions bench/replay/sessions --log $R4/replay/requests.jsonl > $R4/replay/server.log 2>&1 &)
	fi
	;;
app)
	ARM=$2; SRC=$3
	rm -rf "$R4/apps/$ARM"; mkdir -p "$R4/apps/$ARM"
	cp -cR "$SRC" "$R4/apps/$ARM/VOLT.app"
	# A local worktree build has no commit (getVersion cannot read a linked worktree's .git), and without a commit the
	# window runs with no V8 code cache, unlike a shipped build. Stamp the source commit as a release build has it.
	COMMIT=${4:-}
	if [ -n "$COMMIT" ]; then
		python3 -c 'import json,sys; p=sys.argv[1]; d=json.load(open(p)); d.setdefault("commit", sys.argv[2]); json.dump(d, open(p,"w"), indent="\t")' \
			"$R4/apps/$ARM/VOLT.app/Contents/Resources/app/product.json" "$COMMIT"
	fi
	;;
seed)
	ARM=$2; APP=$ARM; UD=$R4/ud/$ARM
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
	node "$R3SCRIPTS/volt-drive.mjs" $PORT seed 5
	bun "$HERE/run.ts" --app $APP --quit || true
	bun "$HERE/run.ts" --app $APP --kill
	;;
clone)
	# A copy of a seeded arm's profile and HOME for another arm, so both restore the same state
	SRC=$2; DST=$3
	bun "$HERE/run.ts" --app $SRC --quit || true
	bun "$HERE/run.ts" --app $SRC --kill
	bun "$HERE/run.ts" --app $DST --kill
	rm -rf $R4/ud/$DST "$HOMES/$DST"
	cp -cR $R4/ud/$SRC $R4/ud/$DST
	cp -cR "$HOMES/$SRC" "$HOMES/$DST"
	rm -f $R4/ud/$DST/agentServer/runtime.json $R4/ud/$DST/*.sock $R4/ud/$DST/code.lock
	LC_ALL=C sed -i '' "s#/ud/$SRC/#/ud/$DST/#g; s#/ud/$SRC\"#/ud/$DST\"#g" $R4/ud/$DST/User/globalStorage/storage.json
	sed -i '' "s#h/$SRC#h/$DST#g" "$HOMES/$DST/.claude/settings.json"
	;;
*) echo "usage: setup.sh rig | app <arm> <VOLT.app> [commit] | seed <arm> | clone <src> <dst>"; exit 2 ;;
esac
