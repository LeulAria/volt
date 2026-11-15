#!/bin/sh
# The C1 arena base: ADEMark's arena/ (clone at ~/.volt-r4/ademark, commit recorded) as a git repo on main,
# committed once. runvolt.mjs and runcli.mjs clone it per run into ~/.volt-r4/c1/runs/<id>.
set -e
C1=${C1_DIR:-$HOME/.volt-r6/orch/c1}
A=${ADEMARK:-$HOME/.volt-r4/ademark}
rm -rf "$C1/arena-base"
mkdir -p "$C1/runs"
cp -R "$A/arena" "$C1/arena-base"
cd "$C1/arena-base"
git init -q -b main
git add -A
git -c user.name=bench -c user.email=bench@local commit -qm arena
echo "arena from ademark $(git -C "$A" rev-parse --short HEAD)" > "$C1/arena-base.txt"
cat "$C1/arena-base.txt"
