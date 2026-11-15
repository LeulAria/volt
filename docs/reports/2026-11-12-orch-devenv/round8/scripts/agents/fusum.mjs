// Follow-up rows by arm and variant (valid rows only): median Enter -> first word painted, n, range, 1-minute loads,
// and where the agent came from.
//   node fusum.mjs [arm ...]
import { readFileSync } from 'fs';
import { join } from 'path';
import { DATA, median } from './lib.mjs';
const rows = readFileSync(join(DATA, 'followup.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l)).filter(r => !r.invalid && r.ok);
const arms = process.argv.slice(2);
const groups = new Map();
for (const r of rows.filter(r => !arms.length || arms.includes(r.arm))) {
	const key = `${r.arm} gap ${r.gapMs ?? 400}${r.reader ? ' reader' : ''}`;
	(groups.get(key) ?? groups.set(key, []).get(key)).push(r);
}
for (const [key, g] of groups) {
	const ms = g.map(r => r.firstWordMs);
	const loads = g.map(r => parseFloat(r.load));
	const src = [...new Set(g.map(r => r.trace?.agentSource))].join('/');
	console.log(`${key.padEnd(26)} median ${String(median(ms)).padStart(5)} ms  n ${g.length}  range ${Math.min(...ms)}-${Math.max(...ms)}  load ${Math.min(...loads)}-${Math.max(...loads)}  agent ${src}`);
}
