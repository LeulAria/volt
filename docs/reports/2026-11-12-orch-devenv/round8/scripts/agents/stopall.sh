#!/bin/zsh
# Stops every arm's test instance (they share CDP 9986; a launch that timed out leaves its instance running).
cd ${0:A:h}
for ud in $HOME/.volt-r8/agents/ud-*(N/); do SPEED_UD=$ud SPEED_CDP=9986 node launch.mjs stop >/dev/null; done
