// node callers.mjs <file.cpuprofile> <regex>   stacks (root..leaf) through functions matching regex, by sampled ms
import { readFileSync } from 'fs';
const [file, re] = process.argv.slice(2);
const p = JSON.parse(readFileSync(file, 'utf8'));
const byId = new Map(p.nodes.map(n => [n.id, n]));
const parent = new Map();
for (const n of p.nodes) { for (const ch of n.children ?? []) { parent.set(ch, n.id); } }
const dt = new Map();
for (let i = 0; i < p.samples.length; i++) { dt.set(p.samples[i], (dt.get(p.samples[i]) ?? 0) + (p.timeDeltas[i + 1] ?? 0)); }
const key = n => `${n.callFrame.functionName || '(anon)'} ${n.callFrame.url.replace(/^.*\/out\//, '')}:${n.callFrame.lineNumber + 1}`;
const stacks = new Map();
const rx = new RegExp(re);
for (const [id, us] of dt) {
	const chain = [];
	for (let cur = id; cur !== undefined; cur = parent.get(cur)) { chain.unshift(key(byId.get(cur))); }
	const i = chain.findIndex(k => rx.test(k));
	if (i < 0) { continue; }
	const s = chain.slice(Math.max(1, i - 8), i + 3).join(' > ');
	stacks.set(s, (stacks.get(s) ?? 0) + us);
}
for (const [s, us] of [...stacks].sort((a, b) => b[1] - a[1]).slice(0, 15)) { console.log((us / 1e3).toFixed(1).padStart(7), s, '\n'); }
