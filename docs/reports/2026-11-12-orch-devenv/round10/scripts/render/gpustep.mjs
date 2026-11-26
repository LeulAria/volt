// Exploratory: the GPU process's and renderer's footprint (ADEMark's sampler, 4 Hz) across the steps A7 takes before
// its streams run: at rest, New Chat, a click in the composer, a paste, Enter, and on. Prints one line per second
// with the step marks. Needs a running test instance.
//   node gpustep.mjs [prompt=replay:stream-1] [seconds after Enter=30]
import { execFileSync, spawn } from 'child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { UD, cdp, focusComposer, newChat, paste, sleep } from './lib.mjs';
import { role } from './roles.mjs';

const prompt = process.argv[2] ?? 'replay:stream-1';
const after = Number(process.argv[3] ?? 30);
const NATIVE = process.env.SPEED_NATIVE ?? `${process.env.HOME}/.volt-r3/speed/native/bin/ademark-native`;
const ps = () => execFileSync('ps', ['-axo', 'pid=,command='], { maxBuffer: 64 << 20 }).toString().split('\n').filter(Boolean).map(l => { const m = /^\s*(\d+)\s+(.*)$/.exec(l); return [Number(m[1]), m[2]]; });
const main = ps().find(([, c]) => c.includes(`--user-data-dir ${UD}`) && /MacOS\/(Electron|VOLT)( |$)/.test(c) && !c.includes('--type=') && !c.includes('volt-agent-server-main'));
const dir = mkdtempSync(join(tmpdir(), 'gpustep-'));
const rules = join(dir, 'rules.json');
const csv = join(dir, 's.csv');
writeFileSync(rules, JSON.stringify({ rootPids: [main[0]], bundlePaths: [], vendorDirs: [], agentExecutables: ['claude', 'codex'], excludeNames: ['crashpad_handler'] }));
const total = 10 + 12 + 8 + 6 + after;
const sampler = spawn(NATIVE, ['sample', '--rules', rules, '--hz', '4', '--duration-s', String(total + 4), '--csv', csv], { stdio: 'ignore' });
const t0 = Date.now();
const marks = [];
const mark = name => marks.push([(Date.now() - t0) / 1000, name]);
const c = await cdp();
await sleep(10_000);
mark('New Chat'); await newChat(c);
await sleep(12_000);
const pt = await c.evaluate(`(() => { const t = [...document.querySelectorAll('.volt-agent-input-box')].filter(e => e.offsetParent).at(-1); const r = t.getBoundingClientRect(); return [r.x + 60, r.y + r.height / 2]; })()`);
mark('click composer'); await c.click(pt[0], pt[1]); await focusComposer(c);
await sleep(8_000);
mark('paste'); await paste(c, prompt);
await sleep(6_000);
mark('Enter'); await c.key('Enter', 'Enter', 13, 0, '\r');
await sleep(after * 1000);
c.close();
await new Promise(r => sampler.on('exit', r));
const cmds = new Map(ps());
const lines = readFileSync(csv, 'utf8').trim().split('\n');
const header = lines.shift().split(',');
const col = n => header.indexOf(n);
const first = Number(lines[0].split(',')[col('t_ns')]);
const bySecond = new Map();
for (const line of lines) {
	const f = line.split(',');
	const s = Math.floor((Number(f[col('t_ns')]) - first) / 1e9);
	const r = role(cmds.get(Number(f[col('pid')])) ?? f[col('exe')]);
	const e = bySecond.get(s) ?? {};
	e[r] = Math.max(e[r] ?? 0, Math.round(Number(f[col('phys_footprint_b')]) / 1048576));
	bySecond.set(s, e);
}
for (const [s, e] of [...bySecond].sort((a, b) => a[0] - b[0])) {
	const m = marks.filter(([t]) => Math.floor(t) === s).map(([, n]) => `<- ${n}`).join(' ');
	console.log(`${String(s).padStart(3)} s  gpu ${String(e.gpu ?? 0).padStart(4)}  renderer ${String(e.renderer ?? 0).padStart(4)}  main ${String(e.main ?? 0).padStart(4)}  ${m}`);
}
