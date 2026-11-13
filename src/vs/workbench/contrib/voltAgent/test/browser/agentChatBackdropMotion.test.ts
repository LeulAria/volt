/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { BACKDROP_IDLE_MS, BACKDROP_TYPING_QUIET_MS, backdropMotion } from '../../browser/chat/agentChatBackground.js';

suite('agentChatBackdrop motion', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('moves after input until the window has been idle a while, then holds its frame for good', () => {
		assert.deepStrictEqual(backdropMotion(1_000, 0, -10_000), { moves: true, recheckIn: BACKDROP_IDLE_MS - 1_000 });
		assert.deepStrictEqual(backdropMotion(BACKDROP_IDLE_MS, 0, -10_000), { moves: false });
	});

	test('holds still while keys are typed, and moves again once they are quiet', () => {
		assert.deepStrictEqual(backdropMotion(5_000, 5_000, 5_000), { moves: false, recheckIn: BACKDROP_TYPING_QUIET_MS });
		assert.strictEqual(backdropMotion(5_000 + BACKDROP_TYPING_QUIET_MS, 5_000, 5_000).moves, true);
	});
});
