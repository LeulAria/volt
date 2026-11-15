#!/bin/zsh
# Stops every arm's test instance (they share CDP 9976; a launch that timed out leaves its instance running).
cd ${0:A:h}
for other in before after minbefore minafter min2; do (source ./arm.sh $other 2>/dev/null; node launch.mjs stop >/dev/null); done
