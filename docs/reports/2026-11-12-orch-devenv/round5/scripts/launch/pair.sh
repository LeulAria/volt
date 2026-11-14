#!/bin/zsh
# usage: pair.sh <outdir> <n> <test> <arm>...   interleave arms rep by rep (quitting the others first: they share CDP 9974).
# Takes ~/.volt-r5/timing.lock for at most 20 minutes at a time, then lets others in for a minute.
# Each launch waits for the 1-minute load to be <= 14 (run.ts); its row records the load.
cd ${0:A:h}
OUT=$1; N=$2; T=$3; shift 3; ARMS=($@)
LOCK=~/.volt-r5/timing.lock
take() { until mkdir $LOCK 2>/dev/null; do sleep 20; done; echo "launch pair.sh pid $$ start $(date)" > $LOCK/owner; LT=$(date +%s); }
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
