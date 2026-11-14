#!/bin/zsh
# The rest of round 4's weight runs, one after another (one instance at a time): 2 more rounds of the resumed-chat
# A/B, then one A7 pair, then one A5/A9/A10 block pair. Each step first waits (at most 20 min) for a 1-minute load
# under 40, so launches do not time out.
cd ${0:A:h}
calm() {
	local until=$(( $(date +%s) + 1200 ))
	while (( $(uptime | sed 's/.*averages: //' | cut -d' ' -f1 | cut -d. -f1) >= 40 && $(date +%s) < until )); do sleep 10; done
}
calm; ./resumeab.sh 2 1 3 40
calm; ./a7block.sh 1
calm; ./blocks.sh 1
echo "== chain done $(date -u +%FT%TZ)"
