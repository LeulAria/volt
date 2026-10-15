/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { formatDuration } from '../../browser/usage/agentUsageFormat.js';

suite('Volt usage format', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('reset countdowns never read 60m or 24h', () => {
		const minute = 60_000;
		assert.strictEqual(formatDuration(4 * 60 * minute + 59.6 * minute), '5h');
		assert.strictEqual(formatDuration(59.7 * minute), '1h');
		assert.strictEqual(formatDuration(3 * 24 * 60 * minute + 23.6 * 60 * minute), '4d');
		assert.strictEqual(formatDuration(90 * minute), '1h 30m');
		assert.strictEqual(formatDuration(30_000), '<1m');
	});
});
