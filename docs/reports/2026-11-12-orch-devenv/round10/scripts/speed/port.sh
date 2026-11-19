# Sourced by session10.sh, launch/pair.sh and diag runs: this area's CDP port is 9987 (the round-10 brief). When
# another program listens there (17 Nov: a test server started from the user's own Volt took 127.0.0.1:9987), the
# runs use 9977 instead: lib.mjs reads SMOOTH_CDP, launch/run.ts ADE_CDP_PORT.
if lsof -nP -iTCP:9987 -sTCP:LISTEN 2>/dev/null | grep -qv "VOLT\|Electron\|COMMAND"; then
	export SMOOTH_CDP=9977 ADE_CDP_PORT=9977
else
	export SMOOTH_CDP=9987 ADE_CDP_PORT=9987
fi
