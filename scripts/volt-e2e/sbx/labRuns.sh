#!/bin/bash
# n reloads of the test window with Agent Lab's TEST ONLY attacks on: collects the activation, the
# attacks at start and the delayed attacks (runtime), and a self test, per run, into <out-dir>.
#   labRuns.sh <cdp-port> <extension storage folder> <out-dir> <label> [n]
PORT=$1; G=$2; OUT=$3; LABEL=$4; N=${5:-3}
HERE=$(cd "$(dirname "$0")" && pwd)
mkdir -p "$OUT"
wait_for() { for _ in $(seq 1 ${2:-120}); do [ -f "$1" ] && return 0; sleep 1; done; echo "timed out: $1" >&2; return 1; }
for i in $(seq 1 "$N"); do
	rm -f "$G"/*.json
	node "$HERE/cdp.mjs" "$PORT" palette 'Developer: Reload Window' >/dev/null
	sleep 4
	wait_for "$G/activation.json" && wait_for "$G/mockAttacks-start.json" && wait_for "$G/mockAttacks-delayed.json" 60
	node "$HERE/cdp.mjs" "$PORT" key Escape >/dev/null
	node "$HERE/cdp.mjs" "$PORT" palette 'Agent Lab: Run Self Test' >/dev/null
	wait_for "$G/selfTest.json" 90 || { node "$HERE/cdp.mjs" "$PORT" palette 'Agent Lab: Run Self Test' >/dev/null; wait_for "$G/selfTest.json" 90; }
	for f in activation mockAttacks-start mockAttacks-delayed selfTest; do cp "$G/$f.json" "$OUT/$LABEL-run$i-$f.json" 2>/dev/null; done
	echo "run $i done"
done
