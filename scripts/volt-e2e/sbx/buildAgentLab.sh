#!/bin/bash
# Compiles and packages the Agent Lab sample (docs/volt/examples/volt-agent-lab-attacks) as a .vsix.
#   scripts/volt-e2e/sbx/buildAgentLab.sh [out.vsix]
# vsce needs Node 22 (Node 25 dropped SlowBuffer, which its jwa dependency uses).
set -e
ROOT=$(cd "$(dirname "$0")/../../.." && pwd)
OUT=${1:-/tmp/volt-agent-lab-attacks.vsix}
cd "$ROOT/docs/volt/examples/volt-agent-lab-attacks"
node "$ROOT/node_modules/typescript/bin/tsc" -p .
NODE22=$(ls -d ~/.nvm/versions/node/v22* 2>/dev/null | tail -1)/bin/node
[ -x "$NODE22" ] || NODE22=node
echo y | env -u ELECTRON_RUN_AS_NODE "$NODE22" "$ROOT/build/node_modules/@vscode/vsce/vsce" package --skip-license --allow-missing-repository -o "$OUT"
