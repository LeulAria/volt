// The A8 rows of data/typing/a8.jsonl as a markdown table per arm: each row's p50 / p95 with its loads, the median
// and range of the rows, and p50 / p95 pooled over every key. Rows with missed keys, with a start load over 14, or
// (Volt arms) without the front reply streaming are listed and left out.
//   node a8table.mjs [--since ISO] [--file a8.jsonl]
import { readFileSync } from 'fs';
import { join } from 'path';
import { DATA, median, pct } from './lib.mjs';
const args = process.argv.slice(2);
const opt = n => args.includes(n) ? args[args.indexOf(n) + 1] : undefined;
const since = opt('--since') ?? '';
const rows = readFileSync(join(DATA, opt('--file') ?? 'a8.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(r => r.at >= since);
const arms = [...new Set(rows.map(r => r.arm))];
const r1 = v => v === null || v === undefined ? '-' : Math.round(v * 100) / 100;
console.log('| Arm | Rows (p50 / p95, load at start / while typing) | Median p50 (range) | Median p95 (range) | Pooled p50 / p95 (n) | Left out |');
console.log('|---|---|---|---|---|---|');
for (const arm of arms) {
	const all = rows.filter(r => r.arm === arm);
	const bad = r => r.missed > 0 || r.loadStart > 14 || (!['t3code', 'paseo'].includes(arm) && r.streamed !== true);
	const ok = all.filter(r => !bad(r));
	const pooled = ok.flatMap(r => r.k2p ?? []);
	const range = k => ok.length ? `${r1(median(ok.map(r => r[k])))} (${r1(Math.min(...ok.map(r => r[k])))}-${r1(Math.max(...ok.map(r => r[k])))})` : '-';
	console.log(`| \`${arm}\` | ${ok.map(r => `${r1(r.k2pP50)}/${r1(r.k2pP95)} (${r1(r.loadStart)}/${r1(r.loadTyping)})`).join(', ')} | ${range('k2pP50')} | ${range('k2pP95')} | ${r1(median(pooled))} / ${r1(pct(pooled, 0.95))} (${pooled.length}) | ${all.filter(bad).map(r => `${r1(r.k2pP50)}/${r1(r.k2pP95)} load ${r1(r.loadStart)}/${r1(r.loadTyping)} missed ${r.missed}${r.streamed === false ? ' not streaming' : ''}`).join('; ') || 'none'} |`);
}
