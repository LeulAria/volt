// Per task and arm: score, median tokens, fresh tokens, $, tool calls, grep-like calls, Reads, wall time,
// and how many runs used a new code_nav op (impact, body, structural). Medians with n and range.
//   node summary.mjs <tag regex, e.g. ^r5b->   (prints markdown tables)
import { execFileSync } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
const here = dirname(fileURLToPath(import.meta.url));
const tag = process.argv[2] ?? '^r5b-';
const runs = execFileSync('node', [join(here, 'codebench.mjs'), tag, '--json'], { encoding: 'utf8', maxBuffer: 64 << 20 }).trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
const grades = execFileSync('node', [join(here, 'grade.mjs'), tag], { encoding: 'utf8' }).trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
for (const r of runs) { r.score = grades.find(g => g.label === r.label && String(g.rep) === String(r.rep))?.score; }
const med = xs => { const s = [...xs].sort((a, b) => a - b); return s.length % 2 ? s[s.length >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; };
const fmt = (xs, f = x => x) => `${f(med(xs))} (${f(Math.min(...xs))}-${f(Math.max(...xs))})`;
const k = x => `${(x / 1000).toFixed(1)}K`;
const s = x => `${(x / 1000).toFixed(1)} s`;
const tasks = [...new Set(runs.map(r => r.label.replace(/^[^-]+-(before|after)-/, '')))].sort();
console.log('| Task | Arm | n | Score | Tokens | Fresh | $ | Tool calls | grep-like | Reads | New ops used | Wall (load) |');
console.log('|---|---|---|---|---|---|---|---|---|---|---|---|');
const totals = { before: [], after: [] };
for (const task of tasks) {
	for (const arm of ['before', 'after']) {
		const rs = runs.filter(r => r.label.endsWith(`-${arm}-${task}`) && r.ended);
		if (!rs.length) { continue; }
		totals[arm].push(...rs);
		const scores = rs.map(r => r.score ?? 0);
		console.log(`| ${task} | ${arm} | ${rs.length} | ${scores.reduce((a, b) => a + b, 0)}/${rs.length} | ${fmt(rs.map(r => r.total), k)} | ${fmt(rs.map(r => r.fresh), k)} | ${med(rs.map(r => r.usd)).toFixed(4)} | ${fmt(rs.map(r => r.toolCalls))} | ${med(rs.map(r => r.grepLike))} | ${med(rs.map(r => r.reads))} | ${rs.filter(r => r.newOps > 0).length}/${rs.length} | ${fmt(rs.map(r => r.ms), s)} (${fmt(rs.map(r => +r.load))}) |`);
	}
}
console.log('\n| Arm | Runs | Right | Sum of per-task median tokens | Sum of median $ | Sum of median tool calls | Runs using a new op |');
console.log('|---|---|---|---|---|---|---|');
for (const arm of ['before', 'after']) {
	const rs = totals[arm];
	const per = tasks.map(task => rs.filter(r => r.label.endsWith(`-${arm}-${task}`))).filter(x => x.length);
	console.log(`| ${arm} | ${rs.length} | ${rs.reduce((a, r) => a + (r.score ?? 0), 0)}/${rs.length} | ${k(per.reduce((a, x) => a + med(x.map(r => r.total)), 0))} | ${per.reduce((a, x) => a + med(x.map(r => r.usd)), 0).toFixed(4)} | ${per.reduce((a, x) => a + med(x.map(r => r.toolCalls)), 0)} | ${rs.filter(r => r.newOps > 0).length}/${rs.length} |`);
}
console.log('\nOps per run (after):');
for (const r of totals.after) { console.log(`- ${r.label} r${r.rep}: ${r.calls.join(' ')}`); }
