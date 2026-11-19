import { readFileSync } from 'node:fs';
const [file, offS, fromS, toS] = process.argv.slice(2);
const raw = JSON.parse(readFileSync(file, 'utf8')); const ev = Array.isArray(raw) ? raw : raw.traceEvents;
const procs = new Map(), threads = new Map();
for (const e of ev) { if (e.ph === 'M' && e.name === 'process_name') procs.set(e.pid, e.args?.name); if (e.ph === 'M' && e.name === 'thread_name') threads.set(`${e.pid}:${e.tid}`, e.args?.name); }
const zm = ev.find(e => e.cat === 'blink.user_timing' && e.name === 'code/didStartRenderer');
const zero = zm.ts - Number(offS) * 1000;
const from = zero + Number(fromS) * 1000, to = zero + Number(toS) * 1000;
const want = /Navigat|navigation|URLLoader|ResourceLoad|CreateRenderView|RenderProcessHost|ChildProcessLauncher|Launch|EstablishGpu|GpuChannel|CommitNavigation|ParseHTML|ParseAuthorStyleSheet|ResourceSendRequest|ResourceReceiveResponse|ResourceFinish|EvaluateScript|v8.compileModule|firstPaint|FirstPaint|firstContentfulPaint|DrawFrame|BeginMainFrame|ProxyImpl::ScheduledActionDraw|Display::DrawAndSwap|SwapBuffers|RenderThreadImpl|CreateWebView|BrowserWindow|NativeWindow|WakeupMainThread/;
const xs = ev.filter(e => e.ts >= from && e.ts < to && (e.ph === 'X' || e.ph === 'I' || e.ph === 'i' || e.ph === 'b' || e.ph === 'R') && want.test(e.name) && ((e.dur ?? 0) > 1500 || e.ph !== 'X' || /Navigat|Resource|Launch|Gpu|Commit|firstPaint|FirstPaint|CreateWebView/.test(e.name))).sort((a, b) => a.ts - b.ts);
let n = 0;
for (const e of xs) {
	const d = e.args?.data ?? e.args ?? {};
	const url = (d.url ?? d.requestId ?? '').toString().split('/').slice(-1)[0].slice(0, 40);
	console.log(`+${((e.ts - zero) / 1000).toFixed(0).padStart(5)} ${(procs.get(e.pid) ?? '?').slice(0, 8).padEnd(8)} ${(threads.get(`${e.pid}:${e.tid}`) ?? '').slice(0, 18).padEnd(18)} ${e.ph} ${e.name.slice(0, 60)} ${e.dur ? (e.dur / 1000).toFixed(0) + 'w/' + ((e.tdur ?? 0) / 1000).toFixed(0) + 'c' : ''} ${url}`);
	if (++n > 140) break;
}
