#!/bin/zsh
# Round-4 first-word measurement, gated at load <= LOAD_MAX (default 14) per repetition:
#   1. in-app A4 (a4.mjs), before = volt-e4-base, after = this worktree, interleaved per launch (ab.sh)
#   2. the adapter alone (acpbench.mjs): unpatched vs Volt's preload, interleaved per repetition (acpab.sh)
#   ./measure.sh [a4 rounds] [acp rounds]      logs in ~/.volt-r4/firstword/
#   ./measure.sh quiet [rounds]                 second pass: A4 then A3 on each launch, arm order rotated, no adapter bench
here=${0:A:h}
export LOAD_MAX=${LOAD_MAX:-14}
logs=$HOME/.volt-r4/firstword
if [[ $1 == quiet ]]; then
  ROTATE=1 $here/ab.sh a4.mjs,a3.mjs 3 ${2:-6} before=/Users/leularia/Desktop/VOLT/volt-e4-base after=/Users/leularia/Desktop/VOLT/volt-e4-firstword 20 > $logs/measure-quiet.out 2>&1
  echo done >> $logs/measure-quiet.out
  exit
fi
$here/ab.sh a4.mjs 3 ${1:-8} before=/Users/leularia/Desktop/VOLT/volt-e4-base after=/Users/leularia/Desktop/VOLT/volt-e4-firstword 20 > $logs/measure-a4.out 2>&1
WARM=5000 $here/acpab.sh ${2:-20} r4 "base:" "volt:volt" > $logs/measure-acp.out 2>&1
echo done >> $logs/measure-acp.out
