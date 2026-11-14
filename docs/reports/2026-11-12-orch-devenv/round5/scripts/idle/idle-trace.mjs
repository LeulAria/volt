// What runs while the window is idle: a Chromium trace of every process over `secs` seconds, summarised per process
// and thread (busy ms, task count) and, on the renderer main thread, per timer / animation-frame / event callback
// (function name and script position), plus style, layout and paint passes. Analysis aid, not a timing.
//   node idle-trace.mjs [secs=10] [--focus] [--out file.json]
import { writeFileSync } from 'fs';
import { cdp, load1, sleep } from './lib.mjs';

const args = process.argv.slice(2);
const secs = Number(args[0] && /^\d+$/.test(args[0]) ? args[0] : 10);
const out = args.includes('--out') ? args[args.indexOf('--out') + 1] : undefined;
let events, state = 'from file', l0 = '';
if (args.includes('--from')) {
	events = JSON.parse((await import('fs')).readFileSync(args[args.indexOf('--from') + 1], 'utf8'));
} else {
const c = await cdp();
if (args.includes('--focus')) {
	await c.send('Emulation.setFocusEmulationEnabled', { enabled: true });
}
if (args.includes('--settle')) {
	await sleep(Number(args[args.indexOf('--settle') + 1]) * 1000);
}
state = await c.evaluate('JSON.stringify({vis: document.visibilityState, focus: document.hasFocus()})');
const done = new Promise(r => c.on('Tracing.tracingComplete', r));
await c.send('Tracing.start', {
	transferMode: 'ReturnAsStream',
	traceConfig: {
		recordMode: 'recordAsMuchAsPossible',
		includedCategories: (process.env.TRACE_CATS ?? 'toplevel,devtools.timeline,disabled-by-default-devtools.timeline.frame,v8.execute,viz').split(','),
	},
});
l0 = load1();
await sleep(secs * 1000);
await c.send('Tracing.end');
const { stream } = await done;
let text = '';
for (; ;) {
	const r = await c.send('IO.read', { handle: stream, size: 1 << 20 });
	text += r.result.base64Encoded ? Buffer.from(r.result.data, 'base64').toString() : r.result.data;
	if (r.result.eof) { break; }
}
await c.send('IO.close', { handle: stream });
const parsed = JSON.parse(text);
events = Array.isArray(parsed) ? parsed : parsed.traceEvents;
if (args.includes('--focus')) {
	await c.send('Emulation.setFocusEmulationEnabled', { enabled: false });
}
c.close();
if (out) {
	writeFileSync(out, JSON.stringify(events));
}
}

const names = new Map();
for (const e of events) {
	if (e.ph === 'M' && e.name === 'process_name') { names.set(`p${e.pid}`, e.args.name); }
	if (e.ph === 'M' && e.name === 'thread_name') { names.set(`t${e.pid}.${e.tid}`, e.args.name); }
}
const x = events.filter(e => e.ph === 'X' && typeof e.dur === 'number');
const ts = x.map(e => e.ts);
const span = (ts.reduce((a, b) => Math.max(a, b), -Infinity) - ts.reduce((a, b) => Math.min(a, b), Infinity)) / 1e3;
// Busy time per thread: top-level slices (ThreadControllerImpl::RunTask / RunTask / tasks) only.
const top = x.filter(e => /^(ThreadControllerImpl::RunTask|ThreadPool_RunTask|RunTask|SequenceManager RunTask)$/.test(e.name));
const per = new Map();
for (const e of top) {
	const k = `${names.get(`p${e.pid}`) ?? e.pid} / ${names.get(`t${e.pid}.${e.tid}`) ?? e.tid}`;
	const v = per.get(k) ?? { n: 0, ms: 0 };
	v.n++; v.ms += e.dur / 1e3;
	per.set(k, v);
}
console.log(JSON.stringify({ secs, load: l0, state, spanMs: Math.round(span), events: events.length }));
console.log('\n== busy threads (tasks/s, ms/s)');
for (const [k, v] of [...per].sort((a, b) => b[1].ms - a[1].ms).slice(0, 20)) {
	console.log(`${k.padEnd(60)} ${(v.n / secs).toFixed(1).padStart(7)} /s ${(v.ms / secs).toFixed(2).padStart(7)} ms/s`);
}
// Renderer main thread detail.
const rendererPid = [...names].find(([k, v]) => k.startsWith('p') && /Renderer/.test(v))?.[0].slice(1);
const main = x.filter(e => String(e.pid) === rendererPid && names.get(`t${e.pid}.${e.tid}`) === 'CrRendererMain');
const count = (pred) => { const m = new Map(); for (const e of main.filter(pred)) { const f = e.args?.data ?? {}; const k = `${e.name} ${f.functionName ?? ''} ${(f.url ?? '').replace(/^.*\/out\//, '')}:${f.lineNumber ?? ''}:${f.columnNumber ?? ''} ${f.type ?? ''}`; const v = m.get(k) ?? { n: 0, ms: 0 }; v.n++; v.ms += e.dur / 1e3; m.set(k, v); } return m; };
console.log('\n== renderer main: callbacks (count, ms) over the window');
for (const [k, v] of [...count(e => e.name === 'FunctionCall' || e.name === 'EventDispatch' || e.name === 'TimerFire' || e.name === 'FireAnimationFrame' || e.name === 'FireIdleCallback' || e.name === 'v8.callFunction')].sort((a, b) => b[1].n - a[1].n).slice(0, 40)) {
	console.log(`${String(v.n).padStart(5)} ${v.ms.toFixed(1).padStart(8)} ms  ${k}`);
}
console.log('\n== renderer main: rendering passes');
for (const [k, v] of [...count(e => /^(UpdateLayoutTree|Layout|Paint|PrePaint|Layerize|Commit|UpdateLayer|ScheduleStyleRecalculation|ParseHTML|HitTest|IntersectionObserverController::computeIntersections|ResizeObserverController::DeliverObservations)$/.test(e.name))].sort((a, b) => b[1].n - a[1].n)) {
	console.log(`${String(v.n).padStart(5)} ${v.ms.toFixed(1).padStart(8)} ms  ${k.split(' ')[0]}`);
}
const draws = x.filter(e => e.name === 'Display::DrawAndSwap');
const links = x.filter(e => e.args?.src_func === 'CVDisplayLinkCallback');
console.log(`display link callbacks: ${links.length} (${(links.length / secs).toFixed(1)}/s)`);
console.log(`\nviz DrawAndSwap: ${draws.length} (${(draws.length / secs).toFixed(1)}/s)`);
