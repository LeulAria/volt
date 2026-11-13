/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { turnNavCapacity, turnNavHasOffscreen, turnNavPreview, turnNavWindowStart } from '../../browser/editor/agentTurnNav.js';

suite('Agent turn nav', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('previews a reply as one line of plain text', () => {
		assert.strictEqual(
			turnNavPreview('**What was wrong:** the `out/` folder was stale.\n\n- first\n- second'),
			'What was wrong: the out/ folder was stale. first second',
		);
	});

	test('cuts long replies with an ellipsis', () => {
		const preview = turnNavPreview('word '.repeat(200), 40);
		assert.ok(preview.endsWith('…'));
		assert.ok(preview.length <= 41);
	});

	test('an empty reply has no preview', () => {
		assert.strictEqual(turnNavPreview(''), '');
	});

	test('the rail rests while every sent message is on screen', () => {
		assert.strictEqual(turnNavHasOffscreen([true, true], 0), false);
		assert.strictEqual(turnNavHasOffscreen([], 0), false);
	});

	test('the rail shows once a message is off screen or not drawn yet', () => {
		assert.strictEqual(turnNavHasOffscreen([false, true], 0), true);
		assert.strictEqual(turnNavHasOffscreen([true, true, false], 0), true);
		assert.strictEqual(turnNavHasOffscreen([true, true], 3), true);
	});

	test('a long chat draws as many ticks as fit in half the thread, never fewer than twelve', () => {
		assert.strictEqual(turnNavCapacity(700), 116);
		assert.strictEqual(turnNavCapacity(40), 12);
		assert.strictEqual(turnNavCapacity(0), 12);
	});

	test('the tick window starts at the last messages and follows the ones in view', () => {
		// Nothing drawn in view yet: the last 100 of 1,000.
		assert.strictEqual(turnNavWindowStart(1000, 100, 0, -1, -1), 900);
		// In view and inside the window: it stays.
		assert.strictEqual(turnNavWindowStart(1000, 100, 900, 950, 952), 900);
		// Scrolled above it: it moves so the messages in view sit in its middle.
		assert.strictEqual(turnNavWindowStart(1000, 100, 900, 500, 501), 450);
		// Near the start or the end it stops at the edge.
		assert.strictEqual(turnNavWindowStart(1000, 100, 900, 3, 4), 0);
		assert.strictEqual(turnNavWindowStart(1000, 100, 0, 998, 999), 900);
		// A chat shorter than the window shows all of it.
		assert.strictEqual(turnNavWindowStart(40, 100, 0, 10, 12), 0);
		// A chat that got shorter pulls the window back inside it.
		assert.strictEqual(turnNavWindowStart(150, 100, 900, 120, 121), 50);
	});
});
