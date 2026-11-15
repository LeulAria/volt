// A Chromium memory-infra dump of the test instance over its browser CDP endpoint: per process, the
// top allocators (gpu, cc tiles, skia, partition_alloc, v8, malloc ...), effective size.
//   node memdump.mjs [out.json]
import { writeFileSync } from 'fs';
import { PORT, sleep } from './lib.mjs';

const version = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
const ws = new WebSocket(version.webSocketDebuggerUrl, { perMessageDeflate: false });
await new Promise(r => ws.addEventListener('open', r, { once: true }));
let id = 0;
const pending = new Map();
const events = [];
let complete;
ws.addEventListener('message', e => {
	const m = JSON.parse(e.data);
	if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
	else if (m.method === 'Tracing.dataCollected') { events.push(...m.params.value); }
	else if (m.method === 'Tracing.tracingComplete') { complete?.(); }
});
const send = (method, params = {}) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
await send('Tracing.start', { traceConfig: { includedCategories: ['disabled-by-default-memory-infra'], excludedCategories: ['*'], memoryDumpConfig: { triggers: [] } }, transferMode: 'ReportEvents' });
await sleep(500);
const dump = await send('Tracing.requestMemoryDump', { deterministic: true, levelOfDetail: 'detailed' });
await sleep(500);
const done = new Promise(r => { complete = r; });
await send('Tracing.end');
await done;
ws.close();
const dumps = events.filter(e => e.ph === 'v' && e.args?.dumps);
const procs = {};
for (const e of dumps) {
	const ads = e.args.dumps.allocators ?? {};
	const name = events.find(x => x.ph === 'M' && x.name === 'process_name' && x.pid === e.pid)?.args?.name ?? String(e.pid);
	const rows = [];
	for (const [k, v] of Object.entries(ads)) {
		if (k.split('/').length > 2) { continue; }
		const size = parseInt(v.attrs?.effective_size?.value ?? v.attrs?.size?.value ?? '0', 16);
		if (size > 1 << 20) { rows.push([k, Math.round(size / 1048576 * 10) / 10]); }
	}
	rows.sort((a, b) => b[1] - a[1]);
	const totals = e.args.dumps.process_totals ?? {};
	procs[`${name} ${e.pid}`] = { resident: totals.resident_set_bytes ? Math.round(parseInt(totals.resident_set_bytes, 16) / 1048576) : undefined, footprint: totals.private_footprint_bytes ? Math.round(parseInt(totals.private_footprint_bytes, 16) / 1048576) : undefined, top: rows.slice(0, 14) };
}
if (process.argv[2]) { writeFileSync(process.argv[2], JSON.stringify({ dump: dump.result, procs, raw: dumps }, null, 1)); }
for (const [p, v] of Object.entries(procs)) {
	console.log(`== ${p} resident ${v.resident} MiB footprint ${v.footprint} MiB`);
	for (const [k, s] of v.top) { console.log(`   ${String(s).padStart(7)}  ${k}`); }
}
