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

	test('ignores empty payloads', () => {
		assert.strictEqual(parseTokenUsage({ sessionUpdate: 'usage_update' }), undefined);
	});
});
