#!/bin/zsh
# Recreates the speed rig's /tmp state after a reboot:
#   /tmp/v4-fw/arena   a git checkout of ADEMark's arena (the project the test window opens)
#   replay server         ADEMark's own bench/replay/server.ts on 127.0.0.1:18942, log /tmp/v4-fw/replay.jsonl
# ADEMark itself lives at ~/.volt-r4/ademark.
#   ./setup.sh            arena + replay server (idempotent)
#   ./setup.sh replay     (re)start only the replay server
set -e
ADEMARK=${ADEMARK:-$HOME/.volt-r4/ademark}
PORT=${SPEED_REPLAY:-18942}
mkdir -p /tmp/v4-fw /tmp/v4-fw-ext

if [[ $1 != replay ]]; then
	if [[ ! -d /tmp/v4-fw/arena/.git ]]; then
		rm -rf /tmp/v4-fw/arena
		cp -R $ADEMARK/arena /tmp/v4-fw/arena
		git -C /tmp/v4-fw/arena init -q -b main
		git -C /tmp/v4-fw/arena add -A
		git -C /tmp/v4-fw/arena -c user.name=bench -c user.email=bench@localhost commit -q -m arena
	fi
fi

pkill -f "replay/server.ts --port $PORT" || true
nohup bun $ADEMARK/bench/replay/server.ts --port $PORT --sessions $ADEMARK/bench/replay/sessions --log /tmp/v4-fw/replay.jsonl > /tmp/v4-fw/replay.out 2>&1 &
for i in {1..50}; do
	curl -sf http://127.0.0.1:$PORT/_ademark/health > /dev/null && { echo "replay up on $PORT"; exit 0; }
	sleep 0.2
done
echo "replay server did not start" >&2
cat /tmp/v4-fw/replay.out >&2
exit 1
