// Copyright (c) Volt ADK. All rights reserved.
// Licensed under the MIT License. See License.txt in the project root for license information.

// Regenerates brands/brands.json (provider marks the widgets draw) from the agent window's own
// path data in src/vs/workbench/services/voltRuntime/browser/providers/providerBrands.ts.
// The config plugin turns each entry into an SVG image set in the widget extension's asset catalog.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, '../../../src/vs/workbench/services/voltRuntime/browser/providers/providerBrands.ts'), 'utf8');
const spark = /const SPARK[^=]*=\s*\{\s*d:\s*'([^']+)'/.exec(source)?.[1];
const table = source.slice(source.indexOf('export const PROVIDER_BRANDS'));
const brands = {};
for (const id of ['claude', 'codex', 'cursor', 'grok', 'opencode', 'kimi', 'muse', 'local', 'openrouter', 'generic']) {
	const start = table.search(new RegExp(`\\n\\t${id}: \\{`));
	if (start < 0) {
		continue;
	}
	const end = table.indexOf('\n\t},', start);
	const block = table.slice(start, end);
	const viewBox = /viewBox: '([^']+)'/.exec(block)?.[1];
	const color = /\n\t\tcolor: '([^']+)'/.exec(block)?.[1];
	const paths = [];
	for (const match of block.matchAll(/\{\s*(?:evenOdd: true,\s*)?d: '([^']+)'(?:,\s*fill: '([^']+)')?(?:,\s*evenOdd: true)?/g)) {
		paths.push({ d: match[1], ...(match[2] ? { fill: match[2] } : {}), ...(/evenOdd: true/.test(match[0]) ? { evenOdd: true } : {}) });
	}
	if (!paths.length && /\[SPARK\]/.test(block) && spark) {
		paths.push({ d: spark });
	}
	if (viewBox && paths.length) {
		brands[id] = { viewBox, ...(color ? { color } : {}), paths };
	}
}
writeFileSync(join(here, '../brands/brands.json'), JSON.stringify(brands, null, '\t') + '\n');
console.log(`wrote ${Object.keys(brands).length} brands: ${Object.keys(brands).join(', ')}`);
