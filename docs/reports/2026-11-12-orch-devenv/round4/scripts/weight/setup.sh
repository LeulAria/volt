#!/bin/zsh
# Recreates the speed rig's /tmp state after a reboot:
#   /tmp/v4-weight/arena   a git checkout of ADEMark's arena (the project the test window opens)
#   replay server         ADEMark's own bench/replay/server.ts on 127.0.0.1:18946, log /tmp/v4-weight/replay.jsonl
#   ~/.volt-r3/speed/native/bin/ademark-native   ADEMark's sampler, built from a private copy of bench/native
# ADEMark itself lives at ~/.volt-r3/ademark (/tmp/ademark links to it).
#   ./setup.sh            arena + native helper + replay server (idempotent)
#   ./setup.sh replay     (re)start only the replay server
set -e
ADEMARK=${ADEMARK:-$HOME/.volt-r4/ademark}
PORT=${SPEED_REPLAY:-18946}
mkdir -p /tmp/v4-weight /tmp/v4-weight-ext

if [[ $1 != replay ]]; then
	if [[ ! -d /tmp/v4-weight/arena/.git ]]; then
		rm -rf /tmp/v4-weight/arena
		cp -R $ADEMARK/arena /tmp/v4-weight/arena
		git -C /tmp/v4-weight/arena init -q -b main
		git -C /tmp/v4-weight/arena add -A
		git -C /tmp/v4-weight/arena -c user.name=bench -c user.email=bench@localhost commit -q -m arena
	fi
	if [[ ! -x $HOME/.volt-r3/speed/native/bin/ademark-native ]]; then
		mkdir -p $HOME/.volt-r3/speed
		rsync -a --exclude .build --exclude bin $ADEMARK/bench/native/ $HOME/.volt-r3/speed/native/
		$HOME/.volt-r3/speed/native/build.sh
	fi
fi

pkill -f "replay/server.ts --port $PORT" || true
nohup bun $ADEMARK/bench/replay/server.ts --port $PORT --sessions $ADEMARK/bench/replay/sessions --log /tmp/v4-weight/replay.jsonl > /tmp/v4-weight/replay.out 2>&1 &
for i in {1..50}; do
	curl -sf http://127.0.0.1:$PORT/_ademark/health > /dev/null && { echo "replay up on $PORT"; exit 0; }
	sleep 0.2
done
echo "replay server did not start" >&2
cat /tmp/v4-weight/replay.out >&2
exit 1
