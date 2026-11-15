#!/bin/zsh
# Interleaved before/after of in-app test scripts, one launch per arm per round (arm.sh: before = volt-e5-base on
# ~/.volt-r6/firstword/ud-base, after = this worktree on ~/.volt-r6/firstword/ud). The arm order alternates per round.
#   ./ab.sh <script.mjs[ args...]>[,<script2.mjs ...>] <rounds> [settle s=25]
# Each round takes the shared timing lock at load <= 14 (timing.sh) and lets it go after both arms.
here=${0:A:h}
cd $here
source ./timing.sh
scripts=$1; rounds=$2; settle=${3:-25}
for r in $(seq 1 $rounds); do
	arms=(before after)
	(( r % 2 == 0 )) && arms=(after before)
	take_timing
	for arm in $arms; do
		source ./arm.sh $arm
		node launch.mjs stop > /dev/null
		node launch.mjs
		sleep $settle
		for s in ${(s:,:)scripts}; do
			node ${=s/ARM/$arm}
		done
		node launch.mjs stop > /dev/null
	done
	drop_timing
done
