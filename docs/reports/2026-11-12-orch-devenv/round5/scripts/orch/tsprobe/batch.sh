#!/bin/zsh
# Interleaved ToolSearch probe: base (volt-e5-base out/) and after (this tree's out/), N reps each, 2 pairs at a time.
# usage: batch.sh <from> <to>
here=${0:a:h}
for i in $(seq $1 2 $2); do
  for j in $i $((i+1)); do
    node $here/run.mjs base /Users/leularia/Desktop/VOLT/volt-e5-base/out $j &
    node $here/run.mjs after /Users/leularia/Desktop/VOLT/volt-e5-orch/out $j &
  done
  wait
done
