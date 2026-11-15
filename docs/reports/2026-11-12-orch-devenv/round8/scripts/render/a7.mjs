// A7 Fight Weight (ADEMark method, unofficial): open 5 new threads and send `replay:stream-1..5` in them,
// 2 s apart, thread 1 back in front; sample the instance's tree at 4 Hz for 180 s from the first send
// (ADEMark's sampler, phys_footprint). p95 of app, agents and app+agents; agent subtrees alive.
//   node a7.mjs <arm>   (rows appended to data/render/a7.jsonl)
import { execFileSync, spawn } from 'child_process';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { DATA, UD, cdp, focusComposer, load, mem, newChat, paste, sleep, waitCalm } from './lib.mjs';
import { role } from './roles.mjs';

const arm = process.argv[2] ?? 'after';
const NATIVE = process.env.SPEED_NATIVE ?? `${process.env.HOME}/.volt-r3/speed/native/bin/ademark-native`;
const WINDOW_S = Number(process.env.A7_WINDOW_S ?? 180);
mkdirSync(join(DATA, 'raw'), { recursive: true });
const mainPid = Number(execFileSync('ps', ['-axo', 'pid=,command=']).toString().split('\n').find(l => l.includes(`--user-data-dir ${UD}`) && /MacOS\/(Electron|VOLT)( |$)/.test(l) && !l.includes('--type=') && !l.includes('volt-agent-server-main'))?.trim().split(/\s+/)[0]);
if (!mainPid) { throw new Error('no running test instance'); }
const rules = join(DATA, 'raw', `a7-rules-${arm}.json`);
// A reused agent server (from an earlier launch) is no child of this main process: it counts too.
const serverPids = execFileSync('ps', ['-axo', 'pid=,command=']).toString().split('\n').filter(l => l.includes(`--user-data-dir ${UD}`) && l.includes('volt-agent-server-main')).map(l => Number(l.trim().split(/\s+/)[0]));
writeFileSync(rules, JSON.stringify({ rootPids: [mainPid, ...serverPids], bundlePaths: [], vendorDirs: [], agentExecutables: ['claude', 'codex'], excludeNames: ['crashpad_handler'] }));
const csv = join(DATA, 'raw', `a7-${arm}-${Date.now()}.csv`);
await waitCalm();
const loadAtStart = load();
const memStart = mem();
const c = await cdp();
let sampler;
for (let i = 1; i <= 5; i++) {
	await newChat(c);
	await sleep(1500);
	// A click in the composer, as a user would (and ADEMark's native typing does): user input for the window.
	const pt = await c.evaluate(`(() => { const t = [...document.querySelectorAll('.volt-agent-input-box')].filter(e => e.offsetParent).at(-1); const r = t.getBoundingClientRect(); return [r.x + 60, r.y + r.height / 2]; })()`);
	await c.click(pt[0], pt[1]);
	await focusComposer(c);
	// Pasted, as ADEMark's `timed.send` pastes (a paste starts no Tab predictor; typing would).
	await paste(c, `replay:stream-${i}`);
	await sleep(500);
	await c.key('Enter', 'Enter', 13, 0, '\r');
	if (i === 1) {
		sampler = spawn(NATIVE, ['sample', '--rules', rules, '--hz', '4', '--duration-s', String(WINDOW_S), '--csv', csv], { stdio: ['ignore', 'pipe', 'inherit'] });
	}
	await sleep(2000);
}
// Thread 1 back in front: the oldest of the five in the sidebar.
await c.evaluate(`(() => { const rows = [...document.querySelectorAll('.monaco-list-row')].filter(e => e.offsetParent && /Replay/i.test(e.getAttribute('aria-label') || '')); rows[4]?.click(); return rows.length; })()`);
let summary = '';
sampler.stdout.on('data', d => summary += d);
await new Promise(r => sampler.on('exit', r));
c.close();
const lines = readFileSync(csv, 'utf8').trim().split('\n');
const header = lines.shift().split(',');
const col = n => header.indexOf(n);
const ticks = new Map();
const cmds = new Map(execFileSync('ps', ['-axo', 'pid=,command='], { maxBuffer: 64 << 20 }).toString().split('\n').filter(Boolean).map(l => { const m = /^\s*(\d+)\s+(.*)$/.exec(l); return [Number(m[1]), m[2]]; }));
const pidRole = new Map();
for (const line of lines) {
	const f = line.split(',');
	const t = f[col('t_ns')];
	const tick = ticks.get(t) ?? { app: 0, agents: 0, agentRoots: 0, roles: {}, counts: {} };
	const b = Number(f[col('phys_footprint_b')]);
	const pid = Number(f[col('pid')]);
	if (f[col('group')] === 'agents') { tick.agents += b; } else { tick.app += b; }
	const r = role(cmds.get(pid) ?? f[col('exe')]);
	pidRole.set(pid, r);
	tick.roles[r] = (tick.roles[r] ?? 0) + b;
	tick.counts[r] = (tick.counts[r] ?? 0) + 1;
	if (r === 'claude CLI') { tick.agentRoots++; }
	ticks.set(t, tick);
}
const mib = b => Math.round(b / 1048576);
const p = (a, q) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(q * (s.length - 1) + 0.5))]; };
const all = [...ticks.values()];
// The tick whose app+agents total is the p95 one, split by role (MiB, process count), and each role's own p95.
const p95Total = p(all.map(t => t.app + t.agents), 0.95);
const p95Tick = all.find(t => t.app + t.agents === p95Total);
const roleNames = [...new Set(all.flatMap(t => Object.keys(t.roles)))].sort();
const byRoleAtP95 = Object.fromEntries(roleNames.map(r => [r, { mib: mib(p95Tick.roles[r] ?? 0), n: p95Tick.counts[r] ?? 0 }]));
const byRoleP95 = Object.fromEntries(roleNames.map(r => [r, mib(p(all.map(t => t.roles[r] ?? 0), 0.95))]));
const byRoleMedian = Object.fromEntries(roleNames.map(r => [r, mib(p(all.map(t => t.roles[r] ?? 0), 0.5))]));
// Extension-host helpers beyond the extension host itself (tsserver's three).
const languageHelpersMax = Math.max(...all.map(t => (t.counts['extension host'] ?? 0)));
const row = {
	arm, test: 'A7', at: new Date().toISOString(), load: loadAtStart, loadEnd: load(), ticks: all.length,
	appP95: mib(p(all.map(t => t.app), 0.95)), agentsP95: mib(p(all.map(t => t.agents), 0.95)), totalP95: mib(p(all.map(t => t.app + t.agents), 0.95)),
	agentCountMedian: p(all.map(t => t.agentRoots), 0.5), mem: memStart, memEnd: mem(), csv,
	byRoleAtP95, byRoleP95, byRoleMedian, extensionHostProcessesMax: languageHelpersMax,
	roles: Object.entries([...pidRole.entries()].reduce((acc, [, r]) => (acc[r] = (acc[r] ?? 0) + 1, acc), {})),
};
appendFileSync(join(DATA, 'a7.jsonl'), JSON.stringify(row) + '\n');
console.log(JSON.stringify(row));
