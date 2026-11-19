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
		includedCategories: ['latencyInfo', 'input', 'benchmark', 'devtools.timeline', 'disabled-by-default-devtools.timeline', 'disabled-by-default-devtools.timeline.stack', 'disabled-by-default-devtools.timeline.frame', 'blink.user_timing', 'v8.execute', 'blink', 'disabled-by-default-v8.cpu_profiler', ...(args.includes('--inval') ? ['disabled-by-default-devtools.timeline.invalidationTracking'] : [])],
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

// Round 7: how big each pass is. Layout: dirty and total layout objects (beginData), partial or full; style recalcs:
// elements recalculated (args.elementCount). Medians and p95 over the window, and the share of passes that were full.
{
	const q = (vals, p) => { const s = [...vals].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)] : null; };
	const lay = main.filter(e => e.name === 'Layout' && e.args?.beginData);
	const dirty = lay.map(e => e.args.beginData.dirtyObjects ?? 0);
	const total = lay.map(e => e.args.beginData.totalObjects ?? 0);
	const full = lay.filter(e => e.args.beginData.partialLayout === false).length;
	const durs = lay.map(e => e.dur / 1000);
	console.log(`\n== layout size: ${lay.length} passes, dirty objects p50 ${q(dirty, 0.5)} p95 ${q(dirty, 0.95)} max ${Math.max(0, ...dirty)}, total objects p50 ${q(total, 0.5)}, full (not partial) ${full}, ms p50 ${q(durs, 0.5)?.toFixed(2)} p95 ${q(durs, 0.95)?.toFixed(2)}`);
	const st = main.filter(e => e.name === 'UpdateLayoutTree');
	const els = st.map(e => e.args?.elementCount ?? e.args?.endData?.elementCount ?? 0);
	const sdur = st.map(e => e.dur / 1000);
	console.log(`== style size: ${st.length} recalcs, elements p50 ${q(els, 0.5)} p95 ${q(els, 0.95)} max ${Math.max(0, ...els)}, ms p50 ${q(sdur, 0.5)?.toFixed(2)} p95 ${q(sdur, 0.95)?.toFixed(2)}`);
	const paint = main.filter(e => e.name === 'Paint' || e.name === 'PrePaint');
	console.log(`== paint+prepaint: ${paint.length}, ms total ${(paint.reduce((a, e) => a + e.dur, 0) / 1000).toFixed(0)}`);
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

// --inval: what dirtied style before each forced style recalc (invalidation tracking events between the previous
// UpdateLayoutTree's end and the forced one's start), grouped by the forcing stack, then by reason + selector + stack.
if (args.includes('--inval')) {
	const recalcs = main.filter(e => e.name === 'UpdateLayoutTree').sort((a, b) => a.ts - b.ts);
	const invals = events.filter(e => e.pid === mainPid && /InvalidationTracking$/.test(e.name)).sort((a, b) => a.ts - b.ts);
	const groups = new Map();
	let j = 0;
	for (let i = 0; i < recalcs.length; i++) {
		const r = recalcs[i];
		const forcedBy = r.args?.beginData?.stackTrace?.length ? stackKey(r.args.beginData.stackTrace).split(' < ')[0] : '(frame)';
		const from = i ? recalcs[i - 1].ts + (recalcs[i - 1].dur ?? 0) : 0;
		while (j < invals.length && invals[j].ts < from) { j++; }
		for (let k = j; k < invals.length && invals[k].ts < r.ts; k++) {
			const d = invals[k].args?.data ?? {};
			const key = `${forcedBy} <= ${invals[k].name.replace('InvalidationTracking', '')} ${d.reason ?? ''} ${d.selectorPart ?? ''} ${d.extraData ?? ''} ${d.nodeName ?? ''} ${d.stackTrace ? '@' + stackKey(d.stackTrace).split(' < ').slice(0, 3).join(' < ') : ''}`.replace(/\s+/g, ' ');
			groups.set(key, (groups.get(key) ?? 0) + 1);
		}
	}
	console.log('\n== style invalidations before forced recalcs (count, forcing function <= invalidation reason/selector/node/stack)');
	for (const [k, v] of [...groups].sort((a, b) => b[1] - a[1]).slice(0, 30)) {
		console.log(`${String(v).padStart(6)} ${k}`);
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

// Round 7: each key's EventLatency split into Chromium's stages (its nested async slices share the key's id), p50/p95
// per stage over the keys, and for the slowest keys their stages and the longest main-thread tasks inside their span.
{
	const idOf = e => e.id2?.local ?? e.id2?.global ?? e.id;
	const keyIds = new Map();
	for (const e of events) {
		if (e.name === 'EventLatency' && e.ph === 'b' && e.args?.event_latency?.event_type === 'KEY_PRESSED') { keyIds.set(idOf(e), { ts: e.ts, stages: new Map(), end: null }); }
	}
	const open = new Map();
	for (const e of [...events].filter(e => (e.ph === 'b' || e.ph === 'e') && keyIds.has(idOf(e))).sort((a, b) => a.ts - b.ts)) {
		const k = keyIds.get(idOf(e));
		const ok = `${idOf(e)}|${e.name}`;
		if (e.ph === 'b') { open.set(ok, e.ts); }
		else if (open.has(ok)) {
			const d = (e.ts - open.get(ok)) / 1000;
			open.delete(ok);
			if (e.name === 'EventLatency') { k.end = e.ts; } else { k.stages.set(e.name, (k.stages.get(e.name) ?? 0) + d); }
		}
	}
	const keysDone = [...keyIds.values()].filter(k => k.end);
	const names = new Map();
	for (const k of keysDone) { for (const [n, d] of k.stages) { (names.get(n) ?? names.set(n, []).get(n)).push(d); } }
	console.log(`\n== key latency stages (${keysDone.length} keys): name, keys with it, p50, p95, max ms`);
	for (const [n, ds] of [...names].sort((a, b) => pct(b[1], 0.95) - pct(a[1], 0.95)).slice(0, 18)) {
		console.log(`  ${n.padEnd(58)} ${String(ds.length).padStart(3)} ${pct(ds, 0.5).toFixed(1).padStart(7)} ${pct(ds, 0.95).toFixed(1).padStart(7)} ${Math.max(...ds).toFixed(1).padStart(7)}`);
	}
	const tasks = main.filter(e => e.name === 'RunTask' || e.name === 'ThreadControllerImpl::RunTask');
	const label = t => {
		const inner = main.filter(e => e.ts >= t.ts && e.ts < t.ts + t.dur && e !== t && /^(FunctionCall|FireAnimationFrame|EventDispatch|TimerFire|UpdateLayoutTree|Layout|Paint|ProxyMain::BeginMainFrame|V8.GC_.*|MajorGC|MinorGC|V8.HandleInterrupts)$/.test(e.name)).sort((a, b) => b.dur - a.dur).slice(0, 3);
		return inner.map(e => `${e.name}${e.args?.data?.functionName ? ' ' + e.args.data.functionName : ''}${e.args?.data?.type ? ' ' + e.args.data.type : ''}${e.args?.data?.url ? '@' + e.args.data.url.replace(/^.*\/out\//, '') + ':' + e.args.data.lineNumber : ''} ${(e.dur / 1000).toFixed(1)}`).join(' | ');
	};
	console.log('== slowest keys: total ms, stages over 4 ms, main-thread tasks over 4 ms inside the key span');
	for (const k of keysDone.sort((a, b) => (b.end - b.ts) - (a.end - a.ts)).slice(0, 6)) {
		const st = [...k.stages].filter(([, d]) => d > 4).map(([n, d]) => `${n} ${d.toFixed(1)}`).join(', ');
		console.log(`  ${((k.end - k.ts) / 1000).toFixed(1)} ms: ${st}`);
		for (const t of tasks.filter(t => t.ts + t.dur > k.ts && t.ts < k.end && t.dur > 4000).slice(0, 5)) {
			console.log(`      task ${(t.dur / 1000).toFixed(1)} at +${((t.ts - k.ts) / 1000).toFixed(0)}: ${label(t)}`);
		}
	}
}

// Round 7: large style recalcs (100 elements or more), by what forced them (a JS stack) or the frame's own pass, and
// the event or callback whose task they ran in.
{
	const big = main.filter(e => e.name === 'UpdateLayoutTree' && (e.args?.elementCount ?? 0) >= 100);
	const tasks = main.filter(e => e.name === 'RunTask' || e.name === 'ThreadControllerImpl::RunTask');
	const by = new Map();
	for (const e of big) {
		const st = e.args?.beginData?.stackTrace;
		const forced = st?.length ? st.slice(0, 3).map(f => `${f.functionName || '(anon)'}:${f.lineNumber}:${f.columnNumber}`).join(' < ') : '(frame)';
		const task = tasks.find(t => t.ts <= e.ts && e.ts < t.ts + t.dur);
		const inner = task && main.filter(x => x.ts >= task.ts && x.ts < task.ts + task.dur && /^(EventDispatch|FireAnimationFrame|TimerFire|FunctionCall)$/.test(x.name)).sort((a, b) => b.dur - a.dur)[0];
		const k = `${forced}  in ${inner ? inner.name + (inner.args?.data?.type ? ' ' + inner.args.data.type : '') : '?'}`;
		const s = by.get(k) ?? { n: 0, els: 0, us: 0 };
		s.n++; s.els += e.args.elementCount; s.us += e.dur;
		by.set(k, s);
	}
	console.log(`\n== large style recalcs (>= 100 elements): ${big.length}; by forcing stack and task (count, elements, ms)`);
	for (const [k, v] of [...by].sort((a, b) => b[1].us - a[1].us).slice(0, 12)) {
		console.log(`${String(v.n).padStart(5)} ${String(v.els).padStart(7)} ${(v.us / 1000).toFixed(1).padStart(8)} ${k.slice(0, 200)}`);
	}
}
