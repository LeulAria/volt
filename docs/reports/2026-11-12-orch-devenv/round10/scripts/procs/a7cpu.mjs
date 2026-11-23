// CPU of the agent server and the adapter host over an A7 window (ADEMark sampler CSV: cumulative cpu ns per pid),
// with their footprint at the row's p95 tick, for every A7 row of the given arms.
//   node a7cpu.mjs <arm...>
import { readFileSync } from 'fs';
import { join } from 'path';
import { DATA } from './lib.mjs';
const arms = process.argv.slice(2);
for (const r of readFileSync(join(DATA, 'a7.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l)).filter(r => !arms.length || arms.includes(r.arm))) {
	const lines = readFileSync(r.csv, 'utf8').trim().split('\n');
	const h = lines.shift().split(',');
	const c = n => h.indexOf(n);
	const by = new Map();
	for (const l of lines) {
		const f = l.split(',');
		const exe = f[c('exe')].split('/').pop();
		const e = by.get(f[c('pid')]) ?? by.set(f[c('pid')], { exe, ppid: f[c('ppid')], first: null, last: null }).get(f[c('pid')]);
		const pt = { t: Number(f[c('t_ns')]), cpu: Number(f[c('cpu_user_ns')]) + Number(f[c('cpu_sys_ns')]) };
		e.first ??= pt; e.last = pt;
	}
	const pct = e => e.last.t > e.first.t ? (100 * (e.last.cpu - e.first.cpu) / (e.last.t - e.first.t)).toFixed(1) : 'n/a';
	const server = [...by.values()].find(e => e.exe === 'Electron' && [...by.values()].some(x => x.exe === 'claude' && by.get(x.ppid) === e));
	const host = [...by.values()].find(e => e.exe === 'node');
	console.log(`${r.arm.padEnd(14)} load ${String(r.load).split(' ')[0].padStart(5)}  server ${String(r.byRoleAtP95['agent server']?.mib).padStart(4)} MiB cpu ${server ? pct(server) : '?'}%  host ${String(r.byRoleAtP95['ACP adapter (node)']?.mib).padStart(4)} MiB cpu ${host ? pct(host) : '?'}%  total ${r.totalP95}`);
}
