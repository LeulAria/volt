/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ACCESS_MODE_OPTIONS, accessModeOption, DEFAULT_ACCESS_MODE, normalizeVoltAccessMode } from '../../common/access/accessModes.js';

suite('Volt access modes', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('fresh installs default to Supervised', () => {
		assert.strictEqual(DEFAULT_ACCESS_MODE, 'supervised');
		assert.strictEqual(normalizeVoltAccessMode(undefined), 'supervised');
		assert.strictEqual(normalizeVoltAccessMode('not-a-mode'), 'supervised');
		assert.strictEqual(ACCESS_MODE_OPTIONS[0].id, 'supervised');
		assert.strictEqual(accessModeOption('supervised').id, 'supervised');
	});

	test('normalize keeps an explicit user pick', () => {
		assert.strictEqual(normalizeVoltAccessMode('full-access'), 'full-access');
		assert.strictEqual(normalizeVoltAccessMode('auto'), 'auto');
		assert.strictEqual(normalizeVoltAccessMode('auto-accept-edits'), 'auto-accept-edits');
		assert.strictEqual(normalizeVoltAccessMode('supervised'), 'supervised');
	});
});
