/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { addLineNumbers, truncateHead, truncateHeadTail } from '../../../common/harness/toolResult.js';

suite('Volt tool result hygiene', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('numbers lines from a start offset', () => {
		assert.strictEqual(addLineNumbers('a\nb', 9), ' 9 | a\n10 | b');
	});

	test('head truncation teaches offset', () => {
		const text = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join('\n');
		const truncated = truncateHead(text, 4, 10_000);
		assert.strictEqual(truncated.truncated, true);
		assert.ok(truncated.text.includes('line 4'));
		assert.ok(!truncated.text.includes('line 5'));
		assert.ok(/offset=5/.test(truncated.text));
	});

	test('head/tail keeps the end of command output', () => {
		const text = 'HEAD' + 'x'.repeat(1000) + 'FAIL: not found';
		const truncated = truncateHeadTail(text, 200);
		assert.strictEqual(truncated.truncated, true);
		assert.ok(truncated.text.startsWith('HEAD'));
		assert.ok(truncated.text.endsWith('FAIL: not found'));
		assert.ok(/omitted/.test(truncated.text));
	});
});
