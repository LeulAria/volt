#!/bin/zsh
# Fresh seeded state for one arm: wipe the profile, launch, pick the arena project, seed n threads, quit.
#   ./prep.sh before|after [n=3]
set -e
cd ${0:A:h}
source ./arm.sh $1
node launch.mjs stop >/dev/null
rm -rf $SPEED_UD $SPEED_UD.log
node launch.mjs
sleep 5
node pickproject.mjs
node seed.mjs ${2:-3}
