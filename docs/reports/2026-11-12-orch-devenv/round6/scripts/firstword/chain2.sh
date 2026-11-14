#!/bin/zsh
# Round 5 firstword, chain 2 (in-app, interleaved before/after, each round under the timing lock at load <= 14):
#   A. restored chat, first message 45 s after launch (round 4's firstlaunch rig): strict click, then HUMAN=1 (pointer
#      moves to the composer first)
#   B. reopened chat after 40 s idle (round 4's resume rig, openWait 1 s): strict, then HUMAN=1
#   C. A4 (a4.mjs, ADEMark's sequence) on Opus 5.5
#   D. Bare CLI A4 on this Mac (barecli.py)
#   E. the direct path: the adapter vs the Agent SDK with no adapter, warm and cold (adapter level, no app)
cd ${0:A:h}
source ./timing.sh
export LOAD_MAX=14 WEIGHT_MAX_LOAD=14
while kill -0 $(cat ~/.volt-r6/firstword/chain1.pid) 2>/dev/null; do sleep 30; done
echo "== A restored $(date)"
for r in 1 2 3 4; do
	arms=(before after); (( r % 2 == 0 )) && arms=(after before)
	take_timing
	for arm in $arms; do (source ./arm.sh $arm; node firstlaunch.mjs $arm restored 45); done
	for arm in $arms; do (source ./arm.sh $arm; HUMAN=1 node firstlaunch.mjs $arm restored 45); done
	drop_timing
done
echo "== B reopen $(date)"
./ab.sh "resume.mjs ARM 2 1 40" 3
HUMAN=1 ./ab.sh "resume.mjs ARM 2 1 40" 3
echo "== C A4 $(date)"
FW_MODEL=agent:seed-claude-code:claude-opus-5-5 ./ab.sh "a4.mjs ARM 3" 5
echo "== D bare $(date)"
for r in 1 2 3 4 5; do take_timing; python3 -u barecli.py r5-bare 2; drop_timing; done
echo "== E direct $(date)"
for r in 1 2 3 4 5 6; do
	take_timing
	node resumebench.mjs r5-direct 1 warm=5000
	node sdkbench.mjs r5-direct-sdk 1 settings mcp warm=5000
	node resumebench.mjs r5-direct 1
	node sdkbench.mjs r5-direct-sdk 1 settings mcp warm=0
	drop_timing
done
echo "chain2 done $(date)"
