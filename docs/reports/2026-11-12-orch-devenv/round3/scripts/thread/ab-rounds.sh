#!/bin/bash
# Interleaved A/B: base, new, base, new ... for `rounds` rounds; ends on new. Log to $LOG.
#   ab-rounds.sh <rounds> [tests]
HERE=$(cd "$(dirname "$0")" && pwd)
for r in $(seq 1 "${1:-2}"); do
	for side in base new; do
		"$HERE/suite.sh" "$side" "$r" "$2" || echo "suite $side r$r failed"
	done
done
