// A/B tables: node summarize.mjs <summary.jsonl> [scores.json] [tag]
// scores.json: { "<arm>/<file>": score } from the blind scoring (key.json joined with the grades).
import fs from 'node:fs';

const [summaryFile, scoresFile, onlyTag] = process.argv.slice(2);
const rows = fs.readFileSync(summaryFile, 'utf8').trim().split('\n').map(line => JSON.parse(line)).filter(row => !row.error && (!onlyTag || row.tag === onlyTag));
const scores = scoresFile && fs.existsSync(scoresFile) ? JSON.parse(fs.readFileSync(scoresFile, 'utf8')) : {};
const scoreOf = row => scores[`arm${row.arm}/${row.id}-${row.tag}-r${row.run}.answer.md`];
const tokens = row => (row.input ?? 0) + (row.cacheWrite ?? 0) + (row.cacheRead ?? 0) + (row.output ?? 0);
const median = values => { const v = values.filter(x => typeof x === 'number').sort((a, b) => a - b); return v.length ? (v.length % 2 ? v[(v.length - 1) / 2] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2) : NaN; };
const sum = values => values.reduce((a, b) => a + (b ?? 0), 0);
const fmt = (value, digits = 1) => Number.isFinite(value) ? value.toFixed(digits) : '-';
const range = values => { const v = values.filter(x => typeof x === 'number'); return v.length ? `${fmt(Math.min(...v))}-${fmt(Math.max(...v))}` : '-'; };

const ids = [...new Set(rows.map(row => row.id))].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
const out = ['| Q | arm | score (3 runs) | wall s median (range) | cost $ median | tokens median | output tok median | tool calls median | Volt calls median | approvals |', '|---|---|---|---|---|---|---|---|---|---|'];
const totals = {};
for (const id of ids) {
	for (const arm of [1, 2]) {
		const set = rows.filter(row => row.id === id && row.arm === arm);
		if (!set.length) {
			continue;
		}
		const sc = set.map(scoreOf);
		out.push(`| ${id} | ${arm} | ${sc.map(s => s ?? '?').join(' / ')} | ${fmt(median(set.map(r => r.wallMs / 1000)))} (${range(set.map(r => r.wallMs / 1000))}) | ${fmt(median(set.map(r => r.cost)), 4)} | ${fmt(median(set.map(tokens)) / 1000, 0)}k | ${fmt(median(set.map(r => r.output)), 0)} | ${fmt(median(set.map(r => r.toolCalls)), 0)} | ${fmt(median(set.map(r => r.voltCalls)), 0)} | ${arm === 2 ? sum(set.map(r => r.approvals)) : '-'} |`);
		const t = totals[arm] ??= { n: 0, score: 0, scored: 0, wall: 0, cost: 0, tokens: 0, output: 0, calls: 0, volt: 0, approvals: 0, walls: [] };
		t.n += set.length;
		t.score += sum(sc.filter(s => typeof s === 'number'));
		t.scored += sc.filter(s => typeof s === 'number').length;
		t.wall += sum(set.map(r => r.wallMs / 1000));
		t.walls.push(...set.map(r => r.wallMs / 1000));
		t.cost += sum(set.map(r => r.cost));
		t.tokens += sum(set.map(tokens));
		t.output += sum(set.map(r => r.output));
		t.calls += sum(set.map(r => r.toolCalls));
		t.volt += sum(set.map(r => r.voltCalls));
		t.approvals += sum(set.map(r => r.approvals ?? 0));
	}
}
out.push('', '| arm | runs | score (sum / max) | wall s total | wall s median per run | cost $ total | tokens total | output tokens | tool calls | Volt calls | approvals |', '|---|---|---|---|---|---|---|---|---|---|---|');
for (const [arm, t] of Object.entries(totals)) {
	out.push(`| ${arm} | ${t.n} | ${t.scored ? `${fmt(t.score, 1)} / ${t.scored}` : '-'} | ${fmt(t.wall, 0)} | ${fmt(median(t.walls))} | ${fmt(t.cost, 4)} | ${fmt(t.tokens / 1e6, 2)}M | ${t.output} | ${t.calls} | ${t.volt} | ${arm === '2' ? t.approvals : '-'} |`);
}
console.log(out.join('\n'));
