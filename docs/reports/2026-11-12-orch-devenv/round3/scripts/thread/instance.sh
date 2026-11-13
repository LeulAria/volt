#!/bin/bash
# Start/stop the round-3 thread test instance: one Volt dev window on CDP $PORT with profile $UD,
# plus the agent server it spawns for that profile. Only processes whose command line holds $UD
# are stopped.
#   instance.sh start|stop|restart [worktree]
UD=${UD:-/tmp/v3-thread-ud}
PORT=${PORT:-9953}
REPO=${REPO:-/tmp/v3-thread-repo}
WT=${2:-/Users/leularia/Desktop/VOLT/volt-e3-thread}

stop() {
	for pid in $(pgrep -f -- "--user-data-dir[ =]$UD( |$)"); do
		cmd=$(ps -o command= -p "$pid" 2>/dev/null)
		case "$cmd" in
			*"$UD"*) kill "$pid" 2>/dev/null ;;
		esac
	done
	for i in $(seq 1 30); do
		pgrep -f -- "--user-data-dir[ =]$UD( |$)" >/dev/null || break
		sleep 0.5
	done
	for pid in $(pgrep -f -- "--user-data-dir[ =]$UD( |$)"); do kill -9 "$pid" 2>/dev/null; done
	for label in $(launchctl list 2>/dev/null | awk '{print $3}' | grep '^com.volt.agent-server.'); do
		if launchctl print "gui/$(id -u)/$label" 2>/dev/null | grep -q -- "$UD"; then
			launchctl bootout "gui/$(id -u)/$label" 2>/dev/null
		fi
	done
}

start() {
	cd "$WT" || exit 1
	unset ELECTRON_RUN_AS_NODE
	nohup ./scripts/code.sh --user-data-dir "$UD" --extensions-dir /tmp/v3-thread-ext --remote-debugging-port=$PORT \
		--disable-renderer-backgrounding --disable-backgrounding-occluded-windows --disable-background-timer-throttling \
		"$REPO" > /tmp/v3-thread-win.log 2>&1 &
	for i in $(seq 1 120); do
		curl -s "http://127.0.0.1:$PORT/json" | grep -q workbench && break
		sleep 0.5
	done
	echo "window up on $PORT"
}

case "$1" in
	start) start ;;
	stop) stop ;;
	restart) stop; start ;;
	*) echo "usage: $0 start|stop|restart [worktree]"; exit 2 ;;
esac
