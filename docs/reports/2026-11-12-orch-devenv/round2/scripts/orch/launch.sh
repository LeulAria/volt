#!/bin/bash
# Starts the orchestrator test window (CDP 9942, profile /tmp/v2-orch-ud). `cap` routes Claude's API
# calls through capproxy.mjs on 9943 (ENABLE_TOOL_SEARCH=true keeps Claude Code's deferred tools on
# behind a proxy, as without one). `stop` ends the window and its agent server.
cd /Users/leularia/Desktop/VOLT/volt-e2e-orch
if [ "$1" = stop ]; then
	pkill -f "user-data-dir /tmp/v2-orch-ud --extensions-dir /tmp/v2-orch-ext"; sleep 3
	pkill -f "volt-agent-server-main.js --user-data-dir /tmp/v2-orch-ud"; exit 0
fi
unset ELECTRON_RUN_AS_NODE
if [ "$1" = cap ]; then export ANTHROPIC_BASE_URL=http://127.0.0.1:9943 ENABLE_TOOL_SEARCH=true; fi
nohup ./scripts/code.sh --user-data-dir /tmp/v2-orch-ud --extensions-dir /tmp/v2-orch-ext --remote-debugging-port=9942 \
	--disable-renderer-backgrounding --disable-backgrounding-occluded-windows --disable-background-timer-throttling /tmp/voltbench/fx > /tmp/v2-orch-launch.log 2>&1 &
