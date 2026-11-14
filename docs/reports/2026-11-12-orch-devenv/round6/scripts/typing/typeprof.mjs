// Analysis aid (not a timing): where the renderer's main thread goes while 5 chats stream and 60 keys are typed, as
// in A8. Needs a running arm with its streams under way (streams.mjs). Takes a Chromium trace with the DevTools
// timeline categories over the typing window, then prints, for the typing window:
//   - counts and total ms per timeline event (UpdateLayoutTree, Layout, Paint, FunctionCall, TimerFire, ...)
//   - forced (synchronous) layouts and style recalcs with their JS stacks, top N
//   - per-frame: how many frames the main thread drew and the longest tasks
//   - key to presented frame (EventLatency KEY_PRESSED) p50/p95, as a8.mjs
//   node typeprof.mjs [keys=60] [--out trace.json] [--notype]
import { writeFileSync } from 'fs';
import { cdp, focusComposer, median, pct, sleep } from './lib.mjs';
import { keyLatencies } from './a8.mjs';

const args = process.argv.slice(2);
const keys = Number(args.find(a => /^\d+$/.test(a)) ?? 60);
const out = args.includes('--out') ? args[args.indexOf('--out') + 1] : undefined;
const notype = args.includes('--notype');
const PROBE_CHARS = 'abcdefghijklmnopqrstuvwxyz';

const c = await cdp();
await c.send('Emulation.setFocusEmulationEnabled', { enabled: true });
if (!notype && !await focusComposer(c)) {
	throw new Error('no composer');
}
const events = [];
c.on('Tracing.dataCollected', p => { events.push(...p.value); });
const done = new Promise(r => c.on('Tracing.tracingComplete', r));
await c.send('Tracing.start', {
	transferMode: 'ReportEvents',
	traceConfig: {
		recordMode: 'recordAsMuchAsPossible',
		includedCategories: ['latencyInfo', 'input', 'benchmark', 'devtools.timeline', 'disabled-by-default-devtools.timeline', 'disabled-by-default-devtools.timeline.stack', 'disabled-by-default-devtools.timeline.frame', 'blink.user_timing', 'v8.execute', 'blink', 'disabled-by-default-v8.cpu_profiler'],
	},
});
await sleep(500);
const t0 = Date.now();
for (let i = 0; i < keys; i++) {
	const ch = PROBE_CHARS[i % PROBE_CHARS.length];
	const code = ch.toUpperCase().charCodeAt(0);
	if (!notype) {
		await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: ch, code: `Key${ch.toUpperCase()}`, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code, text: ch });
		await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch, code: `Key${ch.toUpperCase()}`, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code });
	}
	await sleep(250 * (0.8 + Math.random() * 0.4));
}
const spanMs = Date.now() - t0;
await sleep(1000);
await c.send('Tracing.end');
await done;
if (!notype) {
	await c.key('a', 'KeyA', 65, 4);
	await c.key('Backspace', 'Backspace', 8);
}
await c.send('Emulation.setFocusEmulationEnabled', { enabled: false });
c.close();
if (out) {
	writeFileSync(out, JSON.stringify(events));
}

// The renderer main thread with the most timeline work (the test window's).
const byThread = new Map();
for (const e of events) {
	if (e.ph === 'X' && e.dur && /^(UpdateLayoutTree|Layout|Paint|FunctionCall|RunTask|EventDispatch)$/.test(e.name)) {
		const k = `${e.pid}:${e.tid}`;
		byThread.set(k, (byThread.get(k) ?? 0) + e.dur);
	}
}
const mainKey = [...byThread].sort((a, b) => b[1] - a[1])[0]?.[0];
const [mainPid, mainTid] = (mainKey ?? '0:0').split(':').map(Number);
const main = events.filter(e => e.pid === mainPid && e.tid === mainTid && e.ph === 'X');
const ms = us => Math.round(us / 100) / 10;
console.log(`typing window ${spanMs} ms, ${keys} keys; renderer main thread pid ${mainPid} tid ${mainTid}; ${events.length} trace events`);

const sum = new Map();
for (const e of main) {
	const s = sum.get(e.name) ?? { n: 0, us: 0, max: 0 };
	s.n++; s.us += e.dur ?? 0; s.max = Math.max(s.max, e.dur ?? 0);
	sum.set(e.name, s);
}
console.log('\n== main thread timeline events (count, total ms, per s, max ms)');
for (const [k, v] of [...sum].sort((a, b) => b[1].us - a[1].us).slice(0, 25)) {
	console.log(`${String(v.n).padStart(6)} ${ms(v.us).toFixed(1).padStart(9)} ${(v.n / (spanMs / 1000)).toFixed(1).padStart(7)}/s ${ms(v.max).toFixed(1).padStart(7)} ${k}`);
}

// Forced layouts and style recalcs: Layout/UpdateLayoutTree events with a JS stack (beginData.stackTrace) are synchronous.
const stackKey = st => (st ?? []).slice(0, 6).map(f => `${f.functionName || '(anon)'}@${(f.url ?? '').replace(/^.*\/out\//, '')}:${f.lineNumber}`).join(' < ');
for (const name of ['Layout', 'UpdateLayoutTree']) {
	const forced = main.filter(e => e.name === name && e.args?.beginData?.stackTrace?.length);
	const by = new Map();
	for (const e of forced) {
		const k = stackKey(e.args.beginData.stackTrace);
		const s = by.get(k) ?? { n: 0, us: 0 };
		s.n++; s.us += e.dur ?? 0;
		by.set(k, s);
	}
	console.log(`\n== forced ${name}: ${forced.length} of ${sum.get(name)?.n ?? 0}, ${ms(forced.reduce((a, e) => a + (e.dur ?? 0), 0))} ms; top stacks`);
	for (const [k, v] of [...by].sort((a, b) => b[1].us - a[1].us).slice(0, 12)) {
		console.log(`${String(v.n).padStart(5)} ${ms(v.us).toFixed(1).padStart(8)} ${k}`);
	}
}

// Long tasks on the main thread.
const tasks = main.filter(e => e.name === 'RunTask' || e.name === 'ThreadControllerImpl::RunTask').sort((a, b) => (b.dur ?? 0) - (a.dur ?? 0));
console.log(`\n== tasks: ${tasks.length}, over 16 ms: ${tasks.filter(t => t.dur > 16000).length}, over 50 ms: ${tasks.filter(t => t.dur > 50000).length}, longest ${tasks.slice(0, 5).map(t => ms(t.dur)).join(', ')} ms`);
// What the long tasks held: the top-level children by name.
const kids = new Map();
for (const t of tasks.filter(t => t.dur > 16000)) {
	for (const e of main) {
		if (e !== t && e.ts >= t.ts && e.ts + (e.dur ?? 0) <= t.ts + t.dur && /^(FunctionCall|TimerFire|EventDispatch|UpdateLayoutTree|Layout|Paint|HitTest|FireAnimationFrame|XHRReadyStateChange|RunMicrotasks)$/.test(e.name)) {
			const k = e.name === 'FunctionCall' || e.name === 'FireAnimationFrame' || e.name === 'TimerFire' ? `${e.name} ${(e.args?.data?.functionName ?? '')}@${(e.args?.data?.url ?? '').replace(/^.*\/out\//, '')}:${e.args?.data?.lineNumber ?? ''}` : e.name === 'EventDispatch' ? `EventDispatch ${e.args?.data?.type}` : e.name;
			const s = kids.get(k) ?? { n: 0, us: 0 };
			s.n++; s.us += e.dur ?? 0;
			kids.set(k, s);
		}
	}
}
console.log('== inside tasks over 16 ms (count, ms)');
for (const [k, v] of [...kids].sort((a, b) => b[1].us - a[1].us).slice(0, 15)) {
	console.log(`${String(v.n).padStart(5)} ${ms(v.us).toFixed(1).padStart(8)} ${k}`);
}

// FunctionCall / FireAnimationFrame / TimerFire by callback (self-ish: inclusive of their work).
const calls = new Map();
for (const e of main.filter(e => /^(FunctionCall|FireAnimationFrame|TimerFire)$/.test(e.name))) {
	const d = e.args?.data ?? {};
	const k = `${e.name} ${d.functionName ?? ''}@${(d.url ?? '').replace(/^.*\/out\//, '')}:${d.lineNumber ?? ''}`;
	const s = calls.get(k) ?? { n: 0, us: 0 };
	s.n++; s.us += e.dur ?? 0;
	calls.set(k, s);
}
console.log('\n== callbacks (count, inclusive ms)');
for (const [k, v] of [...calls].sort((a, b) => b[1].us - a[1].us).slice(0, 20)) {
	console.log(`${String(v.n).padStart(5)} ${ms(v.us).toFixed(1).padStart(8)} ${k}`);
}

const k2p = keyLatencies(events.filter(e => e.name === 'EventLatency'));
console.log(`\n== key to presented frame: n ${k2p.length}, p50 ${median(k2p)}, p95 ${pct(k2p, 0.95)}, max ${k2p.length ? Math.max(...k2p) : null}`);
const busyUs = main.filter(e => e.name === 'RunTask' || e.name === 'ThreadControllerImpl::RunTask').reduce((a, e) => a + (e.dur ?? 0), 0);
console.log(`main thread busy ${ms(busyUs)} ms of ${spanMs} ms (${Math.round(busyUs / 10 / spanMs)} %)`);
