// Where two captured request bodies stop sharing a prompt-cache prefix (the API caches tools, then system,
// then messages, in that order): prints the first differing part and the text around it.
//   node prefixdiff.mjs <a.json> <b.json>
import { readFileSync } from 'fs';
const [a, b] = process.argv.slice(2).map(f => JSON.parse(readFileSync(f, 'utf8')));
const strip = x => JSON.parse(JSON.stringify(x, (k, v) => k === 'cache_control' ? undefined : v));
const parts = body => [
	...(body.tools ?? []).map((t, i) => [`tools[${i}] ${t.name}`, JSON.stringify(strip(t))]),
	...(body.system ?? []).map((s, i) => [`system[${i}]`, s.text ?? JSON.stringify(s)]),
	...(body.messages ?? []).flatMap((m, i) => (Array.isArray(m.content) ? m.content : [{ type: 'text', text: m.content }]).map((c, j) => [`messages[${i}].${m.role}[${j}]`, c.text ?? JSON.stringify(strip(c))])),
];
const pa = parts(a), pb = parts(b);
for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
	if (pa[i]?.[0] !== pb[i]?.[0] || pa[i]?.[1] !== pb[i]?.[1]) {
		const [na, ta = ''] = pa[i] ?? ['(none)'];
		const [nb, tb = ''] = pb[i] ?? ['(none)'];
		let k = 0; while (k < ta.length && ta[k] === tb[k]) { k++; }
		console.log(`first difference at part ${i}: ${na} vs ${nb}, char ${k}`);
		console.log('A:', JSON.stringify(ta.slice(Math.max(0, k - 120), k + 200)));
		console.log('B:', JSON.stringify(tb.slice(Math.max(0, k - 120), k + 200)));
		process.exit(0);
	}
}
console.log('identical prefix');
