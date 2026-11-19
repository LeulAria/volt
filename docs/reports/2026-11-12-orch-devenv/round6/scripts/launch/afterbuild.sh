#!/bin/zsh
# After build chain: e6/launch tip built minified in the min-base tree (heavy lock), installed as apps/<arm> (default after) (commit stamped),
# then warm-up launches of both arms. Logs to logs/afterbuild.log. Run after installbase.sh published READY.
ARM=${1:-after}; R=~/.volt-r6/launch; T=/Users/leularia/Desktop/VOLT/volt-e5-min-base/volt; S=/Users/leularia/Desktop/VOLT/volt-e5-launch
RIG=$S/docs/reports/2026-11-12-orch-devenv/round6/scripts/launch
export PATH="$HOME/.nvm/versions/node/v22.19.0/bin:/opt/homebrew/bin:$PATH"; unset ELECTRON_RUN_AS_NODE
set -e
[ -f ~/.volt-r6/min/base/READY ] || { echo "base not published"; exit 1; }
TIP=$(cd $S && git rev-parse HEAD)
cd $T && git checkout -q --detach $TIP && echo "min-base tree at $(git log --oneline -1)"
# the .build/extensions patch of the base build stays (same extension manifests on this branch)
$R/minbuild.sh $T
RC=$?; [ $RC -eq 0 ] || { echo "after build failed rc=$RC"; exit $RC; }
rm -rf $R/apps/$ARM; mkdir -p $R/apps/$ARM; cp -cR $T/../VSCode-darwin-arm64/VOLT.app $R/apps/$ARM/VOLT.app
python3 -c 'import json,sys; p=sys.argv[1]; d=json.load(open(p)); d.setdefault("commit", sys.argv[2]); json.dump(d, open(p,"w"), indent="\t")' \
	$R/apps/$ARM/VOLT.app/Contents/Resources/app/product.json "$TIP"
echo "after installed, commit $TIP, $(date)"
ls $R/apps/$ARM/VOLT.app/Contents/Resources/app/out/vs/workbench/contrib/voltAgent/browser/blocks/vendor/ 2>&1 | head -3
grep -c 'contrib/voltAgent/browser/blocks/vendor/beautifulMermaid.js' $R/apps/$ARM/VOLT.app/Contents/Resources/app/out/vs/workbench/workbench.desktop.main.js || true
echo "AFTER READY $(date)"
