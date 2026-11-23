#!/bin/zsh
# Dev A/B of the quiet heap reducer (round 10 fix 2) without rebuilding: rewrites the dev build's compiled
# out/vs/base/node/voltQuietHeapReducer.js so the reducer never schedules (off) or works as the source (on).
#   ./qhflag.sh off | on        (restore with `on`; main, extension host and shared process of the next launch use it)
F=/Users/leularia/Desktop/VOLT/volt-e5-weight/out/vs/base/node/voltQuietHeapReducer.js
case $1 in
	off) perl -0pi -e 's/if \((false && )?host\.gc\) \{/if (false && host.gc) {/' $F ;;
	on) perl -0pi -e 's/if \(false && host\.gc\) \{/if (host.gc) {/' $F ;;
	*) echo "qhflag.sh off|on" >&2; exit 1 ;;
esac
grep -c "if (false && host.gc)" $F | sed 's/^0$/on/; s/^1$/off/'
