#!/bin/zsh
# The follow-up cost of the 20 s agent stop, in one hold of ~/.volt-r9/timing.lock (about 4 min per arm and round):
# per arm, a fresh 5-thread profile, then `followup.mjs` with a 30 s idle (past the 20 s stop) at gap 400 ms (click,
# type, Enter: the warm-up's head start) and gap 0 (no head start); FUBLOCK_READER=1 adds gap 0 with the pointer
# moving over the reply during the idle (reading); arms interleaved `rounds` times.
#   ./fublock.sh "<arm> <arm> ..." [rounds=2] [reps=2]      rows -> ../../data/rest/followup.jsonl
cd ${0:A:h}
ARMS=(${=1}); ROUNDS=${2:-2}; REPS=${3:-2}
LOCK=$HOME/.volt-r9/timing.lock
until mkdir $LOCK 2>/dev/null; do sleep 20; done
echo "agents fublock pid $$ start $(date)" > $LOCK/owner
trap 'node launch.mjs stop >/dev/null 2>&1; grep -qs "pid $$ " $LOCK/owner && rm -rf $LOCK' EXIT
./stopall.sh
for round in $(seq $ROUNDS); do
	for arm in $ARMS; do
		source ./arm.sh $arm || exit 1
		echo "== fublock $arm round $round $(date -u +%FT%TZ) load $(uptime | sed 's/.*averages: //')"
		./prep.sh $arm 5 >/dev/null || { echo "prep failed"; exit 1; }
		node launch.mjs >/dev/null && sleep 20
		FOLLOWUP_GAP_MS=400 node followup.mjs $arm $REPS 30
		FOLLOWUP_GAP_MS=0 node followup.mjs $arm $REPS 30
		[[ -n $FUBLOCK_READER ]] && FOLLOWUP_READER=1 FOLLOWUP_GAP_MS=0 node followup.mjs $arm $REPS 30
		node launch.mjs stop >/dev/null
	done
done
echo "== end fublock $(date -u +%FT%TZ)"
