/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	DEFAULT_CHECK_EVERY_MS,
	DEFAULT_MAX_ATTEMPTS,
	failureSignature,
	fixPrompt,
	IWatchedAttempt,
	IWatchedTaskSpec,
	judgeAttempt,
	nextStepAfterFailure,
	outputSnapshot,
	parseWatchArgs,
	STUCK_REPEATS,
} from '../../common/terminals/watchedTasks.js';

function spec(overrides: Partial<IWatchedTaskSpec> = {}): IWatchedTaskSpec {
	const parsed = parseWatchArgs({ command: 'xcodebuild -scheme App build' });
	assert.ok(!('error' in parsed));
	return { ...parsed, ...overrides };
}

function failed(number: number, signature: string): IWatchedAttempt {
	return { number, terminalId: `term-${number}`, startedAt: 0, endedAt: 1, result: 'failed', signature };
}

suite('watched tasks', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('arguments: defaults, clamps and a missing command', () => {
		const parsed = parseWatchArgs({ command: ' ./gradlew assembleDebug ', check_every_s: 1, max_attempts: 99, auto_fix: false });
		assert.ok(!('error' in parsed));
		assert.strictEqual(parsed.command, './gradlew assembleDebug');
		assert.strictEqual(parsed.checkEveryMs, 2_000);
		assert.strictEqual(parsed.maxAttempts, 10);
		assert.strictEqual(parsed.autoFix, false);
		const defaults = spec();
		assert.strictEqual(defaults.checkEveryMs, DEFAULT_CHECK_EVERY_MS);
		assert.strictEqual(defaults.maxAttempts, DEFAULT_MAX_ATTEMPTS);
		assert.strictEqual(defaults.autoFix, true);
		assert.deepStrictEqual(parseWatchArgs({}), { error: 'command is required.' });
	});

	test('verdict: running, passed, failed with the error line, hung', () => {
		const s = spec();
		assert.strictEqual(judgeAttempt({ status: 'running' }, 'Compiling', s, 1_000).verdict, 'running');
		assert.strictEqual(judgeAttempt({ status: 'completed', exitCode: 0 }, '** BUILD SUCCEEDED **', s, 1_000).verdict, 'passed');
		const failure = judgeAttempt({ status: 'failed', exitCode: 65 }, 'CompileSwift\n/App/View.swift:12:5: error: cannot find \'Foo\' in scope\n** BUILD FAILED **', s, 1_000);
		assert.strictEqual(failure.verdict, 'failed');
		assert.match(failure.reason!, /cannot find 'Foo' in scope.*exit code 65/);
		assert.strictEqual(judgeAttempt({ status: 'running' }, '', s, s.attemptTimeoutMs + 1).verdict, 'timedOut');
		assert.strictEqual(judgeAttempt({ status: 'stopped' }, '', s, 1).verdict, 'stopped');
		assert.strictEqual(judgeAttempt(undefined, '', s, 1).verdict, 'failed');
	});

	test('verdict: success and failure patterns', () => {
		const s = spec({ successPattern: 'Installed on', failurePattern: 'BUILD FAILED' });
		assert.strictEqual(judgeAttempt({ status: 'running' }, 'Installed on iPhone 17', s, 1).verdict, 'passed', 'a success line passes while it still runs');
		assert.strictEqual(judgeAttempt({ status: 'completed', exitCode: 0 }, 'done', s, 1).verdict, 'failed', 'exit 0 without the success line');
		const flagged = judgeAttempt({ status: 'completed', exitCode: 0 }, 'BUILD FAILED in 3s', spec({ failurePattern: 'BUILD FAILED' }), 1);
		assert.deepStrictEqual(flagged, { verdict: 'failed', reason: 'BUILD FAILED in 3s' });
	});

	test('signature: the same error reads the same across runs', () => {
		const a = failureSignature('error: /private/var/folders/x1/T/abc/main.o: undefined symbol at 12:5 (deadbeef12)');
		const b = failureSignature('error: /private/var/folders/q9/T/zzz/main.o: undefined symbol at 40:1 (cafebabe99)');
		assert.strictEqual(a, b);
		assert.notStrictEqual(a, failureSignature('error: no such module \'Firebase\''));
	});

	test('loop: fix, then stuck on the same error, out of attempts, auto-fix off', () => {
		const s = spec({ maxAttempts: 5 });
		assert.deepStrictEqual(nextStepAfterFailure([failed(1, 'x')], s, 0, 1), { next: 'fix' });
		const same = Array.from({ length: STUCK_REPEATS }, (_, i) => failed(i + 1, 'x'));
		assert.strictEqual((nextStepAfterFailure(same, s, 0, 1) as { state: string }).state, 'stuck');
		const changing = [failed(1, 'x'), failed(2, 'y'), failed(3, 'x')];
		assert.deepStrictEqual(nextStepAfterFailure(changing, s, 0, 1), { next: 'fix' }, 'a different error between is progress');
		const many = [failed(1, 'a'), failed(2, 'b'), failed(3, 'c'), failed(4, 'd'), failed(5, 'e')];
		assert.strictEqual((nextStepAfterFailure(many, s, 0, 1) as { state: string }).state, 'exhausted');
		assert.strictEqual((nextStepAfterFailure([failed(1, 'x')], spec({ autoFix: false }), 0, 1) as { state: string }).state, 'failed');
		assert.strictEqual((nextStepAfterFailure([failed(1, 'x')], s, 0, s.budgetMs) as { state: string }).state, 'exhausted');
	});

	test('fix prompt and snapshot', () => {
		const attempt: IWatchedAttempt = { number: 2, terminalId: 'term-2', startedAt: 0, result: 'failed', reason: 'error: boom (exit code 1)' };
		const prompt = fixPrompt('watch-1', 'iOS build', spec(), attempt, 'step\nerror: boom\n', true);
		assert.match(prompt, /attempt 2 of 5/);
		assert.match(prompt, /same error as the previous attempt/);
		assert.match(prompt, /Do not run the command yourself/);
		assert.deepStrictEqual(outputSnapshot('a\n\nb  \nc\nd', 3), ['b', 'c', 'd']);
	});
});
