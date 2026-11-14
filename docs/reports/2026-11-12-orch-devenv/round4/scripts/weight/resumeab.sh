#!/bin/zsh
# Resumed-chat first word, before/after interleaved: per round, each arm is launched on its seeded profile,
# runs resume.mjs for `reps` reps (load-gated, see resume.mjs) and is stopped.
#   ./resumeab.sh [rounds=3] [reps=1] [openWait s=3] [idle s=40]
cd ${0:A:h}
for i in $(seq 1 ${1:-3}); do
	for arm in before after; do
		# Both arms share CDP 9946: make sure neither is up (a launch that timed out leaves its instance running).
		for other in before after; do (source ./arm.sh $other; node launch.mjs stop >/dev/null); done
		source ./arm.sh $arm
		echo "== resume $arm round $i $(date -u +%FT%TZ) load $(uptime | sed 's/.*averages: //')"
		node launch.mjs || { echo "launch failed"; node launch.mjs stop >/dev/null; continue; }
		sleep 8
		node resume.mjs $arm ${2:-1} ${3:-3} ${4:-40}
		node launch.mjs stop >/dev/null
	done
done
echo "== resumeab done $(date -u +%FT%TZ)"
