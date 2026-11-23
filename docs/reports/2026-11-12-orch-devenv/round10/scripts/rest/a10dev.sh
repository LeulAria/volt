#!/bin/zsh
# Exploratory dev A/B of A10's renderer side (memory only, no timing, so no timing lock and no load gate):
# per arm name `dev-<tag>`: fresh profile, 5 seeded threads, relaunch as shipped, 60 s, 30 s sample (front),
# 15 more threads, 60 s sample at once (rest-20), footprint categories and parked DOM. Rows go to
# ~/.volt-r10/rest/explore/rest.jsonl (never into the committed data).
#   ./a10dev.sh <tag>          (set the experiment with stashflag.sh first)
cd ${0:A:h}
ARM=dev-$1
export SPEED_DATA=$HOME/.volt-r10/rest/explore WEIGHT_LOAD_WAIT_S=0
mkdir -p $SPEED_DATA
source ./arm.sh $ARM || exit 1
trap 'node launch.mjs stop >/dev/null 2>&1' EXIT INT TERM
./stopall.sh
REST_KEEP_RENDERING=1 ./prep.sh $ARM 5 >/dev/null || { echo "prep failed"; exit 1; }
node launch.mjs stop >/dev/null
node launch.mjs
node rest.mjs $ARM front:60:30 | head -1
node fpsnap.mjs "" 4 | grep -E "renderer|gpu|agent server" | cut -c1-220
node seed.mjs 15 >/dev/null || echo "seed 15 failed"
node rest.mjs $ARM rest-20:0 | head -1
node fpsnap.mjs "" 4 | grep -E "renderer|gpu|agent server" | cut -c1-220
node parked.mjs
node a10delta.mjs $ARM | tail -12
