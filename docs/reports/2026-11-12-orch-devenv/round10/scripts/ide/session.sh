#!/bin/sh
# One before/after session on the same dev rig:
#   session.sh <checkout> <base commit> [n]
# base arm = <checkout> with src/ of <base commit> transpiled, after arm = the checkout's HEAD.
# Each arm: bench.mjs (correctness, warm latency, tokens), cold.mjs (first call), and for the after
# arm grepcmp.mjs. Takes ~/.volt-r9/heavy.lock for transpiles and ~/.volt-r9/timing.lock for the
# runs, waiting up to WAIT_S (default 900 s) for a 1-minute load of 14 or less; past that it runs
# anyway and the load is in every result file. To bench a built app instead: bench.mjs <VOLT.app> <arm>.
set -u
here=$(cd "$(dirname "$0")" && pwd)
co=$1; base=$2; n=${3:-12}
export PATH=$HOME/.nvm/versions/node/v22.19.0/bin:$PATH
unset ELECTRON_RUN_AS_NODE
lock() { # lock <dir> <what>
	while ! mkdir "$1" 2>/dev/null; do
		pid=$(sed -n 's/.*pid \([0-9]*\).*/\1/p' "$1/owner" 2>/dev/null)
		if [ -n "$pid" ] && ! kill -0 "$pid" 2>/dev/null; then rm -rf "$1"; else sleep 10; fi
	done
	echo "ide $2 pid $$ start $(date)" > "$1/owner"
}
transpile() { lock "$HOME/.volt-r9/heavy.lock" transpile; (cd "$co" && npm run transpile-client-oxc >/dev/null 2>&1; echo "transpile exit $?"); rm -rf "$HOME/.volt-r9/heavy.lock"; }
quiet() { end=$(( $(date +%s) + ${WAIT_S:-900} )); while [ "$(sysctl -n vm.loadavg | awk '{print ($2 > 14)}')" = 1 ] && [ "$(date +%s)" -lt "$end" ]; do sleep 15; done; echo "load $(sysctl -n vm.loadavg)"; }
arm() { # arm <name>
	quiet; lock "$HOME/.volt-r9/timing.lock" "bench $1"
	node "$here/bench.mjs" "$co" "$1" --n "$n"
	node "$here/cold.mjs" "$co" "$1" --reps 3
	[ "$1" = after ] && node "$here/grepcmp.mjs" "$co" "$1"
	rm -rf "$HOME/.volt-r9/timing.lock"
}
(cd "$co" && git checkout -q "$base" -- src) && transpile && arm base
(cd "$co" && git checkout -q HEAD -- src) && transpile && arm after
(cd "$co" && git status --short | head -5)
