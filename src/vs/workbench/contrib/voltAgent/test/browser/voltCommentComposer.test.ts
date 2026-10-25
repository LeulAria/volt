/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { placeBesideAnchor } from '../../browser/chrome/voltCommentComposer.js';

suite('VoltCommentComposer placement', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const bounds = { left: 0, top: 0, right: 1000, bottom: 800 };
	const size = { width: 390, height: 72 };

	test('goes below the anchor, centred, 12px under it', () => {
		const placed = placeBesideAnchor({ x: 400, y: 100, width: 200, height: 100 }, size, bounds);
		assert.deepStrictEqual(placed, { left: 500 - 195, top: 212 });
	});

	test('goes above when there is no room below', () => {
		const placed = placeBesideAnchor({ x: 400, y: 680, width: 200, height: 100 }, size, bounds);
		assert.deepStrictEqual(placed, { left: 305, top: 680 - 72 - 12 });
	});

	test('goes beside a tall anchor that leaves no room above or below', () => {
		const placed = placeBesideAnchor({ x: 100, y: 20, width: 200, height: 760 }, size, bounds);
		assert.deepStrictEqual(placed, { left: 312, top: 20 });
	});

	test('stays inside the bounds and clear of the insets', () => {
		const placed = placeBesideAnchor({ x: 980, y: 0, width: 10, height: 10 }, size, { ...bounds, top: 50 });
		assert.ok(placed.left + size.width <= bounds.right - 8);
		assert.ok(placed.top >= 58);
	});
});
