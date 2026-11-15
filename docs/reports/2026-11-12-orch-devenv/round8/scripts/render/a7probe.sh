#!/bin/zsh
# Exploratory (no data rows): what the GPU and renderer hold at A7's peak. Starts a7.mjs's five replay streams on
# the running instance (load gate off, rows to a scratch dir), and DELAY s after the first send takes the GPU's
# shared images (gputiles.mjs), the tree's footprint by role (fp.mjs) and, last, the renderer's heap by
# constructor (heapsummary.mjs, which pauses the renderer).
#   ./a7probe.sh <arm> <label> [delay s=40]
cd ${0:A:h}
source ./arm.sh $1
OUT=$HOME/.volt-r8/render/probe
mkdir -p $OUT
WEIGHT_MAX_LOAD=999 SPEED_DATA=$HOME/.volt-r8/render/scratch A7_WINDOW_S=${A7_WINDOW_S:-90} node a7.mjs probe-$2 > $OUT/$2-a7.log 2>&1 &
A7=$!
# a7.mjs opens five chats 3.5 s apart before the streams run.
sleep $(( ${3:-40} + 18 ))
echo "load $(uptime | sed 's/.*averages: //')" > $OUT/$2-peak.txt
node gputiles.mjs >> $OUT/$2-peak.txt 2>&1
node fp.mjs 3 >> $OUT/$2-peak.txt 2>&1
node allocators.mjs "" 1 >> $OUT/$2-peak.txt 2>&1
node heapsummary.mjs http://127.0.0.1:$SPEED_CDP '' 30 > $OUT/$2-heap.txt 2>&1
wait $A7
echo "done $2"
