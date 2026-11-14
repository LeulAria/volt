#!/bin/zsh
# Env for one arm of the round-6 weight rig: `source arm.sh before|after|minbefore|minafter`.
#   before:    the shared read-only dev build volt-e5-base (9bbb8818c60), profile ~/.volt-r6/weight/ud-before
#   after:     this worktree's dev build, profile ~/.volt-r6/weight/ud-after
#   minbefore: the shared minified before build (path in ~/.volt-r6/min/base/READY), profile ud-minbefore
#   minafter:  this branch's minified build (path in ~/.volt-r6/weight/min/READY), profile ud-minafter
#              (build 1: ab157fe66a7, Orbit still picture + plugin host idle stop)
#   min2:      the second minified build (path in ~/.volt-r6/weight/min2/READY, 1f9c93b49cf: build 1 + dictation
#              glow out of the layout at rest + event log keeps frames), profile ud-min2
# Every arm uses CDP 9976 and the replay server on 18976, so only one arm runs at a time.
unset ELECTRON_RUN_AS_NODE SPEED_APP
W=$HOME/.volt-r6/weight
case $1 in
	before) export SPEED_CHECKOUT=/Users/leularia/Desktop/VOLT/volt-e5-base ;;
	after) export SPEED_CHECKOUT=/Users/leularia/Desktop/VOLT/volt-e5-weight ;;
	minbefore) export SPEED_APP=$(head -1 $HOME/.volt-r6/min/base/READY) ;;
	minafter) export SPEED_APP=$(head -1 $W/min/READY) ;;
	min2) export SPEED_APP=$(head -1 $W/min2/READY) ;;
	*) echo "arm.sh: unknown arm $1" >&2; return 1 ;;
esac
export SPEED_UD=$W/ud-$1 SPEED_EXT=$W/ext-$1 WEIGHT_ARM=$1
export SPEED_CDP=9976 SPEED_REPLAY=18976 SPEED_FOLDER=$W/arena SPEED_REPLAY_LOG=$W/replay.jsonl
