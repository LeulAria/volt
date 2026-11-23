#!/bin/zsh
# Exploratory dev A/B of a renderer change: for each variant (git rev of FILE), sync that version of FILE into out/,
# run A7's five streams (A7_WINDOW_S, default 150) on the golden 'after' profile, and DELAY s in read the renderer's
# JS heap (after GC) and footprint; the A7 row (scratch) gives the renderer's p95. Restores FILE from HEAD at the end.
#   FILE=src/... ./heapab.sh <rev>:<label> ...
cd ${0:A:h}
REPO=/Users/leularia/Desktop/VOLT/volt-e5-tokens
export PATH=$HOME/.nvm/versions/node/v22.19.0/bin:$PATH
for spec in "$@"; do
	rev=${spec%%:*}; label=${spec#*:}
	git -C $REPO show $rev:$FILE > $REPO/$FILE && touch $REPO/$FILE && (cd $REPO && node build/volt/syncOut.mjs $FILE >/dev/null)
	source ./arm.sh after
	./stopall.sh; rm -rf $SPEED_UD; cp -R $SPEED_UD.golden $SPEED_UD
	node launch.mjs >/dev/null; sleep 20
	SPEED_DATA=$HOME/.volt-r9/render/scratch A7_WINDOW_S=${A7_WINDOW_S:-150} WEIGHT_MAX_LOAD=99 node a7.mjs heap-$label > /tmp/heapab-a7.log 2>&1 &
	sleep $(( ${DELAY:-140} + 18 ))
	RP=$(pgrep -f "type=renderer.*$SPEED_UD" | head -1)
	echo "$label load $(uptime | sed 's/.*averages: //') renderer footprint $(footprint -p $RP 2>/dev/null | sed -n 2p | sed 's/.*Footprint: //;s/ (.*//') $(node -e 'const {cdp}=await import("./lib.mjs"); const c=await cdp(); await c.send("HeapProfiler.collectGarbage"); const u=(await c.send("Runtime.getHeapUsage")).result; console.log("heap used", Math.round(u.usedSize/1048576), "MiB"); c.close(); process.exit(0)' --input-type=module)"
	wait
	tail -1 /tmp/heapab-a7.log | python3 -c "import json,sys; r=json.loads(sys.stdin.read()); print('  $label a7 total', r['totalP95'], 'renderer@p95', r['byRoleAtP95']['renderer']['mib'], 'renderer own p95', r['byRoleP95']['renderer'], 'gpu own p95', r['byRoleP95']['gpu'])"
	node launch.mjs stop >/dev/null
done
git -C $REPO checkout HEAD -- $FILE && touch $REPO/$FILE && (cd $REPO && node build/volt/syncOut.mjs $FILE >/dev/null)
