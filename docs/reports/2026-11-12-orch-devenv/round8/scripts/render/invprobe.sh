#!/bin/zsh
# Exploratory: what invalidates paint while A7's streams run. Launches the arm, starts a7.mjs (scratch rows), and
# DELAY s after its start records invtrace.mjs for SECS s, then the composited layers.
#   ./invprobe.sh <arm> <label> [delay after streams show=10] [secs=2]   (INV_TOOL=rastertrace.mjs, INV_EXTRA_ARGS=...)
cd ${0:A:h}
source ./arm.sh $1
OUT=$HOME/.volt-r8/render/probe
node launch.mjs stop >/dev/null
WEIGHT_EXTRA_ARGS="$INV_EXTRA_ARGS" node launch.mjs >/dev/null || exit 1
sleep 20
WEIGHT_MAX_LOAD=999 SPEED_DATA=$HOME/.volt-r8/render/scratch A7_WINDOW_S=60 node a7.mjs probe-$2 > $OUT/$2-a7.log 2>&1 &
# Wait for thread 1 in front with its reply streaming (fresh-text fades on screen), then DELAY s more.
for i in $(seq 1 120); do sleep 2; [[ $(node ev.mjs 'document.querySelectorAll(".volt-agent-fresh-text").length' 2>/dev/null) -gt 0 ]] && [[ $(node ev.mjs '[...document.querySelectorAll(".monaco-list-row")].filter(e => e.offsetParent && /Replay/i.test(e.getAttribute("aria-label") || "")).length' 2>/dev/null) -ge 5 ]] && break; done
sleep ${3:-10}
node ${INV_TOOL:-invtrace.mjs} ${4:-2} > $OUT/$2-inv.txt 2>&1
node layers.mjs 50000 >> $OUT/$2-inv.txt 2>&1
wait
node launch.mjs stop >/dev/null
cat $OUT/$2-inv.txt
