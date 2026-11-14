#!/bin/zsh
# Interleaved A/B of test scripts between two checkouts on the same profile.
#   ./ab.sh <script.mjs>[,<script2.mjs>...] <runs per launch> <rounds> <armA>=<checkoutA> <armB>=<checkoutB> [settle s]
# Several scripts run one after another on the same launch (a4.mjs,a3.mjs: A3 starts from A4's last thread).
# ROTATE=1: arm order alternates per round (A B, B A, ...); default A B every round.
# LOAD_MAX=<n>: each launch waits, with no instance open, until the 1-minute load is at most n.
here=${0:A:h}
script=$1; runs=$2; rounds=$3; a=$4; b=$5; settle=${6:-20}
for r in $(seq 1 $rounds); do
  arms=($a $b)
  if [[ -n $ROTATE && $ROTATE != 0 ]] && (( r % 2 == 0 )); then arms=($b $a); fi
  for arm in $arms; do
    name=${arm%%=*}; co=${arm#*=}
    node $here/launch.mjs stop
    if [[ -n $LOAD_MAX && $LOAD_MAX != 0 ]]; then
      while (( $(uptime | sed 's/.*averages*: *//' | cut -d' ' -f1) > LOAD_MAX )); do sleep 20; done
    fi
    SPEED_CHECKOUT=$co node $here/launch.mjs
    sleep $settle
    for s in ${(s:,:)script}; do
      SPEED_CHECKOUT=$co node $here/$s $name $runs
    done
  done
done
node $here/launch.mjs stop
