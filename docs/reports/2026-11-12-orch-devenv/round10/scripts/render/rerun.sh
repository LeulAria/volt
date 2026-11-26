#!/bin/zsh
# Round 9 render rig on one release build, one command: A7 (5 replay streams, 180 s at 4 Hz, per process) for
# `rounds` rounds under ~/.volt-r9/timing.lock with the 1-minute load gate (14), then the table by process.
#   ./rerun.sh /path/to/VOLT.app <arm name> [rounds=3] [other arms to interleave, e.g. "r7"]
# Rows: ../../data/render/a7.jsonl (arm = the name given). Needs nothing else of ours on CDP 9983 / replay 18993.
cd ${0:A:h}
[[ -d $1 && -n $2 ]] || { echo "usage: ./rerun.sh /path/to/VOLT.app <arm name> [rounds=3] [other arms]" >&2; exit 1; }
mkdir -p $HOME/.volt-r9/render/arms
echo $1 > $HOME/.volt-r9/render/arms/$2
./setup.sh > /dev/null || exit 1
ARMS="${4:+$4 }$2" ./a7block.sh ${3:-3}
node a7roles.mjs 14 ${=4} $2
