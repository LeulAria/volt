#!/bin/bash
# One side of an interleaved A/B round: switch out/ to `side` (ab.sh), wait for the window, then run
# every long-thread bench once, each only when the 1-minute load is at or below $MAXLOAD.
#   suite.sh base|new <round> [tests]
# tests (default all): warm cold open75k earlier home a11open stutter idle reasoning send
# `earlier` runs before `home`: the branch's Home draws the whole 45k chat, which left `earlier`
# nothing to draw when it ran second (round 1).
set -e
SIDE=$1
ROUND=$2
TESTS=${3:-"warm cold open75k earlier home a11open stutter idle reasoning send"}
MAXLOAD=${MAXLOAD:-14}
HERE=$(cd "$(dirname "$0")" && pwd)
DATA=${DATA:-$HERE/../../data/thread/ab}
mkdir -p "$DATA"
cd "$HERE"

waitload() {
	while :; do
		l=$(uptime | sed -E 's/.*load averages?: ([0-9.]+).*/\1/')
		if awk "BEGIN{exit !($l <= $MAXLOAD)}"; then return; fi
		echo "load $l > $MAXLOAD, waiting"
		sleep 30
	done
}

if [ "${SKIP_SWITCH:-0}" != 1 ]; then
	./ab.sh "$SIDE"
fi
# The cold copies are cold again only after the server restarts (ab.sh restarts it).
node ready.mjs --idle 10000
out() { echo "$DATA/$SIDE-r$ROUND-$1.json"; }
for t in $TESTS; do
	waitload
	echo "== $SIDE r$ROUND $t"
	case $t in
		warm) node open-bench.mjs --runs 3 --out "$(out warm)" ;;
		cold) node open-bench.mjs --copies --runs 5 --out "$(out cold)" ;;
		home) node scroll-bench.mjs --chat "Long thread 45k" --top "Turn 1: keep reading the modules (long45k)" --runs 3 --out "$(out home)" ;;
		earlier) node scroll-bench.mjs --mode earlier --chat "Long thread 45k" --runs 2 --out "$(out earlier)" ;;
		idle) node idle-cpu.mjs --chat "Long thread 45k" --drawall --runs 3 --out "$(out idle)" ;;
		open75k) node open-bench.mjs --chat "Long thread 75k|Turn 1: keep reading the modules" --marker LAST --session agent-bench-long75k --runs 3 --out "$(out open75k)" ;;
		a11open) node open-bench.mjs --chat "Long thread A11 (seeded)" --marker "LONGTHREAD-END a11" --runs 3 --out "$(out a11open)" ;;
		stutter) node scroll-bench.mjs --mode stutter --chat "Long thread A11 (seeded)" --runs 5 --out "$(out stutter)" ;;
		reasoning) node reasoning-bench.mjs --runs 3 --out "$(out reasoning)" ;;
		# Live turns (Haiku 5.5), two per side and round.
		send) node pick-model.mjs > /dev/null && node send-bench.mjs --runs 2 --out "$(out send)" ;;
	esac
done
