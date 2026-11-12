#!/bin/bash
# Interleaved A/B of one prompt: ab.sh <promptFile> <label> <n> [b1run options...]
# base, new, base, new... in the same window; rows go to ../../data/orch/<label>.jsonl.
S=$(cd $(dirname $0) && pwd); P=$1; L=$2; N=$3; shift 3
for i in $(seq 1 $N); do
	for arm in base new; do
		$S/arm.sh $arm || exit 1
		node $S/b1run.mjs 9942 /tmp/v2-orch-ud $P $L-$arm-$i --log $S/../../data/orch/$L.jsonl "$@" > /dev/null || echo "run $L-$arm-$i failed"
	done
done
$S/arm.sh new
