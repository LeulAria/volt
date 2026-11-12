#!/bin/bash
# Switches the worktree's orchestrator code between the round-2 base and this branch for an A/B
# run in the same window: arm.sh base|new. Only non-test src files this branch changed are
# swapped; out/ is rebuilt for them, the agent server restarts on its own, the window reloads.
cd /Users/leularia/Desktop/VOLT/volt-e2e-orch
BASE=81563ca39e4
FILES=$(git diff --name-only $BASE HEAD -- src | grep -v '/test/' | grep '\.ts$')
if [ "$1" = base ]; then git checkout $BASE -- $FILES; else git checkout HEAD -- $FILES; fi
node build/volt/syncOut.mjs $FILES > /tmp/v2-orch-arm.log 2>&1 || { echo "syncOut failed"; tail -5 /tmp/v2-orch-arm.log; exit 1; }
old=$(pgrep -f "volt-agent-server-main.js --user-data-dir /tmp/v2-orch-ud")
for i in $(seq 1 40); do new=$(pgrep -f "volt-agent-server-main.js --user-data-dir /tmp/v2-orch-ud"); [ -n "$new" ] && [ "$new" != "$old" ] && break; sleep 1; done
sleep 4
node /tmp/voltbench/cdp.mjs 9942 reload > /dev/null; sleep 8
# Ready when the window's New Agent button is there and the server answers (a run's first send waited 60+ s at load 110 otherwise).
for i in $(seq 1 60); do node /tmp/voltbench/cdp.mjs 9942 eval '!!document.querySelector("[aria-label=\\"New Agent\\"]")' 2>/dev/null | grep -q true && break; sleep 2; done
sleep 20
echo "arm=$1 server $old -> $new"
