#!/bin/zsh
# Round 7 pairs: before vs after (and any extra arms given), 6 A2 then 6 A1, interleaved rep by rep (pair.sh).
# usage: pairs.sh <outdir> [arms...]   default arms: before after
OUT=$1; shift; ARMS=(${@:-before after})
cd ${0:A:h}
echo "A2 start $(date)"; ./pair.sh $OUT 6 A2 $ARMS
echo "A1 start $(date)"; ./pair.sh $OUT 6 A1 $ARMS
echo "PAIRS DONE $(date)"
