/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { classifyProviderError, isAcpTurnRestartable, parseRetryAfter, retryDelayMs } from '../../../common/harness/sessionRetry.js';

suite('Volt session retry', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('classifies overflow vs retry vs fail', () => {
		assert.strictEqual(classifyProviderError(new Error('maximum context length exceeded')), 'overflow');
		assert.strictEqual(classifyProviderError({ status: 429, message: 'rate limited' }), 'retry');
		assert.strictEqual(classifyProviderError({ status: 503, message: 'unavailable' }), 'retry');
		assert.strictEqual(classifyProviderError(new Error('invalid api key')), 'fail');
		assert.strictEqual(classifyProviderError({ retryable: true, message: 'transient' }), 'retry');
		assert.strictEqual(classifyProviderError(new Error('Internal error')), 'retry');
		assert.strictEqual(classifyProviderError(new Error('ACP process exited (1)')), 'retry');
		assert.strictEqual(isAcpTurnRestartable('Internal error'), true);
		assert.strictEqual(isAcpTurnRestartable('ACP process exited (1)'), true);
		assert.strictEqual(isAcpTurnRestartable('invalid api key'), false);
	});

	test('honours Retry-After and caps backoff', () => {
		assert.strictEqual(parseRetryAfter({ headers: { 'retry-after': '2' } }), 2_000);
		assert.strictEqual(parseRetryAfter({ retryAfterMs: 1_500 }), 1_500);
		assert.ok(retryDelayMs(1) >= 400);
		assert.ok(retryDelayMs(8) <= 30_000);
		assert.strictEqual(retryDelayMs(1, 50_000), 30_000);
	});
});
