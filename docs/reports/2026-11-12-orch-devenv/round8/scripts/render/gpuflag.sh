#!/bin/zsh
# Exploratory: the GPU process's footprint by category about 50 s into A7's streams, with extra launch arguments.
#   ./gpuflag.sh <arm> <label> [extra args...]
cd ${0:A:h}
source ./arm.sh $1; label=$2; shift 2
node launch.mjs stop >/dev/null
WEIGHT_EXTRA_ARGS="$*" node launch.mjs >/dev/null || exit 1
sleep 20
(WEIGHT_MAX_LOAD=999 SPEED_DATA=$HOME/.volt-r8/render/scratch A7_WINDOW_S=60 node a7.mjs probe-$label > $HOME/.volt-r8/render/probe/$label-a7.log 2>&1 &)
sleep 50
GP=$(pgrep -f "type=gpu-process.*$SPEED_UD" | head -1)
echo "== $label ($*) load $(uptime | sed 's/.*averages: //')"
ps -o command= -p $GP | tr ' ' '\n' | grep -E "^--(enable|disable)-features" | cut -c1-200
footprint -p $GP | sed -n 2p
footprint -p $GP | grep -E "graphics|IOSurface"
node gputiles.mjs | sed -n 1,4p
node ev.mjs 'innerWidth + "x" + innerHeight + "@" + devicePixelRatio'
sleep 12
node launch.mjs stop >/dev/null
