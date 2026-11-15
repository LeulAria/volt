#!/bin/zsh
# Env for one arm of the round-8 agents rig (round 6's weight rig): `source arm.sh <arm> [app path]`.
#   base     the release build before round 7 (~/.volt-r7/min/base/VOLT.app, 039a70b7208)
#   r7       the release build of round 8's base (~/.volt-r8/min/r7/VOLT.app, 3b41bdb483f)
#   r8       round 8's combined release build (~/.volt-r8/min/r8/VOLT.app), or any build: `arm.sh <name> /path/VOLT.app`
#   devbase  the shared read-only dev build volt-e5-base (69073864ed2)
#   dev      this worktree's dev build
# Every arm uses CDP 9986 and the replay server on 18996, so only one arm runs at a time. Profile ud-<arm>.
unset ELECTRON_RUN_AS_NODE SPEED_APP SPEED_CHECKOUT
W=$HOME/.volt-r8/agents
if [[ -n $2 ]]; then
	export SPEED_APP=$2
else
	case $1 in
		base) export SPEED_APP=$HOME/.volt-r7/min/base/VOLT.app ;;
		r7) export SPEED_APP=$HOME/.volt-r8/min/r7/VOLT.app ;;
		r8) export SPEED_APP=$HOME/.volt-r8/min/r8/VOLT.app ;;
		devbase) export SPEED_CHECKOUT=/Users/leularia/Desktop/VOLT/volt-e5-base ;;
		dev) export SPEED_CHECKOUT=/Users/leularia/Desktop/VOLT/volt-e5-weight ;;
		*) echo "arm.sh: unknown arm $1" >&2; return 1 ;;
	esac
fi
if [[ -n $SPEED_APP && ! -d $SPEED_APP ]]; then echo "arm.sh: no app at $SPEED_APP" >&2; return 1; fi
export SPEED_UD=$W/ud-$1 SPEED_EXT=$W/ext-$1 WEIGHT_ARM=$1
export SPEED_CDP=9986 SPEED_REPLAY=18996 SPEED_FOLDER=$W/arena SPEED_REPLAY_LOG=$W/replay.jsonl
