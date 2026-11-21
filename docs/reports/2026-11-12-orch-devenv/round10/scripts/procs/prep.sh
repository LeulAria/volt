#!/bin/zsh
# Fresh seeded state for one arm: wipe the profile, launch, pick the arena project, seed n threads, quit.
#   ./prep.sh before|after [n=5]
# Round 9: seed.mjs fails when the chat's model is not Claude (Claude's catalog fetch failed at launch): one retry.
cd ${0:A:h}
source ./arm.sh $1
for attempt in 1 2; do
	node launch.mjs stop >/dev/null
	rm -rf $SPEED_UD $SPEED_UD.log
	node launch.mjs && sleep 5 && node pickproject.mjs && node seed.mjs ${2:-5} && exit 0
	echo "prep attempt $attempt failed"
done
exit 1
