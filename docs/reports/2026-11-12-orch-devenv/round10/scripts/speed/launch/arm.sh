#!/bin/zsh
# Installs a release build as a launch arm and warms it (untimed), so pair.sh can time it:
#   arm.sh <name> </path/to/VOLT.app> [warm launches=2]
# The arm gets an APFS clone of the app under ~/.volt-r10/speed/launch/apps/<name>, a copy of the seeded five-thread
# profile and HOME (from the r8 arm, or round 7's seed when there is no r8 arm yet), and warm launches that fill its
# code caches and write its launch-window hint (the hint names the app's own path, so every arm needs its own).
# Then: pair.sh ~/.volt-r10/speed/launch/out/<run> 6 A2 r8 <name>   and the same with A1.
set -e
cd ${0:A:h}; . ../port.sh
export PATH="$HOME/.nvm/versions/node/v22.19.0/bin:$HOME/.bun/bin:$PATH"; unset ELECTRON_RUN_AS_NODE
NAME=$1; APP=$2; WARM=${3:-2}
[ -d "$APP" ] || { echo "no app at $APP"; exit 2; }
bash setup.sh rig
bash setup.sh app $NAME "$APP"
if [ "$NAME" = r8 ] || [ ! -d ~/.volt-r10/speed/launch/ud/r8 ]; then bash setup.sh clone r7seed $NAME; else bash setup.sh clone r8 $NAME; fi
for i in $(seq 1 $WARM); do bun run.ts --app $NAME --launch; sleep 22; bun run.ts --app $NAME --quit; sleep 3; done
echo "arm $NAME ready: $(grep -o '"appRoot":"[^"]*"' ~/.volt-r10/speed/launch/ud/$NAME/launchWindow.json)"
