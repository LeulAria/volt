#!/bin/zsh
# The floor under the ACP adapter, interleaved per round with the adapter runs (order rotated):
#   fl-sdk  = Claude Code through the Agent SDK, no adapter, the adapter's settings sources and Volt's MCP server (stub)
#   fl-base = the adapter as shipped, fl-volt = the adapter with Volt's preload
# Each repetition waits until the 1-minute load is at most LOAD_MAX (default 14). Needs tap.mjs (18944) and mcpstub.mjs (18945).
#   ./floor.sh <rounds>
here=${0:A:h}; rounds=${1:-10}; LOAD_MAX=${LOAD_MAX:-14}
variants=("acp fl-base" "acp fl-volt volt" "sdk fl-sdk settings mcp")
gate() { while (( $(uptime | sed 's/.*averages*: *//' | cut -d' ' -f1) > LOAD_MAX )); do sleep 20; done; }
for r in $(seq 1 $rounds); do
  for i in 1 2 3; do
    v=(${=variants[$(( (i + r) % 3 + 1 ))]})
    gate
    if [[ $v[1] == acp ]]; then
      node $here/acpbench.mjs $v[2] 1 ${v[3,-1]} warm=5000 | head -1
    else
      node $here/sdkbench.mjs $v[2] 1 ${v[3,-1]} warm=5000 | head -1
    fi
  done
done
echo done
