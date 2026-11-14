#!/bin/zsh
# Round 4 quiet-window runs (09:00 restart), one instance at a time, every timed row gated at a 1-minute load
# <= 14 (resume.mjs, a5/a7/a9.mjs, a10run.sh wait for it): resumed-chat first word 3 rounds x 2 reps, A7 2 rounds,
# then 2 A5/A9/A10 block pairs, all before/after interleaved.
cd ${0:A:h}
./resumeab.sh 3 2 3 40
./a7block.sh 2
./blocks.sh 2
echo "== chain2 done $(date -u +%FT%TZ)"
