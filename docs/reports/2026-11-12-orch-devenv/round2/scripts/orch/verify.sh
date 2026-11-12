#!/bin/bash
# After the code-tool permission and subagent-count fixes: one council (does the Grok seat answer?)
# and one B1 run with countwatch.mjs sampling the three counts. Rows go to ../../data/orch/verify-*.
S=$(cd $(dirname $0) && pwd); D=$S/../../data/orch
for i in $(seq 1 40); do node /tmp/voltbench/cdp.mjs 9942 eval '!!document.querySelector("[aria-label=\\"New Agent\\"]")' 2>/dev/null | grep -q true && break; sleep 2; done
sleep 15
node $S/b1run.mjs 9942 /tmp/v2-orch-ud $S/council-prompt.txt verify-council-$(date +%H%M%S) --log $D/verify-council.jsonl --timeout 900 > /dev/null || echo "council failed"
node $S/countwatch.mjs 9942 150 > $D/verify-counts.jsonl &
node $S/b1run.mjs 9942 /tmp/v2-orch-ud $S/b1-prompt.txt verify-b1-$(date +%H%M%S) --log $D/verify-b1.jsonl > /dev/null || echo "b1 failed"
wait
echo VERIFYDONE
