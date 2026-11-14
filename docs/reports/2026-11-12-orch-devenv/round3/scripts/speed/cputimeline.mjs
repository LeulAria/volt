// node cputimeline.mjs <file.cpuprofile> fromMs toMs [bucketMs=10]  per bucket: busy ms and the heaviest Volt/VS Code frames on the stack
import { readFileSync } from 'fs';
const [file, from, to, bucket = '10'] = process.argv.slice(2);
const p = JSON.parse(readFileSync(file, 'utf8'));
const nodes = new Map(p.nodes.map(n => [n.id, n]));
const parent = new Map();
for (const n of p.nodes) { for (const c of n.children ?? []) { parent.set(c, n.id); } }
const name = n => `${n.callFrame.functionName || '(anon)'}@${n.callFrame.url.split('/').slice(-1)[0]}:${n.callFrame.lineNumber + 1}`;
const base = p.startTime + p.timeDeltas[0];
let t = p.startTime;
const buckets = new Map();
for (let i = 0; i < p.samples.length; i++) {
	t += p.timeDeltas[i];
	const ms = (t - base) / 1000;
	if (ms < +from || ms > +to) { continue; }
	const dt = (p.timeDeltas[i + 1] ?? 0) / 1000;
	let n = nodes.get(p.samples[i]);
	if (n.callFrame.functionName === '(idle)') { continue; }
	const b = Math.floor(ms / +bucket) * +bucket;
	const e = buckets.get(b) ?? { busy: 0, frames: new Map() };
	e.busy += dt;
	const seen = new Set();
	while (n) {
		const url = n.callFrame.url;
		if (/voltAgent|voltRuntime|voltAgentServer|editor\/|base\/|platform\//.test(url)) {
			const k = name(n);
			if (!seen.has(k)) { seen.add(k); e.frames.set(k, (e.frames.get(k) ?? 0) + dt); }
		}
		n = nodes.get(parent.get(n.id));
	}
	buckets.set(b, e);
}
for (const [b, e] of [...buckets].sort((x, y) => x[0] - y[0])) {
	const top = [...e.frames].sort((x, y) => y[1] - x[1]).slice(0, 4).map(([k, v]) => `${k} ${v.toFixed(0)}`).join(' | ');
	console.log(`${String(b).padStart(6)} busy ${e.busy.toFixed(1).padStart(5)}  ${top}`);
}
