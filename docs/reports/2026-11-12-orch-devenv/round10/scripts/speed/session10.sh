#!/bin/zsh
# One timed session under ~/.volt-r9/timing.lock (at most 25 minutes): waits for the lock, runs the steps given, frees
# the lock. Each launch and each run inside waits for a 1-minute load of 14 or less (rows record the load).
#   session10.sh ab <arm,arm> [reps] [n3] [n4]        A3 and A4 per launch, interleaved, no project (a scratch chat)
#   session10.sh abp <arm,arm> [reps] [n3] [n4]       the same in the arena project (ADEMark's precondition)
# Arms: r8, dev, devbase, or name=/path/VOLT.app (a release app) / name=/path/to/dev/tree.
# The rerun for a given app: session10.sh abp r8,new=/path/VOLT.app 2 3 6
cd "$(dirname "$0")"
export PATH="$HOME/.nvm/versions/node/v22.19.0/bin:$PATH"
unset ELECTRON_RUN_AS_NODE
. ./port.sh
LOCK=$HOME/.volt-r9/timing.lock
load1() { sysctl -n vm.loadavg | tr -d '{}' | awk '{print $1}'; }
while true; do
	# A lock whose owner pid is dead is stale (the round-10 brief).
	if [ -f "$LOCK/owner" ]; then
		pid=$(sed -n 's/.*pid \([0-9]*\).*/\1/p' "$LOCK/owner")
		if [ -n "$pid" ] && ! kill -0 "$pid" 2>/dev/null; then echo "stale lock of pid $pid removed"; rm -rf "$LOCK"; fi
	fi
	# ~/.volt-r10/speed/busy: this area's own test instance is in use (one instance at a time on CDP 9987).
	if [ ! -e "$HOME/.volt-r10/speed/busy" ] && mkdir "$LOCK" 2>/dev/null; then
		echo "speed session10.sh $* pid $$ start $(date)" > "$LOCK/owner"
		break
	fi
	sleep 2
done
trap 'rm -rf "$LOCK"' EXIT
echo "== lock taken $(date) load $(load1)"
while [ $# -gt 0 ]; do
	case "$1" in
		ab) A_PROJECT=0 node ab.mjs "$2" "${3:-2}" "${4:-6}" "${5:-6}"; shift $(( $# < 5 ? $# : 5 )) ;;
		abp) A_PROJECT=1 node ab.mjs "$2" "${3:-2}" "${4:-6}" "${5:-6}"; shift $(( $# < 5 ? $# : 5 )) ;;
		*) echo "unknown step $1"; exit 2 ;;
	esac
done
echo "== done $(date) load $(load1)"
