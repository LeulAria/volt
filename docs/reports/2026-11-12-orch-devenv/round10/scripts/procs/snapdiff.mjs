// Round 10: what grew between two V8 heap snapshots, by constructor (self size and count) and the largest new
// strings; with one file, that snapshot's own summary. Snapshots are big: delete them afterwards.
//   node snapdiff.mjs <before.heapsnapshot> [after.heapsnapshot] [top=40]
import { readFileSync } from 'node:fs';
const [a, b, topArg = '40'] = process.argv.slice(2);
function summary(file) {
	const snap = JSON.parse(readFileSync(file, 'utf8'));
	const meta = snap.snapshot.meta, nf = meta.node_fields, types = meta.node_types[0], N = nf.length;
	const iType = nf.indexOf('type'), iName = nf.indexOf('name'), iSelf = nf.indexOf('self_size');
	const by = new Map(); const strings = new Map(); let total = 0;
	for (let i = 0; i < snap.nodes.length; i += N) {
		const type = types[snap.nodes[i + iType]], name = snap.strings[snap.nodes[i + iName]], self = snap.nodes[i + iSelf];
		total += self;
		const key = type === 'object' || type === 'closure' ? `${type}:${name}` : type;
		const e = by.get(key) ?? { n: 0, size: 0 }; e.n++; e.size += self; by.set(key, e);
		if ((type === 'string' || type === 'concatenated string' || type === 'sliced string') && self > 20_000) { const k = name.slice(0, 90).replace(/\s+/g, ' '); const s = strings.get(k) ?? { n: 0, size: 0 }; s.n++; s.size += self; strings.set(k, s); }
	}
	return { by, strings, total };
}
const A = summary(a), B = b ? summary(b) : undefined;
const mb = n => (n / 1048576).toFixed(1).padStart(7);
if (!B) {
	console.log(`total ${mb(A.total)} MB`);
	for (const [k, v] of [...A.by].sort((x, y) => y[1].size - x[1].size).slice(0, Number(topArg))) { console.log(mb(v.size), 'MB', String(v.n).padStart(8), k.slice(0, 90)); }
	console.log('-- strings over 20 KB'); for (const [k, v] of [...A.strings].sort((x, y) => y[1].size - x[1].size).slice(0, 25)) { console.log(mb(v.size), 'MB', String(v.n).padStart(4), k); }
} else {
	console.log(`total ${mb(A.total)} -> ${mb(B.total)} MB`);
	const keys = new Set([...A.by.keys(), ...B.by.keys()]);
	const d = [...keys].map(k => [k, (B.by.get(k)?.size ?? 0) - (A.by.get(k)?.size ?? 0), (B.by.get(k)?.n ?? 0) - (A.by.get(k)?.n ?? 0)]).sort((x, y) => Math.abs(y[1]) - Math.abs(x[1]));
	for (const [k, size, n] of d.slice(0, Number(topArg))) { console.log(mb(size), 'MB', String(n).padStart(8), k.slice(0, 90)); }
	console.log('-- strings over 20 KB that grew');
	const sk = new Set([...A.strings.keys(), ...B.strings.keys()]);
	for (const [k, size, n] of [...sk].map(k => [k, (B.strings.get(k)?.size ?? 0) - (A.strings.get(k)?.size ?? 0), (B.strings.get(k)?.n ?? 0) - (A.strings.get(k)?.n ?? 0)]).sort((x, y) => y[1] - x[1]).slice(0, 25)) { console.log(mb(size), 'MB', String(n).padStart(4), k); }
}
