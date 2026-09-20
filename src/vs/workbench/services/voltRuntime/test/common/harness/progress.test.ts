/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { classifyError, IStepObservation, isRetryable, ProgressTracker } from '../../../common/harness/progress.js';
import { IToolCall, IToolResult } from '../../../common/tools/tool.js';

suite('Volt progress intelligence', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	suite('error classification', () => {
		const cases: readonly (readonly [string, string, string])[] = [
			['read_file', 'ENOENT: no such file or directory, open \'src/nope.ts\'', 'not-found'],
			['edit_file', 'Cannot find module \'./missing\'', 'environment'],
			['shell', 'EACCES: permission denied', 'permission'],
			['web_fetch', 'ETIMEDOUT after 30000ms', 'transient'],
			['web_fetch', 'HTTP 429 rate limit exceeded', 'transient'],
			['edit_file', 'No match found for old_string', 'invalid-args'],
			['shell', 'src/a.ts(12,5): error TS2322: Type \'string\' is not assignable to type \'number\'', 'syntax'],
			['shell', 'AssertionError: expected 3 to equal 4', 'assertion'],
			['shell', '2 failing', 'assertion'],
			['write_file', 'File changed on disk since it was read', 'conflict'],
			['shell', 'The operation was cancelled', 'cancelled'],
			['shell', 'exit code 1', 'assertion'],
			['read_file', 'something inexplicable', 'unknown'],
		];
		for (const [tool, message, expected] of cases) {
			test(`${expected}: ${message.slice(0, 44)}`, () => {
				assert.strictEqual(classifyError(tool, message), expected);
			});
		}
	});

	test('only transient and conflict are worth retrying verbatim', () => {
		assert.strictEqual(isRetryable('transient'), true);
		assert.strictEqual(isRetryable('conflict'), true);
		assert.strictEqual(isRetryable('assertion'), false);
		assert.strictEqual(isRetryable('permission'), false);
	});

	test('a text-only step is full progress', () => {
		const report = new ProgressTracker().observe(step(1, [], [], { text: '4' }));
		assert.strictEqual(report.score, 1);
		assert.strictEqual(report.stuck, false);
	});

	test('a step that produced nothing at all scores zero', () => {
		const report = new ProgressTracker().observe(step(1, [], [], { text: '' }));
		assert.strictEqual(report.score, 0);
	});

	test('an edit scores higher than a read', () => {
		const edit = new ProgressTracker().observe(step(1, [call('c1', 'edit_file', { path: 'a.ts' })], [ok('c1', 'edit_file')], { files: 1 }));
		const read = new ProgressTracker().observe(step(1, [call('c1', 'read_file', { path: 'a.ts' })], [ok('c1', 'read_file')]));
		assert.ok(edit.score > read.score, `${edit.score} > ${read.score}`);
		assert.strictEqual(edit.signals.stateChanged, true);
		assert.strictEqual(read.signals.stateChanged, false);
	});

	test('repeating a call drops novelty and raises repetition', () => {
		const tracker = new ProgressTracker();
		const observation = step(1, [call('c1', 'grep', { pattern: 'x' })], [ok('c1', 'grep')]);
		const first = tracker.observe(observation);
		const second = tracker.observe({ ...observation, step: 2 });
		assert.strictEqual(first.signals.novelty, 1);
		assert.strictEqual(second.signals.novelty, 0);
		assert.strictEqual(second.signals.repetition, 1);
	});

	test('reading the same file at a different offset is not a new resource', () => {
		const tracker = new ProgressTracker();
		tracker.observe(step(1, [call('c1', 'read_file', { path: 'a.ts', offset: 0 })], [ok('c1', 'read_file')]));
		const second = tracker.observe(step(2, [call('c2', 'read_file', { path: 'a.ts', offset: 200 })], [ok('c2', 'read_file')]));
		assert.strictEqual(second.signals.novelty, 1, 'the call itself is new');
		assert.ok(second.signals.forward < 0.8, 'but no new resource was reached');
	});

	test('trips stuck after three barren steps and clears on a change', () => {
		const tracker = new ProgressTracker();
		let report = tracker.observe(barren(1));
		assert.strictEqual(report.barrenSteps, 1);
		assert.strictEqual(report.stuck, false);

		report = tracker.observe(barren(2));
		report = tracker.observe(barren(3));
		assert.strictEqual(report.stuck, true, `score ${report.score}`);
		assert.ok(/steps without a change/.test(report.reason));

		report = tracker.observe(step(4, [call('c9', 'edit_file', { path: 'a.ts' })], [ok('c9', 'edit_file')], { files: 1 }));
		assert.strictEqual(report.barrenSteps, 0);
		assert.strictEqual(report.stuck, false);
	});

	test('detects the doom loop on the third identical batch', () => {
		const tracker = new ProgressTracker();
		const observation = step(1, [call('c1', 'grep', { pattern: 'x' })], [ok('c1', 'grep')]);
		assert.strictEqual(tracker.observe(observation).doomLoop, false);
		assert.strictEqual(tracker.observe({ ...observation, step: 2 }).doomLoop, false);
		const third = tracker.observe({ ...observation, step: 3 });
		assert.strictEqual(third.doomLoop, true);
		assert.strictEqual(third.reason, 'Identical tool batch three times in a row.');
	});

	test('marks a failure repeated when the same one already happened', () => {
		const tracker = new ProgressTracker();
		const first = tracker.observe(step(1, [call('c1', 'read_file', { path: 'a.ts' })], [fail('c1', 'read_file', 'ENOENT: no such file, open \'a.ts\'')]));
		const second = tracker.observe(step(2, [call('c2', 'read_file', { path: 'b.ts' })], [fail('c2', 'read_file', 'ENOENT: no such file, open \'b.ts\'')]));
		assert.strictEqual(first.errors[0].repeated, false);
		assert.strictEqual(second.errors[0].repeated, true, 'same class and shape of message');
	});

	test('picks the most specific class when a step fails several ways', () => {
		const report = new ProgressTracker().observe(step(1,
			[call('c1', 'shell', { command: 'x' }), call('c2', 'shell', { command: 'y' })],
			[fail('c1', 'shell', 'ETIMEDOUT'), fail('c2', 'shell', 'AssertionError: expected 1 to equal 2')],
		));
		assert.strictEqual(report.dominantError, 'assertion');
		assert.strictEqual(report.signals.errorRate, 1);
	});

	test('accumulates token waste until something productive happens', () => {
		const tracker = new ProgressTracker({ wasteBudget: 1000 });
		tracker.observe({ ...barren(1), tokens: { input: 400, output: 100 } });
		const second = tracker.observe({ ...barren(2), tokens: { input: 400, output: 100 } });
		assert.ok(second.signals.tokenWaste >= 0.5, `waste ${second.signals.tokenWaste}`);

		const productive = tracker.observe({
			...step(3, [call('c9', 'edit_file', { path: 'a.ts' })], [ok('c9', 'edit_file')], { files: 1 }),
			tokens: { input: 400, output: 100 },
		});
		assert.strictEqual(productive.signals.tokenWaste, 0);
	});

	test('reset forgets history so a new approach is judged fresh', () => {
		const tracker = new ProgressTracker();
		const observation = step(1, [call('c1', 'grep', { pattern: 'x' })], [ok('c1', 'grep')]);
		tracker.observe(observation);
		tracker.observe({ ...observation, step: 2 });
		tracker.reset();
		const after = tracker.observe({ ...observation, step: 3 });
		assert.strictEqual(after.signals.novelty, 1);
		assert.strictEqual(after.doomLoop, false);
		assert.strictEqual(after.barrenSteps, 0);
	});
});

function step(
	index: number,
	calls: readonly IToolCall[],
	results: readonly IToolResult[],
	extra: { text?: string; files?: number } = {},
): IStepObservation {
	return {
		step: index,
		calls,
		results,
		assistantText: extra.text ?? '',
		filesChanged: extra.files ?? 0,
	};
}

/** A step that reads a file it has not read before and learns nothing actionable. */
function barren(index: number): IStepObservation {
	return step(index, [call(`c${index}`, 'read_file', { path: `f${index}.ts` })], [fail(`c${index}`, 'read_file', 'file is empty')]);
}

function call(id: string, name: string, args: unknown): IToolCall {
	return { id, name, args };
}

function ok(callId: string, name: string): IToolResult {
	return { callId, name, kind: 'read', text: 'ok' };
}

function fail(callId: string, name: string, text: string): IToolResult {
	return { callId, name, kind: 'read', text, isError: true };
}
