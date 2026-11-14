#!/bin/zsh
# GPU and renderer at rest, A/B: per arm (in the order given, repeat as you like), relaunch on its seeded profile,
# rest 90 s with no input, then the composited layers, footprints by role and the GPU allocators.
#   ./gpuab.sh <arm>...   (rows appended to data/weight/gpuab.jsonl)
cd ${0:A:h}
for arm in "$@"; do
	./stopall.sh >/dev/null
	source ./arm.sh $arm
	node launch.mjs >/dev/null
	sleep 90
	L=$(uptime | sed 's/.*averages: //')
	layers=$(node layers.mjs 20000 | head -1)
	fp=$(./probe.sh $arm | grep -E " (gpu|renderer|main)$| total$" | awk '{printf "%s=%s ", $4 $5, $1}')
	md=$(node memdump.mjs 2>&1 | grep -E "^ +[0-9.]+ +(iosurface|gpu/shared_images|cc/tile_memory)$" | awk '{printf "%s=%s ", $2, $1}')
	echo "{\"arm\":\"$arm\",\"at\":\"$(date -u +%FT%TZ)\",\"load\":\"$L\",\"layers\":\"$layers\",\"footprint\":\"$fp\",\"memdump\":\"$md\"}" | tee -a ../../data/weight/gpuab.jsonl
	node launch.mjs stop >/dev/null
done
