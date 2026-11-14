#!/bin/zsh
# Env for one arm of the weight rig: `source arm.sh before|after`.
#   before: the shared read-only build volt-e4-base, profile /tmp/v4-weight-ud-base
#   after:  this worktree, profile /tmp/v4-weight-ud
# Both use CDP 9946 and the replay server on 18946, so only one arm runs at a time.
unset ELECTRON_RUN_AS_NODE
if [[ $1 == before ]]; then
	export SPEED_CHECKOUT=/Users/leularia/Desktop/VOLT/volt-e4-base SPEED_UD=/tmp/v4-weight-ud-base SPEED_EXT=/tmp/v4-weight-ext-base
else
	export SPEED_CHECKOUT=/Users/leularia/Desktop/VOLT/volt-e4-weight SPEED_UD=/tmp/v4-weight-ud SPEED_EXT=/tmp/v4-weight-ext
fi
export WEIGHT_ARM=$1
