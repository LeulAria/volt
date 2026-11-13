// node summarize.mjs <file.jsonl> <field> [groupField=arm]   median, range and N per arm
import { readFileSync } from 'fs';
const [file, field, group = 'arm'] = process.argv.slice(2);
const rows = readFileSync(file, 'utf8').trim().split('\n').map(l => JSON.parse(l));
const get = (r, path) => path.split('.').reduce((o, k) => o?.[k], r);
const by = {};
for (const r of rows) { const v = get(r, field); if (typeof v === 'number') { (by[r[group]] ??= []).push(v); } }
for (const [k, v] of Object.entries(by)) {
	const s = [...v].sort((a, b) => a - b);
	const med = s.length % 2 ? s[s.length >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
	console.log(`${k.padEnd(14)} n=${s.length} median=${Math.round(med)} range=${Math.round(s[0])}-${Math.round(s.at(-1))}`);
}
