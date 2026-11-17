// Analysis aid (not a timing): what the main thread does inside each key's frame (from the main frame being sent to
// its commit, EventLatency's SendBeginMainFrameToCommit stage), while the running arm's chats stream. Types `keys`
// probe keys into the composer on screen, traces with the DevTools timeline categories (no stacks), then prints:
//   - the key stages (p50 / p95)
//   - per timeline event name: in how many key frames it ran, its median and p95 ms per key frame (summed per frame)
//   - with --js: the top JS functions (self ms) sampled inside key frames (CPU profiler on: slower)
//   node keyframe.mjs [keys=60] [--js] [--out trace.json]
import { writeFileSync } from 'fs';
import { cdp, focusComposer, median, pct, sleep } from './lib.mjs';
import { keyLatencies } from './a8.mjs';

const args = process.argv.slice(2);
const keys = Number(args.find(a => /^\d+$/.test(a)) ?? 60);
const js = args.includes('--js');
const out = args.includes('--out') ? args[args.indexOf('--out') + 1] : undefined;
const PROBE_CHARS = 'abcdefghijklmnopqrstuvwxyz';

const c = await cdp();
await c.send('Emulation.setFocusEmulationEnabled', { enabled: true });
if (!await focusComposer(c)) {
	throw new Error('no composer');
}
const events = [];
c.on('Tracing.dataCollected', p => { events.push(...p.value); });
const done = new Promise(r => c.on('Tracing.tracingComplete', r));
await c.send('Tracing.start', {
	transferMode: 'ReportEvents',
	traceConfig: {
		recordMode: 'recordAsMuchAsPossible',
		includedCategories: ['latencyInfo', 'input', 'benchmark', 'devtools.timeline', 'disabled-by-default-devtools.timeline.frame', 'blink', 'cc', ...(js ? ['disabled-by-default-v8.cpu_profiler', 'v8.execute'] : [])],
	},
});
await sleep(400);
for (let i = 0; i < keys; i++) {
	const ch = PROBE_CHARS[i % PROBE_CHARS.length];
	const code = ch.toUpperCase().charCodeAt(0);
	await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: ch, code: `Key${ch.toUpperCase()}`, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code, text: ch });
	await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch, code: `Key${ch.toUpperCase()}`, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code });
	await sleep(250 * (0.8 + Math.random() * 0.4));
}
await sleep(1500);
await c.send('Tracing.end');
await done;
await c.key('a', 'KeyA', 65, 4);
await c.key('Backspace', 'Backspace', 8);
c.close();
if (out) { writeFileSync(out, JSON.stringify({ traceEvents: events })); }

const k2p = keyLatencies(events);
console.log(`key to presented frame: n ${k2p.length}, p50 ${median(k2p)}, p95 ${pct(k2p, 0.95)}, max ${Math.max(...k2p)}`);

// The renderer main thread: the one running the composer's keydown.
const kd = events.find(e => e.name === 'EventDispatch' && e.args?.data?.type === 'keydown');
const pid = kd?.pid, tid = kd?.tid;
const idOf = e => e.id2?.local ?? e.id2?.global ?? e.id;
const keyIds = new Set(events.filter(e => e.name === 'EventLatency' && e.ph === 'b' && e.args?.event_latency?.event_type === 'KEY_PRESSED').map(idOf));
const spans = new Map();
for (const e of events.filter(e => (e.ph === 'b' || e.ph === 'e') && keyIds.has(idOf(e))).sort((a, b) => a.ts - b.ts)) {
	const k = `${idOf(e)}|${e.name}`;
	if (e.ph === 'b') { spans.set(k, { id: idOf(e), name: e.name, ts: e.ts }); }
	else if (spans.has(k)) { spans.get(k).end = e.ts; }
}
const byKey = new Map();
for (const s of spans.values()) { if (s.end) { (byKey.get(s.id) ?? byKey.set(s.id, {}).get(s.id))[s.name] = s; } }
const stageDurs = new Map();
for (const st of byKey.values()) { for (const [n, s] of Object.entries(st)) { (stageDurs.get(n) ?? stageDurs.set(n, []).get(n)).push((s.end - s.ts) / 1000); } }
console.log('\n== stages (keys, p50, p95)');
for (const [n, v] of [...stageDurs].sort((a, b) => median(b[1]) - median(a[1]))) { if (pct(v, 0.95) >= 0.3) { console.log(`  ${n.padEnd(56)} ${String(v.length).padStart(3)} ${median(v).toFixed(2).padStart(6)} ${pct(v, 0.95).toFixed(2).padStart(6)}`); } }

const main = events.filter(e => e.pid === pid && e.tid === tid && e.ph === 'X').sort((a, b) => a.ts - b.ts);
const frames = [...byKey.values()].map(st => st.SendBeginMainFrameToCommit).filter(Boolean);
const per = new Map();
for (const f of frames) {
	const inFrame = main.filter(e => e.ts >= f.ts && e.ts < f.end);
	const sum = new Map();
	for (const e of inFrame) { sum.set(e.name, (sum.get(e.name) ?? 0) + (e.dur ?? 0) / 1000); }
	for (const [n, v] of sum) { (per.get(n) ?? per.set(n, []).get(n)).push(v); }
}
console.log(`\n== main-thread events inside ${frames.length} key frames (frames with it, p50 ms, p95 ms, mean ms over all key frames)`);
for (const [n, v] of [...per].sort((a, b) => b[1].reduce((x, y) => x + y, 0) - a[1].reduce((x, y) => x + y, 0)).slice(0, 40)) {
	console.log(`  ${n.padEnd(44)} ${String(v.length).padStart(3)} ${median(v).toFixed(2).padStart(6)} ${pct(v, 0.95).toFixed(2).padStart(6)} ${(v.reduce((x, y) => x + y, 0) / frames.length).toFixed(2).padStart(6)}`);
}
// rAF callbacks inside key frames: what JS functions they run (FunctionCall's data).
const fn = new Map();
for (const f of frames) {
	for (const e of main.filter(e => e.ts >= f.ts && e.ts < f.end && e.name === 'FunctionCall')) {
		const d = e.args?.data ?? {};
		const k = `${d.functionName || '(anon)'} ${(d.url || '').split('/').pop()}:${d.lineNumber}`;
		const v = fn.get(k) ?? { n: 0, ms: 0 };
		v.n++; v.ms += (e.dur ?? 0) / 1000;
		fn.set(k, v);
	}
}
console.log('\n== FunctionCall inside key frames (count, total ms)');
for (const [k, v] of [...fn].sort((a, b) => b[1].ms - a[1].ms).slice(0, 25)) { console.log(`  ${String(v.n).padStart(4)} ${v.ms.toFixed(1).padStart(7)} ${k}`); }
// Style and layout sizes in key frames.
const sty = [], lay = [];
for (const f of frames) {
	for (const e of main.filter(e => e.ts >= f.ts && e.ts < f.end)) {
		if (e.name === 'UpdateLayoutTree') { sty.push(e.args?.elementCount ?? e.args?.data?.elementCount ?? 0); }
		if (e.name === 'Layout') { lay.push(e.args?.beginData?.dirtyObjects ?? 0); }
	}
}
console.log(`\n== style recalc elements per key frame: n ${sty.length} p50 ${median(sty)} p95 ${pct(sty, 0.95)}; layout dirty objects p50 ${median(lay)} p95 ${pct(lay, 0.95)}`);
// What other main-thread work ran between the key's handler and its frame (stream tasks the frame waited behind).
