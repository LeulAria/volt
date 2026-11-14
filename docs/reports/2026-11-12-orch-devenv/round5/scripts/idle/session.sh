#!/bin/zsh
# One timed session under ~/.volt-r5/timing.lock (at most 25 min): waits for a 1-minute load of 14 or less and a free
# lock, then runs `node a6-batch.mjs 1 <arms>` and `node a8.mjs <a8reps> <a8arms>` (each gates on the load again),
# and frees the lock. Rows go to data/idle/a6.jsonl and a8.jsonl.
#   ./session.sh [a6arms=before,after] [a8reps=2] [a8arms=]   (a8arms empty: before/after ABBA)
cd "$(dirname "$0")"
A6ARMS=${1:-before,after}
A8REPS=${2:-2}
A8ARMS=${3:-}
LOCK=$HOME/.volt-r5/timing.lock
load1() { sysctl -n vm.loadavg | tr -d '{}' | awk '{print $1}'; }
while true; do
	if [ "$(echo "$(load1) <= 14" | bc)" = 1 ] && mkdir "$LOCK" 2>/dev/null; then
		echo "idle session.sh pid $$ start $(date)" > "$LOCK/owner"
		break
	fi
	sleep 20
done
trap 'rm -rf "$LOCK"' EXIT
echo "== lock taken $(date) load $(load1)"
if [ "$A6ARMS" != "-" ]; then node a6-batch.mjs 1 "$A6ARMS"; fi
if [ "$A8REPS" != "0" ]; then node a8.mjs "$A8REPS" $A8ARMS; fi
echo "== done $(date) load $(load1)"
