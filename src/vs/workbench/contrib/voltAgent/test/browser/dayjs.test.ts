/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { dayjs } from '../../browser/chrome/dayjs.js';

suite('dayjs (relative time)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('the first minute is "just now": a label that counted seconds redrew the chat once a second after every turn', () => {
		const now = Date.now();
		assert.strictEqual(dayjs(now).fromNow(), 'just now');
		assert.strictEqual(dayjs(now - 12_000).fromNow(), 'just now');
		assert.strictEqual(dayjs(now - 59_000).fromNow(), 'just now');
		assert.strictEqual(dayjs(now - 61_000).fromNow(), '1m ago');
		assert.strictEqual(dayjs(now - 12 * 60_000).fromNow(), '12m ago');
		assert.strictEqual(dayjs(now - 3 * 3_600_000).fromNow(), '3h ago');
	});
});
