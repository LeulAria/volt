#!/bin/sh
cd /tmp/v4-merged-tok
unset ELECTRON_RUN_AS_NODE
export TOK_DIR=/tmp/v4-merged-tok TOK_FOLDER=$HOME/.volt-r4/tokens/run/arena TOK_CFG=$HOME/.volt-r4/tokens/run/cfg-clean TOK_PROXY=http://127.0.0.1:19943 VOLT_UD=/tmp/v4-merged-tok-ud VOLT_EXT=/tmp/v4-merged-tok-ext VOLT_CDP=9958 TOK_ACCESS=full
REF=agent:seed-claude-code:claude-opus-5-5
B3='Read src/paginate.ts and src/dates.ts. Explain what each function does and list every bug you find with the line number. Do not change any file.'
for r in 1 2 3; do node runtok.mjs run merged-b1 "$REF" hi $r; done
for r in 1 2 3; do node runtok.mjs run merged-b3 "$REF" "$B3" $r; done
echo DONE
