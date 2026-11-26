// Renderer heap strings grouped: by length bucket, and by (retainer edge <- retainer object) for the biggest groups,
// with a sample. Exploratory.   node heapstrings.mjs [out.heapsnapshot]
import { writeFileSync } from 'fs';
import { PORT } from './lib.mjs';
const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
const pick = list.find(t => t.type === 'page' && /workbench/.test(t.url) && t.title);
const ws = new WebSocket(pick.webSocketDebuggerUrl, { perMessageDeflate: false });
await new Promise(r => ws.addEventListener('open', r, { once: true }));
let id = 0; const pending = new Map(); const chunks = [];
ws.addEventListener('message', e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } else if (m.method === 'HeapProfiler.addHeapSnapshotChunk') { chunks.push(m.params.chunk); } });
const send = (method, params = {}) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
await send('HeapProfiler.enable'); await send('HeapProfiler.collectGarbage');
await send('HeapProfiler.takeHeapSnapshot', { reportProgress: false }); ws.close();
const text = chunks.join(''); if (process.argv[2]) { writeFileSync(process.argv[2], text); }
const s = JSON.parse(text); const m = s.snapshot.meta; const nf = m.node_fields, ef = m.edge_fields; const N = nf.length, E = ef.length;
const types = m.node_types[0], etypes = m.edge_types[0];
const iT = nf.indexOf('type'), iN = nf.indexOf('name'), iS = nf.indexOf('self_size'), iE = nf.indexOf('edge_count');
const eT = ef.indexOf('type'), eN = ef.indexOf('name_or_index'), eTo = ef.indexOf('to_node');
const count = s.nodes.length / N;
const isStr = new Uint8Array(count); let strTotal = 0; const buckets = {};
for (let n = 0; n < count; n++) { const t = types[s.nodes[n * N + iT]]; if (/string/.test(t)) { isStr[n] = 1; const sz = s.nodes[n * N + iS]; strTotal += sz; const b = sz < 64 ? '<64' : sz < 256 ? '<256' : sz < 1024 ? '<1K' : sz < 16384 ? '<16K' : sz < 262144 ? '<256K' : '>=256K'; const e = buckets[b] ??= { n: 0, size: 0 }; e.n++; e.size += sz; } }
console.log('strings MiB', (strTotal / 1048576).toFixed(1), JSON.stringify(Object.fromEntries(Object.entries(buckets).map(([k, v]) => [k, `${v.n} / ${(v.size / 1048576).toFixed(1)} MiB`]))));
// First retainer of each string >= 256 B: group by retainer (type:name) and edge name.
const groups = new Map();
let edge = 0;
for (let n = 0; n < count; n++) {
	const ec = s.nodes[n * N + iE]; const from = `${types[s.nodes[n * N + iT]]}:${String(s.strings[s.nodes[n * N + iN]]).slice(0, 40)}`;
	for (let k = 0; k < ec; k++, edge += E) {
		const to = s.edges[edge + eTo] / N; if (!isStr[to]) { continue; }
		const sz = s.nodes[to * N + iS]; if (sz < 256) { continue; }
		isStr[to] = 2;
		const et = etypes[s.edges[edge + eT]]; const en = et === 'element' || et === 'hidden' ? `[${et}]` : String(s.strings[s.edges[edge + eN]]);
		const key = `${from} .${en}`; const g = groups.get(key) ?? { n: 0, size: 0, sample: '' };
		g.n++; g.size += sz; if (!g.sample) { g.sample = String(s.strings[s.nodes[to * N + iN]]).slice(0, 80).replace(/\s+/g, ' '); }
		groups.set(key, g);
	}
}
for (const [k, g] of [...groups].sort((a, b) => b[1].size - a[1].size).slice(0, 25)) { console.log((g.size / 1048576).toFixed(2).padStart(7), 'MiB', String(g.n).padStart(7), k.slice(0, 70).padEnd(70), '|', g.sample); }
process.exit(0);
