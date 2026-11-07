/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from '../../../../../base/common/path.js';
import { FileAccess } from '../../../../../base/common/network.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
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
});
