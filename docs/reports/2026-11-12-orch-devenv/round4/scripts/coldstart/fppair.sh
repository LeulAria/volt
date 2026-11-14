#!/bin/zsh
# usage: fppair.sh <armA> <armB> <n> <out.jsonl> [label]
# First-paint runs (fp2.mjs), alternating two arms; each launch is a relaunch (the arm is quit, its agent server stays).
# Waits for the 1-minute load to be <= ADE_LOAD_MAX (default 14) before each launch.
cd /Users/leularia/Desktop/VOLT/volt-e4-coldstart/docs/reports/2026-11-12-orch-devenv/round4/scripts/coldstart
A=$1; B=$2; N=$3; OUT=$4; L=${5:-relaunch}; MAX=${ADE_LOAD_MAX:-14}
load1() { uptime | sed -E 's/.*load averages?: ([0-9.]+).*/\1/' }
for i in $(seq 1 $N); do
  for a in $A $B; do
    o=$([ $a = $A ] && echo $B || echo $A)
    bun run.ts --app $o --quit >/dev/null 2>&1
    bun run.ts --app $a --quit >/dev/null 2>&1
    sleep 3
    w=0; while (( $(load1) > MAX )) && (( w < 1800 )); do sleep 10; w=$((w + 10)); done
    node fp2.mjs $a $OUT $L | cut -c1-400
    sleep 2
  done
done
for a in $A $B; do bun run.ts --app $a --quit >/dev/null 2>&1; done
