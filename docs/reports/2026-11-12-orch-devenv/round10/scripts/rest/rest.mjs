// A5 Weigh-in + A6 Idle Burn in one window, as ADEMark takes them (method, unofficial): ADEMark's own sampler
// (`ademark-native sample`, proc_pid_rusage at 4 Hz) over the test instance's process tree for `window` s after a settle.
//   A5  = median of the app group's phys_footprint sum; per role = sum of per-pid medians
//   A6  = delta(user+sys CPU) / wall of the app group, % of one core; wakeups/s = delta(idle + irq wakeups) / wall
// Variants: front (focus emulated over CDP, as the frontmost app's page), covered (ADEMark's own `cover` panel over the
// window for the sample), rest-20 (A10's 20-thread sample, no settle).
//   node rest.mjs <arm> [variant=front] [settle s=90] [window s=60]     rows -> ../../data/rest/rest.jsonl
import { execFile, execFileSync, execSync } from 'child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { DATA, load, mem, sleep, UD, cdp, waitCalm, profileProcesses } from './lib.mjs';
import { role } from './roles.mjs';

const [arm = 'dev', variant = 'front', settleArg = '90', windowArg = '60'] = process.argv.slice(2);
const NATIVE = process.env.SPEED_NATIVE ?? `${process.env.HOME}/.volt-r3/speed/native/bin/ademark-native`;
const WINLIST = `${process.env.HOME}/.volt-r10/rest/tools/winlist`;
mkdirSync(join(DATA, 'raw'), { recursive: true });
const ps = () => execSync('ps -axo pid=,command=', { maxBuffer: 64 << 20 }).toString().split('\n').filter(Boolean).map(l => { const m = /^\s*(\d+)\s+(.*)$/.exec(l); return [Number(m[1]), m[2]]; });
const main = ps().find(([, l]) => l.includes(`--user-data-dir ${UD}`) && /MacOS\/(Electron|VOLT|Volt)( |$)/.test(l) && !l.includes('--type=') && !l.includes('volt-agent-server-main'));
if (!main) { throw new Error('no running test instance'); }
const pid = main[0];
const winOnScreen = () => { try { return execFileSync(WINLIST, { encoding: 'utf8' }).split('\n').some(l => l.startsWith(`${pid} `)); } catch { return undefined; } };

const c = await cdp();
const emulateFocus = process.env.REST_NO_FOCUS !== '1';
await c.send('Emulation.setFocusEmulationEnabled', { enabled: emulateFocus });
await sleep(Number(settleArg) * 1000);
const gate = Number(settleArg) > 0 || variant === 'covered' ? await waitCalm() : { calm: parseFloat(load()) <= 14, waitedS: 0 };
// Roots: main, plus every process started with this profile that is no child of main (a reused agent server).
const roots = [pid, ...profileProcesses().filter(p => p.pid !== pid && p.cmd.includes(UD) && /volt-agent-server-main/.test(p.cmd)).map(p => p.pid)];
const rules = join(DATA, 'raw', `rules-${arm}.json`);
writeFileSync(rules, JSON.stringify({ rootPids: roots, bundlePaths: [], vendorDirs: [], agentExecutables: ['claude', 'codex'], excludeNames: ['crashpad_handler'] }));
const csv = join(DATA, 'raw', `rest-${arm}-${variant}-${Date.now()}.csv`);
let cover; const coverTries = [];
if (variant === 'covered') {
	for (let i = 0; i < 3 && !cover; i++) {
		const p = new Promise(res => execFile(NATIVE, ['cover', '--pid', String(pid), '--duration-s', String(Number(windowArg) + 10)], { encoding: 'utf8' }, (err, out, stderr) => res(err ? { error: `${String(err).slice(0, 200)} ${String(out).slice(0, 300)} ${String(stderr).slice(0, 300)}`.trim() } : JSON.parse(out))));
		const early = await Promise.race([p, sleep(6000).then(() => undefined)]);
		if (early?.error) { coverTries.push(early.error); } else { cover = p; }
	}
	cover ??= Promise.resolve({ error: coverTries.at(-1) });
}
const onScreen = winOnScreen();
const stateDuring = await c.evaluate('JSON.stringify({vis: document.visibilityState, focus: document.hasFocus()})');
const loadAvg = load();
const memStart = mem();
const cmds = new Map(ps());
const summary = JSON.parse(execFileSync(NATIVE, ['sample', '--rules', rules, '--hz', '4', '--duration-s', windowArg, '--csv', csv], { encoding: 'utf8' }));
const coverResult = cover ? await cover : undefined;
for (const [p, l] of ps()) { if (!cmds.has(p)) { cmds.set(p, l); } }
let domNodes, threads;
try {
	domNodes = await c.evaluate('document.getElementsByTagName("*").length');
	await c.send('Emulation.setFocusEmulationEnabled', { enabled: false });
} catch { }
c.close();

const lines = readFileSync(csv, 'utf8').trim().split('\n');
const header = lines.shift().split(',');
const idx = name => header.indexOf(name);
const perPid = new Map();
for (const line of lines) {
	const f = line.split(',');
	const p = Number(f[idx('pid')]);
	const e = perPid.get(p) ?? { pid: p, group: f[idx('group')], exe: f[idx('exe')], foot: [], cpu: [], wk: [], t: [] };
	e.foot.push(Number(f[idx('phys_footprint_b')]));
	e.cpu.push(Number(f[idx('cpu_user_ns')]) + Number(f[idx('cpu_sys_ns')]));
	e.wk.push(Number(f[idx('wakeups_idle')]) + Number(f[idx('wakeups_irq')]));
	e.t.push(Number(f[idx('t_ns')]));
	perPid.set(p, e);
}
const med = a => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };
const r3 = v => Math.round(v * 1000) / 1000;
const byRole = {};
const procs = [];
for (const e of perPid.values()) {
	const cmd = cmds.get(e.pid) ?? e.exe;
	const r = role(cmd);
	const mib = med(e.foot) / 1048576;
	const wall = (e.t.at(-1) - e.t[0]) / 1e9;
	const cpuPct = wall > 0 ? (e.cpu.at(-1) - e.cpu[0]) / 1e9 / wall * 100 : 0;
	const wakeups = wall > 0 ? (e.wk.at(-1) - e.wk[0]) / wall : 0;
	procs.push({ pid: e.pid, role: r, group: e.group, mib: Math.round(mib * 10) / 10, cpuPct: r3(cpuPct), wakeups: Math.round(wakeups * 10) / 10, wallS: Math.round(wall), cmd: cmd.slice(0, 200) });
	const b = byRole[r] ??= { n: 0, mib: 0, cpuPct: 0, wakeups: 0 };
	b.n++; b.mib += mib; b.cpuPct += cpuPct; b.wakeups += wakeups;
}
for (const b of Object.values(byRole)) { b.mib = Math.round(b.mib * 10) / 10; b.cpuPct = r3(b.cpuPct); b.wakeups = Math.round(b.wakeups * 10) / 10; }
procs.sort((a, b) => b.mib - a.mib);
const sum = (g, k) => r3(procs.filter(p => p.group === g).reduce((s, p) => s + p[k], 0));
const row = {
	arm, variant, at: new Date().toISOString(), load: loadAvg, loadEnd: load(), calm: gate.calm, settleS: Number(settleArg), windowS: Number(windowArg), emulateFocus, stateDuring, onScreen,
	cover: coverResult, coverTries,
	appMedianMiB: Math.round(summary.app_median_b / 1048576 * 10) / 10, agentsMedianMiB: Math.round(summary.agents_median_b / 1048576), totalMedianMiB: Math.round(summary.total_median_b / 1048576),
	processes: procs.length, cpuAppPct: sum('app', 'cpuPct'), wakeupsApp: sum('app', 'wakeups'), cpuAgentsPct: sum('agents', 'cpuPct'), domNodes,
	mem: memStart, memEnd: mem(), byRole, procs, csv: csv.replace(/^.*\/data\//, 'data/'),
};
row.swapGrewMiB = row.memEnd.swapUsedMiB - row.mem.swapUsedMiB;
appendFileSync(join(DATA, 'rest.jsonl'), JSON.stringify(row) + '\n');
console.log(JSON.stringify({ arm, variant, appMiB: row.appMedianMiB, agentsMiB: row.agentsMedianMiB, processes: row.processes, cpuApp: row.cpuAppPct, wakeups: row.wakeupsApp, cpuAgents: row.cpuAgentsPct, load: loadAvg, calm: gate.calm, onScreen, stateDuring, cover: coverResult?.error ? 'ERR ' + coverResult.error.slice(0, 80) : coverResult ? 'ok' : undefined }));
console.log(Object.entries(byRole).sort((a, b) => b[1].mib - a[1].mib).map(([k, v]) => `${k.padEnd(48)} n=${v.n} ${String(v.mib).padStart(6)} MiB  cpu ${v.cpuPct.toFixed(3)}%  wk ${v.wakeups}/s`).join('\n'));
