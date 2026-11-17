// JS CPU profile of the test window's renderer (or any CDP websocket URL) for `secs` s; prints self and total time
// per function (url:line), top N, skipping (idle)/(program). Analysis aid.
//   node jsprof.mjs [secs=20] [--ws ws://...] [--interval us=200] [--out file.cpuprofile] [--focus]
import { writeFileSync } from 'fs';
import { cdp, connect, sleep } from './lib.mjs';

const args = process.argv.slice(2);
const opt = (n, d) => args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1] : d;
const secs = Number(args.find(a => /^\d+$/.test(a)) ?? 20);
const c = opt('ws') ? await connect(opt('ws')) : await cdp();
if (args.includes('--focus')) {
	await c.send('Emulation.setFocusEmulationEnabled', { enabled: true });
}
await c.send('Profiler.enable');
await c.send('Profiler.setSamplingInterval', { interval: Number(opt('interval', 200)) });
await c.send('Profiler.start');
await sleep(secs * 1000);
const { result } = await c.send('Profiler.stop');
c.close();
const p = result.profile;
if (opt('out')) {
	writeFileSync(opt('out'), JSON.stringify(p));
}
analyze(p, Number(opt('top', 40)));

export function analyze(p, top) {
	const byId = new Map(p.nodes.map(n => [n.id, n]));
	const parent = new Map();
	for (const n of p.nodes) { for (const ch of n.children ?? []) { parent.set(ch, n.id); } }
	const dt = new Map();
	for (let i = 0; i < p.samples.length; i++) {
		dt.set(p.samples[i], (dt.get(p.samples[i]) ?? 0) + (p.timeDeltas[i + 1] ?? 0));
	}
	const key = n => `${n.callFrame.functionName || '(anon)'} ${n.callFrame.url.replace(/^.*\/out\//, '')}:${n.callFrame.lineNumber + 1}`;
	const self = new Map(), total = new Map();
	for (const [id, us] of dt) {
		const n = byId.get(id);
		if (/^\((idle|program|garbage collector)\)$/.test(n.callFrame.functionName)) {
			self.set(n.callFrame.functionName, (self.get(n.callFrame.functionName) ?? 0) + us);
			continue;
		}
		self.set(key(n), (self.get(key(n)) ?? 0) + us);
		const seen = new Set();
		for (let cur = id; cur !== undefined; cur = parent.get(cur)) {
			const k = key(byId.get(cur));
			if (!seen.has(k)) { seen.add(k); total.set(k, (total.get(k) ?? 0) + us); }
		}
	}
	const span = (p.endTime - p.startTime) / 1e3;
	console.log(`span ${Math.round(span)} ms; (idle) ${Math.round((self.get('(idle)') ?? 0) / 1e3)} ms, (program) ${Math.round((self.get('(program)') ?? 0) / 1e3)} ms, GC ${Math.round((self.get('(garbage collector)') ?? 0) / 1e3)} ms`);
	console.log('\n== total (inclusive) ms');
	for (const [k, v] of [...total].sort((a, b) => b[1] - a[1]).slice(0, top)) { console.log((v / 1e3).toFixed(1).padStart(8), k); }
	console.log('\n== self ms');
	for (const [k, v] of [...self].filter(([k]) => !k.startsWith('(')).sort((a, b) => b[1] - a[1]).slice(0, top)) { console.log((v / 1e3).toFixed(1).padStart(8), k); }
}
