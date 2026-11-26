#!/bin/zsh
# Round 8 agents rig, one arm, one command (ADEMark method, unofficial):
#   ./r8run.sh <arm> [app path] [parts="a5 a10 a7"]
# arm: base | r7 | r8 | dev | devbase, or any name with the path of a VOLT.app (profile ~/.volt-r9/procs/ud-<arm>).
#   a5+a10: fresh profile, 5 seeded threads, relaunch, 90 s settle, 60 s sample (A5), 15 more threads, 60 s sample at once (A10)
#   a7:     fresh profile, 5 seeded threads, relaunch, 30 s at rest, 5 replay streams, 180 s sample (A7)
# Holds ~/.volt-r9/timing.lock for the arm (about 16 min for all parts); every sample waits for a 1-minute load <= 14.
# Rows: ../../data/procs/{a5,a7}.jsonl (variant a10-rest-20 is A10's 20-thread sample). Per process: a7procs.mjs <csv>.
cd ${0:A:h}
ARM=$1; APPPATH=$2; PARTS=${3:-a5 a10 a7}
[[ -n $APPPATH && $APPPATH != /* ]] && { PARTS=$APPPATH; APPPATH=; }
LOCK=$HOME/.volt-r9/timing.lock
until mkdir $LOCK 2>/dev/null; do sleep 20; done
echo "agents r8run $ARM pid $$ start $(date)" > $LOCK/owner
trap 'node launch.mjs stop >/dev/null 2>&1; grep -qs "pid $$ " $LOCK/owner && rm -rf $LOCK' EXIT
./stopall.sh
[[ -x $HOME/.volt-r3/speed/native/bin/ademark-native && -d $HOME/.volt-r9/procs/arena/.git ]] && curl -sf http://127.0.0.1:18996/_ademark/health >/dev/null || ./setup.sh
source ./arm.sh $ARM $APPPATH || exit 1
# prep.sh, a5run.sh and a10run.sh source arm.sh by name: an arm given by path keeps its app.
export R8_APP=$APPPATH
echo "== r8run $ARM ($PARTS) $(date -u +%FT%TZ) load $(uptime | sed 's/.*averages: //')"
if [[ $PARTS == *a5* || $PARTS == *a10* ]]; then
	./prep.sh $ARM 5 || { echo "prep failed"; exit 1; }
	./a5run.sh $ARM 90 launch
	[[ $PARTS == *a10* ]] && ./a10run.sh $ARM
	node launch.mjs stop >/dev/null
fi
if [[ $PARTS == *a7* ]]; then
	./prep.sh $ARM 5 || { echo "prep failed"; exit 1; }
	node launch.mjs stop >/dev/null
	node launch.mjs && sleep 30 && node a7.mjs $ARM
	node launch.mjs stop >/dev/null
fi
echo "== end $ARM $(date -u +%FT%TZ)"
