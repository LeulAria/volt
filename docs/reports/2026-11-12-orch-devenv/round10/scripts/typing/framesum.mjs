// Analysis aid: from a typeprof trace (--out), the main frames split by cost class, with the mean ms of each part
// (animation-frame callbacks, style, layout, prepaint+paint, layerize, the rest), and what the heavy frames hold.
//   node framesum.mjs trace.json
import { readFileSync } from 'fs';
const ev = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const byThread = new Map();
for (const e of ev) { if (e.ph === 'X' && e.dur && /^(UpdateLayoutTree|Layout|Paint|FunctionCall|EventDispatch)$/.test(e.name)) { const k = `${e.pid}:${e.tid}`; byThread.set(k, (byThread.get(k) ?? 0) + e.dur); } }
const [pid, tid] = [...byThread].sort((a, b) => b[1] - a[1])[0][0].split(':').map(Number);
const main = ev.filter(e => e.pid === pid && e.tid === tid && e.ph === 'X').sort((a, b) => a.ts - b.ts);
const frames = main.filter(e => e.name === 'ProxyMain::BeginMainFrame');
const parts = { raf: /^FireAnimationFrame$/, style: /^UpdateLayoutTree$/, layout: /^Layout$/, paint: /^(Paint|PrePaint)$/, layerize: /^Layerize$/, scrollEv: /^EventDispatch$/, hit: /^HitTest$/, commit: /^ProxyMain::BeginMainFrame::commit$/ };
const rows = frames.map(f => {
	const inside = main.filter(e => e !== f && e.ts >= f.ts && e.ts + e.dur <= f.ts + f.dur);
	const r = { dur: f.dur / 1000 };
	for (const [k, re] of Object.entries(parts)) { r[k] = inside.filter(e => re.test(e.name)).reduce((a, e) => a + e.dur, 0) / 1000; }
	// Style and layout forced inside callbacks count in both; `rafStyle` is that overlap.
	const rafs = inside.filter(e => e.name === 'FireAnimationFrame');
	r.rafStyle = inside.filter(e => /^(UpdateLayoutTree|Layout)$/.test(e.name) && rafs.some(a => e.ts >= a.ts && e.ts + e.dur <= a.ts + a.dur)).reduce((a, e) => a + e.dur, 0) / 1000;
	r.styleEls = inside.filter(e => e.name === 'UpdateLayoutTree').reduce((a, e) => a + (e.args?.elementCount ?? 0), 0);
	return r;
});
const classes = [['under 2 ms', r => r.dur < 2], ['2-4 ms', r => r.dur >= 2 && r.dur < 4], ['4-8 ms', r => r.dur >= 4 && r.dur < 8], ['8-16 ms', r => r.dur >= 8 && r.dur < 16], ['16 ms and over', r => r.dur >= 16]];
const mean = (l, k) => l.length ? (l.reduce((a, r) => a + r[k], 0) / l.length).toFixed(2) : '-';
console.log(`${frames.length} main frames, total ${rows.reduce((a, r) => a + r.dur, 0).toFixed(0)} ms`);
console.log('class            n   total  mean | raf (style+layout in it) style layout paint layerize events hit commit | style elements');
for (const [name, f] of classes) {
	const l = rows.filter(f);
	console.log(`${name.padEnd(14)} ${String(l.length).padStart(4)} ${l.reduce((a, r) => a + r.dur, 0).toFixed(0).padStart(6)} ${mean(l, 'dur').padStart(6)} | ${mean(l, 'raf')} (${mean(l, 'rafStyle')}) ${mean(l, 'style')} ${mean(l, 'layout')} ${mean(l, 'paint')} ${mean(l, 'layerize')} ${mean(l, 'scrollEv')} ${mean(l, 'hit')} ${mean(l, 'commit')} | ${mean(l, 'styleEls')}`);
}
// Work outside frames: tasks by top-level event name.
const tops = new Map();
let end = 0;
for (const e of main) { if (e.ts >= end) { end = e.ts + e.dur; const k = e.name === 'EventDispatch' ? `EventDispatch ${e.args?.data?.type}` : e.name; const s = tops.get(k) ?? { n: 0, us: 0, max: 0 }; s.n++; s.us += e.dur; s.max = Math.max(s.max, e.dur); tops.set(k, s); } }
console.log('\ntop-level main-thread events (n, total ms, max ms)');
for (const [k, v] of [...tops].sort((a, b) => b[1].us - a[1].us).slice(0, 14)) { console.log(`${String(v.n).padStart(6)} ${(v.us / 1000).toFixed(0).padStart(7)} ${(v.max / 1000).toFixed(1).padStart(6)} ${k}`); }
