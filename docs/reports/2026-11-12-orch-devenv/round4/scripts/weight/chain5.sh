#!/bin/zsh
# After chain4.sh: first word of the first prompt after a launch, new thread and restored chat, before/after
# interleaved, 3 reps (check that b98ab46593a's deferred prewarm does not slow the first prompt).
cd ${0:A:h}
while kill -0 $(cat ~/.volt-r4/weight/chain4.pid) 2>/dev/null; do sleep 15; done
for rep in 1 2 3; do
	for variant in new restored; do
		for arm in before after; do
			for other in before after; do (source ./arm.sh $other; node launch.mjs stop >/dev/null); done
			(source ./arm.sh $arm; echo "== firstlaunch $arm $variant rep $rep $(date -u +%FT%TZ) load $(uptime | sed 's/.*averages: //')"; node firstlaunch.mjs $arm $variant 15 || node launch.mjs stop >/dev/null)
		done
	done
done
echo "== chain5 done $(date -u +%FT%TZ)"
