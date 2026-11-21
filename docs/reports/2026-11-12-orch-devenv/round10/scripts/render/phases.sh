#!/bin/zsh
# Exploratory (no data rows): a style change's effect on GPU and renderer memory while A7's five streams run,
# alternating shipped / variant phases so the stream's own drift shows. Per phase: wait, then the GPU's and
# renderer's footprint (3 s median), the GPU's raster tiles, and what was repainted (paintprobe.mjs).
#   ./phases.sh <arm> <label> '<css>' [phases=6] [phase s=14] [delay s=25]
cd ${0:A:h}
source ./arm.sh $1
OUT=$HOME/.volt-r9/render/probe
mkdir -p $OUT
WEIGHT_MAX_LOAD=999 SPEED_DATA=$HOME/.volt-r9/render/scratch A7_WINDOW_S=$(( ${6:-25} + ${4:-6} * (${5:-14} + 12) )) node a7.mjs ph-$2 > $OUT/$2-a7.log 2>&1 &
A7=$!
sleep $(( ${6:-25} + 18 ))
CSS=$3
{
	for i in $(seq 1 ${4:-6}); do
		if (( i % 2 == 0 )); then
			node ev.mjs "(() => { const s = document.createElement('style'); s.id = '__ab'; s.textContent = $(node -e 'console.log(JSON.stringify(process.argv[1]))' "$CSS"); document.head.appendChild(s); return true; })()" > /dev/null
			echo "-- phase $i variant $(date +%T) load $(uptime | sed 's/.*averages: //')"
		else
			node ev.mjs "document.getElementById('__ab')?.remove()" > /dev/null
			echo "-- phase $i shipped $(date +%T) load $(uptime | sed 's/.*averages: //')"
		fi
		sleep ${5:-14}
		node fp.mjs 3 | grep -E '^  (gpu|renderer)'
		node gputiles.mjs | grep -E 'shared images|raster tiles|GpuRasterTile' | head -5
		node paintprobe.mjs 2 | sed -n 2,4p
	done
	node ev.mjs "document.getElementById('__ab')?.remove()" > /dev/null
} > $OUT/$2-phases.txt 2>&1
wait $A7
echo "done $2"
