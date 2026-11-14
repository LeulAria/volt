#!/bin/zsh
# usage: pair.sh <armA> <armB> <n> <test> <outdir>   alternate two arms, quitting the other arm first (shared CDP port)
cd /Users/leularia/Desktop/VOLT/volt-e4-coldstart/docs/reports/2026-11-12-orch-devenv/round4/scripts/coldstart
A=$1; B=$2; N=$3; T=$4; OUT=$5
for i in $(seq 1 $N); do
  for a in $A $B; do
    o=$([ $a = $A ] && echo $B || echo $A)
    bun run.ts --app $o --quit >/dev/null 2>&1
    bun run.ts --app $a --tests $T --reps 1 --start $i --out $OUT/$a >/dev/null 2>&1
    tail -1 $OUT/$a/rows.jsonl
  done
done
for a in $A $B; do bun run.ts --app $a --quit >/dev/null 2>&1; done
