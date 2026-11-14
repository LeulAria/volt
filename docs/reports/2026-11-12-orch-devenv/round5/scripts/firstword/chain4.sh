#!/bin/zsh
# Round 5 firstword, chain 4 (adapter level): does a prompt that lands a little while after the session is ready wait
# for Claude Code's own start-up work? In the app, a restored chat warmed 0.6-0.9 s before the send had its turn's
# request leave ~0.6 s after the prompt, while a prompt sent the moment the session is ready (chain 1/3) or 2 s later
# left in ~0.1 s. Prompt at warm = 0, 400, 800, 1200, 2500 ms after ready, interleaved per round, under the timing
# lock at load <= 14; then one run with the CLI's debug log at warm=800 (structure only, label r5-gap-debug).
# Starts the replay server, the tap and the MCP stub, and stops them at the end.
cd ${0:A:h}
source ./timing.sh
export LOAD_MAX=14
R5=$HOME/.volt-r5/firstword
./setup.sh replay
nohup node tap.mjs 18974 18972 $R5/tap.jsonl > $R5/tap.out 2>&1 &
TAP=$!
nohup node mcpstub.mjs 18975 > $R5/mcpstub.out 2>&1 &
STUB=$!
trap 'kill $TAP $STUB 2>/dev/null; pkill -f "replay/server.ts --port 18972"; drop_timing' EXIT
sleep 1
for r in 1 2 3 4 5; do
	take_timing
	for w in 0 400 800 1200 2500; do
		node resumebench.mjs r5-gap 1 warm=$w
	done
	drop_timing
done
take_timing
node resumebench.mjs r5-gap-debug 1 warm=800 debug
drop_timing
echo "chain4 done $(date)"
