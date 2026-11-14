#!/bin/sh
# One interleaved block of the token tests: B1 "hi" x N per model on Volt and the Bare CLI (A,B,A,B), then
# B3 once per model on each. Usage: batch.sh <volt label> <bare label|-> [N] [models: haiku opus]
cd "$(dirname "$0")"
V=$1; B=$2; N=${3:-3}; MODELS=${4:-"haiku opus"}
B3='Read src/paginate.ts and src/dates.ts. Explain what each function does and list every bug you find with the line number. Do not change any file.'
ref() { [ "$1" = haiku ] && echo agent:seed-claude-code:claude-haiku-5-5 || echo agent:seed-claude-code:claude-opus-5-5; }
id() { [ "$1" = haiku ] && echo claude-haiku-5-5 || echo claude-opus-5-5; }
eff() { [ "$1" = haiku ] && echo medium || echo high; }
for r in $(seq 1 $N); do
  for m in $MODELS; do
    node runtok.mjs run "$V-b1" "$(ref $m)" hi $r
    [ "$B" = - ] || node runbare.mjs "$B-b1" "$(id $m)" "$(eff $m)" hi $r
  done
done
[ "${SKIP_B3:-0}" = 1 ] && exit 0
for m in $MODELS; do
  node runtok.mjs run "$V-b3" "$(ref $m)" "$B3" 1
  [ "$B" = - ] || node runbare.mjs "$B-b3" "$(id $m)" "$(eff $m)" "$B3" 1
done
