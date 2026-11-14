#!/bin/sh
# How long Claude Code waits for an MCP tool call (HTTP transport): a 90 s tool, without and with MCP_TOOL_TIMEOUT.
#   ./run.sh <claude binary> <label>     (log: ~/.volt-r4/c1/mcp-timeout-<label>.log)
CLI=${1:-claude}; label=${2:-x}; out=$HOME/.volt-r4/c1/mcp-timeout-$label.log
node "$(dirname "$0")/sleepserver.mjs" 19949 >> "$out" 2>&1 &
srv=$!
sleep 1
cfg='{"mcpServers":{"sleep":{"type":"http","url":"http://127.0.0.1:19949/"}}}'
p='Call the sleep tool with seconds 90. Then reply with exactly the text it returned, or the exact error text if it failed.'
for t in "" 600000; do
  echo "== MCP_TOOL_TIMEOUT=${t:-unset} $($CLI --version)" >> "$out"
  s=$(date +%s)
  env -i HOME="$HOME" USER="$USER" PATH="$PATH" TMPDIR="$TMPDIR" CLAUDE_CONFIG_DIR="$HOME/.volt-r4/c1/cfg-clean" ${t:+MCP_TOOL_TIMEOUT=$t} \
    "$CLI" -p "$p" --model claude-haiku-5-5 --mcp-config "$cfg" --strict-mcp-config --allowedTools mcp__sleep__sleep >> "$out" 2>&1
  echo "== took $(( $(date +%s) - s )) s" >> "$out"
done
kill $srv
cat "$out"
