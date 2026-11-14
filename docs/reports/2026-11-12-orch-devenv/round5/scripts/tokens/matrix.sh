#!/bin/sh
# Round 5 token matrix, interleaved: per repetition B1 "hi" on the before build (CDP 9979, volt-e5-base at 9bbb8818c60),
# the after build (CDP 9973, volt-e5-tokens) and the Bare CLI (CLAUDE_BIN, Claude Code 2.1.322 = the version Volt's
# adapter runs), then B3 (a real read-and-explain task) B3_N times per arm, also interleaved.
# Both test instances must be running (runtok.mjs launch, see README in this folder). Source env.sh first.
# Usage: [B3_N=3] [SKIP_BEFORE=1] [SKIP_AFTER=1] [SKIP_BARE=1] [SKIP_B3=1] matrix.sh <tag> <model id> <bare effort> [N]
cd "$(dirname "$0")"
TAG=$1; MODEL=$2; EFFORT=$3; N=${4:-3}
REF="agent:seed-claude-code:$MODEL"
B3='Read src/paginate.ts and src/dates.ts. Explain what each function does and list every bug you find with the line number. Do not change any file.'
: "${TOK_DIR:?set TOK_DIR}"
before() { [ "${SKIP_BEFORE:-0}" = 1 ] || VOLT_UD=$HOME/.volt-r5/tokens/ud-base VOLT_CDP=9979 node runtok.mjs run "$@"; }
after() { [ "${SKIP_AFTER:-0}" = 1 ] || VOLT_UD=$HOME/.volt-r5/tokens/ud VOLT_CDP=9973 node runtok.mjs run "$@"; }
bare() { [ "${SKIP_BARE:-0}" = 1 ] || ./cleanenv.sh env TOK_DIR="$TOK_DIR" TOK_CFG="$TOK_CFG" TOK_PROXY="${TOK_PROXY:?}" CLAUDE_BIN="${CLAUDE_BIN:-claude}" node runbare.mjs "$@"; }
for r in $(seq 1 "$N"); do
  before "before-$TAG-b1" "$REF" hi "$r"
  after "after-$TAG-b1" "$REF" hi "$r"
  bare "bare-$TAG-b1" "$MODEL" "$EFFORT" hi "$r"
done
[ "${SKIP_B3:-0}" = 1 ] && exit 0
for r in $(seq 1 "${B3_N:-1}"); do
  before "before-$TAG-b3" "$REF" "$B3" "$r"
  after "after-$TAG-b3" "$REF" "$B3" "$r"
  bare "bare-$TAG-b3" "$MODEL" "$EFFORT" "$B3" "$r"
done
