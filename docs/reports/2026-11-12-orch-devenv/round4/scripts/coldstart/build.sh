#!/bin/zsh
# usage: build.sh <repo dir> <log>
cd "$1" || exit 1
export PATH="$HOME/.nvm/versions/node/v22.19.0/bin:$PATH"
unset ELECTRON_RUN_AS_NODE
echo "start $(date) load $(uptime | sed 's/.*averages: //')"
VOLT_BUILD_IGNORE_TYPE_ERRORS=1 nice -n 5 node --max-old-space-size=16384 ./node_modules/gulp/bin/gulp.js ${GULP_TASK:-vscode-darwin-arm64-min}
echo "exit $? $(date) load $(uptime | sed 's/.*averages: //')"
