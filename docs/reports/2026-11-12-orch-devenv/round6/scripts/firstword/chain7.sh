#!/bin/zsh
# Round 6 firstword, chain 7 (adapter level, the round-5 chain 4/6 question answered): Claude Code's first command
# in headless mode waits for every MCP server still connecting (explicit --mcp-config: deadline MCP_TIMEOUT), and the
# account's claude.ai connectors are connecting 0.4-1.1 s after the session is ready. The fix is the host setting
# CLAUDE_CODE_MCP_STARTUP_WAIT_MS=0 plus `mcp__volt` in the session's allow rules (Volt's server stays required).
# Prompt 400 ms after ready (inside the window) and at once (A4's case), default vs fix, interleaved per round, under
# the timing lock at load <= 14. Rows -> ../../data/firstword/resumebench.jsonl, labels r6-c7-*.
# (Its first run, 02:43, looped `for v in $variants`: zsh drops the empty element, so only the fix arm ran; the
# loops now quote the array. chain9.sh re-runs it.)
#   ./chain7.sh [rounds=5]
cd ${0:A:h}
source ./timing.sh
export LOAD_MAX=14
export STUB_PORT=${STUB_PORT:-18985}
rounds=${1:-5}
R6=$HOME/.volt-r6/firstword
echo $$ > $R6/chain7.pid
for r in $(seq 1 $rounds); do
	take_timing
	variants=("" "env:CLAUDE_CODE_MCP_STARTUP_WAIT_MS=0 allow=mcp__volt")
	(( r % 2 == 0 )) && variants=("env:CLAUDE_CODE_MCP_STARTUP_WAIT_MS=0 allow=mcp__volt" "")
	for v in "${variants[@]}"; do
		node resumebench.mjs r6-c7-window 1 warm=400 ${=v}
	done
	for v in "${variants[@]}"; do
		node resumebench.mjs r6-c7-atonce 1 warm=0 ${=v}
	done
	drop_timing
done
echo "chain7 done $(date)"
