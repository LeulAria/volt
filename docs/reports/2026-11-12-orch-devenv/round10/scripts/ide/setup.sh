#!/bin/sh
# Copies the fixtures to <home>/fx/{ts,py,go} as fresh git repos (one commit each). Re-run to reset.
# usage: setup.sh [home]   (default ~/.volt-r10/ide)
set -e
here=$(cd "$(dirname "$0")" && pwd)
home=${1:-$HOME/.volt-r10/ide}
for lang in ts py go; do
	rm -rf "$home/fx/$lang"
	mkdir -p "$home/fx/$lang"
	cp -R "$here/fixtures/$lang/." "$home/fx/$lang/"
	git -C "$home/fx/$lang" init -q -b main
	git -C "$home/fx/$lang" add -A
	git -C "$home/fx/$lang" -c user.name=bench -c user.email=bench@example.com commit -q -m "fixture"
done
echo "$home/fx"
