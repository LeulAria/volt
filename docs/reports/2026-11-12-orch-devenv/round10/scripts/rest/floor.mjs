// The Electron floor (ADEMark's A5/A6 method on an empty window of the same Electron Volt ships: no Volt code).
//   node floor.mjs [page=blank|text] [settle s=60] [window s=60]     rows -> ../../data/rest/floor.jsonl
// Electron binary: FLOOR_ELECTRON, default this worktree's .build/electron (the version in .build/electron/version).
import { execFileSync, execSync, spawn } from 'child_process';
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { DATA, load, sleep, waitCalm } from './lib.mjs';
const here = dirname(fileURLToPath(import.meta.url));
const [page = 'blank', settleArg = '60', windowArg = '60'] = process.argv.slice(2);
const E = process.env.FLOOR_ELECTRON ?? join(here, '../../../../../../.build/electron/VOLT.app/Contents/MacOS/Electron');
const NATIVE = `${process.env.HOME}/.volt-r3/speed/native/bin/ademark-native`;
const ud = `${process.env.HOME}/.volt-r10/rest/ud-floor`;
rmSync(ud, { recursive: true, force: true });
mkdirSync(join(DATA, 'raw'), { recursive: true });
const env = { ...process.env, FLOOR_PAGE: page };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(E, [join(here, 'floor'), `--user-data-dir=${ud}`, '--use-mock-keychain'], { env, stdio: 'ignore', detached: true });
try {
	await sleep(Number(settleArg) * 1000);
	const gate = await waitCalm();
	const rules = join(DATA, 'raw', 'rules-floor.json');
	writeFileSync(rules, JSON.stringify({ rootPids: [child.pid], bundlePaths: [], vendorDirs: [], agentExecutables: ['claude', 'codex'], excludeNames: ['crashpad_handler'] }));
	const csv = join(DATA, 'raw', `floor-${page}-${Date.now()}.csv`);
	const loadAvg = load();
	const cmds = new Map(execSync('ps -axo pid=,command=', { maxBuffer: 64 << 20 }).toString().split('\n').filter(Boolean).map(l => { const m = /^\s*(\d+)\s+(.*)$/.exec(l); return [Number(m[1]), m[2]]; }));
	const summary = JSON.parse(execFileSync(NATIVE, ['sample', '--rules', rules, '--hz', '4', '--duration-s', windowArg, '--csv', csv], { encoding: 'utf8' }));
	const lines = readFileSync(csv, 'utf8').trim().split('\n');
	const header = lines.shift().split(',');
	const idx = n => header.indexOf(n);
	const per = new Map();
	for (const l of lines) {
		const f = l.split(','); const p = Number(f[idx('pid')]);
		const e = per.get(p) ?? { foot: [], cpu: [], wk: [], t: [] };
		e.foot.push(+f[idx('phys_footprint_b')]); e.cpu.push(+f[idx('cpu_user_ns')] + +f[idx('cpu_sys_ns')]); e.wk.push(+f[idx('wakeups_idle')] + +f[idx('wakeups_irq')]); e.t.push(+f[idx('t_ns')]);
		per.set(p, e);
	}
	const role = c => /--type=renderer/.test(c) ? 'renderer' : /--type=gpu-process/.test(c) ? 'gpu' : /network\.mojom/.test(c) ? 'network service' : /--type=utility/.test(c) ? 'utility (other)' : /--type=/.test(c) ? 'other' : 'main';
	const byRole = {}; let cpu = 0, wk = 0;
	for (const [p, e] of per) {
		const s = [...e.foot].sort((a, b) => a - b); const w = (e.t.at(-1) - e.t[0]) / 1e9;
		const r = role(cmds.get(p) ?? ''); const b = byRole[r] ??= { n: 0, mib: 0, cpuPct: 0, wakeups: 0 };
		const c = w > 0 ? (e.cpu.at(-1) - e.cpu[0]) / 1e9 / w * 100 : 0, k = w > 0 ? (e.wk.at(-1) - e.wk[0]) / w : 0;
		b.n++; b.mib += s[s.length >> 1] / 1048576; b.cpuPct += c; b.wakeups += k; cpu += c; wk += k;
	}
	for (const b of Object.values(byRole)) { b.mib = Math.round(b.mib * 10) / 10; b.cpuPct = Math.round(b.cpuPct * 1000) / 1000; b.wakeups = Math.round(b.wakeups * 10) / 10; }
	const row = { arm: 'floor', page, electron: E, at: new Date().toISOString(), load: loadAvg, calm: gate.calm, settleS: +settleArg, windowS: +windowArg, appMedianMiB: Math.round(summary.app_median_b / 1048576 * 10) / 10, cpuAppPct: Math.round(cpu * 1000) / 1000, wakeupsApp: Math.round(wk * 10) / 10, processes: per.size, byRole };
	appendFileSync(join(DATA, 'floor.jsonl'), JSON.stringify(row) + '\n');
	console.log(JSON.stringify(row));
} finally {
	try { process.kill(-child.pid, 'SIGTERM'); } catch { try { child.kill(); } catch { } }
}
