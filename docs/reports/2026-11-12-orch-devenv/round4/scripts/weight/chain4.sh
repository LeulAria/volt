#!/bin/zsh
# After chain3.sh: one more A5/A9/A10 block pair (A10's before rows of chain2 ran at load 17.9 and 27.4), then the
# live recall check of the idle stop on the after arm (Haiku 5.5, 3 short turns).
cd ${0:A:h}
while kill -0 $(cat ~/.volt-r4/weight/chain3.pid) 2>/dev/null; do sleep 15; done
./blocks.sh 1
for other in before after; do (source ./arm.sh $other; node launch.mjs stop >/dev/null); done
source ./arm.sh after
echo "== livecheck $(date -u +%FT%TZ) load $(uptime | sed 's/.*averages: //')"
node launch.mjs --live && sleep 8 && node livecheck.mjs
node launch.mjs stop >/dev/null
echo "== chain4 done $(date -u +%FT%TZ)"
