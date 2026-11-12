#!/bin/bash
# Round-2 restart runs, in order: the B1 A/B pairs 2-3, three natural delegate_task requests
# (does Claude's first call arrive empty?), two default-seat councils, then after.sh <n>.
S=$(cd $(dirname $0) && pwd); D=$S/../../data/orch
for i in 2 3; do
	for arm in base new; do
		$S/arm.sh $arm || exit 1
		node $S/b1run.mjs 9942 /tmp/v2-orch-ud $S/b1-prompt.txt b1ab-$arm-$i --log $D/b1ab.jsonl > /dev/null || echo "run b1ab-$arm-$i failed"
	done
done
for i in 1 2 3; do node $S/b1run.mjs 9942 /tmp/v2-orch-ud $S/natural-delegate-prompt.txt natural-$i-$(date +%H%M%S) --log $D/natural.jsonl --timeout 300 > /dev/null || echo "natural $i failed"; done
for i in 1 2; do node $S/b1run.mjs 9942 /tmp/v2-orch-ud $S/council-default-prompt.txt cdef-$i-$(date +%H%M%S) --log $D/council-default.jsonl --timeout 600 > /dev/null || echo "council default $i failed"; done
$S/after.sh ${1:-3}
echo ALLDONE
