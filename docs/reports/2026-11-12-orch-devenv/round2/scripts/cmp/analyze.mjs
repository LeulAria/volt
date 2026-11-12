// Tables for the report from runs.jsonl: per task and arm, median [min-max] of wall time, time to
// first output, tokens and cost, plus correctness and failures. Usage: node analyze.mjs [runs.jsonl] [--after]
// Cost columns: "reported" is what the harness itself says; "Haiku list" reprices every Claude Haiku 5.5
// arm from its tokens at one rate card (derived from Claude Code 2.1.322's own list-price report and
// Hermes' estimate, which agree): input $0.10/M, output $0.50/M, cache read $0.01/M, cache write $0.20/M.
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const here = dirname(fileURLToPath(import.meta.url));
const file = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : join(here, '../../data/cmp/runs.jsonl');
const rows = readFileSync(file, 'utf8').trim().split('\n').map(l => JSON.parse(l));
const HAIKU = { input: 0.10, output: 0.50, cacheRead: 0.01, cacheWrite: 0.20 };
const haikuArms = new Set(['cc', 'hermes', 'volt', 't3', 'volt-after']);
const listCost = u => u ? ((u.input ?? 0) * HAIKU.input + (u.output ?? 0) * HAIKU.output + (u.cacheRead ?? 0) * HAIKU.cacheRead + (u.cacheWrite ?? 0) * HAIKU.cacheWrite) / 1e6 : undefined;
const tokens = u => u ? (u.input ?? 0) + (u.output ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0) : 0;
const med = xs => { const s = xs.filter(x => typeof x === 'number' && !isNaN(x)).sort((a, b) => a - b); if (!s.length) { return undefined; } const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const range = xs => { const s = xs.filter(x => typeof x === 'number' && !isNaN(x)); return s.length ? [Math.min(...s), Math.max(...s)] : undefined; };
const sec = ms => ms === undefined ? '–' : (ms / 1000).toFixed(1);
const fmt = (xs, f) => { const m = med(xs); const r = range(xs); return m === undefined ? '–' : `${f(m)} [${f(r[0])}–${f(r[1])}]`; };
const ok = r => {
	if (r.timedOut || r.exit) { return 0; }
	const s = r.score ?? {};
	if (r.task === 't0') { return s.ok ? 1 : 0; }
	if (r.task === 't1') { return s.score / 4; }
	if (r.task === 't2') { return s.green && !s.stray?.length ? 1 : 0; }
	return s.plantedFixed && s.pass === s.total && !s.stray?.length ? 1 : 0;
};
const order = ['cc', 't3', 'hermes', 'volt', 'volt-after', 'cursor-sonnet', 'volt-cursor-sonnet', 'cursor-grok', 'volt-cursor-grok'];
const out = [];
for (const task of ['t0', 't1', 't2', 't3']) {
	out.push(`\n### ${task}\n`);
	out.push('| Arm | n | Wall s | First output s | Tokens (all, k) | Prompt per request | Cost reported $ | Cost at Haiku list $ | Score | Subagents |');
	out.push('|---|---|---|---|---|---|---|---|---|---|');
	for (const arm of order) {
		const rs = rows.filter(r => r.task === task && r.arm === arm);
		if (!rs.length) { continue; }
		const maxIn = rs.map(r => r.parentMetrics?.[0]?.maxRequestInput);
		out.push(`| ${arm} | ${rs.length} | ${fmt(rs.map(r => r.wallMs), sec)} | ${fmt(rs.map(r => r.ttftMs), sec)} | ${fmt(rs.map(r => tokens(r.usage)), x => (x / 1000).toFixed(0))} | ${maxIn.some(Boolean) ? fmt(maxIn, x => (x / 1000).toFixed(1) + 'k') : '–'} | ${fmt(rs.map(r => r.costUsd ?? undefined), x => x.toFixed(4))} | ${haikuArms.has(arm) ? fmt(rs.map(r => listCost(r.usage)), x => x.toFixed(4)) : 'n/a'} | ${rs.map(ok).map(x => +x.toFixed(2)).join(' / ')} | ${rs.map(r => r.subagents ?? 0).join(' / ')} |`);
	}
}
console.log(out.join('\n'));
