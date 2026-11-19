#!/bin/zsh
# One timed A5+A6 session under ~/.volt-r7/timing.lock (at most 25 min): waits for a 1-minute load of 14 or less and a
# free lock, stops this area's own test instance if one runs, runs `node a5a6-batch.mjs <reps> <arms>` (gates on the
# load again before each rep), and frees the lock. Rows go to data/idle/a6.jsonl.
#   ./session6.sh [reps=1] [arms=before,after] [--no-seed]
cd "$(dirname "$0")"
REPS=${1:-1}
ARMS=${2:-before,after}
EXTRA=${3:-}
LOCK=$HOME/.volt-r7/timing.lock
load1() { sysctl -n vm.loadavg | tr -d '{}' | awk '{print $1}'; }
while true; do
	if [ "$(echo "$(load1) <= 14" | bc)" = 1 ] && mkdir "$LOCK" 2>/dev/null; then
		echo "idle session6.sh pid $$ start $(date)" > "$LOCK/owner"
		break
	fi
	sleep 3
done
trap 'rm -rf "$LOCK"' EXIT
echo "== lock taken $(date) load $(load1)"
for arm in ${(s:,:)ARMS}; do node ctl.mjs stop "$arm" 2>/dev/null; done
node a5a6-batch.mjs "$REPS" "$ARMS" $EXTRA
echo "== done $(date) load $(load1)"
