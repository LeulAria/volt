#!/bin/zsh
# A10 (ADEMark method, unofficial) for one arm, right after a5run.sh on the same instance: add 15 seeded
# threads (20 in total), then sample 60 s at once, as ADEMark does (no settle).
#   ./a10run.sh before|after
cd ${0:A:h}
source ./arm.sh $1
node seed.mjs ${2:-15}
SPEED_VARIANT=a10-rest-20 node a5.mjs $1 0 60
