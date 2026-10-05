/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { decideContinuation, formatRegressionNudge, isSameCommand, mayMutateWorkspace, openTodos, parseCheckOutput, regressionVerdict } from '../../../common/harness/verification.js';

/** Real `npm test` output of the bench fixture (Node 25 spec reporter, piped): one test already fails. */
const NODE_BEFORE = [
	'> bench-app@1.0.0 test',
	'> node --test',
	'',
	'✔ mean (0.339208ms)',
	'✔ median of odd count (0.064583ms)',
	'✖ median sorts numerically (0.34475ms)',
	'✔ variance (0.060958ms)',
	'ℹ tests 4',
	'ℹ pass 3',
	'ℹ fail 1',
	'',
	'✖ failing tests:',
	'',
	'test at test/stats.test.js:14:1',
	'✖ median sorts numerically (0.34475ms)',
	'  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:',
].join('\n');

const NODE_AFTER_REGRESSED = [
	'✔ mean (0.3ms)',
	'✖ median of odd count (0.1ms)',
	'✖ median sorts numerically (0.3ms)',
	'✔ variance (0.06ms)',
	'✖ stats variance endpoint (2ms)',
	'ℹ tests 5',
	'ℹ pass 2',
	'ℹ fail 3',
].join('\n');

suite('Regression gate', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('parses node:test spec output, without durations and with the failing summary deduplicated', () => {
		const report = parseCheckOutput('npm test', NODE_BEFORE, 1, 900);
		assert.deepStrictEqual(report.failed, ['median sorts numerically']);
		assert.deepStrictEqual(report.passed, ['mean', 'median of odd count', 'variance']);
		assert.deepStrictEqual(report.counts, { pass: 3, fail: 1 });
		assert.strictEqual(report.ok, false);
		assert.strictEqual(report.parsed, true);
		assert.ok(report.tail.includes('AssertionError'));
	});

	test('parses TAP, Jest, pytest, go and cargo names', () => {
		const tap = parseCheckOutput('npm test', 'ok 1 - adds\nnot ok 2 - subtracts\nok 3 - skipped one # SKIP\n# pass 2\n# fail 1', 1);
		assert.deepStrictEqual(tap.failed, ['subtracts']);
		assert.deepStrictEqual(tap.passed, ['adds', 'skipped one']);

		const jest = parseCheckOutput('npx jest', '  ✓ renders (5 ms)\n  ✕ submits (12 ms)\nTests:       1 failed, 1 passed, 2 total', 1);
		assert.deepStrictEqual(jest.failed, ['submits']);
		assert.deepStrictEqual(jest.counts, { pass: 1, fail: 1 });

		const pytest = parseCheckOutput('pytest', 'FAILED tests/test_api.py::test_login - assert 401 == 200\n===== 1 failed, 4 passed in 0.31s =====', 1);
		assert.deepStrictEqual(pytest.failed, ['tests/test_api.py::test_login']);
		assert.deepStrictEqual(pytest.counts, { pass: 4, fail: 1 });

		const go = parseCheckOutput('go test ./...', '--- PASS: TestA (0.00s)\n--- FAIL: TestB (0.01s)\nFAIL\tpkg', 1);
		assert.deepStrictEqual([go.passed, go.failed], [['TestA'], ['TestB']]);

		const cargo = parseCheckOutput('cargo test', 'test a::works ... ok\ntest a::breaks ... FAILED\ntest result: FAILED. 1 passed; 1 failed', 101);
		assert.deepStrictEqual([cargo.passed, cargo.failed, cargo.counts], [['a::works'], ['a::breaks'], { pass: 1, fail: 1 }]);
	});

	test('strips ANSI colors and judges an unknown exit code by the counts', () => {
		const report = parseCheckOutput('npm test', '\u001b[32m✔ fine (1ms)\u001b[39m\nℹ pass 1\nℹ fail 0', null);
		assert.deepStrictEqual(report.passed, ['fine']);
		assert.strictEqual(report.ok, true);
	});

	test('a failure that already existed before the run is not a regression', () => {
		const before = parseCheckOutput('npm test', NODE_BEFORE, 1);
		const after = parseCheckOutput('npm test', NODE_BEFORE, 1);
		assert.deepStrictEqual(regressionVerdict(before, after), { regressed: false, kind: 'none', newFailures: [] });
	});

	test('names tests that passed before (or are new) and fail now', () => {
		const before = parseCheckOutput('npm test', NODE_BEFORE, 1);
		const after = parseCheckOutput('npm test', NODE_AFTER_REGRESSED, 1);
		const verdict = regressionVerdict(before, after);
		assert.strictEqual(verdict.kind, 'tests');
		assert.deepStrictEqual(verdict.newFailures, ['median of odd count', 'stats variance endpoint']);
		const nudge = formatRegressionNudge(verdict, after);
		assert.ok(nudge.includes('- median of odd count'));
		assert.ok(nudge.includes('do not weaken, skip or delete tests'));
	});

	test('falls back to suite and count comparisons when names are missing', () => {
		const passing = parseCheckOutput('make check', 'all good', 0);
		const broken = parseCheckOutput('make check', 'Segmentation fault', 2);
		assert.strictEqual(regressionVerdict(passing, broken).kind, 'suite');

		const fewer = parseCheckOutput('npm test', '2 passing\n1 failing', 1);
		const more = parseCheckOutput('npm test', '1 passing\n2 failing', 1);
		assert.strictEqual(regressionVerdict(fewer, more).kind, 'count');
		assert.strictEqual(regressionVerdict(more, fewer).regressed, false);
	});

	test('never acts without a baseline, or on a timeout', () => {
		const after = parseCheckOutput('npm test', NODE_AFTER_REGRESSED, 1);
		assert.strictEqual(regressionVerdict(undefined, after).kind, 'unknown');
		const timedOut = parseCheckOutput('npm test', '', null, 120_000, true);
		assert.strictEqual(regressionVerdict(parseCheckOutput('npm test', NODE_BEFORE, 1), timedOut).regressed, false);
		assert.strictEqual(regressionVerdict(timedOut, after).regressed, false);
	});

	test('a passing check after the run is never a regression', () => {
		assert.strictEqual(regressionVerdict(undefined, parseCheckOutput('npm test', '✔ a (1ms)', 0)).kind, 'none');
	});

	test('continues once per reason, never in Ask or Plan', () => {
		const before = parseCheckOutput('npm test', NODE_BEFORE, 1);
		const after = parseCheckOutput('npm test', NODE_AFTER_REGRESSED, 1);
		const verdict = regressionVerdict(before, after);
		const todos = [{ content: 'Add tests', status: 'pending' }, { content: 'Wire route', status: 'completed' }];

		assert.strictEqual(decideContinuation({ writes: false, verdict, after, todos, used: { regression: false, todos: false } }).message, undefined);

		const both = decideContinuation({ writes: true, verdict, after, todos, used: { regression: false, todos: false } });
		assert.deepStrictEqual(both.reasons, ['regression', 'todos']);
		assert.ok(both.message?.includes('- Add tests'));
		assert.ok(!both.message?.includes('Wire route'));
		assert.ok(both.notice?.startsWith('2 tests that passed before now fail and 1 to-do is still open'));

		const again = decideContinuation({ writes: true, verdict, after, todos, used: { regression: true, todos: true } });
		assert.strictEqual(again.message, undefined);

		const clean = decideContinuation({ writes: true, verdict: regressionVerdict(before, before), after: before, todos: [], used: { regression: false, todos: false } });
		assert.strictEqual(clean.message, undefined);
	});

	test('open to-dos are the pending and in-progress ones', () => {
		assert.deepStrictEqual(openTodos([{ content: 'a', status: 'in_progress' }, { content: 'b', status: 'completed' }, { content: ' ', status: 'pending' }]), ['a']);
		assert.deepStrictEqual(openTodos(undefined), []);
	});

	test('knows which commands only look at the workspace', () => {
		assert.strictEqual(mayMutateWorkspace('ls -la src'), false);
		assert.strictEqual(mayMutateWorkspace('git status --porcelain'), false);
		assert.strictEqual(mayMutateWorkspace('cat a.txt > b.txt'), true);
		assert.strictEqual(mayMutateWorkspace('npm install lodash'), true);
		assert.strictEqual(mayMutateWorkspace('sed -i s/a/b/ x.js'), true);
		assert.ok(isSameCommand('npm  test', 'NPM test'));
		assert.ok(!isSameCommand('npm test -- a.test.js', 'npm test'));
	});
});
