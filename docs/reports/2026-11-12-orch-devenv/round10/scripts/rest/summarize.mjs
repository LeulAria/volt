// Summary of ../../data/rest/rest.jsonl (and floor.jsonl): per arm, A5 at rest (front rows' app median), A6 front and
// covered (CPU %, wakeups/s), A10 (each front row paired with the next rest-20 row of the same arm), per role medians.
// Rows over the load gate (calm:false or load > MAX, default 14) are listed apart, not in the medians.
//   node summarize.mjs [--all] [arm ...]      (--all: no load gate, for memory-only reading)
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { DATA } from './lib.mjs';
const args = process.argv.slice(2);
const all = args.includes('--all');
const want = args.filter(a => !a.startsWith('--'));
const read = f => existsSync(join(DATA, f)) ? readFileSync(join(DATA, f), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
const rows = read('rest.jsonl');
const MAX = Number(process.env.WEIGHT_MAX_LOAD ?? 14);
const load1 = r => parseFloat(r.load);
const ok = r => all || (r.calm !== false && load1(r) <= MAX && Math.max(load1(r), parseFloat(r.loadEnd ?? r.load)) <= MAX * 1.5);
const med = a => { const s = a.filter(v => typeof v === 'number' && !Number.isNaN(v)).sort((x, y) => x - y); if (!s.length) { return undefined; } const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const fmt = (a, d = 0) => { const v = a.filter(x => typeof x === 'number'); if (!v.length) { return 'no rows'; } return `${med(v).toFixed(d)} (n ${v.length}; ${Math.min(...v).toFixed(d)}-${Math.max(...v).toFixed(d)})`; };
const loads = rs => rs.length ? `load ${Math.min(...rs.map(load1)).toFixed(1)}-${Math.max(...rs.map(load1)).toFixed(1)}` : '';
for (const arm of want.length ? want : [...new Set(rows.map(r => r.arm))]) {
	const mine = rows.filter(r => r.arm === arm);
	const front = mine.filter(r => r.variant === 'front' && ok(r));
	const covered = mine.filter(r => r.variant === 'covered' && ok(r) && r.cover && !r.cover.error);
	const pairs = [];
	for (let i = 0; i < mine.length; i++) {
		if (mine[i].variant !== 'front') { continue; }
		const next = mine.slice(i + 1).find(r => r.variant === 'rest-20' || r.variant === 'front');
		if (next?.variant === 'rest-20' && (all || (ok(mine[i]) && ok(next)))) { pairs.push([mine[i], next]); }
	}
	console.log(`\n== ${arm}${all ? ' (no load gate)' : ''}: ${mine.length} rows, ${mine.filter(r => !ok(r)).length} over the gate`);
	console.log(`A5 at rest, app MiB        ${fmt(front.map(r => r.appMedianMiB), 1)}  ${loads(front)}  on screen ${front.filter(r => r.onScreen).length}/${front.length}`);
	console.log(`A6 front, CPU %            ${fmt(front.map(r => r.cpuAppPct), 3)}   wakeups/s ${fmt(front.map(r => r.wakeupsApp), 1)}`);
	console.log(`A6 covered, CPU %          ${fmt(covered.map(r => r.cpuAppPct), 3)}   wakeups/s ${fmt(covered.map(r => r.wakeupsApp), 1)}  ${loads(covered)}`);
	console.log(`A10 per thread, MB         ${fmt(pairs.map(([a, b]) => (b.appMedianMiB - a.appMedianMiB) / 15), 2)}   rest-20 app ${fmt(pairs.map(([, b]) => b.appMedianMiB), 1)}`);
	const roles = [...new Set(front.flatMap(r => Object.keys(r.byRole)))];
	console.log('role                                              A5 MiB              CPU % front        wakeups/s     A10 MB/thread');
	for (const role of roles.sort((x, y) => (med(front.map(r => r.byRole[y]?.mib ?? 0)) ?? 0) - (med(front.map(r => r.byRole[x]?.mib ?? 0)) ?? 0))) {
		const col = (k, d) => fmt(front.map(r => r.byRole[role]?.[k] ?? 0), d);
		const per = pairs.map(([a, b]) => ((b.byRole[role]?.mib ?? 0) - (a.byRole[role]?.mib ?? 0)) / 15);
		console.log(`${role.padEnd(48)}  ${col('mib', 1).padEnd(26)} ${col('cpuPct', 3).padEnd(28)} ${String(med(front.map(r => r.byRole[role]?.wakeups ?? 0))?.toFixed(1)).padEnd(8)} ${per.length ? med(per).toFixed(2) : ''}`);
	}
}
const floor = read('floor.jsonl').filter(r => all || r.calm !== false);
for (const page of [...new Set(floor.map(r => r.page))]) {
	const f = floor.filter(r => r.page === page);
	console.log(`\n== floor (empty Electron window, page ${page}): app MiB ${fmt(f.map(r => r.appMedianMiB), 1)}  CPU % ${fmt(f.map(r => r.cpuAppPct), 3)}  wakeups/s ${fmt(f.map(r => r.wakeupsApp), 1)}  ${loads(f)}`);
	for (const role of [...new Set(f.flatMap(r => Object.keys(r.byRole)))]) { console.log(`   ${role.padEnd(20)} ${fmt(f.map(r => r.byRole[role]?.mib ?? 0), 1)} MiB   cpu ${fmt(f.map(r => r.byRole[role]?.cpuPct ?? 0), 3)}   wk ${fmt(f.map(r => r.byRole[role]?.wakeups ?? 0), 1)}`); }
}
