// A5 by process role: for each valid `front` row of a6.jsonl, the median phys_footprint of each pid over the sample
// (from the row's raw CSV), summed per role (the row's own pid -> role map), then the median per arm and role.
// Rows over load 14 and rows marked `invalid` are left out, as in summarize.mjs.
//   node a5-roles.mjs [--since ISO] [--variant front|covered]
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { DATA, median } from './lib.mjs';

const args = process.argv.slice(2);
const since = args.includes('--since') ? args[args.indexOf('--since') + 1] : '';
const variant = args.includes('--variant') ? args[args.indexOf('--variant') + 1] : 'front';
const rows = readFileSync(join(DATA, 'a6.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l))
	.filter(r => r.at >= since && !r.invalid && r.variant === variant && r.loadStart <= 14);

const perArm = {};
for (const r of rows) {
	const csv = join(DATA, r.csv.replace(/^data\/idle\//, ''));
	if (!existsSync(csv)) {
		continue;
	}
	const roleOf = new Map(r.procs.map(p => [String(p.pid), p.role]));
	const byPid = new Map();
	const lines = readFileSync(csv, 'utf8').trim().split('\n');
	const head = lines[0].split(',');
	const iPid = head.indexOf('pid'), iGroup = head.indexOf('group'), iFoot = head.indexOf('phys_footprint_b');
	for (const line of lines.slice(1)) {
		const f = line.split(',');
		if (f[iGroup] !== 'app') {
			continue;
		}
		(byPid.get(f[iPid]) ?? byPid.set(f[iPid], []).get(f[iPid])).push(Number(f[iFoot]));
	}
	const byRole = {};
	for (const [pid, values] of byPid) {
		const role = roleOf.get(pid) ?? 'other';
		byRole[role] = (byRole[role] ?? 0) + median(values) / 1048576;
	}
	const arm = perArm[r.arm] ??= {};
	for (const [role, mib] of Object.entries(byRole)) {
		(arm[role] ??= []).push(mib);
	}
	(arm['= app total'] ??= []).push(Object.values(byRole).reduce((a, b) => a + b, 0));
}

for (const [arm, roles] of Object.entries(perArm)) {
	console.log(`## ${arm} (${variant})`);
	for (const [role, values] of Object.entries(roles).sort((a, b) => median(b[1]) - median(a[1]))) {
		console.log(`${role.padEnd(20)} median ${Math.round(median(values))} MiB, n=${values.length}, range ${Math.round(Math.min(...values))}-${Math.round(Math.max(...values))}`);
	}
}
