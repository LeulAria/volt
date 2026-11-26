#!/bin/zsh
# Runs a command holding ~/.volt-r9/timing.lock (waits for it), so no other agent's timed run shares the screen.
#   ./locked.sh <label> <command...>
LOCK=$HOME/.volt-r9/timing.lock
label=$1; shift
until mkdir $LOCK 2>/dev/null; do sleep 15; done
echo "render $label pid $$ start $(date)" > $LOCK/owner
trap 'grep -qs "pid $$ " $LOCK/owner && rm -rf $LOCK' EXIT
"$@"
