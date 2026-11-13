#!/bin/bash
# Remote A/B on a release-shaped server: hybrid-server.mjs builds the installed Volt's app folder
# with this worktree's server at base and at new (once, before round 1); each round runs base then
# new: start that server on :9962 (own profile), slowlink.mjs on :9976 (Slow 3G, control :9977),
# pair the headless phone page (Chrome :9957) through the link at full speed and load /code/ once
# (so the server has its compressed copies ready), then a cold-cache launch over the slow link.
# The link rewrites Host/Origin (--rewrite): the server's host check sees its own address. The new side's profile gets its brotli-11 copies first (premake-copies.mjs), the state the
# branch's server keeps after a phone's first visit. Each sample waits for load <= $MAXLOAD.
#   remote-ab.sh <rounds> [extra steps on the last new server: reconnect terminal terminal-fast]
set -e
ROUNDS=${1:-3}
EXTRA=${2:-}
MAXLOAD=${MAXLOAD:-14}
HERE=$(cd "$(dirname "$0")" && pwd)
DATA=${DATA:-$HERE/../../data/thread/remote}
STATE=~/.volt-r3/thread
mkdir -p "$DATA" "$STATE"
cd "$HERE"
EL=/Applications/Volt.app/Contents/MacOS/Electron

stop_server() {
	[ -f "$STATE/hyb.pid" ] && kill "$(cat "$STATE/hyb.pid")" 2>/dev/null || true
	for i in $(seq 1 20); do curl -s -o /dev/null -m 1 http://127.0.0.1:9962/ || break; sleep 0.5; done
}
start_server() {
	stop_server
	ELECTRON_RUN_AS_NODE=1 nohup "$EL" "/tmp/v3-thread-hyb-$1/out/volt-agent-server-main.js" \
		--user-data-dir "/tmp/v3-thread-hyb-ud-$1" --port 9962 >> "/tmp/v3-thread-hyb-$1.log" 2>&1 &
	echo $! > "$STATE/hyb.pid"
	for i in $(seq 1 240); do curl -s -o /dev/null -m 2 http://127.0.0.1:9962/ && break; sleep 0.5; done
	# Pair the page's origin (the proxy's, 127.0.0.1:9976) with a code made with the server's own
	# token, over the link at full speed, and let /code/ load once so the compressed copies exist.
	curl -s -o /dev/null http://127.0.0.1:9977/fast
	CODE=$(curl -s -X POST -H "Authorization: Bearer $(cat "/tmp/v3-thread-hyb-ud-$1/agentServer/token")" http://127.0.0.1:9962/api/auth/code | node -pe 'JSON.parse(require("fs").readFileSync(0)).code')
	node -e "
		import('$HERE/lib.mjs').then(async ({ connect, sleep }) => {
			const c = await connect(9957, /.*/);
			// Empty the cache: the bundle is immutable, and a cached copy would never reach this server.
			await c.send('Network.enable'); await c.send('Network.clearBrowserCache');
			await c.send('Page.navigate', { url: 'http://127.0.0.1:9976/#code=$CODE' });
			let ok = false;
			for (let i = 0; i < 120 && !ok; i++) {
				await sleep(1000);
				ok = await c.evaluate('!!document.querySelector(\".volt-agent-editor .monaco-editor .view-lines\")').catch(() => false);
			}
			console.log(ok ? 'paired, composer on screen' : 'warm-up: no composer in 120 s');
			await sleep(5000);
			await c.send('Page.navigate', { url: 'about:blank' }); await sleep(1000); c.close();
		});"
	curl -s -o /dev/null http://127.0.0.1:9977/slow
}
ensure_link() {
	curl -s -o /dev/null -m 2 http://127.0.0.1:9977/stats && return
	nohup node slowlink.mjs --listen 9976 --target 127.0.0.1:9962 --control 9977 --rewrite > /tmp/v3-thread-slowlink2.log 2>&1 &
	echo $! > "$STATE/slowlink2.pid"
	sleep 1
}
waitload() {
	while :; do
		l=$(uptime | sed -E 's/.*load averages?: ([0-9.]+).*/\1/')
		if awk "BEGIN{exit !($l <= $MAXLOAD)}"; then return; fi
		echo "load $l > $MAXLOAD, waiting"
		sleep 30
	done
}

if [ "$ROUNDS" = smoke ]; then
	ensure_link
	start_server "${2:-new}"
	exit
fi
[ -f /tmp/v3-thread-hyb-base/out/volt-agent-server-main.js ] || node hybrid-server.mjs base
[ -f /tmp/v3-thread-hyb-new/out/volt-agent-server-main.js ] || node hybrid-server.mjs new
node premake-copies.mjs /tmp/v3-thread-hyb-new /tmp/v3-thread-hyb-ud-new
ensure_link
for r in $(seq 1 "$ROUNDS"); do
	for side in base new; do
		waitload
		start_server "$side"
		# Bytes a launch downloads (CDP encodedDataLength) do not depend on the link's speed; on this
		# rig a launch over the paced link took over 10 minutes on both sides (24-26 MB through the
		# link, most of it WebSocket traffic), so the launch runs with pacing off.
		echo "== hyb-$side r$r launch"
		curl -s -o /dev/null http://127.0.0.1:9977/fast
		node web-bench.mjs --mode launch --url http://127.0.0.1:9976/code/ --control 9977 --runs 1 --out "$DATA/hyb-$side-r$r-launch-fast.json"
		curl -s -o /dev/null http://127.0.0.1:9977/slow
	done
done
for s in $EXTRA; do
	waitload
	echo "== hyb-new $s"
	case $s in
		reconnect) node web-bench.mjs --mode reconnect --url http://127.0.0.1:9976/code/ --control 9977 --runs 3 --out "$DATA/hyb-new-reconnect-slow3g.json" ;;
		terminal) node web-bench.mjs --mode terminal --url http://127.0.0.1:9976/code/ --control 9977 --runs 3 --out "$DATA/hyb-new-terminal-slow3g.json" ;;
		# The same page and origin with the link's pacing off (the paired origin is the link's).
		terminal-fast) curl -s -o /dev/null http://127.0.0.1:9977/fast
			node web-bench.mjs --mode terminal --url http://127.0.0.1:9976/code/ --control 9977 --runs 3 --out "$DATA/hyb-new-terminal-fast.json"
			curl -s -o /dev/null http://127.0.0.1:9977/slow ;;
	esac
done
stop_server
echo REMOTE-AB-DONE
