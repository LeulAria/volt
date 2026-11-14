#!/bin/zsh
# usage: run.sh <ro 0|1> <tag> [claude binary]
RO=$1; TAG=$2; BIN=${3:-claude}
D=/tmp/v4orch/mcpprobe; LOG=$D/$TAG.calls.jsonl; rm -f $LOG
cat > $D/$TAG.mcp.json <<J
{"mcpServers":{"probe":{"command":"node","args":["$D/server.mjs"],"env":{"PROBE_LOG":"$LOG","PROBE_RO":"$RO"}}}}
J
unset CLAUDECODE ELECTRON_RUN_AS_NODE
cd $D && $BIN -p 'Call mcp__probe__probe three times in parallel, all in this one message, with n=1, 2 and 3; give each a note of about 60 words describing a different imaginary job. Then reply: done' --model claude-haiku-5-5 --mcp-config $D/$TAG.mcp.json --strict-mcp-config --output-format stream-json --verbose --include-partial-messages --permission-mode ${PMODE:-bypassPermissions} ${PEXTRA} | node -e '
let t0=Date.now(); const rl=require("readline").createInterface({input:process.stdin});
rl.on("line",l=>{const m=JSON.parse(l); const e=m.event; const at=Date.now();
 if(m.type==="stream_event"&&(e.type==="content_block_stop"||e.type==="message_stop"||e.type==="content_block_start")) console.log(at, e.type, e.content_block?.name||"");
 if(m.type==="user") console.log(at,"tool_result");});' > $D/$TAG.stream.txt
cat $D/$TAG.stream.txt; echo calls:; cat $LOG
