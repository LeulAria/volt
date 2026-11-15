#!/bin/zsh
# Checks that weight's cuts cost no first word and that the Orbit cut shows on a release build, in one hold of
# ~/.volt-r7/timing.lock (~20 min):
#   1. first word of a new thread's first prompt 120 s after launch (the T2 plugin host, started by the launch
#      warm-up, is stopped by then on builds with f55379a6fc2 and still up on builds without), interleaved, `reps` each
#   2. landingab.sh: memory at rest with the new chat's landing (Orbit) in front, one per arm
#   ./fwblock.sh <beforeArm> <afterArm> [reps=3]
cd ${0:A:h}
LOCK=$HOME/.volt-r7/timing.lock
trap 'grep -qs "pid $$ " $LOCK/owner && rm -rf $LOCK' EXIT
until mkdir $LOCK 2>/dev/null; do sleep 20; done
echo "weight fwblock pid $$ start $(date)" > $LOCK/owner
for i in $(seq 1 ${3:-3}); do
	for arm in $1 $2; do
		./stopall.sh
		(source ./arm.sh $arm; echo "== firstlaunch $arm new 120 rep $i $(date -u +%FT%TZ) load $(uptime | sed 's/.*averages: //')"; node firstlaunch.mjs $arm new 120)
	done
done
./landingab.sh $1 $2
./stopall.sh
echo "== fwblock done $(date -u +%FT%TZ)"
