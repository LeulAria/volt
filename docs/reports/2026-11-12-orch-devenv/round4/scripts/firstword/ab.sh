#!/bin/zsh
# Interleaved A/B of one test script between two checkouts on the same profile.
#   ./ab.sh <script.mjs> <runs per launch> <rounds> <armA>=<checkoutA> <armB>=<checkoutB> [settle s]
# LOAD_MAX=<n>: each launch waits, with no instance open, until the 1-minute load is at most n.
here=${0:A:h}
script=$1; runs=$2; rounds=$3; a=$4; b=$5; settle=${6:-20}
for r in $(seq 1 $rounds); do
  for arm in $a $b; do
    name=${arm%%=*}; co=${arm#*=}
    node $here/launch.mjs stop
    if [[ -n $LOAD_MAX && $LOAD_MAX != 0 ]]; then
      while (( $(uptime | sed 's/.*averages*: *//' | cut -d' ' -f1) > LOAD_MAX )); do sleep 20; done
    fi
    SPEED_CHECKOUT=$co node $here/launch.mjs
    sleep $settle
    SPEED_CHECKOUT=$co node $here/$script $name $runs
  done
done
node $here/launch.mjs stop
