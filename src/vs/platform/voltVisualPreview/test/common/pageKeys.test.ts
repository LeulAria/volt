/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { ALT, CTRL, META, parseKeyCombo, SHIFT } from '../../common/pageKeys.js';

suite('Headless page keys', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('keys and chords become the DevTools protocol\'s modifiers and key codes', () => {
		assert.deepStrictEqual(parseKeyCombo('Enter'), { modifiers: 0, key: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' } });
		const selectAll = parseKeyCombo('Meta+a')!;
		assert.deepStrictEqual([selectAll.modifiers, selectAll.key.code, selectAll.key.keyCode], [META, 'KeyA', 65]);
		assert.strictEqual(parseKeyCombo('Shift+Tab')!.modifiers, SHIFT);
		assert.strictEqual(parseKeyCombo('ctrl+alt+ArrowDown')!.modifiers, CTRL | ALT);
		assert.strictEqual(parseKeyCombo('down')!.key.key, 'ArrowDown');
		assert.strictEqual(parseKeyCombo('F5')!.key.keyCode, 116);
		assert.strictEqual(parseKeyCombo('7')!.key.code, 'Digit7');
		assert.strictEqual(parseKeyCombo('Meta++')!.key.key, '+');
		assert.strictEqual(parseKeyCombo('Hyper'), undefined);
	});
});
