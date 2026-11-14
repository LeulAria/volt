/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { hasUserInput, watchForUserInput } from '../../browser/editor/agentUserInput.js';

suite('Agent editor: user input before prewarming', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('a restored window has no user input until a key or pointer press', () => {
		const win = new EventTarget();
		watchForUserInput(win);
		assert.strictEqual(hasUserInput(win), false, 'a restored chat starts no agent');
		win.dispatchEvent(new Event('focus'));
		assert.strictEqual(hasUserInput(win), false, 'focus alone (the window gives its composer focus at launch) is not input');
		win.dispatchEvent(new Event('pointerdown'));
		assert.strictEqual(hasUserInput(win), true);
	});

	test('a key counts, and each window is tracked on its own', () => {
		const main = new EventTarget();
		const aux = new EventTarget();
		watchForUserInput(main);
		watchForUserInput(main);
		watchForUserInput(aux);
		main.dispatchEvent(new Event('keydown'));
		assert.strictEqual(hasUserInput(main), true);
		assert.strictEqual(hasUserInput(aux), false);
	});
});
