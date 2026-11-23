#!/bin/zsh
# Exploratory A7 variant (not a timed row): golden seeded profile (ud-<arm>.golden, made by prep.sh + copy), relaunch
# with extra Chromium args and/or CSS injected over CDP, 30 s, then A7's five streams for A7_WINDOW_S (default 60) s.
# Prints the p95 tick split, GPU/renderer CPU seconds over the window, and the GPU footprint split mid-window.
#   ARM=exp ./expab.sh <label> [css-file|-] [chromium args...]
cd ${0:A:h}
label=$1; css=$2; shift 2
source ./arm.sh ${ARM:-exp}
./stopall.sh
rm -rf $SPEED_UD; cp -R $SPEED_UD.golden $SPEED_UD
WEIGHT_EXTRA_ARGS="$*" node launch.mjs >/dev/null || { echo launch failed; exit 1; }
if [[ -n $css && $css != - ]]; then node inject.mjs $css; fi
sleep 30
cpu() { ps -o time= -p $1 | awk -F: '{print ($1*60+$2)}'; }
GP=$(pgrep -f "type=gpu-process.*$SPEED_UD" | head -1); RP=$(pgrep -f "type=renderer.*$SPEED_UD" | head -1)
g0=$(cpu $GP); r0=$(cpu $RP)
(sleep $(( ${A7_WINDOW_S:-60} / 2 )); ./gpusplit.sh ${SPEED_UD:t:s/ud-//} 1 > /tmp/expab-split.txt) &
out=$(SPEED_DATA=$HOME/.volt-r9/render/scratch A7_WINDOW_S=${A7_WINDOW_S:-60} WEIGHT_MAX_LOAD=99 node a7.mjs $label | tail -1)
g1=$(cpu $GP); r1=$(cpu $RP)
echo $out | python3 -c "import json,sys; r=json.loads(sys.stdin.read()); b={k:v['mib'] for k,v in r['byRoleAtP95'].items()}; print('$label', 'load', r['load'].split()[0], 'total', r['totalP95'], 'app', r['appP95'], 'gpu', b.get('gpu'), 'renderer', b.get('renderer'), 'gpuOwnP95', r['byRoleP95'].get('gpu'), 'rendOwnP95', r['byRoleP95'].get('renderer'), 'agents', r['agentCountMedian'])"
echo "$label cpu s over window: gpu $(( g1 - g0 )) renderer $(( r1 - r0 ))"
cat /tmp/expab-split.txt
node launch.mjs stop >/dev/null
