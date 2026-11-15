// Analysis aid: for a saved V8 .cpuprofile, the callers (stack paths up to 4 frames) and the direct callees of every
// node whose function name matches a pattern, with self/inclusive ms.
//   node callers.mjs <file.cpuprofile> <regexp> [--up 4] [--top 12]
import { readFileSync } from 'fs';

const [file, pattern, ...rest] = process.argv.slice(2);
const opt = (n, d) => rest.includes(`--${n}`) ? Number(rest[rest.indexOf(`--${n}`) + 1]) : d;
const up = opt('up', 4);
const top = opt('top', 12);
const p = JSON.parse(readFileSync(file, 'utf8'));
const byId = new Map(p.nodes.map(n => [n.id, n]));
const parent = new Map();
for (const n of p.nodes) { for (const c of n.children ?? []) { parent.set(c, n.id); } }
// Self time per node from samples and time deltas.
const self = new Map();
for (let i = 0; i < p.samples.length; i++) { self.set(p.samples[i], (self.get(p.samples[i]) ?? 0) + (p.timeDeltas[i + 1] ?? 0)); }
const incl = new Map();
const total = id => {
	if (incl.has(id)) { return incl.get(id); }
	const n = byId.get(id);
	const v = (self.get(id) ?? 0) + (n.children ?? []).reduce((a, c) => a + total(c), 0);
	incl.set(id, v);
	return v;
};
const name = n => `${n.callFrame.functionName || '(anon)'} ${n.callFrame.url.replace(/^.*\/out\//, '').replace(/^.*\/node_modules\//, 'nm/')}:${n.callFrame.lineNumber + 1}`;
const re = new RegExp(pattern);
const callers = new Map();
const callees = new Map();
for (const n of p.nodes) {
	if (!re.test(n.callFrame.functionName)) { continue; }
	const t = total(n.id);
	let path = [];
	for (let id = parent.get(n.id), i = 0; id !== undefined && i < up; id = parent.get(id), i++) { path.push(name(byId.get(id))); }
	const k = `${name(n)}  <  ${path.join('  <  ')}`;
	callers.set(k, (callers.get(k) ?? 0) + t);
	for (const c of n.children ?? []) {
		const ck = `${name(n)}  >  ${name(byId.get(c))}`;
		callees.set(ck, (callees.get(ck) ?? 0) + total(c));
	}
	const sk = `${name(n)}  >  (self)`;
	callees.set(sk, (callees.get(sk) ?? 0) + (self.get(n.id) ?? 0));
}
const ms = us => (us / 1000).toFixed(1).padStart(8);
console.log('== callers (inclusive ms)');
for (const [k, v] of [...callers].sort((a, b) => b[1] - a[1]).slice(0, top)) { console.log(`${ms(v)} ${k}`); }
console.log('== callees (inclusive ms)');
for (const [k, v] of [...callees].sort((a, b) => b[1] - a[1]).slice(0, top)) { console.log(`${ms(v)} ${k}`); }
