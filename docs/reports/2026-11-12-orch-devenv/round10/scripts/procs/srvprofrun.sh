#!/bin/zsh
# Round 10: one untimed A7 on the dev build with the agent server's allocation profile (srvprof.mjs). No timing lock:
# a memory breakdown, not a row (the A7 row it writes has arm dev-yg-insp and is left out of every table).
#   ./srvprofrun.sh [snapshot path]      log -> ~/.volt-r9/procs/srvprof-<time>.log
cd ${0:A:h}
source ./arm.sh dev-yg-insp || exit 1
./prep.sh dev-yg-insp 5 || { echo "prep failed"; exit 1; }
node launch.mjs stop >/dev/null
WEIGHT_EXTRA_ARGS="--inspect=9241" node launch.mjs && sleep 30
LOG=$HOME/.volt-r9/procs/srvprof-$(date +%H%M).log
SRVPROF_SNAP0=${1:+${1%.heapsnapshot}-0.heapsnapshot} node srvprof.mjs 215 $1 > $LOG 2>&1 &
# The main process too (its inspector on 9241): what it allocates while the chats stream.
node srvprof.mjs 215 '' 9241 > ${LOG%.log}-main.log 2>&1 &
WEIGHT_LOAD_WAIT_S=0 node a7.mjs dev-yg-insp | cut -c1-300
wait
node fpsnap.mjs > ${LOG%.log}-fp.txt 2>&1
node launch.mjs stop >/dev/null
./ygflag.sh on
echo "== done $LOG"
