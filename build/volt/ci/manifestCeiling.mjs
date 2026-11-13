/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// manifest within ceiling (plugin platform spec M.4 "M5", G.10): every built-in extension
// (`extensions/volt-*`) may declare in `contributes.voltCapabilities` only what its first-party
// ceiling holds. The ceilings are compiled into core (src/vs/platform/voltPlugins/common/
// firstPartyCeilings.ts), so widening a built-in is a reviewed core change, never a package.json
// edit alone. The check is the same function the extension API runs at registration
// (`declarationsOutsideCeiling`), imported from the TypeScript source (Node strips the types).
//
// Fails on: a declaration beyond the ceiling, a built-in that declares capabilities or contributes
// agents (`voltAgents`) without a ceiling, a `volt-*` folder whose manifest isn't `volt.<folder>`,
// and a ceiling for a built-in that no longer exists (it would hand a future extension of that id
// first-party access). Warns on ceiling entries no declaration uses (keep the ceiling as narrow as
// the manifest).
//
// Usage: node build/volt/ci/manifestCeiling.mjs [--root <dir>] [--warn]
//   --warn   report, but exit 0

import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

export const CEILINGS_MODULE = 'src/vs/platform/voltPlugins/common/firstPartyCeilings.ts';

/** @typedef {{ id: string, targets?: string[] }} Declaration */
/** @typedef {{ folder: string, manifest: any }} BuiltinManifest */
/**
 * @typedef {{
 *   FIRST_PARTY_CEILINGS: Record<string, { id: string, targets?: string[] }[]>,
 *   declarationsOutsideCeiling(extensionId: string, declarations: Declaration[]): string[],
 * }} CeilingsModule
 */

/** @param {string} root */
export async function loadCeilings(root) {
	return /** @type {CeilingsModule} */ (await import(pathToFileURL(path.join(root, CEILINGS_MODULE)).href));
}

/**
 * Every `extensions/volt-*` manifest under `root`.
 * @param {string} root
 * @returns {BuiltinManifest[]}
 */
export function readBuiltins(root) {
	const dir = path.join(root, 'extensions');
	return fs.readdirSync(dir, { withFileTypes: true })
		.filter(entry => entry.isDirectory() && entry.name.startsWith('volt-') && fs.existsSync(path.join(dir, entry.name, 'package.json')))
		.map(entry => ({ folder: entry.name, manifest: JSON.parse(fs.readFileSync(path.join(dir, entry.name, 'package.json'), 'utf8')) }))
		.sort((a, b) => a.folder.localeCompare(b.folder));
}

/** @param {any} manifest @returns {Declaration[]} */
function declarations(manifest) {
	const declared = manifest.contributes?.voltCapabilities ?? {};
	return [...declared.required ?? [], ...declared.optional ?? []];
}

/**
 * @param {BuiltinManifest[]} builtins
 * @param {CeilingsModule} ceilings
 * @returns {{ problems: string[], warnings: string[] }}
 */
export function checkBuiltins(builtins, ceilings) {
	const problems = [];
	const warnings = [];
	const seen = new Set();
	for (const { folder, manifest } of builtins) {
		const expected = `volt.${folder.slice('volt-'.length)}`;
		const id = `${manifest.publisher}.${manifest.name}`;
		if (id.toLowerCase() !== expected) {
			problems.push(`extensions/${folder}: the manifest is ${id}, expected ${expected} (a built-in's ceiling is found by its id)`);
			continue;
		}
		seen.add(expected);
		const declared = declarations(manifest);
		const ceiling = Object.prototype.hasOwnProperty.call(ceilings.FIRST_PARTY_CEILINGS, expected) ? ceilings.FIRST_PARTY_CEILINGS[expected] : undefined;
		if (!ceiling && manifest.contributes?.voltAgents?.length) {
			problems.push(`${expected} contributes voltAgents but has no first-party ceiling`);
		}
		problems.push(...ceilings.declarationsOutsideCeiling(expected, declared));
		for (const entry of ceiling ?? []) {
			if (!declared.some(declaration => declaration.id === entry.id)) {
				warnings.push(`${expected}: the ceiling holds ${entry.id}, which the manifest doesn't declare (narrow the ceiling)`);
			}
		}
	}
	for (const id of Object.keys(ceilings.FIRST_PARTY_CEILINGS)) {
		if (!seen.has(id)) {
			problems.push(`${id} has a first-party ceiling but no extensions/${id.replace(/^volt\./, 'volt-')} built-in (remove the stale ceiling)`);
		}
	}
	return { problems, warnings };
}

async function main() {
	const args = process.argv.slice(2);
	const rootIndex = args.indexOf('--root');
	const root = rootIndex >= 0 ? path.resolve(args[rootIndex + 1]) : process.cwd();
	const builtins = readBuiltins(root);
	const { problems, warnings } = checkBuiltins(builtins, await loadCeilings(root));
	for (const warning of warnings) {
		console.warn(`manifest ceiling: ${warning}`);
	}
	for (const problem of problems) {
		console.error(`manifest ceiling: ${problem}`);
	}
	if (problems.length) {
		console.error(`manifest ceiling: narrow the manifest, or change the ceiling in ${CEILINGS_MODULE} (a reviewed core change).`);
	}
	if (problems.length && !args.includes('--warn')) {
		process.exitCode = 1;
	} else if (!problems.length) {
		console.log(`manifest ceiling: all ${builtins.length} built-ins declare only what their first-party ceiling holds.`);
	}
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('manifestCeiling.mjs')) {
	await main();
}
