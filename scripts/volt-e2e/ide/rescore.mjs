/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Re-grades abRun results from their raw streams (after a fix to questions.mjs). Usage: node rescore.mjs ab-before.jsonl
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { QUESTIONS, score } from './questions.mjs';

const file = resolve(dirname(fileURLToPath(import.meta.url)), '../../../docs/volt-e2e-review/data/ide', process.argv[2]);
const rows = readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
for (const row of rows) {
	const raw = readFileSync(`/tmp/volt-e2e/ide/runs/${row.tag}-${row.arm}-${row.q}-${row.rep}.jsonl`, 'utf8');
	const result = raw.split('\n').map(line => { try { return JSON.parse(line); } catch { return undefined; } }).find(event => event?.type === 'result');
	const graded = score(QUESTIONS.find(q => q.id === row.q), result?.result ?? '');
	row.score = graded.score;
	row.missing = graded.missing;
}
writeFileSync(file, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
console.log(`rescored ${rows.length}`);
