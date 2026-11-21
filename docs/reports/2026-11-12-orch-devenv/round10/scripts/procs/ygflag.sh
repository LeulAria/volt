#!/bin/zsh
# Dev A/B of the young-generation cap (round 9 fix 1) without rebuilding: rewrites the dev build's compiled
# out/vs/base/node/voltNodeHelperHeap.js so nodeHelperHeapFlags() returns [] (off) or the cap of <MB> (on = src's 4).
#   ./ygflag.sh off | on | <MB> | hg<percent> (cap 4 + --heap-growing-percent) | insp (cap 4 + inspector on 9239, for srvprof.mjs)      (restore with `on`; the next launch's agent server and adapter host use it)
F=/Users/leularia/Desktop/VOLT/volt-e5-weight/out/vs/base/node/voltNodeHelperHeap.js
case $1 in
	off) R='return [];' ;;
	on) R='return [`--max-semi-space-size=${NODE_HELPER_MAX_SEMI_SPACE_MB}`];' ;;
	insp) R="return ['--max-semi-space-size=4', '--inspect=127.0.0.1:9239'];" ;;
	hg*) R="return ['--max-semi-space-size=4', '--heap-growing-percent=${1#hg}'];" ;;
	*) R="return ['--max-semi-space-size=$1'];" ;;
esac
python3 - "$F" "$R" <<'PY'
import re, sys
f, r = sys.argv[1], sys.argv[2]
s = open(f).read()
s = re.sub(r'(export function nodeHelperHeapFlags\(\) \{\n\t)return [^\n]*', lambda m: m.group(1) + r, s)
open(f, 'w').write(s)
PY
grep -A1 "export function nodeHelperHeapFlags" $F | tail -1
