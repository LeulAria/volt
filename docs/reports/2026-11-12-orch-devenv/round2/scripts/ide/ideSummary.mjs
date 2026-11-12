// Pick-rate table for ide.mjs runs: node ideSummary.mjs <summary.jsonl> [tag] [access]
import fs from 'node:fs';

const [file, tag, access] = process.argv.slice(2);
const rows = fs.readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line)).filter(row => (!tag || row.tag === tag) && (!access || row.access === access));
const median = values => { const v = [...values].sort((a, b) => a - b); return v.length ? (v.length % 2 ? v[(v.length - 1) / 2] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2) : NaN; };
const ids = [...new Set(rows.map(row => row.id))];
const out = ['| task | picked the IDE tool | Volt tool errors | wall s median | cost $ median | Volt tools used | shell steps median |', '|---|---|---|---|---|---|---|'];
let picked = 0;
let total = 0;
for (const id of ids) {
	const set = rows.filter(row => row.id === id);
	picked += set.filter(row => row.picked).length;
	total += set.length;
	const used = [...new Set(set.flatMap(row => row.host.map(h => h.replace(/ ERROR$/, ''))))].join(', ') || '-';
	out.push(`| ${id} | ${set.filter(row => row.picked).length}/${set.length} | ${set.reduce((a, row) => a + row.voltErrors, 0)} | ${median(set.map(row => row.wallMs / 1000)).toFixed(0)} | ${median(set.map(row => row.cost ?? 0)).toFixed(4)} | ${used} | ${median(set.map(row => row.shell.length))} |`);
}
out.push('', `Picked: ${picked}/${total}`);
console.log(out.join('\n'));
