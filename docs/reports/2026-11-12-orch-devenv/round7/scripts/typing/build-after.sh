#!/bin/zsh
# Round 7 typing "after" release build under ~/.volt-r7/heavy.lock, in the nested tree volt-e5-min-typing/volt
# (deps cloned from the coordinator's min tree), as ~/.volt-r7/min/build-base.sh builds the shared "before":
# compile-build-with-mangling + minify-vscode + vscode-darwin-arm64-min-ci, product.json commit stamped (V8 code cache).
#   build-after.sh [rev=e7/typing]
REV=${1:-e7/typing}
T=/Users/leularia/Desktop/VOLT/volt-e5-min-typing/volt
LOCK=~/.volt-r7/heavy.lock
cd $T || exit 1
until mkdir $LOCK 2>/dev/null; do echo "waiting for heavy lock ($(cat $LOCK/owner 2>/dev/null)) $(date +%T)"; sleep 30; done
trap 'rm -rf $LOCK' EXIT
# Checked out once the lock is ours: commits made while waiting are in the build.
git checkout -q --detach "$REV" || exit 1
cp extensions/volt-provider-claude/package.json .build/extensions/volt-provider-claude/package.json
echo "typing after build $(git rev-parse --short HEAD) pid $$ start $(date)" > $LOCK/owner
export PATH="$HOME/.nvm/versions/node/v22.19.0/bin:$PATH"
unset ELECTRON_RUN_AS_NODE
export VOLT_BUILD_IGNORE_TYPE_ERRORS=1
G="nice -n 5 node --max-old-space-size=16384 ./node_modules/gulp/bin/gulp.js"
echo "at $(git log --oneline -1)"; echo "start $(date) load $(uptime | sed 's/.*averages: //')"
eval $G compile-build-with-mangling && eval $G minify-vscode && eval $G vscode-darwin-arm64-min-ci
RC=$?; echo "exit $RC $(date) load $(uptime | sed 's/.*averages: //')"
[ $RC = 0 ] || exit $RC
SRC=/Users/leularia/Desktop/VOLT/volt-e5-min-typing/VSCode-darwin-arm64/VOLT.app
FULL=$(git rev-parse HEAD)
mkdir -p ~/.volt-r7/typing/min
rm -rf ~/.volt-r7/typing/min/VOLT.app; ditto "$SRC" ~/.volt-r7/typing/min/VOLT.app
python3 -c 'import json,sys; p=sys.argv[1]; d=json.load(open(p)); d["commit"]=sys.argv[2]; json.dump(d, open(p,"w"), indent="\t")' \
	~/.volt-r7/typing/min/VOLT.app/Contents/Resources/app/product.json "$FULL"
echo "$HOME/.volt-r7/typing/min/VOLT.app" > ~/.volt-r7/typing/min/READY
echo "installed $FULL $(date)"
