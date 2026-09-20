/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { startPromptStall } from '../../../common/harness/acpStall.js';

suite('Volt ACP stall', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('fires only when nothing arrives', () => {
		let handle: (() => void) | undefined;
		const stall = startPromptStall(10, () => undefined, (fn, _delay) => {
			handle = fn;
			return { dispose: () => { handle = undefined; } };
		});
		assert.strictEqual(stall.fired(), false);
		handle?.();
		assert.strictEqual(stall.fired(), true);
	});

	test('ping cancels the timer', () => {
		let handle: (() => void) | undefined;
		let stalled = 0;
		const stall = startPromptStall(10, () => { stalled++; }, (fn, _delay) => {
			handle = fn;
			return { dispose: () => { handle = undefined; } };
		});
		stall.ping();
		handle?.();
		assert.strictEqual(stalled, 0);
		assert.strictEqual(stall.fired(), false);
	});
});
