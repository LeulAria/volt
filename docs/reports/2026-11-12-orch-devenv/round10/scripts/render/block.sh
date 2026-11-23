#!/bin/zsh
# One render block for one arm (ADEMark method, unofficial; round 6's weight block without A9, which this round
# does not touch): fresh profile with 5 seeded threads, A5 after a relaunch, then A10 (15 more seeded threads,
# sampled at once), stop. Holds ~/.volt-r9/timing.lock for the block (about 12 min).
#   ./block.sh before|after|minbefore|minafter
cd ${0:A:h}
LOCK=$HOME/.volt-r9/timing.lock
until mkdir $LOCK 2>/dev/null; do sleep 20; done
echo "render block $1 pid $$ start $(date)" > $LOCK/owner
trap 'rm -rf $LOCK' EXIT
./stopall.sh
source ./arm.sh $1
echo "== block $1 $(date -u +%FT%TZ) load $(uptime | sed 's/.*averages: //')"
./prep.sh $1 5 || { echo "prep failed"; node launch.mjs stop; exit 1; }
./a5run.sh $1 90 launch
./a10run.sh $1
node launch.mjs stop
echo "== end $1 $(date -u +%FT%TZ)"
