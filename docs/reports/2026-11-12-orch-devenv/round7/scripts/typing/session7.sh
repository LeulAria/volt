#!/bin/zsh
# One timed session under ~/.volt-r7/timing.lock (at most 25 minutes): waits for a 1-minute load of 14 or less and a
# free lock, runs one batch, frees the lock. Each launch inside also waits for the load gate (rows record the load).
#   session7.sh a8   A8 on the release builds, ABBA: minbase, minafter, minafter, minbase, minbase, minafter
#   session7.sh ab   A3 (6 runs) and A4 (6 runs) per launch, 2 launches per arm, interleaved
cd "$(dirname "$0")"
export PATH="$HOME/.nvm/versions/node/v22.19.0/bin:$PATH"
unset ELECTRON_RUN_AS_NODE
LOCK=$HOME/.volt-r7/timing.lock
load1() { sysctl -n vm.loadavg | tr -d '{}' | awk '{print $1}'; }
while true; do
	if [ "$(echo "$(load1) <= 14" | bc)" = 1 ] && mkdir "$LOCK" 2>/dev/null; then
		echo "typing session7.sh $1 pid $$ start $(date)" > "$LOCK/owner"
		break
	fi
	sleep 3
done
trap 'rm -rf "$LOCK"' EXIT
echo "== lock taken $(date) load $(load1)"
case "$1" in
	a8) node a8.mjs 1 minbase,minafter,minafter,minbase,minbase,minafter ;;
	ab) node ab.mjs minbase,minafter 2 6 6 ;;
esac
echo "== done $(date) load $(load1)"
