#!/bin/zsh
# Env for one arm of the round-8 agents rig (round 6's weight rig): `source arm.sh <arm> [app path]`.
#   base     the release build before round 7 (~/.volt-r7/min/base/VOLT.app, 039a70b7208)
#   r7       the release build of round 8's base (~/.volt-r8/min/r7/VOLT.app, 3b41bdb483f)
#   r8       round 8's combined release build (~/.volt-r8/min/r8/VOLT.app), or any build: `arm.sh <name> /path/VOLT.app`
#   devbase  the shared read-only dev build volt-e5-base (69073864ed2)
#   dev      this worktree's dev build
# Every arm uses CDP 9986 and the replay server on 18996, so only one arm runs at a time. Profile ud-<arm>.
unset ELECTRON_RUN_AS_NODE SPEED_APP SPEED_CHECKOUT
W=$HOME/.volt-r9/procs
if [[ -n ${2:-$R8_APP} ]]; then
	export SPEED_APP=${2:-$R8_APP}
else
	case $1 in
		base) export SPEED_APP=$HOME/.volt-r7/min/base/VOLT.app ;;
		r7) export SPEED_APP=$HOME/.volt-r8/min/r7/VOLT.app ;;
		r8) export SPEED_APP=$HOME/.volt-r8/min/r8/VOLT.app ;;
		devbase) export SPEED_CHECKOUT=/Users/leularia/Desktop/VOLT/volt-e5-base ;;
		dev|dev-*) export SPEED_CHECKOUT=/Users/leularia/Desktop/VOLT/volt-e5-weight ;;
		*) echo "arm.sh: unknown arm $1" >&2; return 1 ;;
	esac
fi
# Round 9: dev-yg-<off|on|MB> sets the dev build's young-generation cap for this arm (ygflag.sh).
[[ $1 == dev-yg-* ]] && ${0:A:h}/ygflag.sh ${1#dev-yg-} >/dev/null
# Round 10: dev-qh-<off|on> turns the dev build's quiet heap reducer off or on for this arm (qhflag.sh); the young-generation cap stays on.
[[ $1 == dev-qh-* ]] && { ${0:A:h}/ygflag.sh on >/dev/null; ${0:A:h}/qhflag.sh ${1#dev-qh-} >/dev/null }
if [[ -n $SPEED_APP && ! -d $SPEED_APP ]]; then echo "arm.sh: no app at $SPEED_APP" >&2; return 1; fi
export SPEED_UD=$W/ud-$1 SPEED_EXT=$W/ext-$1 WEIGHT_ARM=$1
export SPEED_CDP=9986 SPEED_REPLAY=18996 SPEED_FOLDER=$W/arena SPEED_REPLAY_LOG=$W/replay.jsonl
# This Mac's display is 1512x982 pt: ADEMark's 1600x1000 does not fit (the app then opens 1175x705), so the largest
# that fits, as round 8's render rig (whose A7 rows are the r8 baseline of round 9).
export SPEED_WIN_W=1500 SPEED_WIN_H=930
