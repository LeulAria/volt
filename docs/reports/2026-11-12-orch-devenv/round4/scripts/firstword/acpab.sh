#!/bin/zsh
# Interleaved variants of acpbench.mjs: one rep of each variant per round, order rotated each round.
#   ./acpab.sh <rounds> <tag> "<label>:<flags>" ...   e.g. ./acpab.sh 4 v1 "base:" "noair:noair" "probe0:probe0"
here=${0:A:h}; rounds=$1; tag=$2; shift 2
variants=("$@")
for r in $(seq 1 $rounds); do
  n=${#variants[@]}
  for i in $(seq 0 $((n-1))); do
    v=${variants[$(( (i + r) % n + 1 ))]}
    label=${v%%:*}; flags=${v#*:}
    node $here/acpbench.mjs "$tag-$label" 1 ${=flags//,/ } warm=${WARM:-5000} | head -1
  done
done
