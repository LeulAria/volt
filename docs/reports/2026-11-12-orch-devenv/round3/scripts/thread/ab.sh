#!/bin/bash
# Switches the worktree's out/ between the round-3 base (82ae771c1d9) and the branch head for every
# src file this branch changed, then restarts the test instance (the agent server reloads out/ too).
# The working tree's src is left as committed.
#   ab.sh base|new
set -e
BASE=${BASE:-82ae771c1d9}
WT=/Users/leularia/Desktop/VOLT/volt-e3-thread
HERE=$(cd "$(dirname "$0")" && pwd)
cd "$WT"
FILES=$(git diff --name-only "$BASE" HEAD -- 'src/*.ts' | grep -v '/test/' || true)
case "$1" in
	base)
		TMP=$(mktemp -d)
		for f in $FILES; do
			mkdir -p "$TMP/$(dirname "$f")"
			git show "$BASE:$f" > "$TMP/$f" 2>/dev/null || rm -f "$TMP/$f"
		done
		# syncOut compiles paths under src/: swap the files in place, compile, swap back.
		for f in $FILES; do [ -f "$TMP/$f" ] && cp "$f" "$TMP/$f.head" && cp "$TMP/$f" "$f"; done
		node build/volt/syncOut.mjs $FILES >/dev/null
		for f in $FILES; do [ -f "$TMP/$f.head" ] && cp "$TMP/$f.head" "$f"; done
		rm -rf "$TMP"
		;;
	new)
		node build/volt/syncOut.mjs $FILES >/dev/null
		;;
	*) echo "usage: $0 base|new"; exit 2 ;;
esac
echo "out/ = $1 for: $FILES"
"$HERE/instance.sh" restart
