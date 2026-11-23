#!/bin/zsh
# Agent server memory at rest (60 s after launch on a 5-thread profile) and 30 s after 15 more seeds: V8 heap by
# space (inspector) and the footprint tool's breakdown by region. No timing lock (a memory breakdown, not a row).
#   ./asmem.sh <arm> [app path]     needs prep.sh <arm> 5 first (the 5-thread profile)
cd ${0:A:h}
source ./arm.sh $1 $2 || exit 1
EXPR='JSON.stringify({m:Object.fromEntries(Object.entries(process.memoryUsage()).map(([k,v])=>[k,Math.round(v/1048576)])),s:process.getBuiltinModule("v8").getHeapSpaceStatistics().map(x=>[x.space_name,Math.round(x.space_size/1048576),Math.round(x.space_used_size/1048576)])})'
node launch.mjs stop >/dev/null
VOLT_AGENT_SERVER_INSPECT=1 node launch.mjs
sleep ${ASMEM_SETTLE:-60}
pid=$(ps -axo pid,command | grep 'volt-agent-server-main' | grep "agents/ud-$1 \|agents/ud-$1\$" | grep -v grep | awk '{print $1}' | head -1)
[[ -z $pid ]] && pid=$(pgrep -f "volt-agent-server-main.js --user-data-dir $SPEED_UD" | head -1)
kill -USR1 $pid; sleep 2
snap() {
	echo "== $1 $(date -u +%T) load $(uptime | sed 's/.*averages: //') pid $pid"
	node nodeeval.mjs http://127.0.0.1:9229 "$EXPR"
	footprint $pid 2>/dev/null | grep -E "phys_footprint|app-specific|MALLOC_|TOTAL|Footprint:" | head -12
}
snap rest
node seed.mjs 15 > /dev/null
sleep 30
snap seed15+30
[[ -n $ASMEM_KEEP ]] || node launch.mjs stop >/dev/null
