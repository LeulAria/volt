/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { deferredHeadStart } from '../../browser/editor/agentThreadWindow.js';

/** `exchanges` user + reply pairs: messages 0, 2, 4, ... open an exchange. */
function pairs(exchanges: number): { length: number; starts: (index: number) => boolean } {
	return { length: exchanges * 2, starts: index => index % 2 === 0 };
}

suite('Agent thread: draw the end first', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('a long chat starts at its last kept exchanges', () => {
		const { length, starts } = pairs(100);
		// The last 6 exchanges are messages 188..199.
		assert.strictEqual(deferredHeadStart(length, starts, 6, 4), 188);
	});

	test('a short chat is drawn whole', () => {
		const { length, starts } = pairs(6);
		assert.strictEqual(deferredHeadStart(length, starts, 6, 4), 0);
	});

	test('a few exchanges above the kept ones are drawn at once too', () => {
		// 6 kept + 3 above: deferring 3 saves nothing worth a second pass.
		assert.strictEqual(deferredHeadStart(pairs(9).length, pairs(9).starts, 6, 4), 0);
		// 6 kept + 4 above: the 4 wait.
		assert.strictEqual(deferredHeadStart(pairs(10).length, pairs(10).starts, 6, 4), 8);
	});

	test('notification turns and long replies do not open exchanges', () => {
		// 30 exchanges of user + 3 messages that do not open one.
		const starts = (index: number) => index % 4 === 0;
		assert.strictEqual(deferredHeadStart(120, starts, 6, 4), 96);
	});
});
