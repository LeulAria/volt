#!/bin/zsh
# Prints every table of 24-orchestration.md from the committed data, in report order.
#   zsh scripts/orch/cmp/tables.sh   (from round3/ or anywhere)
S=${0:A:h}
R=${S:h:h:h}
D=$R/data/orch/cmp/ab-project
echo '## HEADLINE'; node $S/headline.mjs $D/runs.jsonl
echo; echo '## PHASES'; node $S/phases.mjs $D cc,volt-r3p-base,volt-r3q --max-load 14
echo; echo '## OVERHEAD'; CMP_DATA=$D node $S/breakdown.mjs volt-r3p-base,volt-r3q --max-load 14
echo; echo '## END GAPS'; node $S/endgaps.mjs $D volt-r3p-base,volt-r3q
echo; echo '## REQSIZE'; node $S/reqsize.mjs $D 2>/dev/null | grep -v "volt-r3p t"
echo; echo '## FIXSTATS'; node $S/fixstats.mjs $D volt-r3p-base,volt-r3q
echo; echo '## GRADES'; node $S/grades.mjs $D
