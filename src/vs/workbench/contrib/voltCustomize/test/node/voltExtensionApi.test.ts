/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Volt extension API, the CI checks:
// EXT-CEIL-CI-1: every built-in `extensions/volt-*` manifest declares nothing beyond its compiled
// first-party ceiling (G.10), and the table names no extension that doesn't ship.
// EXT-DTS-1: the publishable copy of `vscode.proposed.volt.d.ts` matches the source.
// EXT-EXAMPLE-1: docs/volt/examples/volt-hello type-checks against the d.ts and its manifest validates.

import assert from 'assert';
import { execFileSync } from 'child_process';
import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from '../../../../../base/common/path.js';
import { FileAccess } from '../../../../../base/common/network.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { declarationsOutsideCeiling, FIRST_PARTY_CEILINGS } from '../../../../../platform/voltPlugins/common/firstPartyCeilings.js';
import { pickVoltContributes, validateVoltContributes } from '../../../../services/voltPlugins/common/voltContributions.js';

suite('Volt extension API: CI checks', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const root = join(FileAccess.asFileUri('').fsPath, '..');

	function builtInManifests(): Map<string, { contributes?: unknown }> {
		const byId = new Map<string, { contributes?: unknown }>();
		const folder = join(root, 'extensions');
		for (const name of readdirSync(folder).filter(entry => entry.startsWith('volt-'))) {
			const file = join(folder, name, 'package.json');
			if (existsSync(file)) {
				const manifest = JSON.parse(readFileSync(file, 'utf8'));
				byId.set(`${manifest.publisher}.${manifest.name}`.toLowerCase(), manifest);
			}
		}
		return byId;
	}

	test('EXT-CEIL-CI-1: each built-in manifest is within its first-party ceiling', () => {
		const manifests = builtInManifests();
		assert.ok(manifests.size >= 30, `found ${manifests.size} built-in manifests`);
		const problems: string[] = [];
		for (const [id, manifest] of manifests) {
			const declared = pickVoltContributes(manifest.contributes).voltCapabilities;
			problems.push(...declarationsOutsideCeiling(id, [...declared?.required ?? [], ...declared?.optional ?? []]));
		}
		assert.deepStrictEqual(problems, [], 'widening a built-in needs its ceiling in firstPartyCeilings.ts (a core change)');
		assert.deepStrictEqual(Object.keys(FIRST_PARTY_CEILINGS).filter(id => !manifests.has(id)), [], 'ceilings for extensions that do not ship');
		assert.deepStrictEqual([...manifests.keys()].filter(id => !Object.prototype.hasOwnProperty.call(FIRST_PARTY_CEILINGS, id)), [], 'built-ins without a ceiling');
	});

	test('EXT-DTS-1: the publishable d.ts is the source d.ts', () => {
		const source = readFileSync(join(root, 'src', 'vscode-dts', 'vscode.proposed.volt.d.ts'), 'utf8');
		const copy = readFileSync(join(root, 'apps', 'volt-extension-api', 'vscode.proposed.volt.d.ts'), 'utf8');
		assert.strictEqual(copy, source, 'copy src/vscode-dts/vscode.proposed.volt.d.ts to apps/volt-extension-api/');
		const pkg = JSON.parse(readFileSync(join(root, 'apps', 'volt-extension-api', 'package.json'), 'utf8'));
		assert.strictEqual(pkg.types, 'vscode.proposed.volt.d.ts');
	});

	test('EXT-EXAMPLE-1: the example extension type-checks and its manifest validates', function () {
		this.timeout(120_000);
		const example = join(root, 'docs', 'volt', 'examples', 'volt-hello');
		const manifest = JSON.parse(readFileSync(join(example, 'package.json'), 'utf8'));
		assert.deepStrictEqual(manifest.enabledApiProposals, ['volt']);
		assert.deepStrictEqual(validateVoltContributes(manifest.contributes), []);
		const tsc = join(root, 'node_modules', 'typescript', 'bin', 'tsc');
		assert.ok(existsSync(tsc), 'typescript is installed');
		// Throws with tsc's diagnostics when the example doesn't type-check.
		execFileSync(process.execPath, [tsc, '-p', example, '--noEmit'], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8' });
	});
});
