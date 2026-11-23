#!/bin/zsh
# What A10's 15 seeds leave in the renderer and GPU process (no timing lock: a breakdown, not a row).
# Fresh 5-thread profile, launch, 60 s, memory-infra dump + renderer heap snapshot (A); 15 seeds, 30 s, again (B).
#   ./r10probe.sh <arm> [app path]     out: ~/.volt-r9/procs/heap/<arm>-{A,B}.{json,heapsnapshot,txt}
cd ${0:A:h}
source ./arm.sh $1 $2 || exit 1
O=$HOME/.volt-r9/procs/heap; mkdir -p $O
./prep.sh $1 5 >/dev/null || exit 1
node launch.mjs >/dev/null
sleep 60
probe() {
	echo "== $1 $(date -u +%T) load $(uptime | sed 's/.*averages: //')"
	ps -axo pid=,rss=,command= | grep -- "--user-data-dir $SPEED_UD\|$SPEED_UD" | grep -v grep | while read p r c; do echo "$p $(footprint $p 2>/dev/null | sed -n 's/.*Footprint: \([0-9.]* [KMG]B\).*/\1/p') ${c[1,90]}"; done
	node memdump.mjs $O/$WEIGHT_ARM-$1.json > $O/$WEIGHT_ARM-$1.memdump.txt 2>&1
	node heapsummary.mjs http://127.0.0.1:$SPEED_CDP $O/$WEIGHT_ARM-$1.heapsnapshot 60 > $O/$WEIGHT_ARM-$1.txt 2>&1
	head -1 $O/$WEIGHT_ARM-$1.txt
}
probe A
node seed.mjs 15 >/dev/null
sleep 30
probe B
[[ -n $PROBE_KEEP ]] || node launch.mjs stop >/dev/null
