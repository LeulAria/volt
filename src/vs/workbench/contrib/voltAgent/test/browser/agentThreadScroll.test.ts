/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { pageScrollTarget, stepTurnIndex } from '../../browser/editor/agentThreadScroll.js';

suite('Agent thread scroll', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('a page is the view height less a strip of overlap', () => {
		assert.strictEqual(pageScrollTarget(0, 500, 5000, 1), 440);
		assert.strictEqual(pageScrollTarget(1000, 500, 5000, -1), 560);
		// Tall views keep at most 64px of overlap.
		assert.strictEqual(pageScrollTarget(0, 1000, 5000, 1), 936);
	});

	test('paging stops at the ends', () => {
		assert.strictEqual(pageScrollTarget(100, 500, 5000, -1), 0);
		assert.strictEqual(pageScrollTarget(4400, 500, 5000, 1), 4500);
		assert.strictEqual(pageScrollTarget(0, 500, 300, 1), 0);
	});

	test('steps to the previous and next message from the landing line', () => {
		const tops = [-900, -300, 8, 400, 1200];
		assert.strictEqual(stepTurnIndex(tops, 8, -1), 1);
		assert.strictEqual(stepTurnIndex(tops, 8, 1), 3);
		assert.strictEqual(stepTurnIndex([8, 400], 8, -1), -1);
		assert.strictEqual(stepTurnIndex([-400, 8], 8, 1), -1);
	});

	test('a message a pixel off the landing line counts as the current one', () => {
		assert.strictEqual(stepTurnIndex([-500, 9, 600], 8, -1), 0);
		assert.strictEqual(stepTurnIndex([-500, 9, 600], 8, 1), 2);
	});
});
