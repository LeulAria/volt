#!/bin/zsh
# usage: floor.sh <out.jsonl> <reps> <mode>...   Times Floor.app (Volt's Electron + floor-main.js) launches: t0 just before
# `open`, winwait for the window, the stub's own marks. Interleaves modes rep by rep; waits for load <= 14 before each.
OUT=$1; N=$2; shift 2; MODES=($@)
APP=~/.volt-r5/launch/floor/Floor.app
cp ${0:A:h}/floor-main.js $APP/Contents/Resources/app/main.js
unset ELECTRON_RUN_AS_NODE
for i in $(seq 1 $N); do
  for m in $MODES; do
    while (( $(uptime | sed 's/.*averages: //' | cut -d' ' -f1 | cut -d. -f1) > 13 )); do sleep 10; done
    LOAD=$(uptime | sed 's/.*averages: //' | cut -d' ' -f1)
    TMP=$(mktemp); TMPL=$(mktemp)
    ~/.volt-r4/coldstart/winwait --prefix $APP --timeout-s 20 > $TMP & WW=$!
    sleep 0.3
    read T0 U0 < <(python3 -c 'import time;print(int(time.time()*1000), time.clock_gettime_ns(time.CLOCK_UPTIME_RAW))')
    open -n -a $APP --env FLOOR_MODE=$m --env FLOOR_LOG=$TMPL
    wait $WW; sleep 2
    python3 - $T0 $U0 $TMP $TMPL $m $LOAD $i >> $OUT <<'P'
import sys,json
t0,u0=int(sys.argv[1]),int(sys.argv[2]); ww=json.load(open(sys.argv[3])); s=json.loads(open(sys.argv[4]).read().strip() or '{}')
r={'mode':sys.argv[5],'rep':int(sys.argv[7]),'load':float(sys.argv[6]),'window_ms':round((ww['t_ns']-u0)/1e6,1) if 't_ns' in ww else None}
for k in ('origin','first','ready','window'):
  if k in s: r[k]=s[k]-t0
print(json.dumps(r))
P
    tail -1 $OUT; rm -f $TMP $TMPL
  done
done
