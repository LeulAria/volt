#!/bin/zsh
# Exploratory (no data rows, no timing lock): one CSS variant's effect on the GPU's tiles and on what repaints while
# A7's five streams run. Golden seeded profile (ud-<arm>.golden), relaunch, CSS injected over CDP (or - for none),
# then DELAY s into the streams: repainted layers (paintprobe.mjs), GPU shared images (gputiles.mjs), GPU and
# renderer footprint (fp.mjs) and their CPU seconds over the last 20 s.
#   ARM=exp ./layerab.sh <label> [css-file|-] [delay=45] [chromium args...]
cd ${0:A:h}
label=$1; css=${2:--}; delay=${3:-45}; shift 3 2>/dev/null
source ./arm.sh ${ARM:-exp}
./stopall.sh
rm -rf $SPEED_UD; cp -R $SPEED_UD.golden $SPEED_UD
WEIGHT_EXTRA_ARGS="$*" node launch.mjs >/dev/null || { echo launch failed; exit 1; }
[[ $css != - ]] && node inject.mjs $css
sleep 20
SPEED_DATA=$HOME/.volt-r9/render/scratch A7_WINDOW_S=$(( delay + 30 )) WEIGHT_MAX_LOAD=99 node a7.mjs layer-$label > /tmp/layerab-a7.log 2>&1 &
sleep $(( delay - 2 ))
cpu() { ps -o time= -p $1 | awk -F: '{print ($1*60+$2)}'; }
GP=$(pgrep -f "type=gpu-process.*$SPEED_UD" | head -1); RP=$(pgrep -f "type=renderer.*$SPEED_UD" | head -1)
g0=$(cpu $GP); r0=$(cpu $RP)
sleep 20
g1=$(cpu $GP); r1=$(cpu $RP)
echo "== $label load $(uptime | sed 's/.*averages: //') cpu s per 20 s: gpu $(( g1 - g0 )) renderer $(( r1 - r0 ))"
node paintprobe.mjs 3 2>&1 | head -8
node gputiles.mjs 2>&1 | head -9
node fp.mjs 3 2>&1 | grep -E "gpu|renderer"
[[ -n $SHOT ]] && node -e 'const {cdp}=await import("./lib.mjs"); const c=await cdp(); const r=await c.send("Page.captureScreenshot",{format:"png"}); (await import("fs")).writeFileSync(process.argv[1], Buffer.from(r.result.data,"base64")); c.close(); process.exit(0)' --input-type=module $SHOT
wait
node launch.mjs stop >/dev/null
