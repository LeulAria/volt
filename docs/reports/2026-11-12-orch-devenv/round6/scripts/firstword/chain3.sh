#!/bin/zsh
# Round 5 firstword, chain 3 (adapter level, after chain 2): what a cold first prompt waits for in Claude Code, prompt
# sent the moment the session is ready, variants interleaved per round under the timing lock at load <= 14:
#   base, nomcp (no Volt MCP server), nometa (no _meta: Volt's prompt append, hooks, plugin), no claude.ai connectors
cd ${0:A:h}
source ./timing.sh
export LOAD_MAX=14
while kill -0 $(cat ~/.volt-r6/firstword/chain2.pid) 2>/dev/null; do sleep 30; done
for r in 1 2 3 4 5 6; do
	take_timing
	for v in "" "nomcp" "nometa" "env:ENABLE_CLAUDEAI_MCP_SERVERS=false"; do
		node resumebench.mjs r5-why 1 ${=v}
	done
	drop_timing
done
echo "chain3 done $(date)"
