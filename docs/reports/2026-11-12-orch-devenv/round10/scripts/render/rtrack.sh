#!/bin/zsh
# Exploratory (no data rows, no timing lock): the renderer over A7's 180 s. Golden profile of the arm, relaunch,
# rsnap.mjs at rest, then five replay streams and rsnap.mjs at each of TIMES s into them.
#   ARM=exp ./rtrack.sh <label> [css-file|-]      TIMES="40 100 170"
cd ${0:A:h}
label=$1; css=${2:--}
source ./arm.sh ${ARM:-exp}
./stopall.sh
rm -rf $SPEED_UD; cp -R $SPEED_UD.golden $SPEED_UD
node launch.mjs >/dev/null || { echo launch failed; exit 1; }
[[ $css != - ]] && node inject.mjs $css
sleep 25
node rsnap.mjs "$label rest"
SPEED_DATA=$HOME/.volt-r9/render/scratch A7_WINDOW_S=185 WEIGHT_MAX_LOAD=99 node a7.mjs track-$label > /tmp/rtrack-a7.log 2>&1 &
t0=$(( $(date +%s) + 18 ))
for t in ${=TIMES:-40 100 170}; do
	while (( $(date +%s) - t0 < t )); do sleep 1; done
	node rsnap.mjs "$label t=$t"
done
wait
tail -1 /tmp/rtrack-a7.log | python3 -c "import json,sys; r=json.loads(sys.stdin.read()); print('  a7 total', r['totalP95'], 'renderer@p95', r['byRoleAtP95']['renderer']['mib'], 'renderer own p95', r['byRoleP95']['renderer'], 'gpu@p95', r['byRoleAtP95']['gpu']['mib'], 'gpu own p95', r['byRoleP95']['gpu'], 'load', r['load'])"
node launch.mjs stop >/dev/null
