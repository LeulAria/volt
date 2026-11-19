// Exploratory footprint now: ADEMark's sampler (phys_footprint, 4 Hz) over the test instance's tree for `window` s,
// per role (median over the window) and the app/agents/total medians. Prints only; writes no data rows.
//   node fp.mjs [window s=3]
import { execFileSync, execSync } from 'child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { UD } from './lib.mjs';
import { role } from './roles.mjs';

const windowS = process.argv[2] ?? '3';
const NATIVE = process.env.SPEED_NATIVE ?? `${process.env.HOME}/.volt-r3/speed/native/bin/ademark-native`;
const ps = () => execSync('ps -axo pid=,command=', { maxBuffer: 64 << 20 }).toString().split('\n').filter(Boolean).map(l => { const m = /^\s*(\d+)\s+(.*)$/.exec(l); return [Number(m[1]), m[2]]; });
const rows = ps();
const main = rows.find(([, c]) => c.includes(`--user-data-dir ${UD}`) && /MacOS\/(Electron|VOLT|Volt)( |$)/.test(c) && !c.includes('--type=') && !c.includes('volt-agent-server-main'));
if (!main) { throw new Error('no running test instance'); }
const serverPids = rows.filter(([, c]) => c.includes(`--user-data-dir ${UD}`) && c.includes('volt-agent-server-main')).map(([p]) => p);
const dir = mkdtempSync(join(tmpdir(), 'fp-'));
const rules = join(dir, 'rules.json');
writeFileSync(rules, JSON.stringify({ rootPids: [main[0], ...serverPids], bundlePaths: [], vendorDirs: [], agentExecutables: ['claude', 'codex'], excludeNames: ['crashpad_handler'] }));
const csv = join(dir, 'fp.csv');
const summary = JSON.parse(execFileSync(NATIVE, ['sample', '--rules', rules, '--hz', '4', '--duration-s', windowS, '--csv', csv], { encoding: 'utf8' }));
const cmds = new Map(ps());
const lines = readFileSync(csv, 'utf8').trim().split('\n');
const header = lines.shift().split(',');
const idx = name => header.indexOf(name);
const perPid = new Map();
for (const line of lines) {
	const f = line.split(',');
	const p = Number(f[idx('pid')]);
	const e = perPid.get(p) ?? { pid: p, group: f[idx('group')], exe: f[idx('exe')], foot: [] };
	e.foot.push(Number(f[idx('phys_footprint_b')]));
	perPid.set(p, e);
}
const med = a => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };
const byRole = new Map();
for (const e of perPid.values()) {
	const r = `${role(cmds.get(e.pid) ?? e.exe)} [${e.group}]`;
	const b = byRole.get(r) ?? { n: 0, mib: 0 };
	b.n++; b.mib += med(e.foot) / 1048576;
	byRole.set(r, b);
}
const mib = b => Math.round(b / 1048576);
console.log(`app ${mib(summary.app_median_b)} agents ${mib(summary.agents_median_b)} total ${mib(summary.total_median_b)} MiB (${perPid.size} processes, ${windowS} s)`);
for (const [r, b] of [...byRole.entries()].sort((a, b) => b[1].mib - a[1].mib)) {
	console.log(`  ${r.padEnd(52)} n=${b.n} ${String(Math.round(b.mib)).padStart(5)} MiB`);
}
