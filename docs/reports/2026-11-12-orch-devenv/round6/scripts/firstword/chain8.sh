#!/bin/zsh
# Round 6 firstword, chain 8 (in-app, before = volt-e5-base at 7f07f73d677 on ~/.volt-r6/firstword/ud-base, after =
# e6/firstword on ~/.volt-r6/firstword/ud; both profiles seeded by prep.sh; the shared timing lock, load <= 14):
#   A. restored chat, first message 45 s after launch (firstlaunch.mjs restored): strict click, then HUMAN=1 (pointer first)
#   B. reopened chat (resume.mjs: A's agent stopped after 40 s idle, open A, 1 s, click, type, Enter), strict and HUMAN=1
#   C. A4 (a4.mjs, ADEMark's sequence) on Opus 5.5
#   ./chain8.sh [rounds=4]
cd ${0:A:h}
source ./timing.sh
export LOAD_MAX=14
R6=$HOME/.volt-r6/firstword
echo $$ > $R6/chain8.pid
rounds=${1:-4}
for r in $(seq 1 $rounds); do
	arms=(before after)
	(( r % 2 == 0 )) && arms=(after before)
	take_timing
	for arm in $arms; do (source ./arm.sh $arm; node firstlaunch.mjs $arm restored 45); done
	for arm in $arms; do (source ./arm.sh $arm; HUMAN=1 node firstlaunch.mjs $arm restored 45); done
	drop_timing
done
./ab.sh "resume.mjs ARM 2 1 40" 3
HUMAN=1 ./ab.sh "resume.mjs ARM 2 1 40" 3
FW_MODEL=agent:seed-claude-code:claude-opus-5-5 ./ab.sh "a4.mjs ARM 3" 4
echo "chain8 done $(date)"
