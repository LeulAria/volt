#!/bin/zsh
# Exploratory: GPU shared images + process footprints DELAY s into A7's five streams, per variant (golden profile).
#   ARM=exp ./tilesab.sh <label> [css-file|-] [delay=45] [chromium args...]
cd ${0:A:h}
label=$1; css=$2; delay=${3:-45}; shift 3
source ./arm.sh ${ARM:-exp}
./stopall.sh
rm -rf $SPEED_UD; cp -R $SPEED_UD.golden $SPEED_UD
WEIGHT_EXTRA_ARGS="$*" node launch.mjs >/dev/null || { echo launch failed; exit 1; }
[[ -n $css && $css != - ]] && node inject.mjs $css
sleep 20
SPEED_DATA=$HOME/.volt-r9/render/scratch A7_WINDOW_S=$(( delay + 30 )) WEIGHT_MAX_LOAD=99 node a7.mjs tiles-$label > /tmp/tilesab-a7.log 2>&1 &
sleep $(( delay + 18 ))
echo "== $label load $(uptime | sed 's/.*averages: //')"
node gputiles.mjs 2>&1 | head -8
node fp.mjs 3 2>&1 | grep -E "gpu|renderer"; node ovprobe.mjs 1
wait
node launch.mjs stop >/dev/null
