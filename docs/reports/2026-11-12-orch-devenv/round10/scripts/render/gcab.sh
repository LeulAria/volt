#!/bin/zsh
# Exploratory (no data rows, no timing lock): one launch variant (extra Chromium args, e.g. --js-flags=...) over
# A7's five streams for A7_WINDOW_S (default 120) s on the arm's golden profile: the renderer's V8 heap as it is
# (heapwatch.mjs), the A7 row's renderer/GPU numbers, and the renderer's and GPU's CPU seconds over the window.
#   ARM=exp ./gcab.sh <label> [chromium args...]
cd ${0:A:h}
label=$1; shift
source ./arm.sh ${ARM:-exp}
./stopall.sh
rm -rf $SPEED_UD; cp -R $SPEED_UD.golden $SPEED_UD
WEIGHT_EXTRA_ARGS="$*" node launch.mjs >/dev/null || { echo launch failed; exit 1; }
sleep 25
W=${A7_WINDOW_S:-120}
cpu() { ps -o time= -p $1 | awk -F: '{print ($1*60+$2)}'; }
GP=$(pgrep -f "type=gpu-process.*$SPEED_UD" | head -1); RP=$(pgrep -f "type=renderer.*$SPEED_UD" | head -1)
g0=$(cpu $GP); r0=$(cpu $RP)
SPEED_DATA=$HOME/.volt-r9/render/scratch A7_WINDOW_S=$W WEIGHT_MAX_LOAD=99 node a7.mjs gc-$label > /tmp/gcab-a7.log 2>&1 &
sleep 20
hw=$(node heapwatch.mjs $(( W - 10 )))
wait
g1=$(cpu $GP); r1=$(cpu $RP)
tail -1 /tmp/gcab-a7.log | python3 -c "import json,sys; r=json.loads(sys.stdin.read()); print('$label', 'load', r['load'].split()[0], 'total', r['totalP95'], '| renderer @p95', r['byRoleAtP95']['renderer']['mib'], 'own p95', r['byRoleP95']['renderer'], 'median', r['byRoleMedian']['renderer'], '| gpu @p95', r['byRoleAtP95']['gpu']['mib'], 'own p95', r['byRoleP95']['gpu'])"
echo "   $hw | cpu s: renderer $(( r1 - r0 )) gpu $(( g1 - g0 ))"
node launch.mjs stop >/dev/null
