#!/bin/zsh
# Round 5 firstword, chain 1 (adapter level, no app): where a cold start's time goes, at load <= 14 with the timing lock.
#   initbench: spawn -> initialize, the adapter as before (plain) vs the after preload (ccvolt: compile cache), 10 rounds
#   resumebench: session/new and session/resume, prompt at once vs 2 s after the session is ready, 6 rounds interleaved
cd ${0:A:h}
source ./timing.sh
export LOAD_MAX=14
take_timing
node initbench.mjs r5-init 10 plain,ccvolt
drop_timing
for r in 1 2 3 4 5 6; do
	take_timing
	for v in "new" "new warm=2000" "resume" "resume warm=2000"; do
		node resumebench.mjs r5-cold 1 ${=v/new/}
	done
	drop_timing
done
echo "chain1 done $(date)"
