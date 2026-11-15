#!/bin/zsh
# Recreates the round-6 weight rig's state (all under ~/.volt-r7/agents, survives a reboot):
#   arena          a git checkout of ADEMark's arena (the project the test window opens)
#   replay server  ADEMark's own bench/replay/server.ts on 127.0.0.1:18986, log replay.jsonl
#   ~/.volt-r3/speed/native/bin/ademark-native   ADEMark's sampler, built from a private copy of bench/native
#   ./setup.sh            arena + native helper + replay server (idempotent)
#   ./setup.sh replay     (re)start only the replay server
set -e
ADEMARK=${ADEMARK:-$HOME/.volt-r4/ademark}
PORT=${SPEED_REPLAY:-18986}
W=$HOME/.volt-r7/agents
mkdir -p $W

if [[ $1 != replay ]]; then
	if [[ ! -d $W/arena/.git ]]; then
		rm -rf $W/arena
		cp -R $ADEMARK/arena $W/arena
		git -C $W/arena init -q -b main
		git -C $W/arena add -A
		git -C $W/arena -c user.name=bench -c user.email=bench@localhost commit -q -m arena
	fi
	if [[ ! -x $HOME/.volt-r3/speed/native/bin/ademark-native ]]; then
		mkdir -p $HOME/.volt-r3/speed
		rsync -a --exclude .build --exclude bin $ADEMARK/bench/native/ $HOME/.volt-r3/speed/native/
		$HOME/.volt-r3/speed/native/build.sh
	fi
fi

pkill -f "replay/server.ts --port $PORT" || true
nohup bun $ADEMARK/bench/replay/server.ts --port $PORT --sessions $ADEMARK/bench/replay/sessions --log $W/replay.jsonl > $W/replay.out 2>&1 &
echo $! > $W/replay.pid
for i in {1..50}; do
	curl -sf http://127.0.0.1:$PORT/_ademark/health > /dev/null && { echo "replay up on $PORT"; exit 0; }
	sleep 0.2
done
echo "replay server did not start" >&2
cat $W/replay.out >&2
exit 1
