/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { isCursorPlanWall, isCursorPlanWallPrefix, isCursorTransientError, nextCursorFallback, normalizeCursorModelId } from '../../../common/harness/cursorQuota.js';

suite('Cursor ACP plan-wall', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('detects the generic ACP banner', () => {
		assert.strictEqual(isCursorPlanWall('Upgrade your plan to continue'), true);
		assert.strictEqual(isCursorPlanWall('\n\nUpgrade your plan to continue'), true);
		assert.strictEqual(isCursorPlanWall('ok'), false);
	});

	test('detects the real Opus usage-limit copy', () => {
		assert.strictEqual(isCursorPlanWall('You\'ve hit your usage limit for Opus. Switch to a different model or set a Spend Limit to continue with Opus.'), true);
	});

	test('holds the banner while it streams in', () => {
		assert.strictEqual(isCursorPlanWallPrefix('Upgrade'), true);
		assert.strictEqual(isCursorPlanWallPrefix('Upgrade your plan to continue'), true);
		assert.strictEqual(isCursorPlanWallPrefix('I will look that up'), false);
	});

	test('maps Auto-smart back to Auto', () => {
		assert.strictEqual(normalizeCursorModelId('auto-smart'), 'auto');
		assert.strictEqual(normalizeCursorModelId('default'), 'auto');
		assert.strictEqual(normalizeCursorModelId('claude-opus-5'), 'claude-opus-5');
	});

	test('treats Cursor Internal error as transient', () => {
		assert.strictEqual(isCursorTransientError('Internal error'), true);
		assert.strictEqual(isCursorTransientError('Internal error.'), true);
		assert.strictEqual(isCursorTransientError('ok'), false);
	});

	test('falls back to Auto then Composer', () => {
		assert.strictEqual(nextCursorFallback(['claude-opus-5']), 'auto');
		assert.strictEqual(nextCursorFallback(['auto-smart']), 'composer-2.5');
		assert.strictEqual(nextCursorFallback(['auto', 'composer-2.5']), undefined);
	});
});
