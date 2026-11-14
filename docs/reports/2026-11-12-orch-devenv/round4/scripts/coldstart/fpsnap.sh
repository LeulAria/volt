#!/bin/zsh
# usage: fpsnap.sh <arm> <profile-name> <n> <out.jsonl>
# A/B of a stored window snapshot's content on one build: before each relaunch the snapshot file is replaced by
# ~/.volt-r4/coldstart/data/snap-<profile>-{orig,trim}.json (the order alternates per rep), then fp2.mjs measures.
# Waits for the 1-minute load to be <= ADE_LOAD_MAX (default 14) before each launch.
cd /Users/leularia/Desktop/VOLT/volt-e4-coldstart/docs/reports/2026-11-12-orch-devenv/round4/scripts/coldstart
ARM=$1; P=$2; N=$3; OUT=$4; MAX=${ADE_LOAD_MAX:-14}
F=/tmp/v4-cold-ud-$P/VoltWindowSnapshots/10f205f1260300b48688da5f.json
D=~/.volt-r4/coldstart/data
load1() { uptime | sed -E 's/.*load averages?: ([0-9.]+).*/\1/' }
for i in $(seq 1 $N); do
  order=$([ $((i % 2)) = 1 ] && echo "orig trim" || echo "trim orig")
  for v in ${=order}; do
    bun run.ts --app $ARM --quit >/dev/null 2>&1
    cp $D/snap-$P-$v.json $F
    sleep 2
    w=0; while (( $(load1) > MAX )) && (( w < 1800 )); do sleep 10; w=$((w + 10)); done
    node fp2.mjs $ARM $OUT $v | cut -c1-260
  done
done
bun run.ts --app $ARM --quit >/dev/null 2>&1
