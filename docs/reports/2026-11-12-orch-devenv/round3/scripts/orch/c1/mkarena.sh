#!/bin/sh
# The C1 arena base: a git repo on main with ADEMark's arena/ (from the ADEMark clone at /tmp/ademark,
# symlinked to ~/.volt-r3/ademark), committed once. runcli.mjs and runvolt.mjs clone it per run.
set -e
rm -rf /tmp/v3orch/c1/arena-base
mkdir -p /tmp/v3orch/c1
cp -R /tmp/ademark/arena /tmp/v3orch/c1/arena-base
cd /tmp/v3orch/c1/arena-base
git init -q -b main
git add -A
git -c user.name=bench -c user.email=bench@local commit -qm arena
