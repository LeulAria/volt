// A5 Weigh-in + A6 Idle Burn (ADEMark method, unofficial): ADEMark's own sampler (ademark-native sample,
// proc_pid_rusage phys_footprint at 4 Hz) over the test instance's process tree for 60 s after a settle,
// with each process named by role. CPU % = delta(user+sys) / wall over the window, per role.
//   node a5.mjs <arm> [settle s=90] [window s=60]   (rows appended to data/speed/a5.jsonl)
import { execFileSync, execSync } from 'child_process';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { DATA, load, mem, sleep, UD, cdp } from './lib.mjs';
import { role } from './roles.mjs';

const [arm = 'dev', settleArg = '90', windowArg = '60'] = process.argv.slice(2);
const NATIVE = process.env.SPEED_NATIVE ?? `${process.env.HOME}/.volt-r3/speed/native/bin/ademark-native`;
mkdirSync(join(DATA, 'raw'), { recursive: true });

function mainPid() {
	const rows = execSync('ps -axo pid=,command=').toString().split('\n');
	const main = rows.find(l => l.includes(`--user-data-dir ${UD}`) && /MacOS\/(Electron|VOLT|Volt)( |$)/.test(l) && !l.includes('--type=') && !l.includes('volt-agent-server-main'));
	return main ? Number(main.trim().split(/\s+/)[0]) : undefined;
}


const pid = mainPid();
if (!pid) {
	throw new Error('no running test instance');
}
// Park the window on a finished chat and leave it alone; the window stays in front (not covered).
await sleep(Number(settleArg) * 1000);
const rules = join(DATA, 'raw', `a5-rules-${arm}.json`);
// The agent server outlives a quit (until it stops itself), so a relaunch may reuse one that is no child of
// this main process: it and its tree count too, as ADEMark's attribution (bundle path) counts them.
const serverPids = execSync('ps -axo pid=,command=').toString().split('\n').filter(l => l.includes(`--user-data-dir ${UD}`) && l.includes('volt-agent-server-main')).map(l => Number(l.trim().split(/\s+/)[0]));
writeFileSync(rules, JSON.stringify({ rootPids: [pid, ...serverPids], bundlePaths: [], vendorDirs: [], agentExecutables: ['claude', 'codex'], excludeNames: ['crashpad_handler'] }));
const csv = join(DATA, 'raw', `a5-${arm}-${Date.now()}.csv`);
const loadAvg = load();
const memStart = mem();
const cmds = new Map(execSync('ps -axo pid=,command=', { maxBuffer: 64 << 20 }).toString().split('\n').filter(Boolean).map(l => { const m = /^\s*(\d+)\s+(.*)$/.exec(l); return [Number(m[1]), m[2]]; }));
const summary = JSON.parse(execFileSync(NATIVE, ['sample', '--rules', rules, '--hz', '4', '--duration-s', windowArg, '--csv', csv], { encoding: 'utf8' }));
for (const l of execSync('ps -axo pid=,command=', { maxBuffer: 64 << 20 }).toString().split('\n').filter(Boolean)) {
	const m = /^\s*(\d+)\s+(.*)$/.exec(l);
	if (!cmds.has(Number(m[1]))) { cmds.set(Number(m[1]), m[2]); }
}
const lines = readFileSync(csv, 'utf8').trim().split('\n');
const header = lines.shift().split(',');
const idx = name => header.indexOf(name);
const perPid = new Map();
const ticks = new Set();
for (const line of lines) {
	const f = line.split(',');
	const p = Number(f[idx('pid')]);
	const t = f[idx('t_ns')];
	ticks.add(t);
	const e = perPid.get(p) ?? { pid: p, group: f[idx('group')], exe: f[idx('exe')], foot: [], cpu: [], t: [] };
	e.foot.push(Number(f[idx('phys_footprint_b')]));
	e.cpu.push(Number(f[idx('cpu_user_ns')]) + Number(f[idx('cpu_sys_ns')]));
	e.t.push(Number(t));
	perPid.set(p, e);
}
const med = a => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };
const byRole = {};
const procs = [];
for (const e of perPid.values()) {
	const r = role(cmds.get(e.pid) ?? e.exe);
	const mib = med(e.foot) / 1048576;
	const wall = (e.t.at(-1) - e.t[0]) / 1e9;
	const cpuPct = wall > 0 ? (e.cpu.at(-1) - e.cpu[0]) / 1e9 / wall * 100 : 0;
	procs.push({ pid: e.pid, role: r, group: e.group, mib: Math.round(mib * 10) / 10, cpuPct: Math.round(cpuPct * 100) / 100, cmd: (cmds.get(e.pid) ?? e.exe).slice(0, 160) });
	const b = byRole[r] ??= { n: 0, mib: 0, cpuPct: 0 };
	b.n++; b.mib += mib; b.cpuPct += cpuPct;
}
for (const b of Object.values(byRole)) { b.mib = Math.round(b.mib); b.cpuPct = Math.round(b.cpuPct * 100) / 100; }
procs.sort((a, b) => b.mib - a.mib);
const cpuTotal = (group) => Math.round(procs.filter(p => !group || p.group === group).reduce((s, p) => s + p.cpuPct, 0) * 100) / 100;
let domNodes;
try { const c = await cdp(); domNodes = await c.evaluate('document.getElementsByTagName("*").length'); c.close(); } catch { }
const row = {
	arm, variant: process.env.SPEED_VARIANT ?? 'chat', at: new Date().toISOString(), load: loadAvg, settleS: Number(settleArg), windowS: Number(windowArg),
	appMedianMiB: Math.round(summary.app_median_b / 1048576), agentsMedianMiB: Math.round(summary.agents_median_b / 1048576), totalMedianMiB: Math.round(summary.total_median_b / 1048576),
	processes: procs.length, cpuAppPct: cpuTotal('app'), cpuAgentsPct: cpuTotal('agents'), domNodes,
	// ADEMark: invalid if swap grew during the window.
	mem: memStart, memEnd: mem(), byRole, procs, csv,
};
row.swapGrewMiB = row.memEnd.swapUsedMiB - row.mem.swapUsedMiB;
appendFileSync(join(DATA, 'a5.jsonl'), JSON.stringify(row) + '\n');
console.log(JSON.stringify({ arm, variant: row.variant, app: row.appMedianMiB, agents: row.agentsMedianMiB, total: row.totalMedianMiB, processes: row.processes, cpuApp: row.cpuAppPct, cpuAgents: row.cpuAgentsPct, load: loadAvg }));
console.log(Object.entries(byRole).sort((a, b) => b[1].mib - a[1].mib).map(([k, v]) => `${k.padEnd(48)} n=${v.n} ${String(v.mib).padStart(5)} MiB cpu ${v.cpuPct}%`).join('\n'));
