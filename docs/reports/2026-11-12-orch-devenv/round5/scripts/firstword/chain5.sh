#!/bin/zsh
# Round 5 firstword, chain 5 (adapter level, after chain 4): on a quiet machine, is `session/resume` cheaper than
# `session/new` for the first prompt of a stopped chat? (A relaunched chat starts `session/new` + a recap because Volt
# keeps a stopped chat's session id in memory only; chain 1's comparison ran at load 6-13.) New vs resume, prompt the
# moment the session is ready, interleaved per round, under the timing lock at load <= 14.
cd ${0:A:h}
source ./timing.sh
export LOAD_MAX=14
R5=$HOME/.volt-r5/firstword
while kill -0 $(cat $R5/chain4.pid) 2>/dev/null; do sleep 15; done
./setup.sh replay
nohup node tap.mjs 18974 18972 $R5/tap.jsonl > $R5/tap.out 2>&1 &
TAP=$!
nohup node mcpstub.mjs 18975 > $R5/mcpstub.out 2>&1 &
STUB=$!
trap 'kill $TAP $STUB 2>/dev/null; pkill -f "replay/server.ts --port 18972"; drop_timing' EXIT
sleep 1
for r in 1 2 3 4 5 6; do
	take_timing
	node resumebench.mjs r5-kind 1
	node resumebench.mjs r5-kind 1 resume
	drop_timing
done
echo "chain5 done $(date)"
