#!/bin/zsh
# Exploratory dev-build A7 peak probes, arms in turn (no timing lock, no data rows; loads are whatever they are):
# per arm a fresh 5-thread profile, relaunch, 30 s, then a7probe.sh (GPU tiles, footprint by role, allocators, heap
# at DELAY s into the streams) and the a7.mjs row of that run (p95 by role).
#   ./a7dev.sh <label> <arm>...     e.g. ./a7dev.sh rows before after before after
cd ${0:A:h}
label=$1; shift
n=0
for arm in $@; do
	n=$((n + 1))
	./stopall.sh
	source ./arm.sh $arm
	./prep.sh $arm 5 > /dev/null 2>&1 || { echo "prep failed $arm"; continue; }
	node launch.mjs stop > /dev/null
	node launch.mjs > /dev/null || { echo "launch failed $arm"; continue; }
	sleep 30
	./a7probe.sh $arm $label-$n-$arm ${DELAY:-40} > /dev/null 2>&1
	node launch.mjs stop > /dev/null
	echo "== $label $n $arm"
	grep -E '^load|shared images|raster tiles|^app |gpu \[app\]|renderer \[app\]|extension host' $HOME/.volt-r8/render/probe/$label-$n-$arm-peak.txt
	tail -1 $HOME/.volt-r8/render/probe/$label-$n-$arm-a7.log | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const r=JSON.parse(s);console.log(JSON.stringify({appP95:r.appP95,totalP95:r.totalP95,gpuP95:r.byRoleP95.gpu,rendererP95:r.byRoleP95.renderer,gpuMed:r.byRoleMedian.gpu,rendererMed:r.byRoleMedian.renderer,load:r.load}))}catch{console.log("no row")}})'
done
