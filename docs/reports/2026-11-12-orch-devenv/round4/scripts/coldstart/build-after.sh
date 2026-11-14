#!/bin/zsh
# Minified "after" build: the after tree checks out e4/coldstart's HEAD, reuses the before build's extensions
# (identical sources: this branch does not touch extensions/), and runs core compile + minify + package only.
A=/Users/leularia/Desktop/VOLT/volt-e4-coldstart-after/volt
B=/Users/leularia/Desktop/VOLT/volt-e4-coldstart-base/volt
cd $A || exit 1
git checkout -q --detach e4/coldstart || exit 1
echo "after at $(git log --oneline -1)"
[ -d .build/extensions ] || cp -cR $B/.build/extensions .build/extensions
export PATH="$HOME/.nvm/versions/node/v22.19.0/bin:$PATH"
unset ELECTRON_RUN_AS_NODE
export VOLT_BUILD_IGNORE_TYPE_ERRORS=1
G="nice -n 5 node --max-old-space-size=16384 ./node_modules/gulp/bin/gulp.js"
echo "start $(date) load $(uptime | sed 's/.*averages: //')"
eval $G compile-build-with-mangling && eval $G minify-vscode && eval $G vscode-darwin-arm64-min-ci
echo "exit $? $(date) load $(uptime | sed 's/.*averages: //')"
