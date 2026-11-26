#!/bin/zsh
# Round 10: one untimed A7 on an arm with the footprint categories of every process 150 s into the streams
# (fpsnap.mjs: V8 heap, malloc, code, per process). No timing lock: a breakdown, not a row (the A7 row it writes has
# arm <arm>x and is left out of every table).
#   ./fprun.sh <arm> [app path]      -> ~/.volt-r9/procs/fp-<arm>-<time>.txt
cd ${0:A:h}
ARM=${1}x
case $1 in r8) export R8_APP=$HOME/.volt-r8/min/r8/VOLT.app ;; dev) export R8_APP= ;; *) export R8_APP=$2 ;; esac
[[ $1 == dev ]] && ARM=dev
source ./arm.sh $ARM || exit 1
./prep.sh $ARM 5 || { echo "prep failed"; exit 1; }
node launch.mjs stop >/dev/null
node launch.mjs && sleep 30
OUT=$HOME/.volt-r9/procs/fp-$ARM-$(date +%H%M).txt
(sleep 165; node fpsnap.mjs $OUT 12 >/dev/null 2>&1) &
WEIGHT_LOAD_WAIT_S=0 node a7.mjs $ARM | cut -c1-600
wait
node launch.mjs stop >/dev/null
echo "== done $OUT"
