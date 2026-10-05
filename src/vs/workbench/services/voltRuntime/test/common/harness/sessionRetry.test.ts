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
		assert.strictEqual(isAcpTurnRestartable('Internal error: You\'ve hit your monthly spend limit · your session limit resets 3:20am (Asia/Dubai)'), false);
		assert.strictEqual(isAcpTurnRestartable('Usage limit reached · resets 3:20 AM'), false);
	});

	test('only a prompt that never started is restarted on a fresh process', () => {
		// Nothing was done yet: a new process and the same prompt are safe.
		assert.strictEqual(isAcpTurnRestartable('ACP agent produced no activity for 9 min. The prompt stalled and the turn was stopped.'), true);
		// Work is already on disk: restarting would redo it, so the user retries instead.
		assert.strictEqual(isAcpTurnRestartable('The agent stopped responding: no activity for 9 min, even after Volt asked it to continue. Retry to pick the turn up from here.'), false);
		assert.strictEqual(isAcpTurnRestartable('Stopped: the agent kept running npm test 3 times with the same error after being asked to change approach.'), false);
		assert.strictEqual(isAcpTurnRestartable('Paused at the tool budget for one run (500 tool calls). Send "continue" to keep going from here.'), false);
	});

	test('honours Retry-After and caps backoff', () => {
		assert.strictEqual(parseRetryAfter({ headers: { 'retry-after': '2' } }), 2_000);
		assert.strictEqual(parseRetryAfter({ retryAfterMs: 1_500 }), 1_500);
		assert.ok(retryDelayMs(1) >= 400);
		assert.ok(retryDelayMs(8) <= 30_000);
		assert.strictEqual(retryDelayMs(1, 50_000), 30_000);
	});
});
