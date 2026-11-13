#!/bin/bash
# Round-3 Track A sequence (ADEMark method, unofficial). One app on CDP port 9951 at a time.
#   trackA.sh volt      the two Volt arms: launch tests interleaved per repetition, then A3/A4, A11/A8, A5/A6
#   trackA.sh ab        before/after of 75aa8a9bc00 on the dev arm (A2, interleaved)
#   trackA.sh others    the comparable apps: A1/A2 (window, and DOM echo where a composer takes the keys), A5/A6
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT=${ADE_OUT:-$HOME/.volt-r3/ade/out}
R="bun $HERE/run.ts"
export ADE_QUIET_CORES=${ADE_QUIET_CORES:-3}
mkdir -p "$OUT"

case "${1:-}" in
ab)
	# Before/after of 75aa8a9bc00 (the agent list opens at launch without focus) on the dev arm: the one compiled file
	# is swapped between interleaved A2 runs (ab/before.js, ab/after.js are out/ of the parent and of the fix).
	F=/Users/leularia/Desktop/VOLT/volt-e3-ade/out/vs/workbench/browser/parts/titlebar/layoutModeSwitch.js
	AB=$HOME/.volt-r3/ade/ab
	$R --app volt-rel --quit >/dev/null
	for r in $(seq 1 ${ADE_AB_REPS:-4}); do
		for side in before after; do
			$R --app volt-dev --quit >/dev/null
			cp "$AB/$side.js" "$F"
			$R --app volt-dev --tests A2 --reps 1 --start $r --out "$OUT/ab-$side"
		done
	done
	$R --app volt-dev --quit >/dev/null
	cp "$AB/after.js" "$F"
	;;
volt)
	for r in 1 2 3 4 5 6; do
		for t in A1 A2; do
			for app in volt-dev volt-rel; do
				# Only one app on the CDP port: the other arm is quit (A2 then starts from a normal quit).
				other=$([ $app = volt-dev ] && echo volt-rel || echo volt-dev)
				$R --app $other --quit >/dev/null
				$R --app $app --tests $t --reps 1 --start $r --out "$OUT/$app"
			done
		done
	done
	for app in volt-dev volt-rel; do
		other=$([ $app = volt-dev ] && echo volt-rel || echo volt-dev)
		$R --app $other --quit >/dev/null
		$R --app $app --quit >/dev/null
		ADE_KEEP_RENDERING=1 $R --app $app --launch >/dev/null; sleep 25
		$R --app $app --tests A3,A4 --reps 6 --out "$OUT/$app"
		if [ $app = volt-dev ]; then
			$R --app $app --tests A11 --reps 5 --long-row "[Volt]" --short-row "Replay:seed" --out "$OUT/$app"
			$R --app $app --tests A8 --reps 2 --out "$OUT/$app"
		fi
		$R --app $app --quit >/dev/null
	done
	for r in 1 2; do
		for app in volt-dev volt-rel; do
			$R --app $app --launch >/dev/null; sleep 20
			$R --app $app --tests A5 --reps 1 --start $r --out "$OUT/$app"
			$R --app $app --quit >/dev/null
		done
	done
	;;
others)
	for r in 1 2 3 4 5 6; do
		for t in A1 A2; do
			for app in ${ADE_APPS:-t3 paseo zeron monocode super claude-desktop}; do
				$R --app $app --tests $t --reps 1 --start $r --out "$OUT/$app"
				$R --app $app --quit >/dev/null
			done
		done
	done
	for app in ${ADE_APPS:-t3 paseo zeron monocode super claude-desktop}; do
		$R --app $app --launch >/dev/null; sleep 20
		$R --app $app --tests A5 --reps 1 --out "$OUT/$app"
		$R --app $app --quit >/dev/null
		$R --app $app --kill >/dev/null
	done
	;;
*) echo "usage: trackA.sh volt | others"; exit 2 ;;
esac
