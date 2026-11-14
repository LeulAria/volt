#!/bin/zsh
# After the min-base build exits 0: copy the app out of the build tree, stamp the commit, smoke-run, publish READY.
# usage: installbase.sh [commit]   (default 7f07f73d677 full sha)
set -e
COMMIT=${1:-7f07f73d6770000000000000000000000000000}
R=~/.volt-r6/launch; SRC=/Users/leularia/Desktop/VOLT/volt-e5-min-base/VSCode-darwin-arm64/VOLT.app
FULL=$(cd /Users/leularia/Desktop/VOLT/volt-e5-min-base/volt && git rev-parse HEAD)
[ -d "$SRC" ] || { echo "no app at $SRC"; exit 1; }
mkdir -p ~/.volt-r6/min/base
rm -rf ~/.volt-r6/min/base/VOLT.app
ditto "$SRC" ~/.volt-r6/min/base/VOLT.app
python3 -c 'import json,sys; p=sys.argv[1]; d=json.load(open(p)); d.setdefault("commit", sys.argv[2]); json.dump(d, open(p,"w"), indent="\t")' \
	~/.volt-r6/min/base/VOLT.app/Contents/Resources/app/product.json "$FULL"
grep -o '"commit": *"[^"]*"' ~/.volt-r6/min/base/VOLT.app/Contents/Resources/app/product.json
# the before arm of the rig is a copy of it (its own app path, so its hint and code cache are its own)
rm -rf $R/apps/before; mkdir -p $R/apps/before; cp -cR ~/.volt-r6/min/base/VOLT.app $R/apps/before/VOLT.app
cat > ~/.volt-r6/min/base/NOTES.md <<EOF
# Shared minified "before" build (launch agent, round 6, $(date +%F))
- App: /Users/leularia/.volt-r6/min/base/VOLT.app (copy; built in /Users/leularia/Desktop/VOLT/volt-e5-min-base/volt at $FULL,
  \`gulp compile-build-with-mangling && minify-vscode && vscode-darwin-arm64-min-ci\`, VOLT_BUILD_IGNORE_TYPE_ERRORS=1, mangled;
  .build/extensions reused from round 4's base build with the 6 extension package.json files changed since then copied in
  (volt-code-intelligence, volt-dev-environment, volt-http-client, volt-orchestra, volt-provider-claude, volt-provider-grok)).
- product.json commit stamped $FULL (a linked-worktree build has none, and without it there is no V8 code cache).
- Launch with your own --user-data-dir, unset ELECTRON_RUN_AS_NODE, ALWAYS pass --use-mock-keychain (else a keychain prompt on the user's screen and CDP hangs).
- Known in this build (fixed on e6/launch): the launch window's page never finds its V8 code cache, so each launch compiles the workbench bundle.
- Do not modify this copy; copy it (cp -cR) if you need to change anything.
EOF
echo "installed $(date)"
