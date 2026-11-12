/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { loneBrace } from '../../node/rootIndex.js';

/** A sandboxed chat's search refused `PaymentGateway\s*{` as "needs ripgrep"; ripgrep rejects it too, so say what to fix. */
suite('loneBrace', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('a brace that is not a repetition or an escape', () => {
		assert.strictEqual(loneBrace('PaymentGateway\\s*{', true), true);
		assert.strictEqual(loneBrace('implements.*X|X\\s*}', true), true);
	});

	test('repetitions, escapes, classes and literals are fine', () => {
		for (const pattern of ['a{2}', 'a{1,3}', 'a{2,}', '\\{\\}', '\\p{L}+', '\\x{41}', '[{}]', 'foo']) {
			assert.strictEqual(loneBrace(pattern, true), false, pattern);
		}
		assert.strictEqual(loneBrace('PaymentGateway {', false), false);
	});
});
