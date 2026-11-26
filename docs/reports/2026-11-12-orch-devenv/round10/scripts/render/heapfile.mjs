// A saved renderer heap snapshot, offline: self size by node type; strings by length bucket and by first retainer
// (type:name .edge); native (Blink) nodes by name; the largest strings. Exploratory.
//   node heapfile.mjs <file.heapsnapshot> [top=25]
import { readFileSync } from 'fs';
const s = JSON.parse(readFileSync(process.argv[2], 'utf8')); const top = Number(process.argv[3] ?? 25);
const m = s.snapshot.meta; const nf = m.node_fields, ef = m.edge_fields; const N = nf.length, E = ef.length;
const types = m.node_types[0], etypes = m.edge_types[0];
const iT = nf.indexOf('type'), iN = nf.indexOf('name'), iS = nf.indexOf('self_size'), iE = nf.indexOf('edge_count');
const eT = ef.indexOf('type'), eN = ef.indexOf('name_or_index'), eTo = ef.indexOf('to_node');
const count = s.nodes.length / N; const mb = b => (b / 1048576).toFixed(2).padStart(7);
const byType = {}; const native = new Map(); const isStr = new Uint8Array(count); const buckets = {}; const big = [];
for (let n = 0; n < count; n++) {
	const t = types[s.nodes[n * N + iT]]; const sz = s.nodes[n * N + iS]; const e = byType[t] ??= { n: 0, size: 0 }; e.n++; e.size += sz;
	if (t === 'native') { const k = String(s.strings[s.nodes[n * N + iN]]).replace(/\d{3,}/g, '#').slice(0, 50); const g = native.get(k) ?? { n: 0, size: 0 }; g.n++; g.size += sz; native.set(k, g); }
	if (/string/.test(t)) { isStr[n] = 1; const b = sz < 64 ? '<64' : sz < 256 ? '<256' : sz < 1024 ? '<1K' : sz < 16384 ? '<16K' : sz < 262144 ? '<256K' : '>=256K'; const g = buckets[b] ??= { n: 0, size: 0 }; g.n++; g.size += sz; if (sz >= 65536) { big.push([sz, String(s.strings[s.nodes[n * N + iN]]).slice(0, 90).replace(/\s+/g, ' ')]); } }
}
console.log('-- by type'); for (const [k, v] of Object.entries(byType).sort((a, b) => b[1].size - a[1].size)) { console.log(mb(v.size), 'MiB', String(v.n).padStart(8), k); }
console.log('-- strings by size', JSON.stringify(Object.fromEntries(Object.entries(buckets).map(([k, v]) => [k, `${v.n} / ${(v.size / 1048576).toFixed(1)} MiB`]))));
console.log('-- native by name'); for (const [k, v] of [...native].sort((a, b) => b[1].size - a[1].size).slice(0, top)) { console.log(mb(v.size), 'MiB', String(v.n).padStart(8), k); }
const groups = new Map(); let edge = 0;
for (let n = 0; n < count; n++) {
	const ec = s.nodes[n * N + iE]; const from = `${types[s.nodes[n * N + iT]]}:${String(s.strings[s.nodes[n * N + iN]]).slice(0, 40)}`;
	for (let k = 0; k < ec; k++, edge += E) {
		const to = s.edges[edge + eTo] / N; if (isStr[to] !== 1) { continue; }
		const sz = s.nodes[to * N + iS]; if (sz < 256) { continue; }
		isStr[to] = 2; const et = etypes[s.edges[edge + eT]]; const en = et === 'element' || et === 'hidden' ? `[${et}]` : String(s.strings[s.edges[edge + eN]]);
		const key = `${from} .${en}`; const g = groups.get(key) ?? { n: 0, size: 0, sample: '' }; g.n++; g.size += sz;
		if (!g.sample) { g.sample = String(s.strings[s.nodes[to * N + iN]]).slice(0, 70).replace(/\s+/g, ' '); } groups.set(key, g);
	}
}
console.log('-- strings >= 256 B by first retainer'); for (const [k, g] of [...groups].sort((a, b) => b[1].size - a[1].size).slice(0, top)) { console.log(mb(g.size), 'MiB', String(g.n).padStart(7), k.slice(0, 64).padEnd(64), '|', g.sample); }
console.log('-- largest strings'); for (const [sz, t] of big.sort((a, b) => b[0] - a[0]).slice(0, 15)) { console.log(mb(sz), 'MiB', t); }
