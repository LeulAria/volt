// A9 Ghost Weight (ADEMark method, unofficial), no-sessions variant: the instance at rest is quit the
// normal way (Cmd+Q in its window), and 60 s later every process that was part of the test profile's
// tree before the quit and is still alive (plus anything they started since) is weighed with ADEMark's
// sampler (phys_footprint, 4 Hz, 1 s). Orphans count: the set is taken by pid before the quit.
//   node a9.mjs <arm>   (rows appended to data/weight/a9.jsonl)
import { execFileSync, execSync } from 'child_process';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { DATA, cdp, load, mem, profileProcesses, sleep } from './lib.mjs';
import { role } from './roles.mjs';

const arm = process.argv[2] ?? 'after';
const WAIT_S = Number(process.env.A9_WAIT_S ?? 60);
const NATIVE = process.env.SPEED_NATIVE ?? `${process.env.HOME}/.volt-r3/speed/native/bin/ademark-native`;
mkdirSync(join(DATA, 'raw'), { recursive: true });

const before = profileProcesses();
const loadAtQuit = load();
const c = await cdp();
await c.key('q', 'KeyQ', 81, 4);
c.close();
const quitAt = Date.now();
await sleep(WAIT_S * 1000);
const alive = new Set(execSync('ps -axo pid=').toString().split('\n').map(Number).filter(Boolean));
const left = before.filter(p => alive.has(p.pid));
const rules = join(DATA, 'raw', `a9-rules-${arm}.json`);
writeFileSync(rules, JSON.stringify({ rootPids: left.map(p => p.pid), bundlePaths: [], vendorDirs: [], agentExecutables: ['claude', 'codex'], excludeNames: ['crashpad_handler'] }));
const csv = join(DATA, 'raw', `a9-${arm}-${Date.now()}.csv`);
let total = 0;
const procs = [];
if (left.length) {
	execFileSync(NATIVE, ['sample', '--rules', rules, '--hz', '4', '--duration-s', '1', '--csv', csv], { encoding: 'utf8' });
	const lines = readFileSync(csv, 'utf8').trim().split('\n');
	const header = lines.shift().split(',');
	const last = new Map();
	for (const line of lines) {
		const f = line.split(',');
		last.set(Number(f[header.indexOf('pid')]), Number(f[header.indexOf('phys_footprint_b')]));
	}
	const cmds = new Map(execSync('ps -axo pid=,command=', { maxBuffer: 64 << 20 }).toString().split('\n').filter(Boolean).map(l => { const m = /^\s*(\d+)\s+(.*)$/.exec(l); return [Number(m[1]), m[2]]; }));
	for (const [pid, bytes] of last) {
		total += bytes;
		procs.push({ pid, role: role(cmds.get(pid) ?? ''), mib: Math.round(bytes / 1048576 * 10) / 10, cmd: (cmds.get(pid) ?? '').slice(0, 140) });
	}
}
const row = { arm, test: 'A9', variant: 'no-sessions', at: new Date().toISOString(), load: loadAtQuit, waitS: WAIT_S, before: before.length, left: procs.length, ghostMiB: Math.round(total / 1048576 * 10) / 10, mem: mem(), procs };
appendFileSync(join(DATA, 'a9.jsonl'), JSON.stringify(row) + '\n');
console.log(JSON.stringify({ arm, ghostMiB: row.ghostMiB, left: row.left, before: row.before, load: loadAtQuit }));
for (const p of procs.sort((a, b) => b.mib - a.mib)) { console.log(String(p.mib).padStart(7), p.role, p.pid); }
