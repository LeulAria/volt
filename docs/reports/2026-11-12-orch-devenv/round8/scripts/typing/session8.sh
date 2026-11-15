#!/bin/zsh
# One timed session under ~/.volt-r8/timing.lock (at most 25 minutes): waits for a 1-minute load of 14 or less and a
# free lock, runs the steps given, frees the lock. Each launch inside also waits for the load gate (rows record it).
#   session8.sh a8 <arm,arm,...>      A8 once per arm in that order (arms: before after base r7 r8, or name=/path/VOLT.app)
#   session8.sh t3 [reps]            the same measure on T3 Code (t3a8.mjs)
#   session8.sh ab <arm,arm> [reps] [n3] [n4]   A3 and A4 per launch, interleaved (ab.mjs)
#   session8.sh exp <arm> <keys> <variants>      the switch-off experiment (exp.mjs)
# Steps chain: session8.sh a8 base,r7 t3 1 a8 r7,base
# The rerun for a given app: session8.sh a8 base,new=/path/VOLT.app,new=/path/VOLT.app,base
cd "$(dirname "$0")"
export PATH="$HOME/.nvm/versions/node/v22.19.0/bin:$PATH"
unset ELECTRON_RUN_AS_NODE
LOCK=$HOME/.volt-r8/timing.lock
load1() { sysctl -n vm.loadavg | tr -d '{}' | awk '{print $1}'; }
while true; do
	if [ "$(echo "$(load1) <= 14" | bc)" = 1 ] && mkdir "$LOCK" 2>/dev/null; then
		echo "typing session8.sh $* pid $$ start $(date)" > "$LOCK/owner"
		break
	fi
	sleep 3
done
trap 'rm -rf "$LOCK"' EXIT
echo "== lock taken $(date) load $(load1)"
while [ $# -gt 0 ]; do
	case "$1" in
		a8) node a8.mjs 1 "$2"; shift 2 ;;
		t3) node t3a8.mjs "${2:-1}"; shift; [ $# -gt 0 ] && shift ;;
		ab) node ab.mjs "$2" "${3:-2}" "${4:-6}" "${5:-6}"; shift $# ;;
		exp) node exp.mjs "$2" "$3" "$4"; shift 4 ;;
		*) echo "unknown step $1"; exit 2 ;;
	esac
done
echo "== done $(date) load $(load1)"
