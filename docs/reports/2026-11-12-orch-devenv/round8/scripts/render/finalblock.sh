#!/bin/zsh
# Final rows (ADEMark method, unofficial), arms interleaved, one round per hold of ~/.volt-r8/timing.lock (~18 min
# for two arms): per arm a fresh profile with 5 seeded threads, A5 (relaunch, 90 s settle, 60 s at 4 Hz), then A7
# as a7block.sh takes it (fresh profile, relaunch, 30 s, five replay streams 180 s at 4 Hz). Rows: a5.jsonl, a7.jsonl.
#   ARMS='r7 r8' ./finalblock.sh [rounds=3]
cd ${0:A:h}
LOCK=$HOME/.volt-r8/timing.lock
trap 'grep -qs "pid $$ " $LOCK/owner && rm -rf $LOCK' EXIT
for i in $(seq 1 ${1:-3}); do
	until mkdir $LOCK 2>/dev/null; do sleep 20; done
	echo "render finalblock round $i pid $$ start $(date)" > $LOCK/owner
	for arm in ${=ARMS:-r7 r8}; do
		./stopall.sh
		source ./arm.sh $arm
		echo "== a5 $arm round $i $(date -u +%FT%TZ) load $(uptime | sed 's/.*averages: //')"
		./prep.sh $arm 5 > /dev/null 2>&1 || { echo "prep failed"; node launch.mjs stop >/dev/null; continue; }
		./a5run.sh $arm 90 launch | tail -3
		node launch.mjs stop >/dev/null
		echo "== a7 $arm round $i $(date -u +%FT%TZ) load $(uptime | sed 's/.*averages: //')"
		./prep.sh $arm 5 > /dev/null 2>&1 || { echo "prep failed"; node launch.mjs stop >/dev/null; continue; }
		node launch.mjs stop >/dev/null
		node launch.mjs >/dev/null || { echo "launch failed"; node launch.mjs stop >/dev/null; continue; }
		sleep 30
		node a7.mjs $arm | tail -1 | cut -c1-160
		node launch.mjs stop >/dev/null
	done
	rm -rf $LOCK
done
echo "== finalblock done $(date -u +%FT%TZ)"
