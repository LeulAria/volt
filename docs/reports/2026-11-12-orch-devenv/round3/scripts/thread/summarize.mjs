#!/usr/bin/env node
// Pools the A/B rounds in data/thread/ab (<side>-r<round>-<test>.json) per test and side:
// median, n, range of each value, failed samples (null), and the highest 1-minute load seen
// before or after a sample. Prints a markdown table.
//   node summarize.mjs [dir]
import fs from 'node:fs';
import path from 'node:path';
import { stats } from './lib.mjs';

const dir = process.argv[2] ?? path.join(path.dirname(new URL(import.meta.url).pathname), '../../data/thread/ab');
const VALUES = {
	warm: ['settled', 'firstVisible'],
	cold: ['settled', 'firstVisible'],
	open75k: ['settled', 'firstVisible'],
	a11open: ['settled', 'firstVisible'],
	home: ['toTop'],
	earlier: ['turnsPerS', 'gapsOver33'],
	stutter: ['gapsOver33', 'maxGap'],
	idle: ['taskMsPerS', 'layoutMsPerS'],
	reasoning: ['shownMs', 'settledMs', 'chars', 'longTaskMs'],
	send: ['echoMs', 'firstWordMs'],
};
const pooled = new Map();
for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.json'))) {
	const m = /^(base|new)-r(\d+)-(\w+)\.json$/.exec(file);
	if (!m) {
		continue;
	}
	const [, side, round, test] = m;
	const data = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
	const key = `${test}|${side}`;
	const entry = pooled.get(key) ?? { results: [], rounds: new Set() };
	entry.rounds.add(Number(round));
	entry.results.push(...data.results);
	pooled.set(key, entry);
}
const one = s => Number(String(s ?? '').split(/\s+/)[0]) || 0;
const fmt = s => s ? `${s.median} (n=${s.n}, ${s.min}–${s.max})` : '–';
console.log('| Test | Value | Before (base) | After (new) | Failed before/after | Max load before/after |');
console.log('|---|---|---|---|---|---|');
for (const [test, values] of Object.entries(VALUES)) {
	const b = pooled.get(`${test}|base`);
	const n = pooled.get(`${test}|new`);
	if (!b && !n) {
		continue;
	}
	for (const value of values) {
		const col = e => {
			const ok = (e?.results ?? []).filter(r => r && typeof r[value] === 'number');
			return ok.length ? stats(ok.map(r => r[value])) : null;
		};
		const failed = e => (e?.results ?? []).filter(r => !r).length;
		const maxLoad = e => Math.max(0, ...(e?.results ?? []).filter(Boolean).map(r => Math.max(one(r.loadBefore), one(r.loadAfter))));
		console.log(`| ${test} | ${value} | ${fmt(col(b))} | ${fmt(col(n))} | ${failed(b)}/${failed(n)} | ${maxLoad(b)}/${maxLoad(n)} |`);
	}
}
