#!/bin/zsh
# One timed session under ~/.volt-r9/timing.lock (at most 25 minutes): waits for a 1-minute load of 14 or less and a
# free lock, runs the steps given, frees the lock. Each launch inside also waits for the load gate (rows record it).
#   session9.sh a8 <arm,arm,...>      A8 once per arm in that order (arms: after r8 r9, or name=/path/VOLT.app)
#   session9.sh t3 [reps]            the same measure on T3 Code (t3a8.mjs)
#   session9.sh paseo [reps]         the same measure on Paseo (paseoa8.mjs)
#   session9.sh ab <arm,arm> [reps] [n3] [n4]   A3 and A4 per launch, interleaved (ab.mjs)
#   session9.sh exp <arm> <keys> <variants>      the switch-off experiment (exp.mjs)
#   session9.sh cast <arm,arm,...>   a screencast of one streaming reply per arm (cast.mjs)
#   session9.sh inject <arm> <keys> <variants>   busy waits / frame loops in an idle composer (inject.mjs)
# Steps chain: session9.sh a8 r8 t3 1 paseo 1 a8 r8
# The rerun for a given app: session9.sh a8 r8,new=/path/VOLT.app t3 1 paseo 1 a8 new=/path/VOLT.app,r8 ...
cd "$(dirname "$0")"
export PATH="$HOME/.nvm/versions/node/v22.19.0/bin:$PATH"
unset ELECTRON_RUN_AS_NODE
LOCK=$HOME/.volt-r9/timing.lock
load1() { sysctl -n vm.loadavg | tr -d '{}' | awk '{print $1}'; }
while true; do
	if [ "$(echo "$(load1) <= 14" | bc)" = 1 ] && mkdir "$LOCK" 2>/dev/null; then
		echo "typing session9.sh $* pid $$ start $(date)" > "$LOCK/owner"
		break
	fi
	sleep 0.5
done
trap 'rm -rf "$LOCK"' EXIT
echo "== lock taken $(date) load $(load1)"
while [ $# -gt 0 ]; do
	case "$1" in
		a8) node a8.mjs 1 "$2"; shift 2 ;;
		t3) node t3a8.mjs "${2:-1}"; shift; [ $# -gt 0 ] && shift ;;
		paseo) node paseoa8.mjs "${2:-1}"; shift; [ $# -gt 0 ] && shift ;;
		ab) node ab.mjs "$2" "${3:-2}" "${4:-6}" "${5:-6}"; shift $# ;;
		exp) node exp.mjs "$2" "$3" "$4"; shift 4 ;;
		cast) node cast.mjs "$2"; shift 2 ;;
		inject) node ctl.mjs launch "$2" --keep && sleep 8 && node inject.mjs "$3" "$4"; node ctl.mjs stop "$2"; shift 4 ;;
		*) echo "unknown step $1"; exit 2 ;;
	esac
done
echo "== done $(date) load $(load1)"
