#!/bin/zsh
# Check for ad7f75e0f14 (restored chat warms a 30 s spare at launch): first word of the first prompt after a launch,
# restored chat and new thread after a 15 s rest, and the restored chat after a 45 s rest (past the 30 s), before/after
# interleaved, 3 reps; then A5 before/after x2 (memory at rest must stay down).
cd ${0:A:h}
for rep in 1 2 3; do
	for spec in restored:15 new:15 restored:45; do
		for arm in before after; do
			for other in before after; do (source ./arm.sh $other; node launch.mjs stop >/dev/null); done
			(source ./arm.sh $arm; echo "== firstlaunch $arm ${spec%:*} rest ${spec#*:} rep $rep $(date -u +%FT%TZ) load $(uptime | sed 's/.*averages: //')"; node firstlaunch.mjs $arm ${spec%:*} ${spec#*:} || node launch.mjs stop >/dev/null)
		done
	done
done
for rep in 1 2; do
	for arm in before after; do
		for other in before after; do (source ./arm.sh $other; node launch.mjs stop >/dev/null); done
		echo "== a5 $arm rep $rep $(date -u +%FT%TZ) load $(uptime | sed 's/.*averages: //')"
		./a5run.sh $arm 90 launch | head -3
	done
done
for other in before after; do (source ./arm.sh $other; node launch.mjs stop >/dev/null); done
echo "== chain6 done $(date -u +%FT%TZ)"
