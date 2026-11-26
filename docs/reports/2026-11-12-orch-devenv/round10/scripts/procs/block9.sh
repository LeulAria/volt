#!/bin/zsh
# Round 9 procs: the checks around a fix in one unattended chain (each step takes ~/.volt-r9/timing.lock itself and
# gates every sample on a 1-minute load <= 14).
#   ./block9.sh <beforeArm> <afterArm> [a7reps=2]
#   1. A7 on both arms, interleaved, a7reps each          (r8run.sh <arm> a7)
#   2. A5 + A10 on both arms                               (r8run.sh <arm> "a5 a10")
#   3. follow-up after the 20 s stop, gap 400 / gap 0 / reading, 1 round x 2 reps   (fublock.sh)
#   4. first word of a new chat's first prompt 120 s after launch, 2 reps each, + memory with the landing (fwblock.sh)
# Arms: r8 (release), dev-yg-off / dev-yg-on / dev-yg-hg<N> (this worktree's dev build, arm.sh sets the flag), or a
# name with an app path through R8_APP (r8run.sh only).
cd ${0:A:h}
B=$1; A=$2; N=${3:-2}
for i in $(seq $N); do ./r8run.sh $B a7; ./r8run.sh $A a7; done
./r8run.sh $B "a5 a10"; ./r8run.sh $A "a5 a10"
FUBLOCK_READER=1 ./fublock.sh "$B $A" 1 2
./fwblock.sh $B $A 2
echo "== block9 done $(date -u +%FT%TZ)"
