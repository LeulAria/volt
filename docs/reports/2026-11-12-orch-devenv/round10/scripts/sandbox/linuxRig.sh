#!/usr/bin/env bash
# Runs a round 10 sandbox script in the Linux rig (the image scripts/volt-sandbox-linux-test.sh
# builds: Ubuntu 24.04, bubblewrap 0.13.1, an unprivileged user), with this checkout's out/ mounted.
#
#   linuxRig.sh escapeProbe.mjs [args]      linuxRig.sh cost.mjs --n 10      linuxRig.sh --shell 'command'
#
# Transpile first (npm run transpile-client-oxc). Output files: pass --out /data/<name>, which is
# round10/data/sandbox in this checkout. VOLT_RIG_OUT=<dir> mounts another out/ (a "before" build).
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../../../../../.." && pwd)"
IMAGE=volt-sandbox-linux-test-bwrap013
docker image inspect "$IMAGE" >/dev/null 2>&1 || docker build -q -t "$IMAGE" -f "$ROOT/build/volt-sandbox/Dockerfile.linux-test" "$ROOT/build/volt-sandbox" >/dev/null
mkdir -p "$HERE/../../data/sandbox"
FLAGS=(--rm --init --security-opt seccomp=unconfined --security-opt apparmor=unconfined --security-opt systempaths=unconfined
	-v "${VOLT_RIG_OUT:-$ROOT/out}:/volt/out:ro" -v "$ROOT/package.json:/volt/package.json:ro" -v "$HERE:/volt/r10:ro" -v "$HERE/../../data/sandbox:/data" -e VOLT_OUT=/volt/out)
# The git extension's environment helper, when it was compiled (the probe's planted-bare-repository row uses it).
if [[ -z "${VOLT_RIG_OUT:-}" && -f "$ROOT/extensions/git/out/safeGitEnv.js" ]]; then
	FLAGS+=(-v "$ROOT/extensions/git/out/safeGitEnv.js:/volt/extensions/git/out/safeGitEnv.js:ro")
fi
if [[ "${1:-}" == "--shell" ]]; then
	shift
	exec docker run "${FLAGS[@]}" "$IMAGE" bash -c "$*"
fi
script="$1"; shift
exec docker run "${FLAGS[@]}" "$IMAGE" node --import 'data:text/javascript,globalThis._VSCODE_FILE_ROOT="/volt/out";' "/volt/r10/$script" --volt-out /volt/out "$@"
