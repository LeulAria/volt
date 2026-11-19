import { readFileSync } from 'node:fs';
const [file, offS] = process.argv.slice(2);
const raw = JSON.parse(readFileSync(file, 'utf8')); const ev = Array.isArray(raw) ? raw : raw.traceEvents;
const procs = new Map();
for (const e of ev) { if (e.ph === 'M' && e.name === 'process_name') procs.set(e.pid, e.args?.name); }
const zm = ev.find(e => e.cat === 'blink.user_timing' && e.name === 'code/didStartRenderer');
const zero = zm.ts - Number(offS) * 1000;
const ms = ts => ((ts - zero) / 1000).toFixed(0);
// first event per process = roughly when it could trace
const first = new Map();
for (const e of ev) { if (e.ts && (!first.has(e.pid) || e.ts < first.get(e.pid))) first.set(e.pid, e.ts); }
console.log('first traced event per process:', [...first].sort((a, b) => a[1] - b[1]).map(([p, t]) => `${procs.get(p) ?? p} +${ms(t)}`).join(', '));
for (const e of ev.filter(e => /ChildProcessLauncher|LaunchProcess|OnProcessLaunched|NetworkService|CreateNetworkService|GpuProcessHost|UtilityProcessHost|RenderProcessHostImpl::Init|OnChannelConnected|EstablishGpuChannel|BrowserGpuChannel/.test(e.name) && e.ts).sort((a, b) => a.ts - b.ts).slice(0, 60)) {
	console.log(`+${ms(e.ts).padStart(5)} ${(procs.get(e.pid) ?? '?').slice(0, 10).padEnd(10)} ${e.ph} ${e.name.slice(0, 70)} ${e.dur ? (e.dur / 1000).toFixed(0) + 'w/' + ((e.tdur ?? 0) / 1000).toFixed(0) + 'c' : ''} ${JSON.stringify(e.args ?? {}).slice(0, 120)} id=${e.id ?? e.id2?.local ?? ''}`);
}
