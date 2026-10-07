/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { parseTokenUsage } from '../../common/tokenUsage.js';

suite('parseTokenUsage', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('reads ACP usage_update used/size', () => {
		const usage = parseTokenUsage({ sessionUpdate: 'usage_update', used: 53_000, size: 200_000 });
		assert.deepStrictEqual(usage, { type: 'usage', input: 0, output: 0, used: 53_000, size: 200_000 });
	});

	test('reads nested prompt usage tokens', () => {
		const usage = parseTokenUsage({ usage: { inputTokens: 1_200, outputTokens: 80 } });
		assert.deepStrictEqual(usage, { type: 'usage', input: 1_200, output: 80 });
	});

	test('reads the cost Claude reports with usage_update (US dollars only)', () => {
		assert.deepStrictEqual(parseTokenUsage({ sessionUpdate: 'usage_update', used: 24_706, size: 200_000, cost: { amount: 0.0374574, currency: 'USD' } }),
			{ type: 'usage', input: 0, output: 0, used: 24_706, size: 200_000, costUsd: 0.0374574 });
		assert.strictEqual(parseTokenUsage({ sessionUpdate: 'usage_update', used: 1, cost: { amount: 2, currency: 'EUR' } })?.costUsd, undefined);
	});

	test('reads cache writes from a prompt result', () => {
		const usage = parseTokenUsage({ usage: { inputTokens: 18, outputTokens: 1044, cachedReadTokens: 35_435, cachedWriteTokens: 10_884, totalTokens: 47_381 } });
		assert.deepStrictEqual(usage, { type: 'usage', input: 18, output: 1044, cache: 35_435, cacheWrite: 10_884 });
	});

	test('ignores empty payloads', () => {
		assert.strictEqual(parseTokenUsage({ sessionUpdate: 'usage_update' }), undefined);
	});
});
