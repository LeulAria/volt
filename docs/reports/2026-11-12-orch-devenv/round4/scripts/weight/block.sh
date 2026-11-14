#!/bin/zsh
# One weight block for one arm (ADEMark method, unofficial): fresh profile with 5 seeded threads, A5 after
# a relaunch, A9 (quit, 60 s), relaunch, A10 (15 more seeded threads, sample at once), stop.
#   ./block.sh before|after
cd ${0:A:h}
source ./arm.sh $1
echo "== block $1 $(date -u +%FT%TZ) load $(uptime | sed 's/.*averages: //')"
./prep.sh $1 5 || { echo "prep failed"; node launch.mjs stop; exit 1; }
./a5run.sh $1 90 launch
node a9.mjs $1
node launch.mjs
sleep 10
./a10run.sh $1
node launch.mjs stop
echo "== end $1 $(date -u +%FT%TZ)"
