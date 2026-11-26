// Parents of sliced strings (big strings kept alive by a substring of them): grouped by their first 50 chars, with
// who holds the slices (2 retainer steps).   node slices.mjs <file.heapsnapshot>
import { readFileSync } from 'fs';
const s = JSON.parse(readFileSync(process.argv[2], 'utf8')); const m = s.snapshot.meta; const nf = m.node_fields, ef = m.edge_fields; const N = nf.length, E = ef.length;
const types = m.node_types[0], etypes = m.edge_types[0];
const iT = nf.indexOf('type'), iN = nf.indexOf('name'), iS = nf.indexOf('self_size'), iE = nf.indexOf('edge_count');
const eT = ef.indexOf('type'), eN = ef.indexOf('name_or_index'), eTo = ef.indexOf('to_node');
const count = s.nodes.length / N;
const rev = new Map(); const parentOf = new Map();
let edge = 0;
for (let n = 0; n < count; n++) { const ec = s.nodes[n * N + iE]; const t = types[s.nodes[n * N + iT]]; for (let k = 0; k < ec; k++, edge += E) { const to = s.edges[edge + eTo] / N; const et = etypes[s.edges[edge + eT]]; const en = et === 'element' || et === 'hidden' ? `[${s.edges[edge + eN]}]` : String(s.strings[s.edges[edge + eN]]); if (t === 'sliced string' && en === 'parent') parentOf.set(n, to); if (et !== 'weak') { (rev.get(to) ?? rev.set(to, []).get(to)).push([n, en]); } } }
const label = n => `${types[s.nodes[n * N + iT]]}:${String(s.strings[s.nodes[n * N + iN]]).slice(0, 40).replace(/\s+/g, ' ')}`;
const groups = new Map(); const seen = new Set();
for (const [slice, parent] of parentOf) {
	const holder = (rev.get(slice) ?? []).map(([f, e]) => { const up = (rev.get(f) ?? [])[0]; return `${e}<-${label(f)}${up ? `  ${up[1]}<-${label(up[0])}` : ''}`; })[0] ?? '?';
	const key = String(s.strings[s.nodes[parent * N + iN]]).slice(0, 50).replace(/\s+/g, ' ') + ' || ' + holder;
	const g = groups.get(key) ?? { slices: 0, parents: 0, size: 0 }; g.slices++;
	if (!seen.has(parent)) { seen.add(parent); g.parents++; g.size += s.nodes[parent * N + iS]; }
	groups.set(key, g);
}
for (const [k, g] of [...groups].sort((a, b) => b[1].size - a[1].size).slice(0, 15)) console.log((g.size / 1048576).toFixed(2).padStart(6), 'MiB parents', g.parents, 'slices', g.slices, '|', k.slice(0, 300));
