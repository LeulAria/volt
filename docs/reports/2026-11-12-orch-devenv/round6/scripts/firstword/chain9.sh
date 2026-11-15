#!/bin/zsh
# Round 6 firstword, chain 9 (the restarted agent, 2026-11-15): chain 7's default arm never ran (zsh dropped the
# empty variant), so chain 7 again with both arms interleaved; then 3 more rounds of chain 8 A (restored chat, click
# and pointer first) because chain 8 A's click rows were n=3 with one 1.7 s outlier.
#   ./chain9.sh [c7rounds=4] [arounds=3]
cd ${0:A:h}
source ./timing.sh
export LOAD_MAX=14
R6=$HOME/.volt-r6/firstword
echo $$ > $R6/chain9.pid
./chain7.sh ${1:-4}
for r in $(seq 1 ${2:-3}); do
	arms=(after before)
	(( r % 2 == 0 )) && arms=(before after)
	take_timing
	for arm in $arms; do (source ./arm.sh $arm; node firstlaunch.mjs $arm restored 45); done
	for arm in $arms; do (source ./arm.sh $arm; HUMAN=1 node firstlaunch.mjs $arm restored 45); done
	drop_timing
done
echo "chain9 done $(date)"
