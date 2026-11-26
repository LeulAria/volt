// Before/after table of the weight rig: medians (n, range) per arm, excluded rows dropped (data/weight/excluded.json).
// A10 mb-per-thread pairs each a10-rest-20 row with the A5 `launch` row just before it on the same arm (one block).
//   node summarize.mjs [maxLoad]   (rows over maxLoad, by their 1-minute load, are listed apart)
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { DATA } from './lib.mjs';

const maxLoad = Number(process.argv[2] ?? Infinity);
// ad7f75e0f14 (restored chat warms a 30 s spare at launch) changed what A5 and the first prompt after launch measure on
// the after arm: after rows taken before it was built are shown on their own lines ("after, b98ab only").
const FIX_AT = '2026-11-14T07:05:00Z';
const launchArm = r => r.arm === 'after' && r.at < FIX_AT ? 'after0' : r.arm;
const excluded = JSON.parse(readFileSync(join(DATA, 'excluded.json'), 'utf8'));
const read = file => existsSync(join(DATA, file)) ? readFileSync(join(DATA, file), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(r => !(excluded[file] ?? {})[r.at]) : [];
const load1 = r => Number(String(r.load).split(/\s+/)[0]);
const med = a => { const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length ? (s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2) : null; };
const cell = a => a.length ? `${Math.round(med(a) * 10) / 10} (n ${a.length}; ${Math.round(Math.min(...a) * 10) / 10}-${Math.round(Math.max(...a) * 10) / 10})` : 'n/a';
const metrics = {};
const add = (name, arm, value, row) => {
	if (value === null || value === undefined || !['before', 'after', 'after0'].includes(arm)) { return; }
	if (arm === 'after0') { name += ' [after = b98ab only, before ad7f75e]'; arm = 'after'; }
	((metrics[name] ??= {})[arm] ??= []).push({ value, load: load1(row) });
};
const a5 = read('a5.jsonl');
for (const [i, r] of a5.entries()) {
	if (r.variant === 'launch') {
		add('A5 app (MiB)', launchArm(r), r.appMedianMiB, r);
		add('A5 agents (MiB)', launchArm(r), r.agentsMedianMiB, r);
		add('A5 total (MiB)', launchArm(r), r.totalMedianMiB, r);
		add('A5 agent processes at rest (claude CLI)', launchArm(r), r.byRole?.['claude CLI']?.n ?? 0, r);
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
for (const r of read('firstlaunch.jsonl')) { add(`first word, first prompt after launch, ${r.variant === 'new' ? 'new thread' : 'restored chat'}, ${r.restS} s rest (ms)`, launchArm(r), r.firstWordMs, r); }
for (const r of read('firstlaunch.jsonl')) { add(`ACP adapters ${r.restS} s after launch (${r.variant === 'new' ? 'new-thread' : 'restored'} rows)`, launchArm(r), r.agentAdaptersAtRest, r); }
const kept = (arms, arm) => (arms[arm] ?? []).filter(x => x.load <= maxLoad);
const range = xs => xs.length ? `${Math.min(...xs)}-${Math.max(...xs)}` : '';
console.log(`| Metric | before | after | load of rows used (1-min) | left out (load > ${maxLoad}): before / after |`);
console.log('|---|---|---|---|---|');
for (const [name, arms] of Object.entries(metrics)) {
	const used = [...kept(arms, 'before'), ...kept(arms, 'after')].map(x => x.load);
	const out = arm => (arms[arm] ?? []).filter(x => x.load > maxLoad).map(x => `${Math.round(x.value * 10) / 10} @${x.load}`).join(', ') || '-';
	console.log(`| ${name} | ${cell(kept(arms, 'before').map(x => x.value))} | ${cell(kept(arms, 'after').map(x => x.value))} | ${range(used)} | ${out('before')} / ${out('after')} |`);
}
