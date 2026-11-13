#!/bin/bash
# T3's remote tests (4-6) against an installed Volt's agent server (release bundle) on :9958, via
# slowlink.mjs on :9959 (Slow 3G: 400 ms RTT, 400 kbit/s) and straight; headless Chrome on :9957.
# Each step waits for the 1-minute load to be at or below $MAXLOAD.
#   remote-suite.sh <tag> [steps]     steps: launch reconnect terminal terminal-direct
set -e
TAG=${1:-r1}
STEPS=${2:-"launch reconnect terminal terminal-direct"}
MAXLOAD=${MAXLOAD:-14}
HERE=$(cd "$(dirname "$0")" && pwd)
DATA=${DATA:-$HERE/../../data/thread/remote}
mkdir -p "$DATA"
cd "$HERE"
waitload() {
	while :; do
		l=$(uptime | sed -E 's/.*load averages?: ([0-9.]+).*/\1/')
		if awk "BEGIN{exit !($l <= $MAXLOAD)}"; then return; fi
		echo "load $l > $MAXLOAD, waiting"
		sleep 30
	done
}
# The installed app's agent server, own profile; it stops itself after 15 idle minutes.
ensure_server() {
	curl -s -o /dev/null -m 2 http://127.0.0.1:9958/ && return
	ELECTRON_RUN_AS_NODE=1 nohup /Applications/Volt.app/Contents/MacOS/Electron /Applications/Volt.app/Contents/Resources/app/out/volt-agent-server-main.js \
		--user-data-dir /tmp/v3-thread-rel --port 9958 >> /tmp/v3-thread-rel.log 2>&1 &
	echo $! > ~/.volt-r3/thread/rel.pid
	for i in $(seq 1 60); do curl -s -o /dev/null -m 2 http://127.0.0.1:9958/ && break; sleep 0.5; done
	# Sign the headless page in (loopback session) and leave it blank, so the timed load is a fresh one.
	node -e "
		import('$HERE/lib.mjs').then(async ({ connect, sleep }) => {
			const c = await connect(9957, /.*/); await c.send('Page.navigate', { url: 'http://127.0.0.1:9958/' }); await sleep(8000);
			await c.send('Page.navigate', { url: 'about:blank' }); await sleep(500); c.close();
		});"
}
for s in $STEPS; do
	waitload
	ensure_server
	echo "== $TAG $s"
	case $s in
		launch) node web-bench.mjs --mode launch --url http://127.0.0.1:9959/code/ --runs 1 --out "$DATA/$TAG-launch-slow3g.json" ;;
		reconnect) node web-bench.mjs --mode reconnect --url http://127.0.0.1:9959/code/ --runs 3 --out "$DATA/$TAG-reconnect-slow3g.json" ;;
		terminal) node web-bench.mjs --mode terminal --url http://127.0.0.1:9959/code/ --runs 3 --out "$DATA/$TAG-terminal-slow3g.json" ;;
		terminal-direct) node web-bench.mjs --mode terminal --url http://127.0.0.1:9958/code/ --runs 3 --out "$DATA/$TAG-terminal-direct.json" ;;
	esac
done
