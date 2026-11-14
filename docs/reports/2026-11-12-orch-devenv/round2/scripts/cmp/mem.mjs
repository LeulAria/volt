// Memory (macOS `footprint`, Activity Monitor's number) and CPU of an app's whole process tree,
// plus processes outside the tree that belong to it (Volt's launchd agent server, a T3 server):
//   node mem.mjs <label> <rootPid> [--extra <regex>] [--window <s>] [--samples <n>]
// Prints one JSON line: footprint MiB summed over the tree (median of samples), process count,
// CPU % (sum of ps cputime growth over the window / wall), and the top processes.
import { execFileSync } from 'child_process';

const [label, rootArg, ...rest] = process.argv.slice(2);
const opt = (name, def) => rest.includes(name) ? rest[rest.indexOf(name) + 1] : def;
const extra = opt('--extra') ? new RegExp(opt('--extra')) : undefined;
const windowS = Number(opt('--window', '10'));
const samples = Number(opt('--samples', '3'));
const sleep = ms => new Promise(r => setTimeout(r, ms));

function table() {
	const out = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,time=,args='], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
	return out.split('\n').filter(Boolean).map(line => {
		const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
		if (!m) { return undefined; }
		const parts = m[3].split(/[:.]/).map(Number);
		// [[dd-]hh:]mm:ss.cc
		const t = m[3].includes('-') ? NaN : (parts.length === 4 ? parts[0] * 3600 + parts[1] * 60 + parts[2] + parts[3] / 100 : parts[0] * 60 + parts[1] + parts[2] / 100);
		return { pid: +m[1], ppid: +m[2], cpuS: t, args: m[4] };
	}).filter(Boolean);
}

function members(rows) {
	const kids = new Map();
	for (const r of rows) { (kids.get(r.ppid) ?? kids.set(r.ppid, []).get(r.ppid)).push(r); }
	const seen = new Map();
	const roots = rows.filter(r => r.pid === Number(rootArg) || (extra && extra.test(r.args)));
	const queue = [...roots];
	while (queue.length) {
		const r = queue.shift();
		if (seen.has(r.pid)) { continue; }
		seen.set(r.pid, r);
		queue.push(...(kids.get(r.pid) ?? []));
	}
	return [...seen.values()];
}

function footprints(pids) {
	if (!pids.length) { return new Map(); }
	let out = '';
	try {
		out = execFileSync('footprint', ['-f', 'bytes', ...pids.map(String)], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
	} catch (err) { out = String(err.stdout ?? ''); }
	const map = new Map();
	for (const m of out.matchAll(/\[(\d+)\]:.*?Footprint: (\d+) B/g)) { map.set(Number(m[1]), Number(m[2])); }
	return map;
}

const totals = [];
let procs = [];
const first = members(table());
const t0 = Date.now();
for (let i = 0; i < samples; i++) {
	procs = members(table());
	const fp = footprints(procs.map(p => p.pid));
	procs = procs.map(p => ({ ...p, mib: (fp.get(p.pid) ?? 0) / 1048576 }));
	totals.push(procs.reduce((a, p) => a + p.mib, 0));
	if (i < samples - 1) { await sleep(windowS * 1000 / Math.max(1, samples - 1)); }
}
const last = members(table());
const wall = (Date.now() - t0) / 1000;
const cpu0 = new Map(first.map(p => [p.pid, p.cpuS]));
let cpuS = 0;
for (const p of last) { cpuS += p.cpuS - (cpu0.get(p.pid) ?? p.cpuS); }
const sorted = [...totals].sort((a, b) => a - b);
const name = a => a.replace(/^.*\/(Contents\/(MacOS|Frameworks)\/)?/, '').slice(0, 70);
console.log(JSON.stringify({
	label, at: new Date().toISOString(), load: execFileSync('uptime').toString().replace(/.*averages?:\s*/, '').trim(),
	footprintMiB: Math.round(sorted[sorted.length >> 1]), samplesMiB: totals.map(Math.round), processes: procs.length,
	cpuPct: Math.round(cpuS / wall * 1000) / 10, windowS: Math.round(wall),
	top: procs.sort((a, b) => b.mib - a.mib).slice(0, 8).map(p => ({ pid: p.pid, mib: Math.round(p.mib), what: name(p.args) })),
}));
