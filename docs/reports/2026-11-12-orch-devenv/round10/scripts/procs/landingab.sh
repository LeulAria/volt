#!/bin/zsh
# Memory at rest with a new chat's landing (Orbit background) in front: per arm, relaunch on its seeded profile, open
# New Chat (so a relaunch restores the landing), relaunch again, rest 120 s with no input, then footprints and the
# memory-infra dump (renderer canvas, GPU). ./landingab.sh <arm>...
cd ${0:A:h}
for arm in "$@"; do
	./stopall.sh >/dev/null
	source ./arm.sh $arm
	[ -d $SPEED_UD ] || ./prep.sh $arm 5 >/dev/null
	node launch.mjs stop >/dev/null; node launch.mjs >/dev/null
	node --input-type=module -e 'import { cdp, newChat, sleep } from "./lib.mjs"; const c = await cdp(); await newChat(c); await sleep(3000); c.close();'
	node launch.mjs stop >/dev/null; node launch.mjs >/dev/null
	sleep 120
	echo "== $arm $(date -u +%FT%TZ) load $(uptime | sed 's/.*averages: //')"
	./probe.sh $arm | grep -E "renderer|gpu|main|total"
	node memdump.mjs 2>&1 | grep -E "canvas/|iosurface|cc/tile_memory"
	node launch.mjs stop >/dev/null
done
