#!/bin/zsh
# Round-5 firstword rig state (idempotent; everything lives under ~/.volt-r5/firstword so it survives a reboot):
#   arena          a git checkout of ADEMark's arena (the project the test window opens)
#   replay server  ADEMark's own bench/replay/server.ts on 127.0.0.1:18972, log ~/.volt-r5/firstword/replay.jsonl
#   ./setup.sh            arena + replay server
#   ./setup.sh replay     (re)start only the replay server
set -e
ADEMARK=${ADEMARK:-$HOME/.volt-r4/ademark}
R5=$HOME/.volt-r5/firstword
PORT=${SPEED_REPLAY:-18972}
mkdir -p $R5/ext $R5/ext-base

if [[ $1 != replay ]]; then
	if [[ ! -d $R5/arena/.git ]]; then
		rm -rf $R5/arena
		cp -R $ADEMARK/arena $R5/arena
		git -C $R5/arena init -q -b main
		git -C $R5/arena add -A
		git -C $R5/arena -c user.name=bench -c user.email=bench@localhost commit -q -m arena
	fi
fi

pkill -f "replay/server.ts --port $PORT" || true
nohup bun $ADEMARK/bench/replay/server.ts --port $PORT --sessions $ADEMARK/bench/replay/sessions --log $R5/replay.jsonl > $R5/replay.out 2>&1 &
for i in {1..50}; do
	curl -sf http://127.0.0.1:$PORT/_ademark/health > /dev/null && { echo "replay up on $PORT"; exit 0; }
	sleep 0.2
done
echo "replay server did not start" >&2
cat $R5/replay.out >&2
exit 1
