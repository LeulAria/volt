/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import {
	DEFAULT_EVERY_MS, formatJobClock, formatJobDuration, IJobWatchSpec, jobWakeEnd, jobWakeMessage, judgeJobCheck, latestOutputLine, parseEvery, parseJobWatchArgs, progressOf,
} from '../../../common/jobs/jobWatch.js';

function spec(args: Record<string, unknown>): IJobWatchSpec {
	const parsed = parseJobWatchArgs(args);
	assert.ok(!('error' in parsed), 'error' in parsed ? parsed.error : '');
	return parsed;
}

const run = (output: string, exitCode: number | null = 0, extra: { timedOut?: boolean; alive?: boolean } = {}) => ({ output, exitCode, timedOut: !!extra.timedOut, ...(extra.alive !== undefined ? { alive: extra.alive } : {}) });

suite('Volt watched jobs', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('reads the check interval the way agents write it', () => {
		assert.strictEqual(parseEvery(3), 3000);
		assert.strictEqual(parseEvery('3s'), 3000);
		assert.strictEqual(parseEvery('every 3 seconds'), 3000);
		assert.strictEqual(parseEvery('2 min'), 120_000);
		assert.strictEqual(parseEvery('soon'), undefined);
		assert.strictEqual(spec({ title: 'Bench', check: 'true' }).everyMs, DEFAULT_EVERY_MS);
		assert.strictEqual(spec({ title: 'Bench', check: 'true', every: 'every 3 seconds' }).everyMs, 3000);
		assert.strictEqual(spec({ title: 'Bench', check: 'true', every_s: 1 }).everyMs, 2000, 'at least 2s apart');
	});

	test('needs a check or a pid, and valid patterns', () => {
		assert.ok('error' in parseJobWatchArgs({ title: 'Bench' }));
		assert.ok('error' in parseJobWatchArgs({ title: 'Bench', check: 'x', done_pattern: '(' }));
		assert.ok('error' in parseJobWatchArgs({ title: 'Bench', pid: -3 }));
		assert.strictEqual(spec({ pid: '4242' }).pid, 4242);
		assert.strictEqual(spec({ title: 'say "hi"', check: 'x' }).title, 'say \'hi\'', 'quotes would break the notice');
		assert.strictEqual(spec({ title: 'Bench', check: 'x', wake: false }).wake, false);
	});

	test('without a pid or done_pattern, exit 0 means done', () => {
		const watch = spec({ title: 'Bench', check: 'test -f out/done' });
		assert.strictEqual(judgeJobCheck(watch, run('', 1)).state, 'running');
		assert.strictEqual(judgeJobCheck(watch, run('', 0)).state, 'done');
		assert.strictEqual(judgeJobCheck(watch, run('zsh: command not found: tset', 127)).state, 'broken');
		assert.strictEqual(judgeJobCheck(watch, run('', null, { timedOut: true })).state, 'broken');
	});

	test('done_pattern and fail_pattern read the output, not the exit code', () => {
		const watch = spec({ title: 'CI', check: 'gh run view 1 --json status -q .status', done_pattern: '^completed', fail_pattern: 'failure' });
		assert.strictEqual(judgeJobCheck(watch, run('in_progress')).state, 'running');
		assert.strictEqual(judgeJobCheck(watch, run('completed')).state, 'done');
		assert.strictEqual(judgeJobCheck(watch, run('completed failure')).state, 'failed');
	});

	test('with a pid, the job is done when the process is gone; the check only shows progress', () => {
		const watch = spec({ title: 'Bench', check: 'tail -n 1 bench.log', pid: 4242 });
		const live = judgeJobCheck(watch, run('python primes: run 3 of 5', 0, { alive: true }));
		assert.strictEqual(live.state, 'running');
		assert.strictEqual(live.line, 'python primes: run 3 of 5');
		assert.strictEqual(live.progress, 0.6);
		assert.strictEqual(judgeJobCheck(watch, run('all done', 0, { alive: false })).state, 'done');
		assert.strictEqual(judgeJobCheck(spec({ pid: 4242 }), run('', 1, { alive: true })).state, 'running');
	});

	test('a JSON line carries status, progress and the end', () => {
		const watch = spec({ title: 'Train', check: 'cat status.json', done_pattern: 'never' });
		const mid = judgeJobCheck(watch, run('{"status":"epoch 4","progress":0.4}'));
		assert.deepStrictEqual([mid.state, mid.line, mid.progress], ['running', 'epoch 4', 0.4]);
		assert.strictEqual(judgeJobCheck(watch, run('{"percent":1}')).progress, 0.01);
		assert.strictEqual(judgeJobCheck(watch, run('{"done":true}')).state, 'done');
		const failed = judgeJobCheck(watch, run('{"error":"CUDA out of memory"}'));
		assert.deepStrictEqual([failed.state, failed.reason], ['failed', 'CUDA out of memory']);
	});

	test('progress from a line, but not from dates or paths', () => {
		assert.strictEqual(progressOf('Downloading 45%'), 0.45);
		assert.strictEqual(progressOf('[3/8] go'), 3 / 8);
		assert.strictEqual(progressOf('run 5/10: primes in 15ms'), 0.5, 'a colon after the count, as bench scripts print');
		assert.strictEqual(progressOf('started 5/10:30'), undefined, 'a time is not a count');
		assert.strictEqual(progressOf('2026/11/06 12:00 started'), undefined);
		assert.strictEqual(progressOf('wrote out/1/2'), undefined);
		assert.strictEqual(progressOf('no numbers here'), undefined);
	});

	test('colour codes and carriage-return redraws are cleaned off', () => {
		assert.deepStrictEqual(latestOutputLine('start\n\u001b[32m 10%\r 55%\u001b[0m\n'), { line: '55%', progress: 0.55 });
		assert.deepStrictEqual(latestOutputLine('\n\n'), {});
	});

	test('clocks and durations', () => {
		assert.strictEqual(formatJobClock(7_000), '0:07');
		assert.strictEqual(formatJobClock(134_000), '2:14');
		assert.strictEqual(formatJobClock(3_734_000), '1:02:14');
		assert.strictEqual(formatJobDuration(12_000), '12s');
		assert.strictEqual(formatJobDuration(134_000), '2m 14s');
		assert.strictEqual(formatJobDuration(3_900_000), '1h 5m');
	});

	test('the wake message tells the agent to report, and reads back its end', () => {
		const done = jobWakeMessage({ id: 'job-1', title: 'Benchmark', end: 'done', durationMs: 134_000, check: 'tail -n 1 bench.log', output: 'node 1.2s\npython 3.4s' });
		assert.strictEqual(done.summary, 'Benchmark finished · 2m 14s');
		assert.ok(done.text.includes('python 3.4s'));
		assert.ok(done.text.includes('give them what you said you would'));
		assert.strictEqual(jobWakeEnd(done.text), 'done');
		const failed = jobWakeMessage({ id: 'task', title: 'Run bench', end: 'failed', durationMs: 5_000, agentTask: true, exitCode: 1, outputFile: '/tmp/x.output' });
		assert.ok(failed.text.includes('exit 1') && failed.text.includes('/tmp/x.output'));
		assert.strictEqual(jobWakeEnd(failed.text), 'failed');
		assert.strictEqual(jobWakeEnd(jobWakeMessage({ id: 'job-2', title: 'CI', end: 'timedOut', durationMs: 7_200_000 }).text), 'timedOut');
		assert.strictEqual(jobWakeEnd(jobWakeMessage({ id: 'job-3', title: 'CI', end: 'broken', durationMs: 60_000 }).text), 'broken');
		assert.strictEqual(jobWakeEnd('[Volt] Update on pull request #3'), undefined);
	});
});
