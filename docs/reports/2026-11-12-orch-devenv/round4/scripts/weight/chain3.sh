#!/bin/zsh
# After chain2.sh: the resumed-chat A/B again with the user typing 1 s after opening the chat (stress case:
# the resume has less time to finish before Enter), 2 rounds x 2 reps, interleaved.
cd ${0:A:h}
while kill -0 $(cat ~/.volt-r4/weight/chain2.pid) 2>/dev/null; do sleep 15; done
./resumeab.sh 2 2 1 40
echo "== chain3 done $(date -u +%FT%TZ)"
