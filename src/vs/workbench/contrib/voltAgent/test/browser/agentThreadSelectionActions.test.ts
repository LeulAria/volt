/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { mainWindow } from '../../../../../base/browser/window.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { needsSelectionLayout } from '../../browser/editor/agentThreadSelectionActions.js';

suite('agentThreadSelectionActions', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('a key typed in a text field does not read the selection while nothing in the transcript is selected', () => {
		assert.strictEqual(needsSelectionLayout(false, mainWindow.document.createElement('textarea')), false);
		assert.strictEqual(needsSelectionLayout(false, mainWindow.document.createElement('input')), false);
	});

	test('a selection change outside a text field, or with transcript text selected, lays the bar out', () => {
		assert.strictEqual(needsSelectionLayout(false, mainWindow.document.body), true);
		assert.strictEqual(needsSelectionLayout(false, null), true);
		// Focus moved into the composer while text was selected: one more pass hides the bar.
		assert.strictEqual(needsSelectionLayout(true, mainWindow.document.createElement('textarea')), true);
	});
});
