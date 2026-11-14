#!/bin/zsh
# A7 Fight Weight (ADEMark method, unofficial), before/after interleaved: per round and arm, a fresh profile with
# 5 seeded threads (prep.sh), a relaunch, 30 s at rest, then a7.mjs (5 replay streams, 180 s at 4 Hz), stop.
#   ./a7block.sh [rounds=1]   (ARMS="minbefore min2" picks the arms; each round holds ~/.volt-r5/timing.lock)
cd ${0:A:h}
LOCK=$HOME/.volt-r5/timing.lock
trap 'grep -qs "pid $$ " $LOCK/owner && rm -rf $LOCK' EXIT
for i in $(seq 1 ${1:-1}); do
	until mkdir $LOCK 2>/dev/null; do sleep 20; done
	echo "weight a7block round $i pid $$ start $(date)" > $LOCK/owner
	for arm in ${=ARMS:-before after}; do
		# Every arm shares CDP 9976: neither may be up (a launch that timed out leaves its instance running).
		./stopall.sh
		source ./arm.sh $arm
		echo "== a7 $arm round $i $(date -u +%FT%TZ) load $(uptime | sed 's/.*averages: //')"
		./prep.sh $arm 5 || { echo "prep failed"; node launch.mjs stop >/dev/null; continue; }
		node launch.mjs stop >/dev/null
		node launch.mjs || { echo "launch failed"; node launch.mjs stop >/dev/null; continue; }
		sleep 30
		node a7.mjs $arm
		node launch.mjs stop >/dev/null
	done
	rm -rf $LOCK
done
echo "== a7block done $(date -u +%FT%TZ)"
