#!/bin/bash
# First-request prompt of a headless Claude Code (the SDK's bundled CLI, the one Volt's ACP adapter
# runs) per configuration, through capproxy.mjs on 9944: cliprobe.sh <label> [cli flags...]
F=~/.npm/_npx/698eb38f5d7f5a61/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude
OUT=/tmp/v2-orch-cap/probe; mkdir -p $OUT
label=$1; shift
start=$(node -e "console.log(Date.now())")
cd /tmp/voltbench/fx && echo "Read src/pricing.ts. Name the function with a bug in one line. Do not edit files." | ENABLE_TOOL_SEARCH=true ANTHROPIC_BASE_URL=http://127.0.0.1:9944 $F -p --model claude-haiku-5-5 "$@" > /tmp/v2-orch-cap/probe-$label.out 2>&1
f=$(ls $OUT/*.req.json | while read x; do ts=$(basename $x | cut -d- -f2 | cut -d. -f1); [ "$ts" -ge "$start" ] || continue; node -e 'const r=require(process.argv[1]);process.exit((r.tools||[]).length>0?0:1)' $x && echo $x && break; done)
node $(dirname $0)/breakdown.mjs $f --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);const k=j.total/j.chars;const g=Object.fromEntries(Object.entries(j.groups).map(([n,v])=>[n,Math.round(v.chars*k)]));console.log(JSON.stringify({label:process.argv[1],total:j.total,groups:g}))})' $label
