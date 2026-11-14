#!/bin/sh
# Round 4 token matrix (round 3's, new ports/profiles), interleaved: per repetition B1 "hi" on the base build (CDP 9947, volt-e4-base), the after build
# (CDP 9943, volt-e4-tokens) and the Bare CLI, then B3 (a real read-and-explain task) B3_N times per arm, also interleaved.
# Both test instances must be running (runtok.mjs launch, see README in this folder).
# Usage: [B3_N=1] matrix.sh <tag> <model id> <bare effort> [N]
#   e.g. B3_N=3 matrix.sh opus claude-opus-5-5 high 3
cd "$(dirname "$0")"
TAG=$1; MODEL=$2; EFFORT=$3; N=${4:-3}
REF="agent:seed-claude-code:$MODEL"
B3='Read src/paginate.ts and src/dates.ts. Explain what each function does and list every bug you find with the line number. Do not change any file.'
: "${TOK_DIR:?set TOK_DIR}"
base() { VOLT_UD=/tmp/v4-tokens-ud-base VOLT_CDP=9947 node runtok.mjs run "$@"; }
after() { VOLT_UD=/tmp/v4-tokens-ud VOLT_CDP=9943 node runtok.mjs run "$@"; }
bare() { ./cleanenv.sh env TOK_DIR="$TOK_DIR" TOK_CFG="$TOK_CFG" TOK_PROXY="${TOK_PROXY:?}" node runbare.mjs "$@"; }
for r in $(seq 1 "$N"); do
  base "base-$TAG-b1" "$REF" hi "$r"
  after "after-$TAG-b1" "$REF" hi "$r"
  [ "${SKIP_BARE:-0}" = 1 ] || bare "bare-$TAG-b1" "$MODEL" "$EFFORT" hi "$r"
done
[ "${SKIP_B3:-0}" = 1 ] && exit 0
for r in $(seq 1 "${B3_N:-1}"); do
  base "base-$TAG-b3" "$REF" "$B3" "$r"
  after "after-$TAG-b3" "$REF" "$B3" "$r"
  [ "${SKIP_BARE:-0}" = 1 ] || bare "bare-$TAG-b3" "$MODEL" "$EFFORT" "$B3" "$r"
done
