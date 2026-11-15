// Per-process view of one A7 sample file (ADEMark's sampler CSV): for each pid, its role by executable and parent,
// median and p95 phys_footprint (MiB) over the ticks it lived, and how many ticks. Rolled up by role at the end.
//   node a7procs.mjs <csv> [minMiB=5]
import { readFileSync } from 'fs';
const [file, min = '5'] = process.argv.slice(2);
const rows = readFileSync(file, 'utf8').trim().split('\n').slice(1).map(l => l.split(','));
const by = new Map();
for (const [t, pid, ppid, group, exe, fp] of rows) {
	const e = by.get(pid) ?? by.set(pid, { pid, ppid, group, exe, exes: new Map(), fp: [], t: new Set() }).get(pid);
	e.fp.push(Number(fp) / 1048576); e.t.add(t);
	// A process is sampled under its launcher's name for a tick or two (sandbox-exec, then the CLI): the name it had longest.
	e.exes.set(exe, (e.exes.get(exe) ?? 0) + 1);
	e.group = group;
}
for (const e of by.values()) { e.exe = [...e.exes].sort((a, b) => b[1] - a[1])[0][0]; }
const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const name = e => e.exe.split('/').pop();
const exeOf = pid => by.get(pid)?.exe ?? '';
const role = e => {
	const n = name(e);
	if (n === 'claude') { return 'claude CLI'; }
	if (n === 'node') { return /Electron|VOLT/.test(exeOf(e.ppid)) || /claude/.test(exeOf(e.ppid)) || true ? 'node (ACP adapter / host)' : 'node'; }
	if (/Helper \(GPU\)/.test(n)) { return 'gpu'; }
	if (/Helper \(Renderer\)/.test(n)) { return 'renderer'; }
	if (/Helper \(Plugin\)/.test(n)) { return 'plugin helper (ext host / tsserver)'; }
	if (/Helper/.test(n)) { return 'utility helper'; }
	if (/Electron|VOLT/.test(n)) { return by.get(e.ppid) ? 'electron child (agent server / code index / plugin host)' : 'main'; }
	return 'other';
};
const roles = new Map();
const ticks = new Set(rows.map(r => r[0])).size;
for (const e of by.values()) {
	const r = role(e);
	const o = roles.get(r) ?? roles.set(r, { n: 0, perTick: new Map() }).get(r);
	o.n++;
}
// Per role, the sum over its processes at each tick; p95 of that.
const perTick = new Map();
for (const [t, pid, , , , fp] of rows) {
	const r = role(by.get(pid));
	const m = perTick.get(r) ?? perTick.set(r, new Map()).get(r);
	m.set(t, (m.get(t) ?? 0) + Number(fp) / 1048576);
}
console.log(`ticks ${ticks}`);
for (const [r, m] of [...perTick].sort((a, b) => q([...b[1].values()], 0.95) - q([...a[1].values()], 0.95))) {
	const v = [...m.values()];
	console.log(`${r.padEnd(58)} procs ${String(roles.get(r).n).padStart(3)}  sum median ${q(v, 0.5).toFixed(0).padStart(5)}  p95 ${q(v, 0.95).toFixed(0).padStart(5)} MiB`);
}
console.log('--- processes over ' + min + ' MiB');
for (const e of [...by.values()].filter(e => q(e.fp, 0.95) >= Number(min)).sort((a, b) => q(b.fp, 0.95) - q(a.fp, 0.95))) {
	console.log(`${e.pid.padStart(6)} <- ${e.ppid.padStart(6)} ${e.group.padEnd(6)} ${name(e).slice(0, 28).padEnd(28)} median ${q(e.fp, 0.5).toFixed(0).padStart(5)} p95 ${q(e.fp, 0.95).toFixed(0).padStart(5)} MiB  ticks ${e.t.size}`);
}
