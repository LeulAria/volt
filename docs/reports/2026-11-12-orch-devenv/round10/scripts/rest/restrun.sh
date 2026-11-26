#!/bin/zsh
# Round 10 rest rig, one arm, one command (ADEMark method, unofficial):
#   ./restrun.sh <arm> [app path] [parts="a5 a6c a10"]
# arm: r8 | dev, or any name with the path of a VOLT.app (profile ~/.volt-r10/rest/ud-<arm>).
#   a5   fresh profile, 5 seeded threads, quit, relaunch as shipped (no keep-rendering flags), 90 s settle,
#        60 s sample: A5 at rest and A6 front (CPU, wakeups) from the same window, per process role
#   a6c  the next 60 s under ADEMark's cover panel: A6 covered
#   a10  15 more seeded threads (20), 60 s sample at once: rest-20; A10 = (rest-20 - A5) / 15 (a10delta.mjs)
# Holds ~/.volt-r9/timing.lock for the arm (about 9 min); every sample waits for a 1-minute load <= 14.
# Rows: ../../data/rest/rest.jsonl; summary: node summarize.mjs
cd ${0:A:h}
ARM=$1; APPPATH=$2; PARTS=${3:-a5 a6c a10}
[[ -n $APPPATH && $APPPATH != /* ]] && { PARTS=$APPPATH; APPPATH=; }
LOCK=$HOME/.volt-r9/timing.lock
if [[ -z $REST_HAVE_LOCK ]]; then
	until mkdir $LOCK 2>/dev/null; do
		# A lock whose owner pid is dead is stale (brief): remove it.
		opid=$(sed -n 's/.*pid \([0-9]*\).*/\1/p' $LOCK/owner 2>/dev/null)
		[[ -n $opid ]] && ! kill -0 $opid 2>/dev/null && { echo "stale lock of pid $opid removed"; rm -rf $LOCK; continue; }
		sleep 15
	done
	echo "rest restrun $ARM pid $$ start $(date)" > $LOCK/owner
	trap 'node launch.mjs stop >/dev/null 2>&1; grep -qs "pid $$ " $LOCK/owner && rm -rf $LOCK; trap - EXIT; exit' EXIT INT TERM
else
	trap 'node launch.mjs stop >/dev/null 2>&1' EXIT
fi
./stopall.sh
[[ -x $HOME/.volt-r3/speed/native/bin/ademark-native && -d $HOME/.volt-r10/rest/arena/.git ]] && curl -sf http://127.0.0.1:18998/_ademark/health >/dev/null || ./setup.sh
source ./arm.sh $ARM $APPPATH || exit 1
export REST_APP=$APPPATH
echo "== restrun $ARM ($PARTS) $(date -u +%FT%TZ) load $(uptime | sed 's/.*averages: //')"
REST_KEEP_RENDERING=1 ./prep.sh $ARM 5 || { echo "prep failed"; exit 1; }
node launch.mjs stop >/dev/null
node launch.mjs
STEPS=(front:90)
[[ $PARTS == *a6c* ]] && STEPS+=(covered:0)
[[ $PARTS == *a10* ]] && STEPS+=(seed:15 rest-20:0)
# One process for all samples: one CDP session, one focus event (see rest.mjs).
node rest.mjs $ARM $STEPS
node launch.mjs stop >/dev/null
echo "== end $ARM $(date -u +%FT%TZ)"
