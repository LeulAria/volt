#!/bin/zsh
# Round 7 after build: e7/launch's tip built minified in the launch nested tree (round 6's volt-e5-min-base) under
# ~/.volt-r7/heavy.lock (minbuild.sh), installed as ~/.volt-r7/launch/apps/<arm> with the commit stamped and the shared
# base build's built-in extensions (the arms differ only by e7/launch's commits). Waits for the base build first.
ARM=${1:-after}; R=~/.volt-r7/launch; T=/Users/leularia/Desktop/VOLT/volt-e5-min-base/volt; S=/Users/leularia/Desktop/VOLT/volt-e5-launch
RIG=$S/docs/reports/2026-11-12-orch-devenv/round7/scripts/launch; BASE=~/.volt-r7/min/base/VOLT.app
export PATH="$HOME/.nvm/versions/node/v22.19.0/bin:/opt/homebrew/bin:$PATH"; unset ELECTRON_RUN_AS_NODE
set -e
while [ ! -f ~/.volt-r7/min/base/READY ]; do echo "waiting for base READY $(date +%T)"; sleep 60; done
TIP=$(cd $S && git rev-parse HEAD)
cd $T && git checkout -q --detach $TIP && echo "nested tree at $(git log --oneline -1)"
cp extensions/volt-provider-claude/package.json .build/extensions/volt-provider-claude/package.json
$RIG/minbuild.sh $T
rm -rf $R/apps/$ARM; mkdir -p $R/apps/$ARM; cp -cR $T/../VSCode-darwin-arm64/VOLT.app $R/apps/$ARM/VOLT.app
A=$R/apps/$ARM/VOLT.app/Contents/Resources/app
rm -rf $A/extensions; cp -cR $BASE/Contents/Resources/app/extensions $A/extensions
python3 -c 'import json,sys; p=sys.argv[1]; d=json.load(open(p)); d["commit"]=sys.argv[2]; json.dump(d, open(p,"w"), indent="\t")' $A/product.json "$TIP"
echo "installed $ARM, commit $TIP, $(date)"
echo "AFTER READY $(date)"
