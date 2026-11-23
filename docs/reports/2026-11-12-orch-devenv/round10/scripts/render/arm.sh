#!/bin/zsh
# Env for one arm of the round-9 render rig (round 8's, round 6's weight rig): `source arm.sh <arm>`.
#   after:  this worktree's dev build, profile ud-after
#   r7:     the release build of round 8's base (~/.volt-r8/min/r7/VOLT.app, 3b41bdb483f), profile ud-r7
#   r8:     the release build of round 9's base (~/.volt-r8/min/r8/VOLT.app, 3c920df8444), profile ud-r8
#   <name>: any other arm name with ARM_APP=/path/to/VOLT.app (a release build; remembered in
#           ~/.volt-r9/render/arms/<name>), profile ud-<name>
# Every arm uses CDP 9983 and the replay server on 18993, so only one arm runs at a time.
unset ELECTRON_RUN_AS_NODE SPEED_APP SPEED_CHECKOUT
W=$HOME/.volt-r9/render
case $1 in
	after) export SPEED_CHECKOUT=/Users/leularia/Desktop/VOLT/volt-e5-tokens ;;
	r7) export SPEED_APP=$HOME/.volt-r8/min/r7/VOLT.app ;;
	r8) export SPEED_APP=$HOME/.volt-r8/min/r8/VOLT.app ;;
	*)
		ARM_APP_PATH=${ARM_APP:-$(cat $W/arms/$1 2>/dev/null)}
		[[ -d $ARM_APP_PATH ]] || { echo "arm.sh: unknown arm $1 (set ARM_APP=/path/to/VOLT.app)" >&2; return 1; }
		mkdir -p $W/arms; echo $ARM_APP_PATH > $W/arms/$1
		export SPEED_APP=$ARM_APP_PATH ;;
esac
export SPEED_UD=$W/ud-$1 SPEED_EXT=$W/ext-$1 WEIGHT_ARM=$1
# This Mac's display is 1512x982 pt: ADEMark's 1600x1000 does not fit (the app then opens 1175x705), so the largest that fits.
export SPEED_WIN_W=1500 SPEED_WIN_H=930
export SPEED_CDP=9983 SPEED_REPLAY=18993 SPEED_FOLDER=$W/arena SPEED_REPLAY_LOG=$W/replay.jsonl
