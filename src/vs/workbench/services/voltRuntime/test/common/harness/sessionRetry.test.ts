/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { classifyProviderError, isAcpTurnRestartable, parseRetryAfter, restartedTurnText, retryDelayMs } from '../../../common/harness/sessionRetry.js';

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
	test('a turn sent again after its agent died says what was done, and a turn that had done nothing is sent as it was', () => {
		// Nothing done yet: the same prompt, as before.
		assert.strictEqual(restartedTurnText('fix the bug', true, undefined), 'fix the bug');
		assert.strictEqual(restartedTurnText('fix the bug', false, { tools: 0, files: [] }), 'fix the bug');
		// The same session again: its steps are above, it continues after them.
		const resumed = restartedTurnText('fix the bug', true, { tools: 5, files: ['src/a.ts'] });
		assert.ok(resumed.startsWith('[Volt] Your agent process died') && resumed.includes('on the same session') && resumed.includes('Do not redo finished steps'));
		assert.ok(resumed.endsWith('\n\nfix the bug'), 'the request stays, byte for byte, at the end');
		// A new session: it does not see its steps, so it is told what they were.
		const fresh = restartedTurnText('fix the bug', false, { tools: 1, files: ['src/a.ts', 'src/b.ts'] });
		assert.ok(fresh.includes('in a new session') && fresh.includes('finished 1 tool call and changed src/a.ts, src/b.ts.') && fresh.includes('before redoing anything'));
		assert.ok(fresh.endsWith('\n\nfix the bug'));
		const many = restartedTurnText('go', false, { tools: 30, files: Array.from({ length: 15 }, (_, i) => `f${i}.ts`) });
		assert.ok(many.includes('30 tool calls') && many.includes('f11.ts and 3 more.') && !many.includes('f12.ts'));
		// A command is never wrapped: the agent would not see it as one.
		assert.strictEqual(restartedTurnText('/compact', true, { tools: 3, files: [] }), '/compact');
	});
});
