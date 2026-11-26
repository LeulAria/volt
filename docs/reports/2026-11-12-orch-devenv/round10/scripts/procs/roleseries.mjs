// Round 10: one role's footprint and CPU over an A7 window, from the sampler CSV of the last A7 row of an arm
// (20 s buckets: median MB, CPU % of one core). Roles by executable path, so only main / gpu / renderer / agent
// server / helpers that have a distinct executable are told apart.
//   node roleseries.mjs <arm> [exe regex=MacOS/(Electron|VOLT)$] [row index from the end=1]
import { readFileSync } from 'fs';
import { join } from 'path';
import { DATA } from './lib.mjs';
const [arm, re = 'MacOS/(Electron|VOLT)$', back = '1'] = process.argv.slice(2);
const rows = readFileSync(join(DATA, 'a7.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l)).filter(r => r.arm === arm);
const row = rows.at(-Number(back));
const lines = readFileSync(row.csv, 'utf8').trim().split('\n').slice(1).map(l => l.split(','));
const rx = new RegExp(re);
const pids = new Map();
for (const f of lines) { if (rx.test(f[4])) { const a = pids.get(f[1]) ?? []; a.push({ t: Number(f[0]) / 1e9, mb: Number(f[5]) / 1048576, cpu: (Number(f[7]) + Number(f[8])) / 1e9 }); pids.set(f[1], a); } }
const t0 = Math.min(...lines.map(f => Number(f[0]) / 1e9));
for (const [pid, s] of pids) {
	const out = [];
	for (let b = 0; b < 9; b++) {
		const w = s.filter(x => x.t - t0 >= b * 20 && x.t - t0 < (b + 1) * 20);
		if (!w.length) { continue; }
		const mbs = w.map(x => x.mb).sort((x, y) => x - y);
		out.push(`${Math.round(mbs[mbs.length >> 1])}MB/${(((w.at(-1).cpu - w[0].cpu) / Math.max(0.25, w.at(-1).t - w[0].t)) * 100).toFixed(1)}%`);
	}
	console.log(`${arm} ${row.at.slice(11, 16)} pid ${pid}: ${out.join('  ')}`);
}
