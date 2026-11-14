/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Volt e2e review (package ide): tables from abRun's JSONL files.
//   node scripts/volt-e2e/ide/summarize.mjs ab-before.jsonl [ab-after.jsonl ...]   (paths relative to docs/volt-e2e-review/data/ide)

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const dataDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../../docs/volt-e2e-review/data/ide');
const rows = process.argv.slice(2).flatMap(file => readFileSync(resolve(dataDir, file), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)));

const mean = values => values.reduce((a, b) => a + b, 0) / (values.length || 1);
const sd = values => { const m = mean(values); return Math.sqrt(mean(values.map(v => (v - m) ** 2))); };
const fmt = (value, digits = 0) => Number.isFinite(value) ? value.toFixed(digits) : '-';
const tokens = row => (row.input ?? 0) + (row.output ?? 0) + (row.cacheRead ?? 0) + (row.cacheWrite ?? 0);

const groups = new Map();
for (const row of rows) {
	const key = `${row.tag}/${row.arm}`;
	groups.set(key, [...(groups.get(key) ?? []), row]);
}

console.log('| arm | runs | accuracy | wall s (mean +/- sd) | cost $ / run | tokens / run (in+out+cache) | output tok | tool calls | volt calls | tool result chars |');
console.log('|---|---|---|---|---|---|---|---|---|---|');
for (const [key, list] of groups) {
	console.log(`| ${key} | ${list.length} | ${fmt(mean(list.map(r => r.score)) * 100, 1)}% | ${fmt(mean(list.map(r => r.wallMs / 1000)), 1)} +/- ${fmt(sd(list.map(r => r.wallMs / 1000)), 1)} | ${fmt(mean(list.map(r => r.costUsd ?? 0)), 4)} | ${fmt(mean(list.map(tokens)))} | ${fmt(mean(list.map(r => r.output ?? 0)))} | ${fmt(mean(list.map(r => r.toolCalls)), 1)} | ${fmt(mean(list.map(r => r.voltCalls)), 1)} | ${fmt(mean(list.map(r => r.toolResultChars)))} |`);
}

console.log('\nPer question (mean of n): accuracy % / wall s / cost $ / tool calls (volt calls)\n');
const questions = [...new Set(rows.map(r => r.q))];
const keys = [...groups.keys()];
console.log(`| question | ${keys.join(' | ')} |`);
console.log(`|---|${keys.map(() => '---').join('|')}|`);
for (const q of questions) {
	const cells = keys.map(key => {
		const list = groups.get(key).filter(r => r.q === q);
		if (!list.length) {
			return '-';
		}
		return `${fmt(mean(list.map(r => r.score)) * 100)} / ${fmt(mean(list.map(r => r.wallMs / 1000)))} / ${fmt(mean(list.map(r => r.costUsd ?? 0)), 3)} / ${fmt(mean(list.map(r => r.toolCalls)), 1)} (${fmt(mean(list.map(r => r.voltCalls)), 1)})`;
	});
	console.log(`| ${q} | ${cells.join(' | ')} |`);
}

console.log('\nTools used (total calls per arm):\n');
for (const [key, list] of groups) {
	const totals = {};
	for (const row of list) {
		for (const [name, count] of Object.entries(row.tools ?? {})) {
			totals[name] = (totals[name] ?? 0) + count;
		}
	}
	console.log(`- ${key}: ${Object.entries(totals).sort((a, b) => b[1] - a[1]).map(([name, count]) => `${name.replace('mcp__volt__', 'volt:')} ${count}`).join(', ')}`);
}
