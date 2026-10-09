/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { enabledProfileIds, isCatalogModelEnabled, isPickerModelVisible, setCatalogModelEnabled } from '../../common/models/modelVisibility.js';

suite('model picker visibility', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('hiding one model from the show-all list does not bring it back', () => {
		const hidden = new Set<string>();
		const whitelist = new Set<string>();
		const next = setCatalogModelEnabled('agent:claude:sonnet', false, hidden, whitelist);
		assert.strictEqual(isCatalogModelEnabled('agent:claude:sonnet', new Set(next.hidden), new Set(next.whitelist)), false);
		assert.strictEqual(isCatalogModelEnabled('agent:claude:opus', new Set(next.hidden), new Set(next.whitelist)), true);
	});

	test('hiding every model stays hidden, and enabling one brings only that one back', () => {
		let hidden = new Set<string>();
		let whitelist = new Set<string>();
		for (const ref of ['a', 'b']) {
			const next = setCatalogModelEnabled(ref, false, hidden, whitelist);
			hidden = new Set(next.hidden);
			whitelist = new Set(next.whitelist);
		}
		assert.strictEqual(isCatalogModelEnabled('a', hidden, whitelist), false);
		assert.strictEqual(isCatalogModelEnabled('b', hidden, whitelist), false);
		const shown = setCatalogModelEnabled('a', true, hidden, whitelist);
		assert.strictEqual(isCatalogModelEnabled('a', new Set(shown.hidden), new Set(shown.whitelist)), true);
		assert.strictEqual(isCatalogModelEnabled('b', new Set(shown.hidden), new Set(shown.whitelist)), false);
	});

	test('a provider that is off drops its models even when each model switch is still on', () => {
		const profiles = enabledProfileIds([
			{ id: 'claude', enabled: false },
			{ id: 'antigravity', enabled: true },
		]);
		assert.strictEqual(isPickerModelVisible({ enabled: true, profileId: 'claude' }, profiles), false);
		assert.strictEqual(isPickerModelVisible({ enabled: true, profileId: 'antigravity' }, profiles), true);
		assert.strictEqual(isPickerModelVisible({ enabled: false, profileId: 'antigravity' }, profiles), false);
	});
});
