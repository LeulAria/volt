#!/bin/zsh
# Env for one arm of the round-6 weight rig: `source arm.sh before|after|minbefore|minafter`.
#   before:    the shared read-only dev build volt-e5-base (7f07f73d677), profile ~/.volt-r7/agents/ud-before
#   after:     this worktree's dev build, profile ~/.volt-r7/agents/ud-after
#   minbefore: the shared minified before build (path in ~/.volt-r7/min/base/READY), profile ud-minbefore
#   minafter:  this branch's minified build (path in ~/.volt-r7/agents/min/READY), profile ud-minafter
#              (round 6: f0bc50afe7e = 20 s refill spare + "just now" label; the shared before build is 7f07f73d677)
#   min2:      round 5's second minified build slot (unused in round 6), profile ud-min2
# Every arm uses CDP 9976 and the replay server on 18986, so only one arm runs at a time.
unset ELECTRON_RUN_AS_NODE SPEED_APP
W=$HOME/.volt-r7/agents
case $1 in
	before) export SPEED_CHECKOUT=/Users/leularia/Desktop/VOLT/volt-e5-base ;;
	after) export SPEED_CHECKOUT=/Users/leularia/Desktop/VOLT/volt-e5-weight ;;
	minbefore) export SPEED_APP=$(head -1 $HOME/.volt-r7/min/base/READY) ;;
	minafter) export SPEED_APP=$(head -1 $W/min/READY) ;;
	min2) export SPEED_APP=$(head -1 $W/min2/READY) ;;
	*) echo "arm.sh: unknown arm $1" >&2; return 1 ;;
esac
export SPEED_UD=$W/ud-$1 SPEED_EXT=$W/ext-$1 WEIGHT_ARM=$1
export SPEED_CDP=9976 SPEED_REPLAY=18986 SPEED_FOLDER=$W/arena SPEED_REPLAY_LOG=$W/replay.jsonl
