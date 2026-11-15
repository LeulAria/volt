#!/bin/zsh
# Env for one arm of the round-5 firstword rig: `source arm.sh before|after`.
#   before: the shared read-only build volt-e5-base (9bbb8818c60), profile ~/.volt-r6/firstword/ud-base
#   after:  this worktree, profile ~/.volt-r6/firstword/ud
# Both use CDP 9972 and the replay server on 18972, so only one arm runs at a time.
unset ELECTRON_RUN_AS_NODE
R6=$HOME/.volt-r6/firstword
if [[ $1 == before ]]; then
	export SPEED_CHECKOUT=/Users/leularia/Desktop/VOLT/volt-e5-base SPEED_UD=$R6/ud-base SPEED_EXT=$R6/ext-base
else
	export SPEED_CHECKOUT=/Users/leularia/Desktop/VOLT/volt-e5-firstword SPEED_UD=$R6/ud SPEED_EXT=$R6/ext
fi
export FW_ARM=$1
