/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { intentWantsPrewarm, openPrewarmDelay, PREWARM_CLICK_GAP_MS, PREWARM_INTENT_GAP_MS, PREWARM_ON_OPEN_MS } from '../../browser/editor/agentPrewarmIntent.js';

suite('Agent editor: warming the agent on intent', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('a chat clicked open warms its agent at once; one opened otherwise waits out the open timer', () => {
		assert.strictEqual(openPrewarmDelay(10_000, undefined), 0, 'the first click');
		assert.strictEqual(openPrewarmDelay(10_000, 10_000 - PREWARM_CLICK_GAP_MS), 0, 'a click a while after the last one');
		assert.strictEqual(openPrewarmDelay(undefined, 9_000), PREWARM_ON_OPEN_MS, 'a restored window or a command');
	});

	test('clicks stepping through chats start no agent per chat', () => {
		assert.strictEqual(openPrewarmDelay(10_000, 9_600), PREWARM_ON_OPEN_MS);
		assert.strictEqual(openPrewarmDelay(10_000, 10_000 - PREWARM_CLICK_GAP_MS + 1), PREWARM_ON_OPEN_MS);
	});

	test('the pointer on the composer or the window to the front asks once in a while, and not right after a full warm', () => {
		const now = 100_000;
		assert.strictEqual(intentWantsPrewarm(now, 0, 0), true, 'nothing asked yet');
		assert.strictEqual(intentWantsPrewarm(now, now - 1_000, 0), false, 'the pointer going in and out of the composer');
		assert.strictEqual(intentWantsPrewarm(now, now - PREWARM_INTENT_GAP_MS, 0), true);
		assert.strictEqual(intentWantsPrewarm(now, 0, now - 1_000), false, 'a focus or a key just asked for a full warm');
		assert.strictEqual(intentWantsPrewarm(now, 0, now - PREWARM_INTENT_GAP_MS), true);
	});
});
