#!/bin/zsh
# The replay server with request dumps and the edit-1 session (functional checks only, never for timed A7 rows).
W=$HOME/.volt-r9/render
pkill -f "replay/server.ts --port 18993" || true
REPLAY_DUMP=$W/dump.jsonl nohup bun $W/replay-dump/bench/replay/server.ts --port 18993 --sessions $W/sessions-edit --log $W/replay.jsonl > $W/replay.out 2>&1 &
sleep 1; curl -sf http://127.0.0.1:18993/_ademark/health && echo up
