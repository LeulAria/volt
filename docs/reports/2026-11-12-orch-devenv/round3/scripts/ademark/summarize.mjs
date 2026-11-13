// Medians (n, range) per app and test from run.ts rows; rows taken while the load gate failed are counted apart.
//   node summarize.mjs <out dir with <app>/rows.jsonl> [--json file]
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2];
const jsonOut = process.argv.includes('--json') ? process.argv[process.argv.indexOf('--json') + 1] : undefined;
const FIELDS = { A1: ['window_ms', 'ready_ms'], A2: ['window_ms', 'ready_ms'], A3: ['ready_ms'], A4: ['total_ms', 'before_request_ms', 'on_screen_ms'], A5: ['app_mb', 'agents_mb', 'total_mb'], A6: ['cpu_pct_front', 'cpu_pct_total', 'wakeups_per_s'], A8: ['p50', 'p95', 'max'], A11: ['open_visible_ms', 'settled_ms'] };
const med = xs => { const s = [...xs].sort((a, b) => a - b); const n = s.length; return n ? (n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2) : null; };
const LIMIT = Number(process.env.ADE_LOAD_MAX ?? 14);
const endLoad = r => Number(/load averages?: ([\d.]+)/.exec(r.uptime ?? '')?.[1] ?? NaN);
const isClean = r => !!r.load_gate?.ok && r.load_gate.load1 <= LIMIT && endLoad(r) <= LIMIT;
const out = {};
for (const app of readdirSync(dir)) {
	const f = join(dir, app, 'rows.jsonl');
	if (!existsSync(f)) { continue; }
	const rows = readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
	for (const [test, fields] of Object.entries(FIELDS)) {
		const rs = rows.filter(r => r.test === test && !r.error && r.skipped !== 'load'); // `skipped` is also the count of probe keys not sent
		if (!rs.length) { continue; }
		for (const field of fields) {
			const vals = rs.filter(r => typeof r[field] === 'number');
			if (!vals.length) { out[`${app} ${test} ${field}`] = { n: 0, missing: rs.length }; continue; }
			const xs = vals.map(r => r[field]);
			// Clean: the 1-minute load was at most 14 when the test started (the gate) and when its row was written (`uptime`).
			const cleanRows = vals.filter(isClean);
			const clean = cleanRows.map(r => r[field]);
			const loads = vals.map(r => r.load_gate?.load1).filter(x => typeof x === 'number');
			// Load per clean sample: the 1-minute load at the test's start and when its row was written.
			const cleanLoads = cleanRows.flatMap(r => [r.load_gate.load1, endLoad(r)]);
			out[`${app} ${test} ${field}`] = {
				median: med(xs), n: xs.length, min: Math.min(...xs), max: Math.max(...xs),
				missing: rs.length - vals.length, under_load: vals.length - clean.length,
				median_clean: clean.length ? med(clean) : null, n_clean: clean.length,
				min_clean: clean.length ? Math.min(...clean) : null, max_clean: clean.length ? Math.max(...clean) : null,
				load1_clean_min: cleanLoads.length ? Math.min(...cleanLoads) : null, load1_clean_max: cleanLoads.length ? Math.max(...cleanLoads) : null,
				load1_median: med(loads),
			};
		}
	}
}
const fmt = x => x === null || x === undefined ? '-' : Math.abs(x) >= 100 ? x.toFixed(0) : x.toFixed(1);
for (const [k, v] of Object.entries(out)) {
	console.log(k.padEnd(34), v.n ? `median ${fmt(v.median)} (n ${v.n}, ${fmt(v.min)}-${fmt(v.max)}), under load ${v.under_load}, load1 median ${fmt(v.load1_median)}${v.missing ? `, missing ${v.missing}` : ''}${v.n_clean ? `, clean median ${fmt(v.median_clean)} (n ${v.n_clean}, ${fmt(v.min_clean)}-${fmt(v.max_clean)}, load ${fmt(v.load1_clean_min)}-${fmt(v.load1_clean_max)})` : ''}`: `no value in ${v.missing} rows`);
}
if (jsonOut) { writeFileSync(jsonOut, JSON.stringify(out, null, 1)); }
