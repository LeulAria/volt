#!/bin/zsh
# Dev A/B switch for the parked-thread experiments: rewrites constants in this worktree's compiled out/ agentEditor.js.
#   ./stashflag.sh <threads> [maxAgeMs]     e.g. 16 (shipped), 2
#   ./stashflag.sh restore                  back to the source's values (node build/volt/syncOut.mjs)
ROOT=${0:A:h}/../../../../../..
F=$ROOT/out/vs/workbench/contrib/voltAgent/browser/editor/agentEditor.js
if [[ $1 == restore ]]; then (cd $ROOT && node build/volt/syncOut.mjs src/vs/workbench/contrib/voltAgent/browser/editor/agentEditor.ts); exit; fi
sed -i '' -E "s/^const MAX_STASHED_THREADS = [0-9]+;/const MAX_STASHED_THREADS = $1;/" $F
[[ -n $2 ]] && sed -i '' -E "s/^const STASHED_THREAD_MAX_AGE_MS = .*;/const STASHED_THREAD_MAX_AGE_MS = $2;/" $F
grep -n -E "^const (MAX_STASHED_THREADS|STASHED_THREAD_MAX_AGE_MS) = " $F
