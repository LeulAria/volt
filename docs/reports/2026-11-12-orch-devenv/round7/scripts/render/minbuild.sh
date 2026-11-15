#!/bin/zsh
# Round 7 render's minified "after" build under ~/.volt-r7/heavy.lock (round 6's launch/minbuild.sh, core mode:
# .build/extensions reused), in the nested tree <x>/volt (output <x>/VSCode-darwin-arm64). Copies the app to
# ~/.volt-r7/render/min/VOLT.app, stamps product.json's commit (no commit = no V8 code cache) and writes READY
# (arm.sh's `minafter`).
#   minbuild.sh [repo=/Users/leularia/Desktop/VOLT/volt-e5-min-render/volt]
REPO=${1:-/Users/leularia/Desktop/VOLT/volt-e5-min-render/volt}
LOCK=~/.volt-r7/heavy.lock
OUT=~/.volt-r7/render/min
cd "$REPO" || exit 1
until mkdir $LOCK 2>/dev/null; do echo "waiting for heavy lock ($(cat $LOCK/owner 2>/dev/null)) $(date +%T)"; sleep 30; done
echo "render minbuild $REPO pid $$ start $(date)" > $LOCK/owner
trap 'rm -rf $LOCK' EXIT
cp extensions/volt-provider-claude/package.json .build/extensions/volt-provider-claude/package.json
export PATH="$HOME/.nvm/versions/node/v22.19.0/bin:$PATH"
unset ELECTRON_RUN_AS_NODE
export VOLT_BUILD_IGNORE_TYPE_ERRORS=1
G="nice -n 5 node --max-old-space-size=16384 ./node_modules/gulp/bin/gulp.js"
echo "at $(git log --oneline -1)"
echo "start $(date) load $(uptime | sed 's/.*averages: //')"
eval $G compile-build-with-mangling && eval $G minify-vscode && eval $G vscode-darwin-arm64-min-ci
RC=$?
echo "exit $RC $(date) load $(uptime | sed 's/.*averages: //')"
[ $RC = 0 ] || exit $RC
mkdir -p $OUT
rm -rf $OUT/VOLT.app
ditto "${REPO:h}/VSCode-darwin-arm64/VOLT.app" $OUT/VOLT.app
python3 -c 'import json,sys; p=sys.argv[1]; d=json.load(open(p)); d["commit"]=sys.argv[2]; json.dump(d, open(p,"w"), indent="\t")' \
	$OUT/VOLT.app/Contents/Resources/app/product.json "$(git rev-parse HEAD)"
echo "$OUT/VOLT.app" > $OUT/READY
echo "$(git rev-parse HEAD) built $(date)" >> $OUT/READY
echo "installed $(date)"
