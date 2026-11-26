// Retainer path (depth 10) of the Map whose table holds the most sliced strings.   node mapowner.mjs <file.heapsnapshot>
import { readFileSync } from 'fs';
const s = JSON.parse(readFileSync(process.argv[2], 'utf8')); const m = s.snapshot.meta; const nf = m.node_fields, ef = m.edge_fields; const N = nf.length, E = ef.length;
const types = m.node_types[0], etypes = m.edge_types[0];
const iT = nf.indexOf('type'), iN = nf.indexOf('name'), iE = nf.indexOf('edge_count'), iS = nf.indexOf('self_size');
const eT = ef.indexOf('type'), eN = ef.indexOf('name_or_index'), eTo = ef.indexOf('to_node');
const count = s.nodes.length / N; const rev = new Map(); const out = new Map();
let edge = 0;
for (let n = 0; n < count; n++) { const ec = s.nodes[n * N + iE]; for (let k = 0; k < ec; k++, edge += E) { const to = s.edges[edge + eTo] / N; const et = etypes[s.edges[edge + eT]]; const en = et === 'element' || et === 'hidden' ? `[${s.edges[edge + eN]}]` : String(s.strings[s.edges[edge + eN]]); (out.get(n) ?? out.set(n, []).get(n)).push([to, en, et]); if (et !== 'weak') (rev.get(to) ?? rev.set(to, []).get(to)).push([n, en]); } }
const T = n => types[s.nodes[n * N + iT]]; const label = n => `${T(n)}:${String(s.strings[s.nodes[n * N + iN]]).slice(0, 60).replace(/\s+/g, ' ')}`;
let best, bestN = 0;
for (let n = 0; n < count; n++) { if (T(n) !== 'array') continue; const c = (out.get(n) ?? []).filter(([to]) => T(to) === 'sliced string').length; if (c > bestN) { bestN = c; best = n; } }
console.log('table with', bestN, 'sliced strings; table entries:', (out.get(best) ?? []).length);
// sample of the table's entries: key and value types
console.log((out.get(best) ?? []).slice(0, 9).map(([to, en]) => `${en}=${label(to)}`).join('\n'));
let cur = best;
for (let d = 0; d < 12; d++) { const r = (rev.get(cur) ?? []).find(([f]) => T(f) !== 'synthetic'); if (!r) break; console.log('  <-', r[1], label(r[0])); cur = r[0]; }
