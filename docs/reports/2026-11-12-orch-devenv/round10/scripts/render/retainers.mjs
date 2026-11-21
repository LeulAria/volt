// Retainer chains (up to depth) of the sliced strings whose parent text starts with a prefix, in a saved snapshot.
//   node retainers.mjs <file.heapsnapshot> <prefix> [depth=6]
import { readFileSync } from 'fs';
const [file, prefix, depthArg] = process.argv.slice(2); const depth = Number(depthArg ?? 6);
const s = JSON.parse(readFileSync(file, 'utf8')); const m = s.snapshot.meta; const nf = m.node_fields, ef = m.edge_fields; const N = nf.length, E = ef.length;
const types = m.node_types[0], etypes = m.edge_types[0];
const iT = nf.indexOf('type'), iN = nf.indexOf('name'), iS = nf.indexOf('self_size'), iE = nf.indexOf('edge_count');
const eT = ef.indexOf('type'), eN = ef.indexOf('name_or_index'), eTo = ef.indexOf('to_node');
const count = s.nodes.length / N;
const rev = Array.from({ length: count }, () => null);
let edge = 0;
for (let n = 0; n < count; n++) { const ec = s.nodes[n * N + iE]; for (let k = 0; k < ec; k++, edge += E) { const to = s.edges[edge + eTo] / N; const et = etypes[s.edges[edge + eT]]; if (et === 'weak') continue; const en = et === 'element' || et === 'hidden' ? `[${s.edges[edge + eN]}]` : String(s.strings[s.edges[edge + eN]]); (rev[to] ??= []).push([n, en]); } }
const label = n => `${types[s.nodes[n * N + iT]]}:${String(s.strings[s.nodes[n * N + iN]]).slice(0, 50).replace(/\s+/g, ' ')}`;
// parents with the prefix
const parents = []; for (let n = 0; n < count; n++) { if (/string/.test(types[s.nodes[n * N + iT]]) && String(s.strings[s.nodes[n * N + iN]]).startsWith(prefix)) parents.push(n); }
console.log('strings with prefix', parents.length, 'total MiB', (parents.reduce((a, n) => a + s.nodes[n * N + iS], 0) / 1048576).toFixed(2));
const chains = new Map();
for (const p of parents.slice(0, 400)) {
	let cur = p; const parts = [];
	for (let d = 0; d < depth; d++) { const r = rev[cur]?.find(([from]) => !/synthetic/.test(label(from))); if (!r) break; parts.push(`${r[1]}<-${label(r[0])}`); cur = r[0]; }
	const k = parts.join('  '); chains.set(k, (chains.get(k) ?? 0) + 1);
}
for (const [k, n] of [...chains].sort((a, b) => b[1] - a[1]).slice(0, 8)) console.log(n, k.slice(0, 900), '\n');
