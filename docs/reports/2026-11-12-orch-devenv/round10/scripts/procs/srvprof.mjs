// Round 10: what the dev agent server allocates and holds while chats stream. Needs the server started with an
// inspector (`arm dev-yg-insp`: ygflag.sh insp adds --inspect=127.0.0.1:9239). Starts V8's sampling heap profiler
// (every allocation, collected or not), logs footprint + heap spaces every 10 s for <seconds>, then prints the top
// allocating functions (self bytes over the window) and, with a path, saves a heap snapshot.
//   node srvprof.mjs <seconds=200> [snapshot.heapsnapshot] [port=9239]
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const [secs = '200', snap, port = '9239'] = process.argv.slice(2);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const ws = new WebSocket(list[0].webSocketDebuggerUrl);
await new Promise(r => ws.onopen = r);
let id = 0; const waits = new Map(); const chunks = [];
ws.onmessage = m => { const d = JSON.parse(m.data); if (d.method === 'HeapProfiler.addHeapSnapshotChunk') { chunks.push(d.params.chunk); } if (d.id && waits.has(d.id)) { waits.get(d.id)(d); waits.delete(d.id); } };
const send = (method, params = {}) => new Promise(r => { const i = ++id; waits.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async e => (await send('Runtime.evaluate', { expression: e, returnByValue: true })).result?.result?.value;
const pid = await ev('process.pid');
const V8 = `(process.getBuiltinModule ? process.getBuiltinModule('v8') : require('v8'))`;
const fp = () => { try { return execFileSync('footprint', ['-p', String(pid)], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().match(/Footprint:\s+([\d.]+ \w+)/)?.[1]; } catch { return undefined; } };
const state = async () => ({ fp: fp(), mem: await ev(`(() => { const m = process.memoryUsage(); return Object.fromEntries(Object.entries(m).map(([k, v]) => [k, Math.round(v / 1048576)])); })()`), spaces: await ev(`${V8}.getHeapSpaceStatistics().filter(s => s.space_size).map(s => s.space_name.replace('_space', '') + ' ' + Math.round(s.space_used_size / 1048576) + '/' + Math.round(s.space_size / 1048576)).join(', ')`) });
await send('HeapProfiler.enable');
// SRVPROF_SNAP0=<path>: a snapshot before the window too (snapdiff.mjs compares the two).
if (process.env.SRVPROF_SNAP0) { await send('HeapProfiler.takeHeapSnapshot', { reportProgress: false }); writeFileSync(process.env.SRVPROF_SNAP0, chunks.join('')); chunks.length = 0; }
await send('HeapProfiler.startSampling', { samplingInterval: 16384, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
const t0 = Date.now();
while (Date.now() - t0 < Number(secs) * 1000) { console.log(Math.round((Date.now() - t0) / 1000) + 's', JSON.stringify(await state())); await sleep(10_000); }
const { profile } = (await send('HeapProfiler.stopSampling')).result;
const self = new Map(); let total = 0;
const walk = (n, path) => {
	const f = n.callFrame; const name = `${f.functionName || '(anon)'} ${f.url.split('/out/').pop()}:${f.lineNumber + 1}`;
	if (n.selfSize) { total += n.selfSize; const e = self.get(name) ?? { size: 0, via: new Map() }; e.size += n.selfSize; const via = path.slice(-3).join(' < '); e.via.set(via, (e.via.get(via) ?? 0) + n.selfSize); self.set(name, e); }
	for (const c of n.children ?? []) { walk(c, [...path, name]); }
};
walk(profile.head, []);
console.log(`allocated over the window: ${Math.round(total / 1048576)} MB (${(total / 1048576 / Number(secs)).toFixed(2)} MB/s)`);
for (const [name, e] of [...self].sort((a, b) => b[1].size - a[1].size).slice(0, 30)) {
	const via = [...e.via].sort((a, b) => b[1] - a[1])[0];
	console.log(`${(e.size / 1048576).toFixed(1).padStart(8)} MB  ${name}\n             via ${via?.[0]}`);
}
console.log('end', JSON.stringify(await state()));
if (snap) { await send('HeapProfiler.takeHeapSnapshot', { reportProgress: false }); writeFileSync(snap, chunks.join('')); console.log('snapshot', snap); }
ws.close();
