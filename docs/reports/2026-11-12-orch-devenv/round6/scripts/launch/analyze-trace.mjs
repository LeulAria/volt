// Offline analysis of a Chromium trace (startup-trace.sh or trace.mjs): the workbench renderer's main thread from
// didStartRenderer to didStartWorkbench, compile vs evaluate, code cache use, long tasks.
//   node analyze-trace.mjs <trace.json> [--tasks]
import { readFileSync } from 'node:fs';
const [file, ...rest] = process.argv.slice(2);
const raw = JSON.parse(readFileSync(file, 'utf8'));
const ev = Array.isArray(raw) ? raw : raw.traceEvents;
let first = Infinity; for (const e of ev) { if (e.ts && e.ts < first) { first = e.ts; } }
const ms = ts => Math.round((ts - first) / 1000);
const procs = new Map(); const threads = new Map();
for (const e of ev) { if (e.ph === 'M' && e.name === 'process_name') { procs.set(e.pid, e.args?.name); } if (e.ph === 'M' && e.name === 'thread_name') { threads.set(`${e.pid}:${e.tid}`, e.args?.name); } }
const marks = ev.filter(e => e.cat === 'blink.user_timing' && /^code\//.test(e.name)).sort((a, b) => a.ts - b.ts);
const start = marks.find(e => e.name === 'code/didStartRenderer');
if (!start) { console.log('no code/didStartRenderer in the trace; marks: ' + marks.slice(0, 5).map(e => e.name).join(', ')); }
const pid = start?.pid ?? marks[0]?.pid, tid = start?.tid ?? marks[0]?.tid;
console.log(`# ${file}\nprocesses: ${[...procs].map(([p, n]) => `${p}=${n}`).join(', ')}; workbench renderer pid ${pid} tid ${tid} (${threads.get(`${pid}:${tid}`)})`);
const show = /didStartRenderer|didWaitForWindowConfig|voltDidPaintWindowSnapshot|willLoadWorkbenchMain|didLoadWorkbenchMain|willStartWorkbench|didStartWorkbench|voltDidHandOff|didRemovePartsSplash|LifecyclePhase/;
console.log('marks (ms after first trace event): ' + marks.filter(e => e.pid === pid && show.test(e.name)).map(e => `${e.name.replace('code/', '')} ${ms(e.ts)}`).join(', '));
// Browser (main process) marks are not in the trace; print the browser's main thread long tasks instead.
const browserPid = [...procs].find(([, n]) => n === 'Browser')?.[0];
const main = ev.filter(e => e.pid === pid && e.tid === tid && e.ph === 'X');
const inWindow = (a, b) => main.filter(e => e.ts >= a && e.ts <= b);
const a = start?.ts ?? first, b = marks.find(e => e.name === 'code/didStartWorkbench')?.ts ?? Infinity;
const sumBy = new Map();
for (const e of inWindow(a, b)) { sumBy.set(e.name, (sumBy.get(e.name) ?? 0) + e.dur / 1000); }
console.log('renderer main thread, event totals from didStartRenderer to didStartWorkbench (ms, nested events overlap):');
for (const [n, d] of [...sumBy].sort((x, y) => y[1] - x[1]).slice(0, 22)) { console.log(`  ${d.toFixed(1).padStart(8)}  ${n}`); }
console.log('v8 compile/cache events > 1 ms (any thread of the renderer):');
for (const e of ev.filter(e => e.pid === pid && /^v8\.(compile|compileModule|deserializeOnBackground|produceCache|parseOnBackground|compileCodeBackground|finalizeDeserialization)$|^V8\.(CompileCode|CompileEvalMicroSeconds|Deserialize)/.test(e.name) && (e.dur ?? 0) > 1000).sort((x, y) => x.ts - y.ts)) {
	const d = e.args?.data ?? e.args ?? {};
	const url = d.url ?? d.fileName ?? '';
	console.log(`  +${ms(e.ts)} ${e.name} ${(e.dur / 1000).toFixed(1)} ms tid ${e.tid}${threads.get(`${pid}:${e.tid}`) ? ' ' + threads.get(`${pid}:${e.tid}`) : ''} ${url.split('/').slice(-1)[0]} ${JSON.stringify({ ...d, url: undefined, fileName: undefined, columnNumber: undefined, lineNumber: undefined, frame: undefined }).slice(0, 200)}`);
}
console.log('evaluate events > 5 ms:');
for (const e of main.filter(e => /EvaluateScript|v8\.evaluateModule|V8\.Execute|v8\.run|FunctionCall|EventDispatch|TimerFire|RunMicrotasks/.test(e.name) && (e.dur ?? 0) > 5000).sort((x, y) => x.ts - y.ts)) {
	const d = e.args?.data ?? e.args ?? {};
	console.log(`  +${ms(e.ts)} ${e.name} ${(e.dur / 1000).toFixed(1)} ms ${(d.url ?? d.functionName ?? d.type ?? '').toString().split('/').slice(-1)[0]}`);
}
if (rest.includes('--tasks')) {
	console.log('renderer main-thread tasks > 8 ms:');
	for (const e of main.filter(e => /RunTask/.test(e.name) && e.dur > 8000).sort((x, y) => x.ts - y.ts)) { console.log(`  +${ms(e.ts)} ${(e.dur / 1000).toFixed(1)} ms`); }
}
if (browserPid) {
	const bt = [...threads].find(([k, n]) => k.startsWith(`${browserPid}:`) && n === 'CrBrowserMain')?.[0]?.split(':')[1];
	const tasks = ev.filter(e => e.pid === browserPid && String(e.tid) === bt && e.ph === 'X' && /RunTask/.test(e.name) && e.dur > 15000).sort((x, y) => x.ts - y.ts);
	console.log(`browser main thread tasks > 15 ms (the main process; JS import of the main bundle shows here): ${tasks.map(e => `+${ms(e.ts)} ${(e.dur / 1000).toFixed(0)}`).join(', ')}`);
	const js = ev.filter(e => e.pid === browserPid && e.ph === 'X' && /v8\.compile|V8\.|EvaluateScript|v8\.evaluateModule/.test(e.name) && e.dur > 5000).sort((x, y) => x.ts - y.ts);
	for (const e of js) { const d = e.args?.data ?? e.args ?? {}; console.log(`  +${ms(e.ts)} ${e.name} ${(e.dur / 1000).toFixed(1)} ms ${(d.url ?? d.fileName ?? '').split('/').slice(-1)[0]} ${JSON.stringify({ ...d, url: undefined, fileName: undefined }).slice(0, 160)}`); }
}
