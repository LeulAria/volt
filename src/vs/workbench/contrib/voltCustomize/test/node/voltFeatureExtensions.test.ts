/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from '../../../../../base/common/path.js';
import { FileAccess } from '../../../../../base/common/network.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { pickVoltContributes, validateVoltContributes, VOLT_CONTRIBUTION_POINTS } from '../../../../services/voltPlugins/common/voltContributions.js';
import { VOLT_FEATURE_MANIFESTS } from '../../common/voltFeatureManifests.generated.js';
import { VOLT_FEATURES } from '../../common/voltFeatures.js';

/** The manifests under `extensions/volt-*` and the catalog name the same extensions. */
suite('Volt feature extensions', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const extensionsFolder = join(FileAccess.asFileUri('').fsPath, '..', 'extensions');

	function manifests(): Map<string, { publisher: string; name: string; main?: string; browser?: string }> {
		const byId = new Map<string, { publisher: string; name: string; main?: string; browser?: string }>();
		for (const folder of readdirSync(extensionsFolder).filter(name => name.startsWith('volt-'))) {
			const file = join(extensionsFolder, folder, 'package.json');
			if (existsSync(file)) {
				const manifest = JSON.parse(readFileSync(file, 'utf8'));
				byId.set(`${manifest.publisher}.${manifest.name}`, manifest);
			}
		}
		return byId;
	}

	test('every optional feature has its manifest, and every manifest a feature', () => {
		const found = manifests();
		const expected = VOLT_FEATURES.flatMap(feature => feature.extensionId ? [feature.extensionId] : []);
		assert.deepStrictEqual(expected.filter(id => !found.has(id)), [], 'features without a manifest');
		assert.deepStrictEqual([...found.keys()].filter(id => !expected.includes(id)), [], 'manifests without a feature');
	});

	test('the manifests carry no code, so turning one off needs no restart', () => {
		for (const [id, manifest] of manifests()) {
			assert.ok(!manifest.main && !manifest.browser, `${id} has code`);
		}
	});

	test('M1: every manifest\'s Volt contribution points validate', () => {
		for (const folder of readdirSync(extensionsFolder).filter(name => name.startsWith('volt-'))) {
			const manifest = JSON.parse(readFileSync(join(extensionsFolder, folder, 'package.json'), 'utf8'));
			assert.deepStrictEqual(validateVoltContributes(manifest.contributes), [], folder);
			assert.ok(manifest.contributes.voltModule, `${folder} has no voltModule`);
			assert.ok(manifest.contributes.voltCapabilities, `${folder} declares no voltCapabilities`);
		}
	});

	test('M1: the generated catalog data is current (node scripts/volt-generate-features.mjs)', () => {
		const onDisk = readdirSync(extensionsFolder).filter(name => name.startsWith('volt-')).sort().map(folder => {
			const manifest = JSON.parse(readFileSync(join(extensionsFolder, folder, 'package.json'), 'utf8'));
			return { publisher: manifest.publisher, name: manifest.name, ...(manifest.engines?.volt ? { engines: { volt: manifest.engines.volt } } : {}), contributes: pickVoltContributes(manifest.contributes) };
		});
		assert.deepStrictEqual(VOLT_FEATURE_MANIFESTS, onDisk);
		// The generator picks the same points the platform defines.
		const script = readFileSync(join(extensionsFolder, '..', 'scripts', 'volt-generate-features.mjs'), 'utf8');
		const points = /const POINTS = \[([^\]]*)\]/.exec(script)?.[1].split(',').map(point => point.trim().replace(/'/g, '')).filter(Boolean);
		assert.deepStrictEqual(points, [...VOLT_CONTRIBUTION_POINTS]);
	});
});
