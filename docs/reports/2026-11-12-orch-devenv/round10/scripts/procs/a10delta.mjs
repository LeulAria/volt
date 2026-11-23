// A10 by process role: for each arm, every (A5 `launch` row, next `a10-rest-20` row) pair in data/procs/a5.jsonl:
// app medians, MB per thread ((rest-20 app - A5 app) / 15, ADEMark's formula) and the per-role change.
//   node a10delta.mjs [arm ...]
import { readFileSync } from 'fs';
import { join } from 'path';
import { DATA } from './lib.mjs';
const rows = readFileSync(join(DATA, 'a5.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
const arms = process.argv.slice(2).length ? process.argv.slice(2) : [...new Set(rows.map(r => r.arm))];
for (const arm of arms) {
	const mine = rows.filter(r => r.arm === arm);
	for (let i = 0; i < mine.length; i++) {
		const a5 = mine[i];
		const a10 = mine[i + 1];
		if (a5.variant !== 'launch' || a10?.variant !== 'a10-rest-20') { continue; }
		console.log(`\n${arm}  A5 app ${a5.appMedianMiB} (load ${a5.load.split(' ')[0]})  A10 rest-20 app ${a10.appMedianMiB} (load ${a10.load.split(' ')[0]})  per thread ${((a10.appMedianMiB - a5.appMedianMiB) / 15).toFixed(1)} MB   agents ${a5.agentsMedianMiB} -> ${a10.agentsMedianMiB}   ${a5.at.slice(11, 16)}Z`);
		const roles = [...new Set([...Object.keys(a5.byRole), ...Object.keys(a10.byRole)])];
		for (const role of roles.sort((x, y) => Math.abs((a10.byRole[y]?.mib ?? 0) - (a5.byRole[y]?.mib ?? 0)) - Math.abs((a10.byRole[x]?.mib ?? 0) - (a5.byRole[x]?.mib ?? 0)))) {
			const b = a5.byRole[role], a = a10.byRole[role];
			const d = (a?.mib ?? 0) - (b?.mib ?? 0);
			if (Math.abs(d) >= 1) { console.log(`  ${role.padEnd(48)} ${String(b?.mib ?? 0).padStart(5)} (n ${b?.n ?? 0}) -> ${String(a?.mib ?? 0).padStart(5)} (n ${a?.n ?? 0})   ${d > 0 ? '+' : ''}${d.toFixed(0)}  = ${(d / 15).toFixed(1)}/thread`); }
		}
	}
}
