#!/bin/sh
# Round 6 C1 queue: every run under the timing lock at load <= 14 (lockrun.mjs), one after another, Opus 5.5 medium.
# Arms: volt after (this branch, CDP 9971, profile ~/.volt-r6/orch/ud), volt before (volt-e5-base, CDP 9978, profile
# ~/.volt-r6/orch/ud-base), Claude Code solo (runcli.mjs, --effort medium). The after instance must be up before the
# first after run; the before instance is launched for its run and stopped after it.
#   sh queue.sh <run-spec>...      run-spec: after:<id> | before:<id> | solo:<id>
# Log: ~/.volt-r6/orch/c1/queue.log
set -u
here=$(cd "$(dirname "$0")" && pwd)
log=$HOME/.volt-r6/orch/c1/queue.log
AFTER_CHECKOUT=/Users/leularia/Desktop/VOLT/volt-e5-orch
BEFORE_CHECKOUT=/Users/leularia/Desktop/VOLT/volt-e5-base
for spec in "$@"; do
  arm=${spec%%:*}; id=${spec#*:}
  echo "$(date -u +%FT%TZ) start $arm $id" >> "$log"
  case $arm in
    after)
      VOLT_UD=$HOME/.volt-r6/orch/ud VOLT_CDP=9971 node "$here/lockrun.mjs" node "$here/runvolt.mjs" run "$id" --model-row 'Opus 5.5 Medium' >> "$HOME/.volt-r6/orch/c1/run-$id.out" 2>&1 ;;
    before)
      export VOLT_UD=$HOME/.volt-r6/orch/ud-base VOLT_CDP=9978
      node "$here/runvolt.mjs" launch --checkout "$BEFORE_CHECKOUT" >> "$HOME/.volt-r6/orch/c1/run-$id.out" 2>&1
      sleep 20
      node "$here/lockrun.mjs" node "$here/runvolt.mjs" run "$id" --model-row 'Opus 5.5 Medium' >> "$HOME/.volt-r6/orch/c1/run-$id.out" 2>&1
      node "$here/runvolt.mjs" stop >> "$HOME/.volt-r6/orch/c1/run-$id.out" 2>&1
      unset VOLT_UD VOLT_CDP ;;
    solo)
      node "$here/lockrun.mjs" node "$here/runcli.mjs" "$id" solo --effort medium >> "$HOME/.volt-r6/orch/c1/run-$id.out" 2>&1 ;;
  esac
  echo "$(date -u +%FT%TZ) done $arm $id status $?" >> "$log"
done
