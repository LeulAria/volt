#!/bin/zsh
# Interleaved weight blocks: ./blocks.sh <arm>...  (e.g. minbefore minafter minafter minbefore); each block takes the
# timing lock; load gates inside wait at most WEIGHT_LOAD_WAIT_S (300 here) and every row records its load.
cd ${0:A:h}
export WEIGHT_LOAD_WAIT_S=${WEIGHT_LOAD_WAIT_S:-300}
for arm in "$@"; do ./block.sh $arm; done
echo "== blocks done $(date -u +%FT%TZ)"
