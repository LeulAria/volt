// Prints the round-4 first-word tables: in-app A4 (a4.jsonl, arms before/after) and the adapter alone
// (acpbench.jsonl, labels r4-base/r4-volt). Only rows whose recorded 1-minute load is at most MAXLOAD count.
//   node summary.mjs [maxload=14] [since=<ISO time>]
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const DATA = join(here, '../../data/firstword');
const arg = name => process.argv.slice(2).find(a => a.startsWith(`${name}=`))?.slice(name.length + 1);
const maxLoad = Number(arg('maxload') ?? 14);
const since = arg('since') ?? '2026-11-14T02:20:00Z';
const rows = file => existsSync(join(DATA, file)) ? readFileSync(join(DATA, file), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(r => r.at >= since) : [];
const load1 = r => Number(String(r.load).split(/\s+/)[0]);
const median = values => {
	const s = values.filter(v => typeof v === 'number').sort((a, b) => a - b);
	return s.length ? (s.length % 2 ? s[s.length >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null;
};
const cell = values => {
	const s = values.filter(v => typeof v === 'number').sort((a, b) => a - b);
	return s.length ? `${median(s)} (${s.length}, ${s[0]}-${s.at(-1)})` : 'n/a';
};
const loads = rs => { const l = rs.map(load1).sort((a, b) => a - b); return l.length ? `${median(l)}, ${l.at(-1)}` : 'n/a'; };

function table(title, arms, metrics, all) {
	console.log(`\n${title} (median (n, min-max); rows with 1-min load <= ${maxLoad})\n`);
	console.log(`| Metric | ${arms.map(a => a.name).join(' | ')} |`);
	console.log(`|---|${arms.map(() => '---').join('|')}|`);
	for (const [label, get] of metrics) {
		console.log(`| ${label} | ${arms.map(a => cell(a.rows.filter(r => load1(r) <= maxLoad).map(get))).join(' | ')} |`);
	}
	console.log(`| min | ${arms.map(a => { const v = a.rows.filter(r => load1(r) <= maxLoad).map(metrics[0][1]).filter(x => typeof x === 'number'); return v.length ? Math.min(...v) : 'n/a'; }).join(' | ')} |`);
	console.log(`| load (median, max) | ${arms.map(a => loads(a.rows.filter(r => load1(r) <= maxLoad))).join(' | ')} |`);
	console.log(`| rows left out (load > ${maxLoad}) | ${arms.map(a => a.rows.filter(r => load1(r) > maxLoad).length).join(' | ')} |`);
	if (all) {
		console.log(`| all rows, ${metrics[0][0]} | ${arms.map(a => cell(a.rows.map(metrics[0][1]))).join(' | ')} |`);
	}
}

const a4 = rows('a4.jsonl');
table('A4 in-app, Enter to first word', ['before', 'after'].map(name => ({ name, rows: a4.filter(r => r.arm === name) })), [
	['Enter to first word on screen, ms', r => r.totalMs],
	['Enter to model request, ms', r => r.beforeRequestMs],
	['model request to first word on screen, ms', r => r.onScreenMs],
	['Enter to prompt leaving the window, ms', r => r.wsSendMs],
	['run start to session/prompt (server), ms', r => r.metrics?.promptMs],
], true);

const acp = rows('acpbench.jsonl');
table('The adapter alone: session/prompt to the model request', [['r4-base', 'unpatched'], ['r4-volt', 'Volt preload']].map(([label, name]) => ({ name, rows: acp.filter(r => r.label === label) })), [
	['session/prompt to model request, ms', r => r.mainReqMs],
	['session/prompt to first text, ms', r => r.firstTextMs],
	['count_tokens before the model request', r => r.before?.filter(b => b.path?.includes('count_tokens')).length],
	['CLI CPU, prompt to request, ms', r => r.cpuCliMs],
], true);
