#!/bin/zsh
# Stops every arm's test instance (they share CDP 9988; a launch that timed out leaves its instance running).
cd ${0:A:h}
for ud in $HOME/.volt-r10/rest/ud-*(N/); do SPEED_UD=$ud SPEED_CDP=9988 node launch.mjs stop >/dev/null; done
