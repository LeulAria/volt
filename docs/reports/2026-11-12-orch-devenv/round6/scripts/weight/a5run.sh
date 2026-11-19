#!/bin/zsh
# A5 (ADEMark method, unofficial) for one arm: stop, relaunch on the seeded profile, settle, sample 60 s.
#   ./a5run.sh before|after [settle s=90] [variant=launch]
cd ${0:A:h}
source ./arm.sh $1
node launch.mjs stop >/dev/null
node launch.mjs
SPEED_VARIANT=${3:-launch} node a5.mjs $1 ${2:-90} 60
