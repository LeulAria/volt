/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { patchDelay } from '../../../node/voltAgent/serverSessionHost.js';

suite('Agent server transcript patches', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('a shown chat\'s first change after a quiet spell goes out at once', () => {
		assert.strictEqual(patchDelay(true, undefined, 1_000), 0, 'never sent: at once');
		assert.strictEqual(patchDelay(true, 900, 1_000), 0, 'last patch 100 ms ago: at once');
	});

	test('a stream still sends at most one patch per 50 ms', () => {
		assert.strictEqual(patchDelay(true, 990, 1_000), 40);
		assert.strictEqual(patchDelay(true, 1_000, 1_000), 50);
	});

	test('a chat no client shows waits the background interval', () => {
		assert.strictEqual(patchDelay(false, undefined, 1_000), 1_000);
		assert.strictEqual(patchDelay(false, 0, 1_000), 1_000);
	});
});
