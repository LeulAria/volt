#!/bin/zsh
# Env for one arm of the round-6 weight rig: `source arm.sh before|after|minbefore|minafter`.
#   before:    the shared read-only dev build volt-e5-base (039a70b7208), profile ~/.volt-r7/render/ud-before
#   after:     this worktree's dev build, profile ~/.volt-r7/render/ud-after
#   minbefore: the shared minified before build (path in ~/.volt-r7/min/base/READY), profile ud-minbefore
#   minafter:  this branch's minified build (path in ~/.volt-r7/render/min/READY), profile ud-minafter
#              (round 6: f0bc50afe7e = 20 s refill spare + "just now" label; the shared before build is 7f07f73d677)
#   min2:      round 5's second minified build slot (unused in round 6), profile ud-min2
# Every arm uses CDP 9973 and the replay server on 18983, so only one arm runs at a time.
unset ELECTRON_RUN_AS_NODE SPEED_APP
W=$HOME/.volt-r7/render
case $1 in
	before) export SPEED_CHECKOUT=/Users/leularia/Desktop/VOLT/volt-e5-base ;;
	after) export SPEED_CHECKOUT=/Users/leularia/Desktop/VOLT/volt-e5-tokens ;;
	minbefore) export SPEED_APP=$(head -1 $HOME/.volt-r7/min/base/READY) ;;
	minafter) export SPEED_APP=$(head -1 $W/min/READY) ;;
	min2) export SPEED_APP=$(head -1 $W/min2/READY) ;;
	*) echo "arm.sh: unknown arm $1" >&2; return 1 ;;
esac
export SPEED_UD=$W/ud-$1 SPEED_EXT=$W/ext-$1 WEIGHT_ARM=$1
# This Mac's display is 1512x982 pt: ADEMark's 1600x1000 does not fit (the app then opens 1175x705), so the largest that fits.
export SPEED_WIN_W=1500 SPEED_WIN_H=930
export SPEED_CDP=9973 SPEED_REPLAY=18983 SPEED_FOLDER=$W/arena SPEED_REPLAY_LOG=$W/replay.jsonl
