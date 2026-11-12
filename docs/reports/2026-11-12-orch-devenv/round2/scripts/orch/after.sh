#!/bin/bash
# The after-fix runs, interleaved: the 6-subtask challenge, a team and a council, N times.
# after.sh <n>; rows go to ../../data/orch/{chal,team,council}.jsonl and chal-checks.jsonl.
S=$(cd $(dirname $0) && pwd); D=$S/../../data/orch; N=${1:-3}
for i in $(seq 1 $N); do
	tag=r2c$i-$(date +%H%M%S)
	$S/chalsetup.sh $tag > /dev/null
	node $S/b1run.mjs 9942 /tmp/v2-orch-ud $S/chal-prompt.txt $tag --log $D/chal.jsonl --timeout 900 > /dev/null || echo "chal $tag failed"
	echo "{\"tag\":\"$tag\",\"check\":$($S/chalcheck.sh $tag)}" >> $D/chal-checks.jsonl
	node $S/b1run.mjs 9942 /tmp/v2-orch-ud $S/team-prompt.txt team-$i-$(date +%H%M%S) --log $D/team.jsonl --timeout 600 > /dev/null || echo "team $i failed"
	node $S/b1run.mjs 9942 /tmp/v2-orch-ud $S/council-prompt.txt council-$i-$(date +%H%M%S) --log $D/council.jsonl --timeout 900 > /dev/null || echo "council $i failed"
done
