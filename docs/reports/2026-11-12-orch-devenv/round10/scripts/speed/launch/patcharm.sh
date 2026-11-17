#!/bin/zsh
# A release arm that differs from r8 by this branch's launch-page files only, without a full build:
#   patcharm.sh <arm> <git ref>
# clones ~/.volt-r8/min/r8/VOLT.app to ~/.volt-r10/speed/launch/apps/<arm> (APFS clone), gives it r8's seeded
# profile and HOME, and replaces the two files the launch page runs with esbuild builds of the sources at <git ref>:
#   out/vs/code/electron-browser/workbench/workbench.js   (bundle, minified, ESM: as the product's)
#   out/vs/base/parts/sandbox/electron-browser/preload.js (one file, minified)
# `patcharm.sh r8c 7312123ce14` is the control (r8's own sources through the same esbuild step);
# `patcharm.sh r8x e10/speed` the branch. Needs a clean tree (it checks the three source files out and back).
set -e
ARM=$1; REF=$2
HERE=${0:A:h}; TREE=/Users/leularia/Desktop/VOLT/volt-e5-firstword
export PATH="$HOME/.nvm/versions/node/v22.19.0/bin:$HOME/.bun/bin:$PATH"; unset ELECTRON_RUN_AS_NODE
FILES=(src/vs/code/electron-browser/workbench/workbench.ts src/vs/platform/voltWindowSnapshot/browser/windowSnapshotPaint.ts src/vs/base/parts/sandbox/electron-browser/preload.ts src/vs/base/parts/sandbox/electron-browser/globals.ts)
cd $TREE
[ -z "$(git status --porcelain -- src)" ] || { echo "src is not clean"; exit 1; }
HEADREF=$(git rev-parse --abbrev-ref HEAD)
TMP=$(mktemp -d)
git checkout -q $REF -- $FILES
ESB=build/node_modules/.bin/esbuild
$ESB src/vs/code/electron-browser/workbench/workbench.ts --bundle --format=esm --minify --target=es2022 --log-level=warning --outfile=$TMP/workbench.js
$ESB src/vs/base/parts/sandbox/electron-browser/preload.ts --minify --target=es2022 --log-level=warning --outfile=$TMP/preload.js
git checkout -q $HEADREF -- $FILES
[ -z "$(git status --porcelain -- src)" ] || { echo "src did not come back clean"; exit 1; }
bash $HERE/setup.sh app $ARM ~/.volt-r8/min/r8/VOLT.app
bash $HERE/setup.sh clone r8 $ARM
OUT=~/.volt-r10/speed/launch/apps/$ARM/VOLT.app/Contents/Resources/app/out
for f in vs/code/electron-browser/workbench/workbench.js vs/base/parts/sandbox/electron-browser/preload.js; do
	rm -f $OUT/$f; cp $TMP/${f:t} $OUT/$f
done
echo "$ARM = r8 + workbench.js, preload.js built from $REF ($(git rev-parse --short $REF))" | tee ~/.volt-r10/speed/launch/apps/$ARM/README
ls -la $OUT/vs/code/electron-browser/workbench/workbench.js $OUT/vs/base/parts/sandbox/electron-browser/preload.js | awk '{print $5, $9}'
rm -rf $TMP
