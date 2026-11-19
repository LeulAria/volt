#!/bin/zsh
# A2 then A1, before vs after, 6 reps each, interleaved (pair.sh takes the timing lock, run.ts gates on load <= 14).
cd /Users/leularia/Desktop/VOLT/volt-e5-launch/docs/reports/2026-11-12-orch-devenv/round6/scripts/launch
export PATH="$HOME/.nvm/versions/node/v22.19.0/bin:$HOME/.bun/bin:/opt/homebrew/bin:$PATH"; unset ELECTRON_RUN_AS_NODE
echo "A2 start $(date)"; ./pair.sh ~/.volt-r6/launch/out/r6a 6 A2 before after
echo "A1 start $(date)"; ./pair.sh ~/.volt-r6/launch/out/r6a 6 A1 before after
echo "PAIRS DONE $(date)"
