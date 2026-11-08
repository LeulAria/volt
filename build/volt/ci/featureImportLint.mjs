/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The feature import lint (sandbox spec H.11 and M3): a Volt feature that moved into its own folder
// (`src/vs/workbench/contrib/<entry>/`, named by its built-in extension's `voltModule.entry`) is
// fenced both ways.
//
// - In: code outside the folder imports only the feature's contract, its `common/` folder (ids,
//   types, the module's interface). The module entry (`browser/<entry>.module.ts`) is imported by
//   core's module table alone (`voltFeatureModuleTable.ts`), so the feature loads when first used
//   and unloads with its extension. Another feature is "outside" too: features talk through
//   contracts, never each other's internals.
// - Out: the folder imports `base/`, `nls`, `platform/`, `editor/`, the workbench's own `browser/` and
//   `common/`, the `volt` facade (`services/voltPlugins/common/`), the module host types and the UI
//   kit. Any other core module it still uses is listed per feature in
//   feature-import-allowlist.json: a ratchet, so the list only shrinks. A new core import fails; an
//   entry nothing uses any more is reported as stale. The feature's own `test/` folder is exempt
//   from this rule (tests set up core around the module), not from the other.
//
// Usage: node build/volt/ci/featureImportLint.mjs [--root <dir>] [--warn]
//   --warn   report, but exit 0

import * as fs from 'node:fs';
import * as path from 'node:path';

const ALLOWLIST = 'build/volt/ci/feature-import-allowlist.json';
const CONTRIB = 'src/vs/workbench/contrib/';
const MODULE_TABLE = 'src/vs/workbench/contrib/voltCustomize/browser/voltFeatureModuleTable.ts';

/** What every feature may import (repository-relative prefixes of the resolved `.ts` path). */
export const ALWAYS_ALLOWED = [
	'src/vs/base/',
	'src/vs/nls.',
	'src/vs/platform/',
	'src/vs/editor/',
	'src/vs/workbench/browser/',
	'src/vs/workbench/common/',
	// The facade (spec H.11 item 3), and its browser half (the agent window as a feature sees it).
	'src/vs/workbench/services/voltPlugins/common/',
	'src/vs/workbench/services/voltPlugins/browser/',
	// The module host it activates with.
	'src/vs/workbench/contrib/voltCustomize/browser/voltFeatureModules.ts',
	// The UI kit: Volt's buttons, dropdowns, menus and tooltips.
	'src/vs/workbench/contrib/voltAgent/browser/ui/',
	'src/vs/workbench/contrib/voltAgent/browser/chrome/voltButton.ts',
	'src/vs/workbench/contrib/voltAgent/browser/chrome/agentTooltip.ts',
];

/** @typedef {{ feature: string, entry: string, folder: string }} Feature */
/** @typedef {{ file: string, line: number, target: string, rule: 'in' | 'out', feature: string, text: string }} Finding */

/**
 * The fenced features: built-in manifests whose `voltModule` names an `entry` folder.
 * @param {string} root
 * @returns {Feature[]}
 */
export function readFeatures(root) {
	const features = [];
	const extensions = path.join(root, 'extensions');
	for (const name of fs.readdirSync(extensions).sort()) {
		if (!name.startsWith('volt-')) {
			continue;
		}
		let manifest;
		try {
			manifest = JSON.parse(fs.readFileSync(path.join(extensions, name, 'package.json'), 'utf8'));
		} catch {
			continue;
		}
		const voltModule = manifest.contributes?.voltModule;
		if (voltModule && typeof voltModule.entry === 'string' && /^volt[A-Z][A-Za-z]*$/.test(voltModule.entry)) {
			features.push({ feature: voltModule.feature, entry: voltModule.entry, folder: `${CONTRIB}${voltModule.entry}/` });
		}
	}
	return features;
}

const IMPORT = /(?:^|[\s;])(?:import|export)\s(?:[^'";]*?\sfrom\s+)?(['"])(\.[^'"]+)\1|\bimport\(\s*(['"])(\.[^'"]+)\3\s*\)/g;

/**
 * Relative imports in a file's text, resolved to repository-relative `.ts` (or other) paths.
 * @param {string} file repository-relative, `/`-separated
 * @param {string} text
 */
export function importsOf(file, text) {
	const found = [];
	const lines = text.split(/\r?\n/);
	const starts = [];
	let offset = 0;
	for (const line of lines) {
		starts.push(offset);
		offset += line.length + 1;
	}
	IMPORT.lastIndex = 0;
	let match;
	while ((match = IMPORT.exec(text))) {
		const spec = match[2] ?? match[4];
		// The line the specifier is on (a multi-line import ends there).
		const at = match.index + match[0].lastIndexOf(spec);
		let line = 0;
		while (line + 1 < starts.length && starts[line + 1] <= at) {
			line++;
		}
		const trimmed = lines[line].trim();
		if (trimmed.startsWith('//') || trimmed.startsWith('* ') || trimmed.startsWith('/*')) {
			continue;
		}
		const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(file), spec)).replace(/\.js$/, '.ts');
		found.push({ line: line + 1, target: resolved, dynamic: match[4] !== undefined, text: trimmed });
	}
	return found;
}

/**
 * The findings for one file.
 * @param {string} file
 * @param {string} text
 * @param {Feature[]} features
 * @param {Readonly<Record<string, readonly string[]>>} allowlist
 * @returns {Finding[]}
 */
export function checkFile(file, text, features, allowlist) {
	const own = features.find(feature => file.startsWith(feature.folder));
	// Tests (a `test/` folder) aren't shipped: core's tests import what they test and core's test
	// helpers. A feature's own tests may set up core (below) but not reach another feature's internals.
	if (!own && /\/test\//.test(file)) {
		return [];
	}
	const findings = [];
	for (const { line, target, dynamic, text: lineText } of importsOf(file, text)) {
		const fenced = features.find(feature => target.startsWith(feature.folder));
		if (fenced && fenced !== own) {
			const contract = target.startsWith(`${fenced.folder}common/`);
			const entry = `${fenced.folder}browser/${fenced.entry}.module.ts`;
			const table = file === MODULE_TABLE && target === entry && dynamic;
			if (!contract && !table) {
				findings.push({ file, line, target, rule: 'in', feature: fenced.feature, text: lineText });
			}
			continue;
		}
		const test = !!own && file.startsWith(`${own.folder}test/`);
		if (own && !test && !fenced && !ALWAYS_ALLOWED.some(prefix => target.startsWith(prefix)) && !(allowlist[own.feature] ?? []).includes(target)) {
			findings.push({ file, line, target, rule: 'out', feature: own.feature, text: lineText });
		}
	}
	return findings;
}

/** @param {string} root @param {string} dir */
function* walk(root, dir) {
	let entries;
	try {
		entries = fs.readdirSync(path.join(root, dir), { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		const relative = `${dir}/${entry.name}`;
		if (entry.isDirectory()) {
			if (entry.name !== 'node_modules' && !entry.name.startsWith('.')) {
				yield* walk(root, relative);
			}
		} else if (entry.isFile() && /\.ts$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
			yield relative;
		}
	}
}

/**
 * Every finding in `src/`, and the allowlist entries nothing uses any more.
 * @param {string} root
 * @param {Readonly<Record<string, readonly string[]>>} allowlist
 */
export function scan(root, allowlist) {
	const features = readFeatures(root);
	const findings = [];
	const used = new Map(features.map(feature => [feature.feature, new Set()]));
	for (const file of walk(root, 'src')) {
		const text = fs.readFileSync(path.join(root, file), 'utf8');
		findings.push(...checkFile(file, text, features, allowlist));
		const own = features.find(feature => file.startsWith(feature.folder));
		if (own && !file.startsWith(`${own.folder}test/`)) {
			for (const { target } of importsOf(file, text)) {
				used.get(own.feature).add(target);
			}
		}
	}
	const stale = [];
	for (const [feature, targets] of Object.entries(allowlist)) {
		for (const target of targets) {
			if (!used.get(feature)?.has(target)) {
				stale.push({ feature, target });
			}
		}
	}
	return { features, findings, stale };
}

function main() {
	const args = process.argv.slice(2);
	const rootIndex = args.indexOf('--root');
	const root = rootIndex >= 0 ? path.resolve(args[rootIndex + 1]) : process.cwd();
	const warn = args.includes('--warn');
	const allowlist = JSON.parse(fs.readFileSync(path.join(root, ALLOWLIST), 'utf8')).features;
	const { features, findings, stale } = scan(root, allowlist);
	for (const entry of stale) {
		console.warn(`feature import lint: stale allowlist entry for ${entry.feature} (nothing imports it any more, remove it): ${entry.target}`);
	}
	for (const finding of findings) {
		const why = finding.rule === 'in'
			? `imports ${finding.feature}'s internals. Outside its folder, use its contract (common/), or run its commands by id.`
			: `is a core module ${finding.feature} doesn't list in ${ALLOWLIST}. Reach it through the volt facade or the feature's contract, or (reviewed) add it to the list.`;
		console.error(`${finding.file}:${finding.line}: ${finding.target} ${why}\n    ${finding.text}`);
	}
	if (findings.length && !warn) {
		process.exitCode = 1;
	} else if (!findings.length) {
		console.log(`feature import lint: ${features.length} fenced feature(s) (${features.map(feature => feature.feature).join(', ')}), no import across a fence.`);
	}
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('featureImportLint.mjs')) {
	main();
}
