#!/bin/zsh
# Exploratory: the GPU process's footprint while seed turns run in the current chat, under one settings change.
# Waits for the GPU to be back at its rest level (<= GPU_REST_MAX MiB, default 320), writes the setting into the test
# profile (the instance picks settings.json up live), runs `exp.mjs seeds <n>` and samples the GPU every 2 s meanwhile.
#   ./turnexp.sh <arm> '<json key>' '<json value>' [n=3]        e.g. ./turnexp.sh after volt.chat.background.image '"none"'
#   ./turnexp.sh <arm> - - [n=3]                                 no change (control)
cd ${0:A:h}
source ./arm.sh $1
KEY=$2; VALUE=$3; N=${4:-3}
gpu() { node fp.mjs 1 2>/dev/null | grep -E 'gpu \[' | awk '{print $(NF-1)}'; }
for i in {1..30}; do g=$(gpu); [[ -n $g && $g -le ${GPU_REST_MAX:-320} ]] && break; sleep 10; done
echo "rest gpu $g MiB"
if [[ $KEY != - ]]; then
	node -e "const fs=require('fs');const f='$SPEED_UD/User/settings.json';const s=JSON.parse(fs.readFileSync(f,'utf8'));s['$KEY']=$VALUE;fs.writeFileSync(f,JSON.stringify(s,null,'\t'));"
	sleep 3
fi
echo "== $KEY = $VALUE, $N seed turns"
( while true; do echo "$(date +%T) gpu $(gpu)"; sleep 2; done ) > /tmp/turnexp-gpu.$$ &
S=$!
node exp.mjs seeds $N 2>&1 | grep -E "^--|gpu \["
kill $S 2>/dev/null
echo "peak gpu $(awk '{print $3}' /tmp/turnexp-gpu.$$ | sort -n | tail -1) MiB over $(wc -l < /tmp/turnexp-gpu.$$) samples"
rm -f /tmp/turnexp-gpu.$$
