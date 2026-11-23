#!/bin/zsh
# Dev A/B of the young-generation cap: A7 on this worktree's dev build with the cap off and on, interleaved.
#   ./ygab.sh [states="off on off on"]   arms dev-yg-<state>; rows in data/procs/a7.jsonl
cd ${0:A:h}
for s in ${=${1:-off on off on}}; do
	./ygflag.sh $s
	./r8run.sh dev-yg-$s a7
done
./ygflag.sh on
