#!/bin/sh
# First-request size of round 2's four tasks (t0-t3, Volt's prompts with its delegation line) on the base
# and the after build, interleaved per task, Haiku 5.5 as in round 2. Each turn is stopped once its first
# model request has answered (TOK_FIRST_ONLY). The project is $TOK_DIR/r2w holding t0-t3 (round 2's
# fixtures, e.g. copied from the orchestration area's /tmp/v3orch/w); /tmp/vcmp/w in the prompts points
# there. Then: node firstreq.mjs $TOK_DIR/capture.jsonl $TOK_DIR/windows.jsonl '^r2-'
# Usage: r2first.sh [N] [tasks]
cd "$(dirname "$0")"
: "${TOK_DIR:?set TOK_DIR}"
N=${1:-2}; TASKS=${2:-"t0 t1 t2 t3"}
P=../../../round2/scripts/cmp/prompts
REF=agent:seed-claude-code:claude-haiku-5-5
prompt() {
	deleg=$(node -e "const d=require('$P/delegation.json').volt; process.stdout.write((d['$1']??'').replace('{{SUBMODEL}}','claude-haiku-5-5'))")
	node -e "const fs=require('fs'); process.stdout.write(fs.readFileSync('$P/$1.txt','utf8').replaceAll('/tmp/vcmp/w', process.env.TOK_DIR + '/r2w').replace('{{DELEGATION}}', process.argv[1]).trim())" "$deleg"
}
for r in $(seq 1 "$N"); do
	for t in $TASKS; do
		p=$(prompt "$t")
		for arm in base after; do
			if [ $arm = base ]; then ud=/tmp/v3-tokens-ud-base; port=9964; else ud=/tmp/v3-tokens-ud; port=9954; fi
			VOLT_UD=$ud VOLT_CDP=$port TOK_FOLDER="$TOK_DIR/r2w" TOK_FIRST_ONLY=1 TOK_SIDE_WAIT_MS=5000 node runtok.mjs run "r2-$arm-$t" "$REF" "$p" "$r"
		done
	done
done
