#!/bin/zsh
# Round 7 agents "after" minified build, under the shared heavy lock (round 6 launch's minbuild.sh with r7 paths).
# Builds the current head of e7/agents in the nested tree /Users/leularia/Desktop/VOLT/volt-e5-min-agents/volt
# (node_modules and .build/{electron,extensions,...} cloned from the coordinator's base tree: no extension changes),
# stamps product.json's commit (no commit = no V8 code cache) and installs ~/.volt-r7/agents/min/VOLT.app (READY).
#   ./minbuild.sh            (log: ~/.volt-r7/agents/minbuild.log)
REPO=/Users/leularia/Desktop/VOLT/volt-e5-min-agents/volt
OUT=/Users/leularia/Desktop/VOLT/volt-e5-min-agents/VSCode-darwin-arm64
DEST=$HOME/.volt-r7/agents/min
LOCK=$HOME/.volt-r7/heavy.lock
cd "$REPO" || exit 1
git checkout -q --detach e7/agents || exit 1
until mkdir $LOCK 2>/dev/null; do echo "waiting for heavy lock ($(cat $LOCK/owner 2>/dev/null)) $(date +%T)"; sleep 30; done
echo "agents minbuild $REPO pid $$ start $(date)" > $LOCK/owner
trap 'rm -rf $LOCK' EXIT
export PATH="$HOME/.nvm/versions/node/v22.19.0/bin:$PATH"
unset ELECTRON_RUN_AS_NODE
export VOLT_BUILD_IGNORE_TYPE_ERRORS=1
G="nice -n 5 node --max-old-space-size=16384 ./node_modules/gulp/bin/gulp.js"
FULL=$(git rev-parse HEAD)
echo "at $(git log --oneline -1)"
echo "start $(date) load $(uptime | sed 's/.*averages: //')"
eval $G compile-build-with-mangling && eval $G minify-vscode && eval $G vscode-darwin-arm64-min-ci
RC=$?
echo "exit $RC $(date) load $(uptime | sed 's/.*averages: //')"
[ $RC = 0 ] || exit $RC
rm -rf $DEST/VOLT.app && mkdir -p $DEST && cp -cR $OUT/VOLT.app $DEST/VOLT.app || exit 1
python3 -c 'import json,sys; p=sys.argv[1]; d=json.load(open(p)); d["commit"]=sys.argv[2]; json.dump(d, open(p,"w"), indent="\t")' $DEST/VOLT.app/Contents/Resources/app/product.json "$FULL"
echo "$DEST/VOLT.app" > $DEST/READY
echo "$FULL" >> $DEST/READY
echo "installed $(date)"
