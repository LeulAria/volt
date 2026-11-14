#!/bin/zsh
# Round 5 firstword, chain 6 (adapter level, after chain 5): chain 4 found that a prompt sent 400-800 ms after the
# session is ready waits until about 1.1 s after ready, and the CLI's debug log shows the claude.ai connectors
# (fetched over the network after start) connecting in that window. Prompt 400 ms after ready with Volt's params, with
# the claude.ai connectors off, and with no MCP server at all; interleaved per round, under the timing lock at load <= 14.
cd ${0:A:h}
source ./timing.sh
export LOAD_MAX=14
R5=$HOME/.volt-r5/firstword
while kill -0 $(cat $R5/chain5.pid) 2>/dev/null; do sleep 5; done
./setup.sh replay
nohup node tap.mjs 18974 18972 $R5/tap.jsonl > $R5/tap.out 2>&1 &
TAP=$!
nohup node mcpstub.mjs 18975 > $R5/mcpstub.out 2>&1 &
STUB=$!
trap 'kill $TAP $STUB 2>/dev/null; pkill -f "replay/server.ts --port 18972"; drop_timing' EXIT
sleep 1
for r in 1 2 3 4 5; do
	take_timing
	for v in "" "env:ENABLE_CLAUDEAI_MCP_SERVERS=false" "nomcp" "nomcp env:ENABLE_CLAUDEAI_MCP_SERVERS=false"; do
		node resumebench.mjs r5-window 1 warm=400 ${=v}
	done
	drop_timing
done
echo "chain6 done $(date)"
