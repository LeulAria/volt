/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// Compares two bench JSON files (scripts/volt-e2e/orch/bench.sh): p50 / mean per metric and the ratio.
// Usage: node scripts/volt-e2e/orch/compare.mjs before.json after.json [--md]
import { readFileSync } from 'fs';
const [a, b] = process.argv.slice(2, 4).map(file => JSON.parse(readFileSync(file, 'utf8')));
const md = process.argv.includes('--md');
const rows = [];
for (const [section, metrics] of Object.entries(a)) {
	if (!metrics || typeof metrics !== 'object' || section === 'toolTokens' || section === 'notificationForOneReport') {
		continue;
	}
	for (const [metric, before] of Object.entries(metrics)) {
		const after = b[section]?.[metric];
		if (!before || typeof before !== 'object' || !after) {
			continue;
		}
		const ratio = after.p50 ? before.p50 / after.p50 : NaN;
		rows.push([section, metric, before.n, before.p50, before.p90, after.p50, after.p90, Number.isFinite(ratio) ? `${ratio.toFixed(2)}x` : '-']);
	}
}
const head = ['section', 'metric', 'n', 'before p50', 'before p90', 'after p50', 'after p90', 'before/after'];
if (md) {
	console.log(`| ${head.join(' | ')} |`);
	console.log(`|${head.map(() => '---').join('|')}|`);
	rows.forEach(row => console.log(`| ${row.join(' | ')} |`));
} else {
	console.table(rows.map(row => Object.fromEntries(head.map((h, i) => [h, row[i]]))));
}
