// A6 Idle Burn (ADEMark method, unofficial): ADEMark's sampler (`ademark-native sample`, proc_pid_rusage at 4 Hz)
// over the arm's process tree for `window` s after `settle` s. CPU % = delta(user+sys) / wall of the `app` group (the
// agents group apart), wakeups/s = delta(pkg_idle + interrupt wakeups) / wall, per process role too.
// Variants: front (window visible; focus emulated over CDP so the page behaves as the frontmost app's: the user works at
// this Mac and the test window is not frontmost), covered (ADEMark's own `ademark-native cover` opaque panel over the
// window for the sampled window; see the report on why it is shrunk first).
//   node a6.mjs <arm> [front|covered] [settle s=60] [window s=60]   (rows appended to data/smooth/a6.jsonl)
import { execFile, execFileSync, execSync } from 'child_process';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { cdp, DATA, load1, mainPid, NATIVE, role, sleep, waitQuiet } from './lib.mjs';

const [arm = 'after', variant = 'front', settleArg = '60', windowArg = '60'] = process.argv.slice(2);
mkdirSync(join(DATA, 'raw'), { recursive: true });
const pid = mainPid(arm);
if (!pid) {
	throw new Error(`no running ${arm} instance`);
}
const c = await cdp();
const emulateFocus = process.env.SMOOTH_NO_FOCUS !== '1';
await c.send('Emulation.setFocusEmulationEnabled', { enabled: emulateFocus });
await sleep(Number(settleArg) * 1000);
const rules = join(DATA, 'raw', `a6-rules-${arm}.json`);
writeFileSync(rules, JSON.stringify({ rootPids: [pid], bundlePaths: [], vendorDirs: [], agentExecutables: ['claude', 'codex'], excludeNames: ['crashpad_handler'] }));
const csv = join(DATA, 'raw', `a6-${arm}-${variant}-${Date.now()}.csv`);
// The brief's gate: a sample starts only at a 1-minute load of 14 or less.
const loadStart = await waitQuiet(14);
let cover;
if (variant === 'covered') {
	cover = new Promise(res => execFile(NATIVE, ['cover', '--pid', String(pid), '--duration-s', String(Number(windowArg) + 4)], { encoding: 'utf8' }, (err, out, stderr) => res(err ? { error: `${String(err).slice(0, 200)} ${String(stderr).slice(0, 300)}`.trim() } : JSON.parse(out))));
	await sleep(2000);
}
const stateDuring = await c.evaluate('JSON.stringify({vis: document.visibilityState, focus: document.hasFocus()})');
const cmds = new Map(execSync('ps -axo pid=,command=', { maxBuffer: 64 << 20 }).toString().split('\n').filter(Boolean).map(l => { const m = /^\s*(\d+)\s+(.*)$/.exec(l); return [Number(m[1]), m[2]]; }));
const summary = JSON.parse(execFileSync(NATIVE, ['sample', '--rules', rules, '--hz', '4', '--duration-s', windowArg, '--csv', csv], { encoding: 'utf8' }));
const coverResult = cover ? await cover : undefined;
await c.send('Emulation.setFocusEmulationEnabled', { enabled: false });
c.close();
const loadEnd = load1();
for (const l of execSync('ps -axo pid=,command=', { maxBuffer: 64 << 20 }).toString().split('\n').filter(Boolean)) {
	const m = /^\s*(\d+)\s+(.*)$/.exec(l);
	if (!cmds.has(Number(m[1]))) { cmds.set(Number(m[1]), m[2]); }
}
const lines = readFileSync(csv, 'utf8').trim().split('\n');
const header = lines.shift().split(',');
const idx = name => header.indexOf(name);
const perPid = new Map();
for (const line of lines) {
	const f = line.split(',');
	const p = Number(f[idx('pid')]);
	const e = perPid.get(p) ?? { pid: p, group: f[idx('group')], exe: f[idx('exe')], cpu: [], wk: [], t: [] };
	e.cpu.push(Number(f[idx('cpu_user_ns')]) + Number(f[idx('cpu_sys_ns')]));
	e.wk.push(Number(f[idx('wakeups_idle')]) + Number(f[idx('wakeups_irq')]));
	e.t.push(Number(f[idx('t_ns')]));
	perPid.set(p, e);
}
const procs = [];
const byRole = {};
let wall = 0;
for (const e of perPid.values()) {
	const w = (e.t.at(-1) - e.t[0]) / 1e9;
	wall = Math.max(wall, w);
	const cpuPct = w > 0 ? (e.cpu.at(-1) - e.cpu[0]) / 1e9 / w * 100 : 0;
	const wakeups = w > 0 ? (e.wk.at(-1) - e.wk[0]) / w : 0;
	const r = role(cmds.get(e.pid) ?? e.exe);
	procs.push({ pid: e.pid, role: r, group: e.group, cpuPct: Math.round(cpuPct * 1000) / 1000, wakeups: Math.round(wakeups * 10) / 10 });
	const b = byRole[r] ??= { n: 0, cpuPct: 0, wakeups: 0 };
	b.n++; b.cpuPct += cpuPct; b.wakeups += wakeups;
}
for (const b of Object.values(byRole)) { b.cpuPct = Math.round(b.cpuPct * 1000) / 1000; b.wakeups = Math.round(b.wakeups * 10) / 10; }
const sum = (g, k) => Math.round(procs.filter(p => p.group === g).reduce((s, p) => s + p[k], 0) * 1000) / 1000;
const row = {
	arm, variant, emulateFocus, at: new Date().toISOString(), loadStart, loadEnd, settleS: Number(settleArg), windowS: Number(windowArg), stateDuring, cover: coverResult,
	cpuAppPct: sum('app', 'cpuPct'), wakeupsApp: sum('app', 'wakeups'), cpuAgentsPct: sum('agents', 'cpuPct'),
	appMedianMiB: Math.round(summary.app_median_b / 1048576), processes: procs.length, byRole, procs, csv: csv.replace(/^.*\/data\//, 'data/'),
};
appendFileSync(join(DATA, 'a6.jsonl'), JSON.stringify(row) + '\n');
console.log(JSON.stringify({ arm, variant, cpuApp: row.cpuAppPct, wakeups: row.wakeupsApp, cpuAgents: row.cpuAgentsPct, loadStart, loadEnd, stateDuring }));
console.log(Object.entries(byRole).sort((a, b) => b[1].cpuPct - a[1].cpuPct).map(([k, v]) => `${k.padEnd(40)} n=${v.n} cpu ${v.cpuPct.toFixed(3)}% wakeups ${v.wakeups}/s`).join('\n'));
