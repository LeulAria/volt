// Round 10 IDE bench: the report's tables from the result files.
//   node tables.mjs <dir with base.json after.json cold-base.json cold-after.json grepcmp-after.json>
import { readFileSync } from 'fs';
import { join } from 'path';

const dir = process.argv[2];
const load = name => { try { return JSON.parse(readFileSync(join(dir, name), 'utf8')); } catch { return undefined; } };
const base = load('base.json'), after = load('after.json');
const SCORE = { correct: 1, partial: 0.5 };
const short = status => ({ correct: 'right', partial: 'partly', wrong: 'WRONG', error: 'error', 'clear-error': 'refused, says why', 'clear-none': 'none, says why' })[status] ?? status;
const ms = value => value === undefined ? '-' : value < 10 ? value.toFixed(1) : String(Math.round(value));
const median = values => { const s = [...values].sort((a, b) => a - b); return s.length ? s[Math.floor((s.length - 1) / 2)] : undefined; };

console.log(`before: ${base?.app} ${base?.at}, load ${base?.loadStart} -> ${base?.loadEnd}, n ${base?.n}, sandbox ${base?.sandbox}`);
console.log(`after:  ${after?.app} ${after?.at}, load ${after?.loadStart} -> ${after?.loadEnd}, n ${after?.n}, sandbox ${after?.sandbox}\n`);

for (const lang of ['ts', 'py', 'go']) {
	const b = base?.langs[lang] ?? [], a = after?.langs[lang] ?? [];
	console.log(`### ${lang}\n`);
	console.log('| case | tool | before | after | warm p50 / p95 ms before (n) | warm p50 / p95 ms after (n) | tokens before | tokens after |');
	console.log('|---|---|---|---|---|---|---|---|');
	for (const row of a) {
		const was = b.find(item => item.id === row.id);
		const cell = item => item ? `${short(item.status)}${item.flaky ? ' (unstable)' : ''}${item.supervised ? ' [Full access]' : ''}` : '-';
		const lat = item => item?.warm?.n ? `${ms(item.warm.p50)} / ${ms(item.warm.p95)} (${item.warm.n})` : '-';
		console.log(`| ${row.id} | ${row.tool}${row.args?.op ? ` ${row.args.op}` : ''} | ${cell(was)} | ${cell(row)} | ${lat(was)} | ${lat(row)} | ${was?.tokens ?? '-'} | ${row.tokens} |`);
	}
	const total = rows => rows.reduce((sum, row) => sum + (SCORE[row.status] ?? 0), 0);
	const count = (rows, status) => rows.filter(row => row.status === status).length;
	const line = rows => `${total(rows)} / ${rows.length} (right ${count(rows, 'correct')}, partly ${count(rows, 'partial')}, wrong ${count(rows, 'wrong')}, error ${count(rows, 'error')}, says why ${count(rows, 'clear-error') + count(rows, 'clear-none')}, unstable ${rows.filter(row => row.flaky).length})`;
	console.log(`\nscore before ${line(b)}; after ${line(a)}`);
	const both = a.filter(row => b.find(item => item.id === row.id)?.warm?.n && row.warm?.n);
	console.log(`median of warm p50 over the ${both.length} cases both arms timed: before ${ms(median(both.map(row => b.find(item => item.id === row.id).warm.p50)))} ms, after ${ms(median(both.map(row => row.warm.p50)))} ms; tokens summed over all cases: before ${b.reduce((s, r) => s + r.tokens, 0)}, after ${a.reduce((s, r) => s + r.tokens, 0)}\n`);
}

for (const name of ['cold-base.json', 'cold-after.json']) {
	const cold = load(name);
	if (!cold) { continue; }
	console.log(`### ${name}\n`);
	console.log('| lang | rep | load | launch to window ms | launch to tools listed ms | first call ms | first answer | ms to a right answer |');
	console.log('|---|---|---|---|---|---|---|---|');
	for (const row of cold.rows) {
		console.log(`| ${row.lang} | ${row.rep} | ${row.load} | ${row.windowMs} | ${row.toolsMs} | ${row.firstMs} | ${short(row.first)}${row.first === 'correct' ? '' : `: ${row.firstText}`} | ${row.rightMs ?? 'never (30 s)'} |`);
	}
	console.log('');
}

const cmp = load('grepcmp-after.json');
if (cmp) {
	console.log('### grep and read alone vs Volt tools\n');
	console.log('| # | lang | question | Volt call | Volt steps | Volt tokens | facts missing | look-alikes | grep steps | grep tokens | facts missing | look-alikes |');
	console.log('|---|---|---|---|---|---|---|---|---|---|---|---|');
	for (const row of cmp.rows) {
		console.log(`| ${row.id} | ${row.lang} | ${row.q} | ${row.tools.calls.join(', ')} | ${row.tools.steps} | ${row.tools.tokens} | ${row.tools.missing.length} | ${row.tools.extra} | ${row.grep.steps} | ${row.grep.tokens} | ${row.grep.missing.length} | ${row.grep.extra} |`);
	}
	console.log(`| | | **total** | | **${cmp.totals.tools.steps}** | **${cmp.totals.tools.tokens}** | | ${cmp.rows.reduce((s, r) => s + r.tools.extra, 0)} | **${cmp.totals.grep.steps}** | **${cmp.totals.grep.tokens}** | | ${cmp.rows.reduce((s, r) => s + r.grep.extra, 0)} |`);
}
