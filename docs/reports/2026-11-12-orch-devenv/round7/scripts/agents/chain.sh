#!/bin/zsh
# weight's unattended chain (round 6): 1) build the minified after build of e6/weight's tip in the nested tree
# (heavy lock), 2) wait for the shared minified before build, 3) interleaved A5/A9/A10 blocks and A7 blocks on both
# minified builds (timing lock inside each block). Log: ~/.volt-r7/agents/chain.log. Restart-safe: skips a finished build.
TREE=/Users/leularia/Desktop/VOLT/volt-e5-weight-min/volt
SRC=/Users/leularia/Desktop/VOLT/volt-e5-weight
LOCK=~/.volt-r7/heavy.lock
OUT=~/.volt-r7/agents/min
RIG=$SRC/docs/reports/2026-11-12-orch-devenv/round7/scripts/weight
mkdir -p $OUT
SHA=$(git -C $SRC rev-parse e6/weight)
if ! grep -qs "commit $SHA" $OUT/READY; then
	until mkdir $LOCK 2>/dev/null; do sleep 30; done
	echo "weight minbuild $TREE pid $$ start $(date)" > $LOCK/owner
	trap 'rm -rf $LOCK' EXIT
	cd $TREE || exit 1
	git checkout -q --detach $SHA || exit 1
	echo "at $(git log --oneline -1)"
	# The shared before build's prebuilt extensions (the base's .build/extensions, patched by launch for the package.json
	# changes since round 4): the -ci task reuses them instead of compiling every extension again.
	rsync -a --delete /Users/leularia/Desktop/VOLT/volt-e5-min-base/volt/.build/extensions/ $TREE/.build/extensions/
	export PATH="$HOME/.nvm/versions/node/v22.19.0/bin:$PATH"
	unset ELECTRON_RUN_AS_NODE
	export VOLT_BUILD_IGNORE_TYPE_ERRORS=1
	G="nice -n 5 node --max-old-space-size=16384 ./node_modules/gulp/bin/gulp.js"
	echo "build start $(date) load $(uptime | sed 's/.*averages: //')"
	eval $G compile-build-with-mangling && eval $G minify-vscode && eval $G vscode-darwin-arm64-min-ci
	RC=$?
	echo "build exit $RC $(date) load $(uptime | sed 's/.*averages: //')"
	[ $RC = 0 ] || exit $RC
	APP=../VSCode-darwin-arm64/VOLT.app
	node -e 'const f=process.argv[1]; const p=JSON.parse(require("fs").readFileSync(f,"utf8")); p.commit=process.argv[2]; require("fs").writeFileSync(f, JSON.stringify(p,null,"\t"));' $APP/Contents/Resources/app/product.json $SHA
	rm -rf $OUT/VOLT.app && cp -cR $APP $OUT/VOLT.app
	echo "$OUT/VOLT.app" > $OUT/READY
	echo "commit $SHA" >> $OUT/READY
	rm -rf $LOCK; trap - EXIT
	echo "minafter ready $(date)"
fi
until [ -s ~/.volt-r7/min/base/READY ]; do sleep 60; done
echo "minbefore ready: $(head -1 ~/.volt-r7/min/base/READY) $(date)"
cd $RIG
export WEIGHT_LOAD_WAIT_S=600
./blocks.sh minbefore minafter minafter minbefore
ARMS="minbefore minafter" ./a7block.sh 1
ARMS="minafter minbefore" ./a7block.sh 1
echo "chain done $(date)"
