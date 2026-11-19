#!/bin/zsh
# node-free launcher: start an arm with a Chromium startup trace (file in out/trace/<arm>-startup.json), wait, Cmd+Q via CDP.
ARM=$1; DUR=${2:-6}; R=~/.volt-r6/launch
APP=$R/apps/$ARM/VOLT.app; UD=$R/ud/$ARM; H=$R/h/$ARM; OUT=$R/out/trace/$ARM-startup.json
unset ELECTRON_RUN_AS_NODE; mkdir -p $R/out/trace
rm -f $OUT
CATS='v8,v8.execute,devtools.timeline,disabled-by-default-v8.compile,disabled-by-default-devtools.timeline,blink,blink.user_timing,loading,toplevel,disabled-by-default-v8.runtime_stats_sampling,disabled-by-default-devtools.timeline.frame'
open -n -a $APP --env HOME=$H --env PATH=$H/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin --env DISABLE_AUTOUPDATER=1 --args --use-mock-keychain --user-data-dir $UD --extensions-dir $H/.volt/extensions --remote-debugging-port=9974 "--trace-startup=$CATS" "--trace-startup-file=$OUT" "--trace-startup-duration=$DUR" "--trace-startup-format=json"
for i in $(seq 1 40); do [ -s $OUT ] && break; sleep 1; done; sleep 2
ls -la $OUT
