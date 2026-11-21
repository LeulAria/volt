#!/bin/zsh
# Exploratory (no data rows): a style change's effect on the GPU's tiles while A7's five streams run. Starts
# a7.mjs's streams on the running instance, then from DELAY s after the first send dumps the GPU's shared images
# (gputiles.mjs) as shipped, with CSS added (a <style> in the window), and as shipped again.
#   ./a7ab.sh <arm> <label> '<css>' [delay s=35]
cd ${0:A:h}
source ./arm.sh $1
OUT=$HOME/.volt-r9/render/probe
mkdir -p $OUT
WEIGHT_MAX_LOAD=999 SPEED_DATA=$HOME/.volt-r9/render/scratch A7_WINDOW_S=${A7_WINDOW_S:-90} node a7.mjs ab-$2 > $OUT/$2-a7.log 2>&1 &
A7=$!
sleep $(( ${4:-35} + 18 ))
CSS=$3
tiles() { echo "-- $1 $(date +%T) load $(uptime | sed 's/.*averages: //')"; node gputiles.mjs | grep -E 'shared images|raster tiles|RenderPass|GpuRasterTile' | head -8; }
{
	tiles shipped
	node ev.mjs "(() => { const s = document.createElement('style'); s.id = '__ab'; s.textContent = $(node -e 'console.log(JSON.stringify(process.argv[1]))' "$CSS"); document.head.appendChild(s); return true; })()" > /dev/null
	sleep 3
	tiles variant
	node ev.mjs "document.getElementById('__ab')?.remove()" > /dev/null
	sleep 3
	tiles shipped-again
} > $OUT/$2-ab.txt 2>&1
wait $A7
echo "done $2"
