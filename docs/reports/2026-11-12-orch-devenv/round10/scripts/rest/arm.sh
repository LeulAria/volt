#!/bin/zsh
# Env for one arm of the round-10 rest rig: `source arm.sh <arm> [app path]`.
#   r8    round 8/9/10's base release build (~/.volt-r8/min/r8/VOLT.app, code = 7312123ce14)
#   dev   this worktree's dev build (volt-e5-idle, branch e10/rest)
#   any other name with the path of a VOLT.app as the second argument (or REST_APP)
# Every arm uses CDP 9988 and the replay server on 18998, so only one arm runs at a time. Profile ud-<arm>.
unset ELECTRON_RUN_AS_NODE SPEED_APP SPEED_CHECKOUT
W=$HOME/.volt-r10/rest
if [[ -n ${2:-$REST_APP} ]]; then
	export SPEED_APP=${2:-$REST_APP}
else
	case $1 in
		r8) export SPEED_APP=$HOME/.volt-r8/min/r8/VOLT.app ;;
		dev*) export SPEED_CHECKOUT=/Users/leularia/Desktop/VOLT/volt-e5-idle ;;
		*) echo "arm.sh: unknown arm $1" >&2; return 1 ;;
	esac
fi
if [[ -n $SPEED_APP && ! -d $SPEED_APP ]]; then echo "arm.sh: no app at $SPEED_APP" >&2; return 1; fi
export SPEED_UD=$W/ud-$1 SPEED_EXT=$W/ext-$1 WEIGHT_ARM=$1
export SPEED_CDP=9988 SPEED_REPLAY=18998 SPEED_FOLDER=$W/arena SPEED_REPLAY_LOG=$W/replay.jsonl
