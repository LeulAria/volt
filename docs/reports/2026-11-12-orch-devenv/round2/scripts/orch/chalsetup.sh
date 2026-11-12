#!/bin/bash
# A fresh copy of the fixture for one challenge run: chalsetup.sh <tag> (inside the window's project, so the sandbox lets subagents write it)
D=/tmp/voltbench/fx/runs/$1; rm -rf $D; mkdir -p $D
cp -R /tmp/voltbench/fx/src $D/src
grep -qx 'runs/' /tmp/voltbench/fx/.git/info/exclude 2>/dev/null || echo 'runs/' >> /tmp/voltbench/fx/.git/info/exclude
(cd $D && git init -q && git add -A && git -c user.email=b@x -c user.name=bench commit -qm base)
echo $D
