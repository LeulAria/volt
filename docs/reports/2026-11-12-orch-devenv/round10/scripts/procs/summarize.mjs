// Before/after table of the weight rig: medians (n, range) per arm, excluded rows dropped (data/procs/excluded.json).
// A10 mb-per-thread pairs each a10-rest-20 row with the A5 `launch` row just before it on the same arm (one block).
//   node summarize.mjs [maxLoad] [beforeArm=before] [afterArm=after]   (rows over maxLoad, by their 1-minute load, are listed apart)
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { DATA } from './lib.mjs';

const maxLoad = Number(process.argv[2] ?? Infinity);
const [B, A] = [process.argv[3] ?? 'before', process.argv[4] ?? 'after'];
const excluded = existsSync(join(DATA, 'excluded.json')) ? JSON.parse(readFileSync(join(DATA, 'excluded.json'), 'utf8')) : {};
const read = file => existsSync(join(DATA, file)) ? readFileSync(join(DATA, file), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(r => !(excluded[file] ?? {})[r.at]) : [];
const load1 = r => Number(String(r.load).split(/\s+/)[0]);
const med = a => { const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length ? (s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2) : null; };
const cell = a => a.length ? `${Math.round(med(a) * 10) / 10} (n ${a.length}; ${Math.round(Math.min(...a) * 10) / 10}-${Math.round(Math.max(...a) * 10) / 10})` : 'n/a';
const metrics = {};
const add = (name, arm, value, row) => { if (value === null || value === undefined || ![B, A].includes(arm)) { return; } ((metrics[name] ??= {})[arm] ??= []).push({ value, load: load1(row) }); };
const a5 = read('a5.jsonl');
for (const [i, r] of a5.entries()) {
	if (r.variant === 'launch') {
		add('A5 app (MiB)', r.arm, r.appMedianMiB, r);
		add('A5 agents (MiB)', r.arm, r.agentsMedianMiB, r);
		add('A5 total (MiB)', r.arm, r.totalMedianMiB, r);
		add('A5 agent processes at rest (claude CLI)', r.arm, r.byRole?.['claude CLI']?.n ?? 0, r);
	}
	if (r.variant === 'a10-rest-20') {
		add('A10 rest-20 app (MiB)', r.arm, r.appMedianMiB, r);
		add('A10 rest-20 total (MiB)', r.arm, r.totalMedianMiB, r);
		add('A10 ACP adapters alive at rest-20', r.arm, r.byRole?.['ACP adapter (node)']?.n ?? 0, r);
		const base = a5.slice(0, i).reverse().find(x => x.arm === r.arm && x.variant === 'launch');
		if (base) { add('A10 MB per extra thread (app)', r.arm, (r.appMedianMiB - base.appMedianMiB) / 15, r); }
	}
}
for (const r of read('a9.jsonl')) { add('A9 no-sessions ghost (MiB)', r.arm, r.ghostMiB, r); }
for (const r of read('a7.jsonl')) {
	add('A7 app p95 (MiB)', r.arm, r.appP95, r);
	add('A7 agents p95 (MiB)', r.arm, r.agentsP95, r);
	add('A7 total p95 (MiB)', r.arm, r.totalP95, r);
}
for (const r of read('resume.jsonl')) { add(`first word, reopened thread, ${r.openWaitS} s after open (ms)`, r.arm, r.firstWordMs, r); }
for (const r of read('firstlaunch.jsonl')) { add(`first word, first prompt after launch, ${r.variant === 'new' ? 'new thread' : 'restored chat'} (ms)`, r.arm, r.firstWordMs, r); }
const kept = (arms, arm) => (arms[arm] ?? []).filter(x => x.load <= maxLoad);
const range = xs => xs.length ? `${Math.min(...xs)}-${Math.max(...xs)}` : '';
console.log(`| Metric | ${B} | ${A} | load of rows used (1-min) | left out (load > ${maxLoad}): before / after |`);
console.log('|---|---|---|---|---|');
for (const [name, arms] of Object.entries(metrics)) {
	const used = [...kept(arms, B), ...kept(arms, A)].map(x => x.load);
	const out = arm => (arms[arm] ?? []).filter(x => x.load > maxLoad).map(x => `${Math.round(x.value * 10) / 10} @${x.load}`).join(', ') || '-';
	console.log(`| ${name} | ${cell(kept(arms, B).map(x => x.value))} | ${cell(kept(arms, A).map(x => x.value))} | ${range(used)} | ${out(B)} / ${out(A)} |`);
}
