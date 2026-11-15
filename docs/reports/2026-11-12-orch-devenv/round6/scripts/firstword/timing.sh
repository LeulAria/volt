#!/bin/zsh
# Shared timing lock (~/.volt-r6/timing.lock, BRIEF-ROUND5.md): `source timing.sh`, then
#   take_timing   waits until the 1-minute load is <= LOAD_MAX (14), no heavy build holds ~/.volt-r6/heavy.lock and the
#                 lock is free, then holds it (a build started mid-round pushes the load past 14 for 20+ minutes)
#   drop_timing   lets it go (hold it at most 25 min at a time)
LOCK=$HOME/.volt-r6/timing.lock
LOAD_MAX=${LOAD_MAX:-14}
load1() { uptime | sed -E 's/.*averages?: *([0-9.]+).*/\1/'; }
take_timing() {
	while true; do
		if (( $(load1) <= LOAD_MAX )) && [[ ! -d $HOME/.volt-r6/heavy.lock ]] && mkdir $LOCK 2>/dev/null; then
			echo "owner firstword pid $$ start $(date) ($(date +%s))" > $LOCK/owner
			echo "[timing] took the lock at $(date +%T), load $(load1)"
			return 0
		fi
		# A lock older than 40 minutes is stale (the brief): say so and take it.
		if [[ -d $LOCK ]] && (( $(date +%s) - $(stat -f %m $LOCK) > 2400 )); then
			echo "[timing] removing a stale lock: $(cat $LOCK/owner 2>/dev/null)" | tee -a $HOME/.volt-r6/firstword/NEXT.md
			rm -rf $LOCK
		fi
		sleep 3
	done
}
drop_timing() { [[ -f $LOCK/owner ]] && grep -q "pid $$ " $LOCK/owner && rm -rf $LOCK && echo "[timing] dropped at $(date +%T)"; }
