#!/bin/zsh
# Round 10: memory A/B of dev arms without the timing lock or the load gate (for a machine that never calms down:
# rows carry their 1-minute load; a7roles.mjs 999 <arms> shows them). Per arm and round: A5 (fresh 5-thread profile,
# relaunch, 90 s settle, 60 s sample), then A7 (fresh profile, relaunch, 30 s at rest, 5 streams, 180 s).
#   ./abrun.sh "<arm> <arm> ..." [rounds=1] [parts="a5 a7"]
cd ${0:A:h}
ARMS=(${=1}); ROUNDS=${2:-1}; PARTS=${3:-a5 a7}
export WEIGHT_LOAD_WAIT_S=0
for round in $(seq $ROUNDS); do
	for arm in $ARMS; do
		./stopall.sh
		source ./arm.sh $arm || exit 1
		echo "== abrun $arm round $round ($PARTS) $(date -u +%FT%TZ) load $(uptime | sed 's/.*averages: //')"
		if [[ $PARTS == *a5* ]]; then
			./prep.sh $arm 5 >/dev/null || { echo "prep failed"; continue; }
			./a5run.sh $arm 90 launch | cut -c1-900
			node launch.mjs stop >/dev/null
		fi
		if [[ $PARTS == *a7* ]]; then
			./prep.sh $arm 5 >/dev/null || { echo "prep failed"; continue; }
			node launch.mjs stop >/dev/null
			source ./arm.sh $arm
			node launch.mjs >/dev/null && sleep 30 && node a7.mjs $arm | cut -c1-200
			node launch.mjs stop >/dev/null
		fi
	done
done
./qhflag.sh on; ./ygflag.sh on
echo "== abrun done $(date -u +%FT%TZ)"
