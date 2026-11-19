// V8 heap of one process over a CDP/inspector websocket: heap usage, then a heap snapshot summarized by
// constructor (self size and count) and by the largest strings / code. For finding what a process keeps at rest.
//   node heapsummary.mjs <ws url | http://127.0.0.1:<port> (first target)> [out.heapsnapshot] [top=40]
import { writeFileSync } from 'fs';

const [target, out, topArg] = process.argv.slice(2);
const top = Number(topArg ?? 40);
let wsUrl = target;
if (/^http/.test(target)) {
	const list = await (await fetch(`${target}/json`)).json();
	const pick = list.find(t => t.type === 'page' && /workbench/.test(t.url) && t.title) ?? list.find(t => t.type === 'node') ?? list[0];
	wsUrl = pick.webSocketDebuggerUrl;
}
const ws = new WebSocket(wsUrl, { perMessageDeflate: false });
await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', rej, { once: true }); });
let id = 0;
const pending = new Map();
const chunks = [];
ws.addEventListener('message', e => {
	const m = JSON.parse(e.data);
	if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
	else if (m.method === 'HeapProfiler.addHeapSnapshotChunk') { chunks.push(m.params.chunk); }
});
const send = (method, params = {}) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
await send('HeapProfiler.enable');
await send('HeapProfiler.collectGarbage');
const usage = (await send('Runtime.getHeapUsage')).result;
await send('HeapProfiler.takeHeapSnapshot', { reportProgress: false });
ws.close();
const text = chunks.join('');
if (out) { writeFileSync(out, text); }
const snap = JSON.parse(text);
const meta = snap.snapshot.meta;
const nf = meta.node_fields;
const types = meta.node_types[0];
const N = nf.length;
const iType = nf.indexOf('type'), iName = nf.indexOf('name'), iSelf = nf.indexOf('self_size');
const byCtor = new Map();
const strings = [];
let total = 0;
for (let i = 0; i < snap.nodes.length; i += N) {
	const type = types[snap.nodes[i + iType]];
	const name = snap.strings[snap.nodes[i + iName]];
	const self = snap.nodes[i + iSelf];
	total += self;
	const key = type === 'object' || type === 'closure' ? `${type}:${name}` : type;
	const e = byCtor.get(key) ?? { n: 0, size: 0 };
	e.n++; e.size += self;
	byCtor.set(key, e);
	if ((type === 'string' || type === 'concatenated string') && self > 200_000) { strings.push([self, name.slice(0, 100).replace(/\s+/g, ' ')]); }
}
console.log(`heap used ${Math.round(usage.usedSize / 1048576)} MiB of ${Math.round(usage.totalSize / 1048576)} MiB; snapshot self total ${Math.round(total / 1048576)} MiB`);
for (const [k, v] of [...byCtor].sort((a, b) => b[1].size - a[1].size).slice(0, top)) {
	console.log(String((v.size / 1048576).toFixed(1)).padStart(7), 'MiB', String(v.n).padStart(8), k.slice(0, 90));
}
console.log('-- large strings');
for (const [s, t] of strings.sort((a, b) => b[0] - a[0]).slice(0, 15)) { console.log(String((s / 1048576).toFixed(2)).padStart(7), 'MiB', t); }
