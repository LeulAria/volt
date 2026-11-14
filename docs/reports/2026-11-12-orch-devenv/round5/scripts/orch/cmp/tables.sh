#!/bin/zsh
# Prints every table of round4/31-orchestration.md from the committed data, in report order.
#   zsh scripts/orch/cmp/tables.sh   (from round4/ or anywhere)
S=${0:A:h}
R=${S:h:h:h}
D=$R/data/orch/cmp
A=cc,volt-r4-base,volt-r4
echo '## HEADLINE'; node $S/headline.mjs $D/runs.jsonl
echo; echo '## PHASES'; node $S/phases.mjs $D $A --max-load 14
echo; echo '## OVERHEAD'; CMP_DATA=$D node $S/breakdown.mjs volt-r4-base,volt-r4 --max-load 14
echo; echo '## END GAPS'; node $S/endgaps.mjs $D volt-r4-base,volt-r4
echo; echo '## REQSIZE'; node $S/reqsize.mjs $D 2>/dev/null
echo; echo '## FIXSTATS'; node $S/fixstats.mjs $D volt-r4-base,volt-r4
echo; echo '## GRADES'; node $S/grades.mjs $D
