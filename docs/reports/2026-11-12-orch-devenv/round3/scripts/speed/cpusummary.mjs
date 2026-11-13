// node cpusummary.mjs <file.cpuprofile> [fromMs] [toMs]  self time by function (top 30) within a window of the profile
import { readFileSync } from 'fs';
const [file, from = '0', to = '1e9'] = process.argv.slice(2);
const p = JSON.parse(readFileSync(file, 'utf8'));
const nodes = new Map(p.nodes.map(n => [n.id, n]));
const self = new Map();
let t = p.startTime;
const base = p.startTime + p.timeDeltas[0];
for (let i = 0; i < p.samples.length; i++) {
	t += p.timeDeltas[i];
	const ms = (t - base) / 1000;
	if (ms < +from || ms > +to) { continue; }
	const n = nodes.get(p.samples[i]);
	const cf = n.callFrame;
	const key = `${cf.functionName || '(anon)'} ${cf.url.split('/').slice(-2).join('/')}:${cf.lineNumber + 1}`;
	self.set(key, (self.get(key) ?? 0) + (p.timeDeltas[i + 1] ?? 0) / 1000);
}
const total = [...self.values()].reduce((a, b) => a + b, 0);
console.log('total ms', Math.round(total));
for (const [k, v] of [...self].sort((a, b) => b[1] - a[1]).slice(0, 30)) { console.log(v.toFixed(1).padStart(8), k); }
