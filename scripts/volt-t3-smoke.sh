#!/usr/bin/env bash
# P2's T3 smoke run (spec H.5, D-10): downloads Open VSX's most downloaded extensions, unpacks each
# .vsix, and runs T3-SMOKE-1 over them (each opted-in extension in its own sandboxed host against an
# unsandboxed baseline). The report lands in <dir>/report.json.
#
#   scripts/volt-t3-smoke.sh [dir] [count]      default: /tmp/volt-t3-smoke, 50
#
# Needs curl, jq and unzip, and `npm run transpile-client-oxc` done. Downloads are kept: a second run
# reuses them (delete the folder to refresh).
set -euo pipefail

DIR="${1:-/tmp/volt-t3-smoke}"
COUNT="${2:-50}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$DIR"

curl -fsS "https://open-vsx.org/api/-/search?sortBy=downloadCount&sortOrder=desc&size=${COUNT}&includeAllVersions=false" -o "$DIR/top.json"
jq -r '.extensions[] | [.namespace, .name, .version, .files.download] | @tsv' "$DIR/top.json" | while IFS=$'\t' read -r ns name version url; do
	folder="$DIR/$ns.$name"
	if [ -f "$folder/extension/package.json" ]; then
		continue
	fi
	echo "fetching $ns.$name@$version"
	tmp="$(mktemp -t volt-t3-vsix)"
	if curl -fsSL "$url" -o "$tmp"; then
		rm -rf "$folder" && mkdir -p "$folder"
		unzip -q -o "$tmp" 'extension/*' -d "$folder" || echo "  could not unpack $ns.$name"
	else
		echo "  could not download $ns.$name"
	fi
	rm -f "$tmp"
done

cd "$ROOT"
unset ELECTRON_RUN_AS_NODE
VOLT_T3_SMOKE_DIR="$DIR" VOLT_SANDBOX_REQUIRED=1 ./scripts/test.sh --run src/vs/workbench/api/test/node/voltSandboxedExtensionSmoke.test.ts
echo "report: $DIR/report.json"
