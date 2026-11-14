#!/bin/zsh
# Round 5 minified build under the shared heavy lock.
# usage: minbuild.sh <repo dir (nested: <x>/volt, output lands in <x>/VSCode-darwin-arm64)> [full]
# Default reuses .build/extensions (core compile + minify + package only, as round 4's build-after.sh); "full" runs
# the whole vscode-darwin-arm64-min task.
REPO=$1; MODE=${2:-core}
LOCK=~/.volt-r5/heavy.lock
cd "$REPO" || exit 1
until mkdir $LOCK 2>/dev/null; do echo "waiting for heavy lock ($(cat $LOCK/owner 2>/dev/null)) $(date +%T)"; sleep 30; done
echo "launch minbuild $REPO pid $$ start $(date)" > $LOCK/owner
trap 'rm -rf $LOCK' EXIT
export PATH="$HOME/.nvm/versions/node/v22.19.0/bin:$PATH"
unset ELECTRON_RUN_AS_NODE
export VOLT_BUILD_IGNORE_TYPE_ERRORS=1
G="nice -n 5 node --max-old-space-size=16384 ./node_modules/gulp/bin/gulp.js"
echo "at $(git log --oneline -1)"
echo "start $(date) load $(uptime | sed 's/.*averages: //')"
if [ "$MODE" = full ]; then
	eval $G vscode-darwin-arm64-min
else
	eval $G compile-build-with-mangling && eval $G minify-vscode && eval $G vscode-darwin-arm64-min-ci
fi
RC=$?
echo "exit $RC $(date) load $(uptime | sed 's/.*averages: //')"
exit $RC
