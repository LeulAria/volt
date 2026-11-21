// A saved heap snapshot's largest ArrayBuffer backing stores (native "system / JSArrayBufferData") with a
// retainer chain each (BFS up, depth 8). Exploratory.   node heapbuffers.mjs <file.heapsnapshot> [min KiB=256]
import { readFileSync } from 'fs';
const s = JSON.parse(readFileSync(process.argv[2], 'utf8')); const min = Number(process.argv[3] ?? 256) * 1024;
const m = s.snapshot.meta; const nf = m.node_fields, ef = m.edge_fields; const N = nf.length, E = ef.length;
const types = m.node_types[0], etypes = m.edge_types[0];
const iT = nf.indexOf('type'), iN = nf.indexOf('name'), iS = nf.indexOf('self_size'), iE = nf.indexOf('edge_count');
const eT = ef.indexOf('type'), eN = ef.indexOf('name_or_index'), eTo = ef.indexOf('to_node');
const count = s.nodes.length / N; const name = n => String(s.strings[s.nodes[n * N + iN]]); const type = n => types[s.nodes[n * N + iT]];
const want = (process.argv[4] ?? 'system / JSArrayBufferData');
const targets = []; for (let n = 0; n < count; n++) { if (name(n) === want && s.nodes[n * N + iS] >= min) { targets.push(n); } }
const first = new Int32Array(count).fill(-1), via = new Array(count); let edge = 0;
// first non-weak retainer of every node
const firstEdge = new Uint32Array(count + 1); { let e = 0; for (let n = 0; n < count; n++) { firstEdge[n] = e; e += s.nodes[n * N + iE]; } firstEdge[count] = e; }
const retainers = new Map(targets.map(t => [t, []]));
const need = new Set(targets);
for (let depth = 0; depth < 9 && need.size; depth++) {
	const found = new Map();
	for (let n = 0; n < count; n++) {
		for (let k = firstEdge[n]; k < firstEdge[n + 1]; k++) {
			const to = s.edges[k * E + eTo] / N; if (!need.has(to) || found.has(to) || to === n) { continue; }
			const et = etypes[s.edges[k * E + eT]]; if (et === 'weak' || et === 'shortcut') { continue; }
			const en = et === 'element' || et === 'hidden' ? `[${s.edges[k * E + eN]}]` : String(s.strings[s.edges[k * E + eN]]);
			found.set(to, [n, en]);
		}
	}
	need.clear();
	for (const [to, [n, en]] of found) { first[to] = n; via[to] = en; if (first[n] === -1 && type(n) !== 'synthetic') { need.add(n); } }
}
for (const t of targets.sort((a, b) => s.nodes[b * N + iS] - s.nodes[a * N + iS])) {
	let chain = '', n = t; for (let d = 0; d < 9 && first[n] >= 0; d++) { chain += ` <- .${String(via[n]).slice(0, 30)} ${type(first[n])}:${name(first[n]).slice(0, 36)}`; n = first[n]; }
	console.log((s.nodes[t * N + iS] / 1048576).toFixed(2).padStart(7), 'MiB', chain);
}
