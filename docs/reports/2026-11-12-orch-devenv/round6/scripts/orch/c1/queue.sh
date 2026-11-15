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
cfg=$HOME/.volt-r6/orch/c1/cfg-clean
# The clean config dir holds the live login's access token only (no refresh token): copy it fresh before every run
# and stop the queue when it has under 25 minutes left (round 6's first C1 queue ran on an expired token: all 401).
tokenMinutes() { python3 -c "import json,time; print(int((json.load(open('$cfg/.credentials.json'))['claudeAiOauth']['expiresAt']/1000-time.time())/60))"; }
# The account's 7-day use (the proxy keeps the API's anthropic-ratelimit-unified-* headers on each row): with no
# overage, 100 % blocks every Claude client of the account until the reset, so the queue stops at RL_STOP (0.97).
RL_STOP=${RL_STOP:-0.97}
rl7d() { python3 -c "
import json
u=None
for l in open('$HOME/.volt-r6/orch/c1/capture.jsonl'):
    try: r=json.loads(l)
    except Exception: continue
    v=(r.get('rl') or {}).get('7d-utilization')
    if v is not None: u=v
print(u or 0)"; }
# Wait (up to 10 min) until no Opus request went through the proxy for 60 s: rows are attributed to a run by time
# alone, so a chat a relaunch resumed on its own must be over before t0.
quiet() { python3 -c "
import json,time
for i in range(60):
    last=0
    for l in open('$HOME/.volt-r6/orch/c1/capture.jsonl'):
        try: r=json.loads(l)
        except Exception: continue
        if 'opus' in str(r.get('model')): last=r['t']
    if time.time()*1000-last>60000: print('quiet'); break
    time.sleep(10)
else: print('not quiet after 10 min')"; }
for spec in "$@"; do
  arm=${spec%%:*}; id=${spec#*:}
  CLEAN=1 sh "$here/mkcfg.sh" "$cfg"
  left=$(tokenMinutes)
  if [ "$left" -lt 25 ]; then echo "$(date -u +%FT%TZ) stop: access token has $left min left" >> "$log"; exit 1; fi
  used=$(rl7d)
  if python3 -c "import sys; sys.exit(0 if float('$used') >= float('$RL_STOP') else 1)"; then echo "$(date -u +%FT%TZ) stop: 7-day use at $used (stop at $RL_STOP)" >> "$log"; exit 1; fi
  echo "$(date -u +%FT%TZ) start $arm $id (token $left min, 7d $used, $(quiet))" >> "$log"
  case $arm in
    after)
      VOLT_UD=$HOME/.volt-r6/orch/ud VOLT_CDP=9971 node "$here/lockrun.mjs" node "$here/runvolt.mjs" run "$id" --model-row 'Opus 5.5 Medium' >> "$HOME/.volt-r6/orch/c1/run-$id.out" 2>&1 ;;
    before)
      export VOLT_UD=$HOME/.volt-r6/orch/ud-base VOLT_CDP=9978
      node "$here/runvolt.mjs" launch --checkout "$BEFORE_CHECKOUT" >> "$HOME/.volt-r6/orch/c1/run-$id.out" 2>&1
      sleep 20
      echo "$(date -u +%FT%TZ) before instance up: $(quiet)" >> "$log"
      node "$here/lockrun.mjs" node "$here/runvolt.mjs" run "$id" --model-row 'Opus 5.5 Medium' >> "$HOME/.volt-r6/orch/c1/run-$id.out" 2>&1
      node "$here/runvolt.mjs" stop >> "$HOME/.volt-r6/orch/c1/run-$id.out" 2>&1
      unset VOLT_UD VOLT_CDP ;;
    solo)
      CLAUDE_BIN=/opt/homebrew/lib/node_modules/@agentclientprotocol/claude-agent-acp/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude \
        node "$here/lockrun.mjs" node "$here/runcli.mjs" "$id" solo --effort medium >> "$HOME/.volt-r6/orch/c1/run-$id.out" 2>&1 ;;
  esac
  echo "$(date -u +%FT%TZ) done $arm $id status $?" >> "$log"
  # A refused run (401 auth, 429 limit) stops the queue: record it, never loop on it.
  if tail -1 "$here/../../../data/orch/c1/c1-runs.jsonl" 2>/dev/null | grep -Eq "\"id\":\"$id\".*(refused request|\"tokensTotal\":0,)"; then
    echo "$(date -u +%FT%TZ) stop: $id ended on a refused request" >> "$log"; exit 1
  fi
done
