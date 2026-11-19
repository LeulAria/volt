#!/bin/zsh
# One timed session under ~/.volt-r7/timing.lock (at most 25 min): waits for a 1-minute load of 14 or less and a free
# lock, then runs `node a6-batch.mjs 1 <arms>` and `node a8.mjs <a8reps> <a8arms>` (each gates on the load again),
# and frees the lock. Rows go to data/typing/a6.jsonl and a8.jsonl.
#   ./session.sh [a6arms=before,after] [a8reps=2] [a8arms=] [a6reps=1]   (a8arms empty: before/after ABBA;
#   a8arms given: that order, once per a8rep; a6arms "-" or a8reps 0 skips that test)
cd "$(dirname "$0")"
A6ARMS=${1:-before,after}
A8REPS=${2:-2}
A8ARMS=${3:-}
A6REPS=${4:-1}
LOCK=$HOME/.volt-r7/timing.lock
load1() { sysctl -n vm.loadavg | tr -d '{}' | awk '{print $1}'; }
while true; do
	if [ "$(echo "$(load1) <= 14" | bc)" = 1 ] && mkdir "$LOCK" 2>/dev/null; then
		echo "idle session.sh pid $$ start $(date)" > "$LOCK/owner"
		break
	fi
	# Every 3 s, as the other areas' lock waiters poll (at 20 s this one never won the lock).
	sleep 3
done
trap 'rm -rf "$LOCK"' EXIT
echo "== lock taken $(date) load $(load1)"
if [ "$A6ARMS" != "-" ]; then node a6-batch.mjs "$A6REPS" "$A6ARMS"; fi
if [ "$A8REPS" != "0" ]; then node a8.mjs "$A8REPS" $A8ARMS; fi
echo "== done $(date) load $(load1)"
