#!/bin/zsh
# Interleaved blocks: before, after, before, after ... (n pairs).
cd ${0:A:h}
for i in $(seq 1 ${1:-2}); do
	./block.sh before
	./block.sh after
done
