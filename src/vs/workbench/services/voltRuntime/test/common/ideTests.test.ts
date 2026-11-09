/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IDE_CAPABILITIES, ideGatewayDescription, ideHelp, ideOp, isIdeGatewayReadOnly } from '../../common/ide/ideCapabilities.js';
import { isIdeReadOnlyCall } from '../../common/ide/ideTools.js';
import { lineRanges, parseCoverage } from '../../common/ide/coverageReports.js';
import { formatCpuProfile, summarizeCpuProfile } from '../../common/ide/cpuProfile.js';
import { jsonPath, missingVariables, parseHttpEnvironments, parseHttpFile, resolveHttpVariables, serializeHttpRequest } from '../../common/ide/httpFile.js';
import { buildTestCommand, detectJsFramework, isJsTestPath, IStaticTest, parseGoTests, parseJsTests, parsePythonTests, parseRustTests, rustModulePath } from '../../common/ide/testFrameworks.js';
import { parseCargoText, parseExpectedActual, parseGoJson, parseJestJson, parseJunit, parseMochaJson, parseStack } from '../../common/ide/testReports.js';

function shape(tests: readonly IStaticTest[]): unknown[] {
	return tests.map(test => test.children.length ? { [test.name]: shape(test.children), line: test.line } : `${test.name}@${test.line}`);
}

suite('IDE tools: test discovery', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('JS: nested describe/it with modifiers, each and one-liners', () => {
		const text = [
			'import { describe, it, expect } from "vitest";',
			'describe("math", () => {',
			'  it("adds", () => {',
			'    expect(1 + 1).toBe(2); // }',
			'  });',
			'  describe.skip(\'nested\', () => {',
			'    test.each([1, 2])("handles %s", (n) => { expect(n).toBeTruthy(); });',
			'  });',
			'  it.only(`template`, async () => {});',
			'});',
			'test("top level", () => {});',
		].join('\n');
		assert.deepStrictEqual(shape(parseJsTests(text)), [
			{ math: ['adds@3', { nested: ['handles %s@7'], line: 6 }, 'template@9'], line: 2 },
			'top level@11',
		]);
		const [math] = parseJsTests(text);
		assert.strictEqual(math.endLine, 10);
		assert.strictEqual(math.children[0].endLine, 5);
	});

	test('Python: classes and functions by indentation', () => {
		const text = ['import pytest', '', 'def test_a():', '    assert 1', '', 'class TestThing:', '    def test_b(self):', '        pass', '    def helper(self):', '        pass', '', 'def helper():', '    pass', 'async def test_c():', '    pass'].join('\n');
		assert.deepStrictEqual(shape(parsePythonTests(text)), ['test_a@3', { TestThing: ['test_b@7'], line: 6 }, 'test_c@14']);
	});

	test('Go: TestX functions only', () => {
		const text = ['package x', 'func TestAdd(t *testing.T) {', '}', 'func Testing(t *testing.T) {}', 'func helper() {}', 'func BenchmarkAdd(b *testing.B) {}'].join('\n');
		assert.deepStrictEqual(shape(parseGoTests(text)), ['TestAdd@2']);
	});

	test('Rust: #[test] in mods, empty mods dropped', () => {
		const text = ['fn add() {}', '#[cfg(test)]', 'mod tests {', '    use super::*;', '    #[test]', '    fn adds() { assert_eq!(1, 1); }', '    #[tokio::test]', '    async fn async_adds() {}', '}', 'mod other {', '    fn not_a_test() {}', '}'].join('\n');
		assert.deepStrictEqual(shape(parseRustTests(text)), [{ tests: ['adds@6', 'async_adds@8'], line: 3 }]);
		assert.deepStrictEqual(rustModulePath('src/net/http.rs'), ['net', 'http']);
		assert.deepStrictEqual(rustModulePath('src/lib.rs'), []);
		assert.deepStrictEqual(rustModulePath('src/net/mod.rs'), ['net']);
		assert.deepStrictEqual(rustModulePath('tests/api.rs'), []);
	});

	test('framework detection and test paths', () => {
		assert.strictEqual(detectJsFramework(JSON.stringify({ devDependencies: { vitest: '^2' } })), 'vitest');
		assert.strictEqual(detectJsFramework(JSON.stringify({ scripts: { test: 'jest --ci' } })), 'jest');
		assert.strictEqual(detectJsFramework(JSON.stringify({ devDependencies: { mocha: '1' } })), 'mocha');
		assert.strictEqual(detectJsFramework(JSON.stringify({ dependencies: { react: '1' } })), undefined);
		assert.strictEqual(detectJsFramework('{ not json'), undefined);
		assert.ok(isJsTestPath('src/a.test.ts'));
		assert.ok(isJsTestPath('src/__tests__/a.ts'));
		assert.ok(isJsTestPath('test/unit/a.js'));
		assert.ok(!isJsTestPath('src/a.ts'));
		assert.ok(!isJsTestPath('node_modules/x/a.test.js'));
	});
});

suite('IDE tools: test commands', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('vitest: files plus an anchored name pattern', () => {
		const command = buildTestCommand('vitest', [{ file: 'src/a.test.ts', path: ['math', 'adds (1+1)'] }], { reportFile: '/tmp/r.json', windows: false });
		assert.strictEqual(command.command, `npx --no-install vitest run --reporter=json --outputFile=/tmp/r.json src/a.test.ts -t '^(?:math adds \\(1\\+1\\))$'`);
		assert.strictEqual(command.format, 'jest-json');
	});

	test('whole files run without a name filter; empty selection runs everything', () => {
		assert.ok(!buildTestCommand('jest', [{ file: 'a.test.js', path: [] }], { reportFile: 'r', windows: false }).command.includes(' -t '));
		assert.strictEqual(buildTestCommand('go', [], { reportFile: 'r.json', windows: false }).command, 'go test -json ./... > r.json');
	});

	test('pytest node ids, go -run, cargo --exact', () => {
		assert.strictEqual(buildTestCommand('pytest', [{ file: 'tests/test_a.py', path: ['TestX', 'test_b'] }], { reportFile: 'r.xml', windows: false, python: '.venv/bin/python' }).command, `.venv/bin/python -m pytest -q -rN --junitxml=r.xml tests/test_a.py::TestX::test_b`);
		assert.strictEqual(buildTestCommand('go', [{ file: 'pkg/a_test.go', path: ['TestA'] }], { reportFile: 'r', windows: false }).command, `go test -json -run '^(?:TestA)$' ./pkg > r`);
		assert.strictEqual(buildTestCommand('cargo', [{ file: 'src/lib.rs', path: ['tests', 'adds'] }], { reportFile: 'r', windows: false }).command, 'cargo test --no-fail-fast -- tests::adds --exact > r');
	});
});

suite('IDE tools: reports', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('jest/vitest json with a failure and a file error', () => {
		const report = parseJestJson(JSON.stringify({
			testResults: [
				{
					name: '/p/src/a.test.ts', assertionResults: [
						{ ancestorTitles: ['math'], title: 'adds', status: 'passed', duration: 3 },
						{ ancestorTitles: ['math'], title: 'subtracts', status: 'failed', failureMessages: ['\u001b[31mError: expect(received).toBe(expected)\n\nExpected: 1\nReceived: -1\n    at Object.<anonymous> (/p/src/a.test.ts:9:21)\n    at /p/node_modules/vitest/x.js:1:1'], location: { line: 8 } },
						{ ancestorTitles: [], title: 'later', status: 'todo' },
					],
				},
				{ name: '/p/src/b.test.ts', assertionResults: [], message: 'SyntaxError: Unexpected token' },
			],
		}));
		assert.strictEqual(report.outcomes.length, 3);
		const failed = report.outcomes[1];
		assert.deepStrictEqual(failed.path, ['math', 'subtracts']);
		assert.strictEqual(failed.state, 'failed');
		assert.strictEqual(failed.expected, '1');
		assert.strictEqual(failed.actual, '-1');
		assert.deepStrictEqual(failed.stack, [{ path: '/p/src/a.test.ts', line: 9, column: 21, label: 'Object.<anonymous>' }]);
		assert.strictEqual(failed.line, 8);
		assert.strictEqual(report.outcomes[2].state, 'skipped');
		assert.deepStrictEqual(report.errors, [{ file: '/p/src/b.test.ts', message: 'SyntaxError: Unexpected token' }]);
	});

	test('mocha json', () => {
		const report = parseMochaJson(JSON.stringify({ tests: [{ title: 'b', fullTitle: 'outer a b', file: '/p/t.js', duration: 2, err: {} }, { title: 'c', fullTitle: 'c', err: { message: 'boom', stack: 'AssertionError: boom\n    at Context.<anonymous> (t.js:4:5)', expected: 2, actual: 3 } }] }));
		assert.deepStrictEqual(report.outcomes[0].path, ['outer a', 'b']);
		assert.strictEqual(report.outcomes[0].state, 'passed');
		assert.strictEqual(report.outcomes[1].state, 'failed');
		assert.strictEqual(report.outcomes[1].expected, '2');
		assert.strictEqual(report.outcomes[1].actual, '3');
	});

	test('junit (pytest)', () => {
		const xml = `<testsuite><testcase classname="tests.test_a.TestX" name="test_b" file="tests/test_a.py" line="6" time="0.01"><failure message="assert 1 == 2">def test_b():
&gt;       assert 1 == 2
E       assert 1 == 2

tests/test_a.py:8: AssertionError</failure></testcase><testcase classname="tests.test_a" name="test_c" time="0"><skipped/></testcase><testcase classname="tests.test_a" name="test_d[1]" time="0"/></testsuite>`;
		const report = parseJunit(xml);
		assert.deepStrictEqual(report.outcomes.map(item => [item.path.join('::'), item.state]), [['TestX::test_b', 'failed'], ['test_c', 'skipped'], ['test_d[1]', 'passed']]);
		assert.strictEqual(report.outcomes[0].line, 7);
		assert.strictEqual(report.outcomes[0].actual, '1');
		assert.deepStrictEqual(report.outcomes[0].stack?.[0], { path: 'tests/test_a.py', line: 8 });
	});

	test('go -json folds subtests and reports build failures', () => {
		const lines = [
			{ Action: 'run', Package: 'm/pkg', Test: 'TestA' },
			{ Action: 'output', Package: 'm/pkg', Test: 'TestA/sub', Output: '    a_test.go:12: got 1 want 2\n' },
			{ Action: 'fail', Package: 'm/pkg', Test: 'TestA/sub', Elapsed: 0 },
			{ Action: 'fail', Package: 'm/pkg', Test: 'TestA', Elapsed: 0.01 },
			{ Action: 'pass', Package: 'm/pkg', Test: 'TestB', Elapsed: 0 },
			{ Action: 'output', Package: 'm/broken', Output: '# m/broken\nbroken/x.go:3:1: undefined: foo\n' },
			{ Action: 'fail', Package: 'm/broken', Elapsed: 0 },
		].map(line => JSON.stringify(line)).join('\n');
		const report = parseGoJson(lines);
		assert.deepStrictEqual(report.outcomes.map(item => [item.path[0], item.state]), [['TestA', 'failed'], ['TestB', 'passed']]);
		assert.ok(report.outcomes[0].message?.includes('got 1 want 2'));
		assert.strictEqual(report.errors.length, 1);
	});

	test('cargo text', () => {
		const text = ['running 2 tests', 'test tests::adds ... ok', 'test tests::subs ... FAILED', '', 'failures:', '', '---- tests::subs stdout ----', 'thread \'tests::subs\' panicked at src/lib.rs:10:9:', 'assertion `left == right` failed', '  left: 1', ' right: 2', '', 'failures:', '    tests::subs', '', 'test result: FAILED. 1 passed; 1 failed'].join('\n');
		const report = parseCargoText(text);
		assert.deepStrictEqual(report.outcomes.map(item => [item.path.join('::'), item.state]), [['tests::adds', 'passed'], ['tests::subs', 'failed']]);
		assert.strictEqual(report.outcomes[1].expected, '2');
		assert.strictEqual(report.outcomes[1].actual, '1');
	});

	test('stack frames skip libraries; expected/actual shapes', () => {
		assert.deepStrictEqual(parseStack('at fn (/x/node_modules/a.js:1:1)\nat run (src/a.ts:3:4)\nat node:internal/x:1:1'), [{ path: 'src/a.ts', line: 3, column: 4, label: 'run' }]);
		assert.deepStrictEqual(parseExpectedActual('AssertionError: expected 3 to equal 4'), { expected: '4', actual: '3' });
	});

	test('read-only ops skip approval', () => {
		assert.ok(isIdeReadOnlyCall('tests', { op: 'list' }));
		assert.ok(!isIdeReadOnlyCall('tests', { op: 'run' }));
		assert.ok(isIdeReadOnlyCall('debug', { op: 'breakpoints' }));
		assert.ok(!isIdeReadOnlyCall('debug', { op: 'breakpoints', action: 'set' }));
		assert.ok(!isIdeReadOnlyCall('debug', { op: 'evaluate' }));
		assert.ok(!isIdeReadOnlyCall('shell', { op: 'list' }));
	});
});

suite('IDE tools: gateway, coverage, profiles, .http', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('gateway description lists every capability; read-only and confirm ops', () => {
		const description = ideGatewayDescription();
		for (const capability of IDE_CAPABILITIES) {
			assert.ok(description.includes(`${capability.id} (`), capability.id);
		}
		assert.ok(isIdeGatewayReadOnly({ capability: 'docker', op: 'logs' }));
		assert.ok(isIdeGatewayReadOnly({ capability: 'k8s', op: 'help' }));
		assert.ok(!isIdeGatewayReadOnly({ capability: 'docker', op: 'restart' }));
		assert.ok(isIdeGatewayReadOnly({ capability: 'git', op: 'stash', args: { action: 'list' } }));
		assert.ok(!isIdeGatewayReadOnly({ capability: 'git', op: 'stash', args: { action: 'pop' } }));
		assert.ok(isIdeReadOnlyCall('ide', { capability: 'coverage', op: 'report' }));
		assert.ok(ideOp('k8s', 'delete')?.confirm);
		assert.ok(ideHelp('http')?.includes('send'));
	});

	test('coverage: istanbul, lcov, cobertura, go', () => {
		const istanbul = parseCoverage('coverage-final.json', JSON.stringify({ '/p/a.ts': { path: '/p/a.ts', s: { 0: 1, 1: 0, 2: 3 }, statementMap: { 0: { start: { line: 1 } }, 1: { start: { line: 2 } }, 2: { start: { line: 4 } } } } }));
		assert.deepStrictEqual(istanbul, [{ path: '/p/a.ts', covered: 2, total: 3, uncovered: [2] }]);
		assert.deepStrictEqual(parseCoverage('lcov.info', 'SF:src/a.ts\nDA:1,1\nDA:2,0\nDA:3,0\nend_of_record\n'), [{ path: 'src/a.ts', covered: 1, total: 3, uncovered: [2, 3] }]);
		assert.deepStrictEqual(parseCoverage('coverage.xml', '<class filename="a.py"><lines><line number="1" hits="1"/><line number="5" hits="0"/></lines></class>'), [{ path: 'a.py', covered: 1, total: 2, uncovered: [5] }]);
		assert.deepStrictEqual(parseCoverage('coverage.out', 'mode: set\nm/a.go:3.1,4.2 2 0\nm/a.go:6.1,6.9 1 1\n'), [{ path: 'm/a.go', covered: 1, total: 3, uncovered: [3, 4] }]);
		assert.strictEqual(lineRanges([1, 2, 3, 7, 9, 10]), '1-3, 7, 9-10');
	});

	test('cpu profile: self and total time merged per function', () => {
		const profile = {
			startTime: 0, endTime: 30_000,
			nodes: [
				{ id: 1, callFrame: { functionName: '(root)', url: '', lineNumber: -1 }, children: [2] },
				{ id: 2, callFrame: { functionName: 'main', url: 'file:///p/a.js', lineNumber: 0 }, children: [3, 4] },
				{ id: 3, callFrame: { functionName: 'hot', url: 'file:///p/a.js', lineNumber: 9 } },
				{ id: 4, callFrame: { functionName: '(garbage collector)', url: '', lineNumber: -1 } },
			],
			samples: [3, 3, 2, 4],
			timeDeltas: [0, 10_000, 10_000, 5_000, 5_000],
		};
		const summary = summarizeCpuProfile(JSON.stringify(profile));
		assert.strictEqual(summary.bySelf[0].name, 'hot');
		assert.strictEqual(summary.bySelf[0].location, '/p/a.js:10');
		assert.strictEqual(summary.byTotal[0].name, 'main');
		assert.ok(summary.byTotal[0].totalMs > summary.bySelf[0].selfMs);
		assert.ok(summary.gcMs > 0);
		assert.ok(formatCpuProfile(summary).includes('Hottest by self time'));
	});

	test('.http files: requests, names, variables, chaining, environments', () => {
		const file = parseHttpFile([
			'@host = https://api.test',
			'',
			'### Login',
			'# @name login',
			'POST {{host}}/login HTTP/1.1',
			'Content-Type: application/json',
			'',
			'{ "user": "a" }',
			'',
			'###',
			'GET {{host}}/me',
			'    ?verbose=1',
			'Authorization: Bearer {{login.response.body.$.token}}',
		].join('\n'));
		assert.deepStrictEqual(file.variables, { host: 'https://api.test' });
		assert.strictEqual(file.requests.length, 2);
		assert.deepStrictEqual({ name: file.requests[0].name, method: file.requests[0].method, body: file.requests[0].body, line: file.requests[0].line }, { name: 'login', method: 'POST', body: '{ "user": "a" }', line: 5 });
		assert.strictEqual(file.requests[1].url, '{{host}}/me?verbose=1');
		const responses = new Map([['login', { status: 200, statusText: 'OK', headers: {}, body: '{"token":"abc"}', durationMs: 1, size: 15 }]]);
		const scope = { file: file.variables, env: {}, responses };
		assert.strictEqual(resolveHttpVariables(file.requests[1].headers[0][1], scope), 'Bearer abc');
		assert.strictEqual(resolveHttpVariables('{{host}}/x/{{missing}}', scope), 'https://api.test/x/{{missing}}');
		assert.deepStrictEqual(missingVariables('{{a}} {{ b }} {{a}}'), ['a', 'b']);
		assert.deepStrictEqual(parseHttpEnvironments('{"$shared":{"v":"1"},"dev":{"host":"localhost"}}', '{"dev":{"token":"t"}}'), { dev: { v: '1', host: 'localhost', token: 't' } });
		assert.strictEqual(serializeHttpRequest(file.requests[0]), '# @name login\nPOST {{host}}/login\nContent-Type: application/json\n\n{ "user": "a" }');
		assert.strictEqual(jsonPath({ a: [{ b: 2 }] }, '$.a[0].b'), 2);
	});
});
