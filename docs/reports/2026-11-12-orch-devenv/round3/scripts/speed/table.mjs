// The report's before/after table from data/speed/*.jsonl: median, n and range per arm, plus the 1-minute
// load the runs were taken under (median and max).
//   node table.mjs [arms=before,after] [since=<ISO>] [until=<ISO>] [maxload=14]
// since/until keep the rows whose `at` falls in that window; maxload drops rows whose 1-minute load (for A8 the
// higher of the load at its start and while typing) was above it, and the last column says how many were dropped.
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { DATA, median } from './lib.mjs';

const opts = Object.fromEntries(process.argv.slice(2).map(a => a.split('=')));
const arms = (opts.arms ?? 'before,after').split(',');
const since = opts.since ? Date.parse(opts.since) : -Infinity;
const until = opts.until ? Date.parse(opts.until) : Infinity;
const maxLoad = opts.maxload ? Number(opts.maxload) : Infinity;
const load1 = r => Math.max(...[r.load, r.loadTyping].filter(Boolean).map(l => Number(String(l).split(/\s+/)[0])));
// An A5 row without `domNodes` was sampled while the instance's window could not be reached over CDP (the
// workbench was gone: 7 processes, no agents), so it does not weigh a running Volt and is left out.
const valid = (name, r) => name !== 'a5.jsonl' || typeof r.domNodes === 'number';
const rows = name => (existsSync(join(DATA, name)) ? readFileSync(join(DATA, name), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : [])
	.filter(r => Date.parse(r.at) >= since && Date.parse(r.at) <= until && valid(name, r));
const metrics = [
	['A2 relaunch to typing (dev build), ms', 'a1.jsonl', r => r.readyMs],
	['A2 part after the module load, ms', 'a1.jsonl', r => r.afterModuleLoadMs],
	['A3 new thread to typing, ms', 'a3.jsonl', r => r.readyMs],
	['A4 Enter to first word, ms', 'a4.jsonl', r => r.totalMs],
	['A4 Enter to request at the model API, ms', 'a4.jsonl', r => r.beforeRequestMs],
	['A4 Enter to prompt leaving the window, ms', 'a4.jsonl', r => r.wsSendMs],
	['A4 request to first word on screen, ms', 'a4.jsonl', r => r.onScreenMs],
	['A8 typing lag p95 with 5 streams, ms', 'a8.jsonl', r => r.paintedP95],
	['A8 typing lag p50 with 5 streams, ms', 'a8.jsonl', r => r.paintedP50],
	['A7-style app memory p95 while 5 stream (18 s), MiB', 'a8.jsonl', r => r.appP95MiB],
	['A5 app memory at rest, on a chat, MiB', 'a5.jsonl', r => r.variant === 'chat' ? r.appMedianMiB : undefined],
	['A5 app + agents at rest, on a chat, MiB', 'a5.jsonl', r => r.variant === 'chat' ? r.totalMedianMiB : undefined],
	['A6 idle CPU, app, on a chat, % of a core', 'a5.jsonl', r => r.variant === 'chat' ? r.cpuAppPct : undefined],
	['A5 app memory at rest, new-chat page, MiB', 'a5.jsonl', r => r.variant === 'landing' ? r.appMedianMiB : undefined],
	['A6 idle CPU, app, new-chat page, % of a core', 'a5.jsonl', r => r.variant === 'landing' ? r.cpuAppPct : undefined],
	['A6 idle CPU, agents, new-chat page, % of a core', 'a5.jsonl', r => r.variant === 'landing' ? r.cpuAgentsPct : undefined],
];
const fmt = v => (v === null || v === undefined ? '-' : Math.abs(v) >= 100 ? String(Math.round(v)) : String(Math.round(v * 10) / 10));
console.log(`| Metric | ${arms.map(a => `${a}: median (n, range)`).join(' | ')} | load (median, max) | dropped over load |`);
console.log(`|---|${arms.map(() => '---').join('|')}|---|---|`);
for (const [label, file, get] of metrics) {
	const measured = rows(file).filter(r => arms.includes(r.arm) && typeof get(r) === 'number');
	const all = measured.filter(r => !(load1(r) > maxLoad));
	const droppedHere = measured.length - all.length;
	const cells = arms.map(arm => {
		const vs = all.filter(r => r.arm === arm).map(get).filter(v => typeof v === 'number' && !Number.isNaN(v));
		return vs.length ? `${fmt(median(vs))} (${vs.length}, ${fmt(Math.min(...vs))}-${fmt(Math.max(...vs))})` : '-';
	});
	const loads = all.filter(r => typeof get(r) === 'number').map(load1).filter(v => !Number.isNaN(v));
	console.log(`| ${label} | ${cells.join(' | ')} | ${loads.length ? `${fmt(median(loads))}, ${fmt(Math.max(...loads))}` : '-'} | ${droppedHere} |`);
}
