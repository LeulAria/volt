// Analysis aid: from a V8 .cpuprofile, the animation-frame invocations (runs of samples under animationFrameRunner)
// ranked by length; for those over a threshold, where their time goes (inclusive ms per function, how many of the
// heavy invocations hold it).
//   node heavyframes.mjs file.cpuprofile [minMs=4] [top=40] [root=animationFrameRunner]
import { readFileSync } from 'fs';
const [file, minArg = '4', topArg = '40', rootName = 'animationFrameRunner'] = process.argv.slice(2);
const p = JSON.parse(readFileSync(file, 'utf8'));
const byId = new Map(p.nodes.map(n => [n.id, n]));
const parent = new Map();
for (const n of p.nodes) { for (const c of n.children ?? []) { parent.set(c, n.id); } }
const label = n => `${n.callFrame.functionName || '(anon)'} ${n.callFrame.url.replace(/^.*\/out\//, '').replace(/^.*node_modules\//, 'nm/')}:${n.callFrame.lineNumber}`;
const stackCache = new Map();
const stackOf = id => { let s = stackCache.get(id); if (!s) { s = []; for (let c = id; c !== undefined; c = parent.get(c)) { s.push(byId.get(c)); } s.reverse(); stackCache.set(id, s); } return s; };
const inv = [];
let cur;
for (let i = 0; i < p.samples.length; i++) {
	const dt = (p.timeDeltas[i + 1] ?? p.timeDeltas[i]) / 1000;
	const st = stackOf(p.samples[i]);
	const at = st.findIndex(n => n.callFrame.functionName === rootName);
	if (at < 0) { cur = undefined; continue; }
	if (!cur) { cur = { ms: 0, fn: new Map() }; inv.push(cur); }
	cur.ms += dt;
	const seen = new Set();
	for (const n of st.slice(at + 1)) { const k = label(n); if (!seen.has(k)) { seen.add(k); cur.fn.set(k, (cur.fn.get(k) ?? 0) + dt); } }
}
const d = inv.map(v => v.ms).sort((a, b) => a - b);
const q = f => d[Math.min(d.length - 1, Math.floor(f * d.length))]?.toFixed(2);
console.log(`${inv.length} invocations of ${rootName}: ms p50 ${q(0.5)} p90 ${q(0.9)} p95 ${q(0.95)} p99 ${q(0.99)} max ${d.at(-1)?.toFixed(1)}, total ${d.reduce((a, v) => a + v, 0).toFixed(0)}`);
const min = Number(minArg);
const heavy = inv.filter(v => v.ms >= min);
console.log(`${heavy.length} of ${min} ms and over, total ${heavy.reduce((a, v) => a + v.ms, 0).toFixed(0)} ms; inclusive ms, invocations holding it (over 0.3 ms)`);
const agg = new Map();
for (const v of heavy) { for (const [k, ms] of v.fn) { const s = agg.get(k) ?? { ms: 0, n: 0 }; s.ms += ms; if (ms > 0.3) { s.n++; } agg.set(k, s); } }
for (const [k, v] of [...agg].sort((a, b) => b[1].ms - a[1].ms).slice(0, Number(topArg))) { console.log(`${v.ms.toFixed(1).padStart(8)} ${String(v.n).padStart(5)}  ${k}`); }
