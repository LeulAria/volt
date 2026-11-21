#!/bin/zsh
# usage: pair.sh <outdir> <n> <test> <arm>...   interleave arms rep by rep (quitting the others first: they share CDP 9987).
# Takes ~/.volt-r9/timing.lock for at most 20 minutes at a time, then lets others in for a minute.
# Each launch waits for the 1-minute load to be <= 14 (run.ts); its row records the load.
cd ${0:A:h}
. ../port.sh
OUT=$1; N=$2; T=$3; shift 3; ARMS=($@)
LOCK=~/.volt-r9/timing.lock
load1() { sysctl -n vm.loadavg | tr -d '{}' | awk '{print $1}'; }
# Waits for this area's instance to be free (~/.volt-r10/speed/busy) and the lock; each launch then waits for a
# 1-minute load of 14 or less (run.ts), for at most ADE_LOAD_WAIT_S.
take() { until [ ! -e ~/.volt-r10/speed/busy ] && mkdir $LOCK 2>/dev/null; do sleep 2; done; echo "speed launch pair.sh pid $$ start $(date)" > $LOCK/owner; LT=$(date +%s); }
drop() { rm -rf $LOCK; }
trap drop EXIT
take
for i in $(seq 1 $N); do
  if (( $(date +%s) - LT > 1200 )); then drop; sleep 60; take; fi
  for a in $ARMS; do
    for o in $ARMS; do [ $o = $a ] || bun run.ts --app $o --quit >/dev/null 2>&1; done
    bun run.ts --app $a --tests $T --reps 1 --start $i --out $OUT/$a >/dev/null 2>&1
    tail -1 $OUT/$a/rows.jsonl | cut -c1-300
  done
done
for a in $ARMS; do bun run.ts --app $a --quit >/dev/null 2>&1; done
