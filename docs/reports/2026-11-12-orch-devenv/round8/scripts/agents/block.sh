#!/bin/zsh
# One weight block for one arm (ADEMark method, unofficial): fresh profile with 5 seeded threads, A5 after a
# relaunch, A9 (relaunched as shipped, agent server as a launchd job; quit, 60 s), relaunch, A10 (15 more seeded
# threads, sample at once), stop. Takes ~/.volt-r8/timing.lock for the block (waits for it; held ~12 min).
#   ./block.sh before|after|minbefore|minafter
cd ${0:A:h}
LOCK=$HOME/.volt-r8/timing.lock
until mkdir $LOCK 2>/dev/null; do sleep 20; done
echo "weight block $1 pid $$ start $(date)" > $LOCK/owner
trap 'rm -rf $LOCK' EXIT
# Every arm shares CDP 9986: neither may be up (a launch that timed out leaves its instance running).
./stopall.sh
source ./arm.sh $1
echo "== block $1 $(date -u +%FT%TZ) load $(uptime | sed 's/.*averages: //')"
./prep.sh $1 5 || { echo "prep failed"; node launch.mjs stop; exit 1; }
./a5run.sh $1 90 launch
node launch.mjs stop >/dev/null
WEIGHT_LAUNCHD=1 node launch.mjs
sleep 30
node a9.mjs $1
node launch.mjs
sleep 10
./a10run.sh $1
node launch.mjs stop
echo "== end $1 $(date -u +%FT%TZ)"
