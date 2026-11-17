#!/bin/zsh
# Runs one untimed command with this area's instance: waits until no speed-owned timed session holds the lock, sets the busy flag.
while grep -q "^speed" ~/.volt-r9/timing.lock/owner 2>/dev/null; do sleep 5; done
touch ~/.volt-r10/speed/busy; trap 'rm -f ~/.volt-r10/speed/busy' EXIT
export PATH="$HOME/.nvm/versions/node/v22.19.0/bin:$HOME/.bun/bin:$PATH"; unset ELECTRON_RUN_AS_NODE
cd /Users/leularia/Desktop/VOLT/volt-e5-firstword/docs/reports/2026-11-12-orch-devenv/round10/scripts/speed
. ./port.sh
export SMOOTH_GATE=999 LOAD_MAX=999 SMOOTH_DATA=$HOME/.volt-r10/speed/diag
"$@"
