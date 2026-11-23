#!/bin/zsh
# Raster work while ONE replay stream runs in the front chat of the running arm: renderer + GPU CPU s over 20 s and a
# 3 s cc trace (raster task count and summed duration, frames drawn).   ./rasterwork.sh <label>
cd ${0:A:h}
node _send.mjs replay:stream-1 && sleep 20
cpu() { ps -o time= -p $1 | awk -F: '{print ($1*60+$2)}'; }
GP=$(pgrep -f "type=gpu-process.*$SPEED_UD" | head -1); RP=$(pgrep -f "type=renderer.*$SPEED_UD" | head -1)
g0=$(cpu $GP); r0=$(cpu $RP); sleep 20; g1=$(cpu $GP); r1=$(cpu $RP)
TOP=1 timeout 60 node trace.mjs /tmp/rw.json 3 cc,viz,gpu >/dev/null
node -e '
const t=require("/tmp/rw.json").traceEvents; const sum=n=>{const r=t.filter(e=>e.name===n&&e.ph==="X"); return r.length+" / "+Math.round(r.reduce((a,e)=>a+(e.dur||0),0)/1000)+" ms";};
console.log(process.argv[1], "draws", t.filter(e=>e.name==="Display::DrawAndSwap").length, "| sw RasterTask", sum("RasterTask"), "| gpu DoRasterCHROMIUM", sum("RasterDecoderImpl::DoRasterCHROMIUM"));' $1
echo "$1 cpu over 20 s: renderer $(( r1 - r0 )) gpu $(( g1 - g0 ))"
