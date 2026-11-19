// CPU time (thread time, which the machine's load does not stretch) of a launch from a Chromium startup trace: the
// browser (main process) main thread and the launch page's renderer main thread, as tasks over a threshold with their
// wall and CPU durations, and totals by event name. Times are ms after the trace's first event; `--zero <mark>` puts
// zero at a renderer mark (default code/didStartRenderer) and `--offset <ms>` says what that mark read after t0 in
// run.ts's row, so the main process's own marks (run.ts prints them after t0) can be laid over the trace.
//   node tracecpu.mjs <trace.json> [--min 5] [--from <ms>] [--to <ms>] [--offset <ms of didStartRenderer after t0>]
import { readFileSync } from 'node:fs';
const argv = process.argv.slice(2);
const file = argv[0];
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const MIN = Number(opt('--min', 5)) * 1000;
const raw = JSON.parse(readFileSync(file, 'utf8'));
const ev = Array.isArray(raw) ? raw : raw.traceEvents;
const procs = new Map(); const threads = new Map();
for (const e of ev) { if (e.ph === 'M' && e.name === 'process_name') { procs.set(e.pid, e.args?.name); } if (e.ph === 'M' && e.name === 'thread_name') { threads.set(`${e.pid}:${e.tid}`, e.args?.name); } }
const marks = ev.filter(e => e.cat === 'blink.user_timing' && /^code\//.test(e.name)).sort((a, b) => a.ts - b.ts);
const zeroMark = marks.find(e => e.name === opt('--zero', 'code/didStartRenderer'));
const offset = Number(opt('--offset', 0));
const zero = zeroMark ? zeroMark.ts - offset * 1000 : Math.min(...ev.filter(e => e.ts).map(e => e.ts));
const ms = ts => ((ts - zero) / 1000).toFixed(0);
const from = Number(opt('--from', -1e9)) * 1000 + zero, to = Number(opt('--to', 1e9)) * 1000 + zero;
const rpid = zeroMark?.pid, rtid = zeroMark?.tid;
const bpid = [...procs].find(([, n]) => n === 'Browser')?.[0];
const btid = Number([...threads].find(([k, n]) => k.startsWith(`${bpid}:`) && n === 'CrBrowserMain')?.[0]?.split(':')[1]);
console.log(`# ${file}: zero = ${zeroMark?.name ?? 'first event'} - ${offset} ms; browser ${bpid}/${btid}; page renderer ${rpid}/${rtid}`);
const show = /didStartRenderer|willWaitForWindowConfig|didWaitForWindowConfig|voltDidPaintWindowSnapshot|willLoadWorkbenchMain|didLoadWorkbenchMain|willStartWorkbench|didStartWorkbench|voltDidHandOff/;
console.log('renderer marks: ' + marks.filter(e => e.pid === rpid && show.test(e.name)).map(e => `${e.name.replace('code/', '')} ${ms(e.ts)}`).join(', '));
function thread(label, pid, tid) {
	const xs = ev.filter(e => e.pid === pid && e.tid === tid && e.ph === 'X' && e.ts >= from && e.ts <= to).sort((a, b) => a.ts - b.ts || b.dur - a.dur);
	// Top-level events: not contained in an earlier one.
	const top = []; let end = -Infinity;
	for (const e of xs) { if (e.ts >= end) { top.push(e); end = e.ts + (e.dur ?? 0); } }
	const cpu = top.reduce((s, e) => s + (e.tdur ?? 0), 0), wall = top.reduce((s, e) => s + (e.dur ?? 0), 0);
	console.log(`\n== ${label}: ${top.length} top-level events, wall ${(wall / 1000).toFixed(0)} ms, CPU ${(cpu / 1000).toFixed(0)} ms`);
	console.log(`top-level events with CPU or wall >= ${MIN / 1000} ms (start, wall, CPU, name, biggest child by CPU):`);
	for (const e of top.filter(e => (e.tdur ?? 0) >= MIN || (e.dur ?? 0) >= MIN)) {
		const kids = xs.filter(k => k !== e && k.ts >= e.ts && k.ts + (k.dur ?? 0) <= e.ts + e.dur && (k.tdur ?? 0) >= MIN / 2 && !/RunTask|ThreadController|SimpleWatcher|Receive mojo|Closure|MessagePump/.test(k.name));
		const names = [...new Map(kids.sort((a, b) => (b.tdur ?? 0) - (a.tdur ?? 0)).map(k => [k.name + (k.args?.data?.url ? ' ' + String(k.args.data.url).split('/').pop() : k.args?.data?.type ? ' ' + k.args.data.type : ''), k])).entries()].slice(0, 4).map(([n, k]) => `${n} ${((k.tdur ?? 0) / 1000).toFixed(0)}`);
		console.log(`  +${ms(e.ts).padStart(5)} ${((e.dur ?? 0) / 1000).toFixed(0).padStart(5)} ${((e.tdur ?? 0) / 1000).toFixed(0).padStart(5)}  ${e.name}${e.args?.src_func ? ' ' + e.args.src_func : ''}  [${names.join('; ')}]`);
	}
	const by = new Map();
	for (const e of xs) { if (/RunTask|ThreadController/.test(e.name)) { continue; } const k = e.name; const v = by.get(k) ?? { cpu: 0, n: 0 }; v.cpu += e.tdur ?? 0; v.n++; by.set(k, v); }
	console.log('CPU by event name (nested events overlap), top 25:');
	for (const [n, v] of [...by].sort((a, b) => b[1].cpu - a[1].cpu).slice(0, 25)) { console.log(`  ${(v.cpu / 1000).toFixed(1).padStart(7)} ms x${v.n}  ${n}`); }
}
thread('browser main thread', bpid, btid);
if (rpid) { thread('page renderer main thread', rpid, rtid); }
// Key events as the browser and the renderer saw them.
const keys = ev.filter(e => /KeyDown|RawKeyDown|Char|KeyUp|KeyboardEvent/.test(JSON.stringify(e.args ?? {}).slice(0, 300) + e.name) && /Input|input|EventLatency/.test(e.cat + e.name) && e.ts >= from && e.ts <= to).sort((a, b) => a.ts - b.ts);
console.log(`\nkey events (${keys.length}), first 40:`);
for (const e of keys.slice(0, 40)) { console.log(`  +${ms(e.ts)} ${procs.get(e.pid)} ${threads.get(`${e.pid}:${e.tid}`) ?? e.tid} ${e.ph} ${e.name} ${e.dur ? (e.dur / 1000).toFixed(1) + ' ms' : ''} ${JSON.stringify(e.args ?? {}).slice(0, 110)}`); }
