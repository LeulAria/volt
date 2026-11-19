/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { parseLcovDetailed } from '../../common/ide/coverageReports.js';
import { commandNotFound, describeMissing, IFolderProbe, IStaticTest, ITestSelection } from '../../common/ide/testAdapter.js';
import { cmakeInfo, cppTestFlavor, ctestPattern, parseCppTests } from '../../common/ide/testAdapterCpp.js';
import { dotnetFilter, parseCsharpTests } from '../../common/ide/testAdapterDotnet.js';
import { cargoPackageName } from '../../common/ide/testAdapterGoRust.js';
import { jsNamePattern, parseJsTests, playwrightTestDir } from '../../common/ide/testAdapterJs.js';
import { gradleFilters, parseJvmTests, surefireFilter } from '../../common/ide/testAdapterJvm.js';
import { isUnittestOnly, parsePythonTests } from '../../common/ide/testAdapterPython.js';
import { buildTestCommand, detectTestProjects, familyOf, isTestMarker, resolveTestProject, TEST_ADAPTERS, testAdapter, testFileSearches } from '../../common/ide/testFrameworks.js';
import { ITestOutcome, ITestReport, parseCompileErrors, parseGtestText, parseTestReport, parseXml } from '../../common/ide/testReports.js';
import { createTestStream, TestStreamEvent } from '../../common/ide/testStreams.js';
import * as recorded from './testRecordings.js';

function shape(tests: readonly IStaticTest[]): unknown[] {
	return tests.map(test => test.children.length ? { [test.name]: shape(test.children) } : test.name);
}

function probe(files: Record<string, string>): IFolderProbe {
	return { files: new Map(Object.entries(files)) };
}

/** The project a file resolves to in a tree of folders with marker files (folder path to its files). */
function projectOf(file: string, tree: Record<string, Record<string, string>>): string | undefined {
	const family = familyOf(file);
	if (!family) {
		return undefined;
	}
	const segments = file.split('/').slice(0, -1);
	const folders = [];
	for (let depth = segments.length; depth >= 0; depth--) {
		const path = segments.slice(0, depth).join('/');
		folders.push({ path, projects: tree[path] ? detectTestProjects(family, probe(tree[path])) : [] });
	}
	const resolved = resolveTestProject(file, folders);
	return resolved ? `${resolved.adapter.id}@${resolved.root || '.'}` : undefined;
}

function states(report: ITestReport): string[] {
	return report.outcomes.map(outcome => `${outcome.state} ${outcome.path.join(' > ')}${outcome.variant ? ` ${outcome.variant}` : ''}`);
}

function failed(report: ITestReport, name: string): ITestOutcome {
	const outcome = report.outcomes.find(item => item.path.at(-1) === name && (item.state === 'failed' || item.state === 'errored'));
	assert.ok(outcome, `no failure named ${name}`);
	return outcome;
}

/** What a stream reader says of an output fed in pieces of `size` characters. */
function streamed(format: Parameters<typeof createTestStream>[0], output: string, size = 37): { events: string[]; display: string | undefined } {
	const stream = createTestStream(format)!;
	const events: TestStreamEvent[] = [];
	let display: string | undefined;
	// The recordings end where they were cut: the last line gets its end.
	const text = output.endsWith('\n') ? output : `${output}\n`;
	for (let index = 0; index < text.length; index += size) {
		const read = stream.push(text.slice(index, index + size));
		events.push(...read.events);
		if (read.display !== undefined) {
			display = (display ?? '') + read.display;
		}
	}
	return { events: events.map(event => `${event.type === 'started' ? 'started' : event.state} ${event.test.path.join(' > ')}${event.test.variant ? ` ${event.test.variant}` : ''}`), display };
}

const posix = { reportFile: '/tmp/r', windows: false };
const windows = { reportFile: 'C:\\Temp\\r', windows: true };
const select = (file: string, path: string[] = [], extra: Partial<ITestSelection> = {}): ITestSelection => ({ file, path, ...extra });

suite('Volt test adapters: the table', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('every adapter is complete: label, globs, markers, a command for everything, and a debug answer', () => {
		for (const adapter of TEST_ADAPTERS) {
			assert.ok(adapter.label && adapter.globs.length && adapter.markers.length, adapter.id);
			const command = adapter.command([], posix);
			assert.ok(command.command && command.format && command.report, adapter.id);
			if (adapter.debug) {
				const plan = adapter.debug([select('a', ['x'])], { ...posix, cwd: '/p' });
				assert.ok(typeof plan === 'string' ? plan.length > 20 : plan.type && plan.extension, adapter.id);
			}
		}
		assert.deepStrictEqual(TEST_ADAPTERS.map(adapter => adapter.id), ['playwright', 'vitest', 'jest', 'mocha', 'node', 'bun', 'pytest', 'unittest', 'go', 'cargo', 'ctest', 'dotnet', 'maven', 'gradle']);
	});

	test('files map to a language family by name; searches split by name and by content', () => {
		assert.strictEqual(familyOf('src/a.test.ts'), 'js');
		assert.strictEqual(familyOf('src/a.ts'), undefined);
		assert.strictEqual(familyOf('tests/test_a.py'), 'python');
		assert.strictEqual(familyOf('pkg/a_test.go'), 'go');
		assert.strictEqual(familyOf('pkg/a.go'), undefined);
		assert.strictEqual(familyOf('src/lib.rs'), 'rust');
		assert.strictEqual(familyOf('tests/math_test.cpp'), 'cpp');
		assert.strictEqual(familyOf('Shop.Tests/CartTests.cs'), 'dotnet');
		assert.strictEqual(familyOf('Shop.Tests/obj/Debug/x.cs'), undefined);
		assert.strictEqual(familyOf('src/test/java/com/shop/CartTest.java'), 'jvm');
		assert.strictEqual(familyOf('src/test/kotlin/com/shop/CartSpec.kt'), 'jvm');
		assert.strictEqual(familyOf('src/main/java/com/shop/Cart.java'), undefined);
		const searches = testFileSearches();
		assert.ok(searches.byName.includes('**/*_test.go'));
		assert.deepStrictEqual(searches.byContent.map(search => search.family), ['rust', 'cpp', 'dotnet']);
		for (const search of searches.byContent) {
			assert.doesNotThrow(() => new RegExp(search.pattern, 'm'));
		}
		assert.ok(isTestMarker('package.json') && isTestMarker('Shop.Tests.csproj') && isTestMarker('go.mod') && !isTestMarker('README.md'));
	});

	test('a missing tool reads as one line: what, for which interpreter and project, and the install command', () => {
		assert.strictEqual(
			describeMissing({ what: 'pytest', for: '/p/.venv/bin/python', install: '/p/.venv/bin/python -m pip install pytest' }, 'api'),
			'The tests did not start: pytest is not installed for /p/.venv/bin/python (project api). Install it with: /p/.venv/bin/python -m pip install pytest');
		assert.strictEqual(commandNotFound('zsh:1: command not found: dotnet\n', 127), 'dotnet');
		assert.strictEqual(commandNotFound('/bin/sh: mvn: command not found\n', 127), 'mvn');
		assert.strictEqual(commandNotFound('\'cmake\' is not recognized as an internal or external command,\r\noperable program or batch file.', 9009), 'cmake');
		assert.strictEqual(commandNotFound('all good', 0), undefined);
	});
});

suite('Volt test adapters: JavaScript and TypeScript', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('detection: config files, dependencies, scripts; a package\'s own framework wins over its monorepo root\'s', () => {
		const tree = {
			'': { 'package.json': JSON.stringify({ workspaces: ['packages/*'], devDependencies: { jest: '^29' } }), 'pnpm-workspace.yaml': '', 'turbo.json': '{}' },
			'packages/web': { 'package.json': JSON.stringify({ devDependencies: { vitest: '^3' } }) },
			'packages/plain': { 'package.json': JSON.stringify({ name: 'plain' }) },
			'packages/api': { 'package.json': JSON.stringify({ scripts: { test: 'node --import tsx --test' } }) },
			'packages/edge': { 'package.json': JSON.stringify({ name: 'edge' }), 'bun.lock': '' },
			'packages/cfg': { 'package.json': JSON.stringify({ name: 'cfg' }), 'vitest.config.ts': 'export default {}' },
		};
		assert.strictEqual(projectOf('packages/web/src/a.test.ts', tree), 'vitest@packages/web');
		assert.strictEqual(projectOf('packages/plain/src/a.test.ts', tree), 'jest@.', 'a package without a framework runs under the root\'s (jest projects)');
		assert.strictEqual(projectOf('packages/api/test/a.test.ts', tree), 'node@packages/api');
		assert.strictEqual(projectOf('packages/edge/a.test.ts', tree), 'bun@packages/edge');
		assert.strictEqual(projectOf('packages/cfg/a.spec.ts', tree), 'vitest@packages/cfg');
		assert.strictEqual(projectOf('src/a.test.ts', { '': { 'package.json': JSON.stringify({ dependencies: { react: '1' } }) } }), undefined, 'no framework: not Volt\'s to run');
		assert.strictEqual(projectOf('test/a.test.js', { '': { 'package.json': '{}', '.mocharc.json': '{}' } }), 'mocha@.');
		assert.strictEqual(testAdapter('node').detect(probe({ 'package.json': JSON.stringify({ scripts: { test: 'node --import tsx --test' } }) }))?.data?.loader, '--import tsx');
	});

	test('Playwright takes its test folder; next to a unit-test runner only the e2e files', () => {
		const both = { '': { 'package.json': JSON.stringify({ devDependencies: { vitest: '^3', '@playwright/test': '^1' } }), 'playwright.config.ts': 'export default defineConfig({ testDir: \'./e2e\' })' } };
		assert.strictEqual(playwrightTestDir('defineConfig({\n  testDir: "./tests/browser/",\n})'), 'tests/browser');
		assert.strictEqual(projectOf('e2e/login.spec.ts', both), 'playwright@.');
		assert.strictEqual(projectOf('src/cart.spec.ts', both), 'vitest@.');
		const noDir = { '': { 'package.json': JSON.stringify({ devDependencies: { jest: '^29', '@playwright/test': '^1' } }) } };
		assert.strictEqual(projectOf('e2e/login.spec.ts', noDir), 'playwright@.');
		assert.strictEqual(projectOf('src/cart.test.ts', noDir), 'jest@.');
		assert.strictEqual(projectOf('tests/login.spec.ts', { '': { 'package.json': JSON.stringify({ devDependencies: { '@playwright/test': '^1' } }) } }), 'playwright@.');
	});

	test('static parsing: nesting, modifiers, each, templates, odd formatting, Playwright describe', () => {
		const text = [
			'import { describe, it, expect } from "vitest";',
			'describe("math", () => {',
			'  it("adds", () => {',
			'    expect(1 + 1).toBe(2); // }',
			'  });',
			'  describe.skip(\'nested\', () => {',
			'    test.each([1, 2])("handles %s", (n) => { expect(n).toBeTruthy(); });',
			'  });',
			'  it.only(`template ${x}`, async () => {});',
			'  it.concurrent.skipIf(isCI)(  "spaced"  , () => {});',
			'});',
			'test("top level", () => {});',
			'const notATest = it;',
			'test.describe("checkout", () => {',
			'  test("pays", async ({ page }) => {',
			'    await page.goto("/");',
			'  });',
			'});',
		].join('\n');
		assert.deepStrictEqual(shape(parseJsTests(text)), [{ math: ['adds', { nested: ['handles %s'] }, 'template ${x}', 'spaced'] }, 'top level', { checkout: ['pays'] }]);
		const [math] = parseJsTests(text);
		assert.deepStrictEqual([math.line, math.endLine, math.children[0].line, math.children[0].endLine], [2, 11, 3, 5]);
	});

	test('commands: project, file, suite and test; quoting on POSIX and Windows', () => {
		assert.strictEqual(buildTestCommand('vitest', [], posix).command, 'npx --no-install vitest run --reporter=json --outputFile=/tmp/r --reporter=verbose');
		assert.strictEqual(buildTestCommand('vitest', [select('src/a b.test.ts')], posix).command, `npx --no-install vitest run --reporter=json --outputFile=/tmp/r --reporter=verbose 'src/a b.test.ts'`);
		assert.strictEqual(
			buildTestCommand('vitest', [select('src/a.test.ts', ['math', 'adds (1+1)'])], { ...posix, runtime: ['/p/node_modules/.bin/vitest'] }).command,
			`/p/node_modules/.bin/vitest run --reporter=json --outputFile=/tmp/r --reporter=verbose src/a.test.ts -t '^(?:math adds \\(1\\+1\\)$)'`);
		assert.strictEqual(jsNamePattern([select('a', ['math'], { kind: 'suite' })]), '^(?:math(?: |$))', 'a suite matches everything under it');
		assert.strictEqual(jsNamePattern([select('a', ['math', 'handles %s']), select('a', ['math', 'is ${x} ok'])]), '^(?:math handles .*$|math is .* ok$)', 'each and template names match any value');
		assert.strictEqual(
			buildTestCommand('vitest', [select('src\\a.test.ts', ['it\'s "quoted"'])], windows).command,
			`npx --no-install vitest run --reporter=json --outputFile=C:\\Temp\\r --reporter=verbose src\\a.test.ts -t "^(?:it's ""quoted""$)"`);
		assert.strictEqual(buildTestCommand('jest', [select('a.test.js')], posix).command, 'npx --no-install jest --json --outputFile=/tmp/r --testLocationInResults --verbose --runTestsByPath a.test.js');
		assert.strictEqual(buildTestCommand('jest', [select('a.test.js', ['cart', 'total'], { kind: 'suite' })], posix).command, `npx --no-install jest --json --outputFile=/tmp/r --testLocationInResults --verbose --runTestsByPath a.test.js -t '^(?:cart total(?: |$))'`);
		assert.match(buildTestCommand('jest', [], { ...posix, coverage: true }).command, / --coverage --coverageReporters=lcovonly --coverageDirectory=\/tmp\/r\.coverage$/);
		assert.strictEqual(buildTestCommand('jest', [], { ...posix, coverage: true }).coverageFile, '/tmp/r.coverage/lcov.info');
		assert.strictEqual(buildTestCommand('mocha', [select('test/a.js', ['math', 'adds'])], posix).command, `npx --no-install mocha --reporter json --reporter-option output=/tmp/r test/a.js --grep '^(?:math adds$)'`);
		assert.strictEqual(buildTestCommand('playwright', [select('e2e/a.spec.ts', ['checkout', 'pays'])], posix).command, `PLAYWRIGHT_JUNIT_OUTPUT_NAME=/tmp/r npx --no-install playwright test --reporter=junit,line e2e/a.spec.ts -g '^(?:checkout pays$)'`);
		assert.match(buildTestCommand('playwright', [], windows).command, /^set "PLAYWRIGHT_JUNIT_OUTPUT_NAME=C:\\Temp\\r" && npx /);
		assert.strictEqual(buildTestCommand('node', [select('test/a.test.js', ['slug', 'joins words'])], { ...posix, data: { loader: '--import tsx' } }).command, `node --import tsx --test --test-reporter=junit --test-reporter-destination=/tmp/r --test-reporter=spec --test-reporter-destination=stdout '--test-name-pattern=^joins words$' test/a.test.js`);
		assert.strictEqual(buildTestCommand('bun', [select('sum.test.ts', ['sum', 'adds'])], posix).command, `bun test --reporter=junit --reporter-outfile=/tmp/r -t '^(?:sum adds$)' ./sum.test.ts`);
	});

	test('vitest: recorded report (pass, fail with expected/actual, each rows, skip) and live output', () => {
		const report = parseTestReport('jest-json', recorded.VITEST_REPORT);
		assert.deepStrictEqual(states(report), [
			'passed math > Base operations > Addition', 'passed math > Base operations > Subtraction', 'passed math > Fibonacci > Fibonacci - positive numbers',
			'failed math > Fibonacci > Fibonacci - negative numbers', 'passed math > Fibonacci > fib(1) is 1', 'passed math > Fibonacci > fib(2) is 1', 'passed math > Fibonacci > fib(3) is 2',
			'skipped math > Fibonacci > Fibonacci - huge', 'passed upper cases',
		]);
		const failure = failed(report, 'Fibonacci - negative numbers');
		assert.strictEqual(failure.file, '/work/js-vitest/src/tests/calculator.test.js');
		assert.match(failure.message ?? '', /^AssertionError: expected -1 to be \+0/);
		assert.deepStrictEqual([failure.expected, failure.actual], ['+0', '-1']);
		assert.deepStrictEqual(failure.stack?.map(frame => `${frame.path}:${frame.line}`), ['/work/js-vitest/src/tests/calculator.test.js:18']);
		const live = streamed('vitest-verbose', recorded.VITEST_OUTPUT);
		assert.strictEqual(live.display, undefined, 'the output shows as it is');
		assert.deepStrictEqual(live.events, [
			'passed upper cases', 'passed math > Base operations > Addition', 'passed math > Base operations > Subtraction', 'passed math > Fibonacci > Fibonacci - positive numbers',
			'failed math > Fibonacci > Fibonacci - negative numbers', 'passed math > Fibonacci > fib(1) is 1', 'passed math > Fibonacci > fib(2) is 1', 'passed math > Fibonacci > fib(3) is 2', 'skipped math > Fibonacci > Fibonacci - huge',
		]);
	});

	test('jest: recorded report, a file that does not parse (one error on the file), and live output', () => {
		assert.deepStrictEqual(states(parseTestReport('jest-json', recorded.JEST_REPORT)), ['passed cart > total > sums line items', 'passed cart > total > empty cart is zero', 'passed cart > discount > applies a percentage', 'passed cart > discount > rounds to cents', 'skipped cart > discount > rejects negative percentages']);
		const broken = parseTestReport('jest-json', recorded.JEST_SYNTAX_REPORT);
		assert.strictEqual(broken.outcomes.length, 5, 'the other file ran');
		assert.strictEqual(broken.errors.length, 1);
		assert.strictEqual(broken.errors[0].file, '/work/jest/src/__tests__/broken.test.js');
		assert.match(broken.errors[0].message, /Test suite failed to run[\s\S]*SyntaxError/);
		assert.ok(broken.errors[0].message.length < 900, 'jest\'s advice about Babel is left out');
		assert.deepStrictEqual(streamed('jest-verbose', recorded.JEST_OUTPUT).events, ['passed cart > total > sums line items', 'passed cart > total > empty cart is zero', 'passed cart > discount > applies a percentage', 'passed cart > discount > rounds to cents', 'skipped cart > discount > rejects negative percentages']);
	});

	test('node --test and bun: recorded JUnit reports; bun\'s failure text comes from its output', () => {
		const node = parseTestReport('junit-node', recorded.NODE_REPORT);
		assert.deepStrictEqual(states(node), ['passed slug > lowercases', 'failed slug > joins words']);
		const failure = failed(node, 'joins words');
		assert.deepStrictEqual([failure.expected, failure.actual], ['\'hello_world\'', '\'hello-world\'']);
		assert.deepStrictEqual(failure.stack?.map(frame => `${frame.path}:${frame.line}`), ['/work/js-node/test/slug.test.js:6']);
		const bun = parseTestReport('junit-node', recorded.BUN_REPORT);
		assert.deepStrictEqual(states(bun), ['passed sum > adds', 'failed sum > fails']);
		assert.deepStrictEqual([bun.outcomes[1].file, bun.outcomes[1].line], ['sum.test.ts', 4]);
		const details = testAdapter('bun').failureDetails!(recorded.BUN_OUTPUT);
		assert.deepStrictEqual(details.map(detail => detail.path), [['sum', 'fails']]);
		assert.match(details[0].message, /Expected: 4\nReceived: 3/);
	});

	test('missing packages and tools are named, with the package manager\'s install command', () => {
		const missing = testAdapter('vitest').missing!;
		assert.deepStrictEqual(missing('npm error npx canceled due to missing packages and no YES option: ["vitest@3.2.4"]\n', 1, { ...posix, data: { packageManager: 'pnpm' } }), { what: 'vitest (this project\'s node_modules)', install: 'pnpm install' });
		assert.deepStrictEqual(missing(' MISSING DEPENDENCY  Cannot find dependency \'@vitest/coverage-v8\'\n', 1, posix), { what: '@vitest/coverage-v8', install: 'npm install -D @vitest/coverage-v8' });
		assert.strictEqual(missing('zsh:1: command not found: npx', 127, posix)?.what, 'Node.js (node and npx)');
		assert.strictEqual(missing(' FAIL  src/a.test.ts > adds\nAssertionError', 1, posix), undefined, 'a failing test is not a missing tool');
		assert.strictEqual(testAdapter('bun').missing!('zsh:1: command not found: bun', 127, posix)?.what, 'bun');
	});
});

suite('Volt test adapters: Python', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('static parsing: pytest classes and functions, unittest classes of any name, async and nested', () => {
		const text = [
			'import pytest, unittest', '',
			'def test_a():', '    assert 1', '',
			'class TestThing:', '    @pytest.mark.parametrize("n", [1, 2])', '    def test_b(self, n):', '        pass', '    def helper(self):', '        pass',
			'    class TestInner:', '        def test_c(self):', '            pass', '',
			'class WalletCase(unittest.TestCase):', '    def test_deposit(self):', '        pass', '',
			'class Helper:', '    def test_not_collected(self):', '        pass', '',
			'def helper():', '    pass',
			'async def test_d():', '    pass',
		].join('\n');
		const tests = parsePythonTests(text);
		assert.deepStrictEqual(shape(tests), ['test_a', { TestThing: ['test_b', { TestInner: ['test_c'] }] }, { WalletCase: ['test_deposit'] }, 'test_d']);
		assert.strictEqual(isUnittestOnly(tests), false, 'module-level tests need pytest');
		assert.strictEqual(isUnittestOnly(parsePythonTests('import unittest\nclass A(unittest.TestCase):\n    def test_x(self):\n        pass\n')), true);
	});

	test('the interpreter: the project venv, then uv, poetry, pipenv, then the platform python', () => {
		const runtimes = testAdapter('pytest').runtimes!(false);
		assert.deepStrictEqual(runtimes.map(candidate => [candidate.exists?.[0] ?? '', candidate.argv.join(' ')]), [
			['.venv/bin/python', '{}'], ['venv/bin/python', '{}'], ['uv.lock', 'uv run python'], ['poetry.lock', 'poetry run python'], ['Pipfile', 'pipenv run python'], ['', 'python3'],
		]);
		assert.deepStrictEqual(testAdapter('pytest').runtimes!(true).map(candidate => candidate.exists?.[0] ?? candidate.argv[0]).slice(0, 2).concat(testAdapter('pytest').runtimes!(true).at(-1)!.argv), ['.venv/Scripts/python.exe', 'venv/Scripts/python.exe', 'python']);
	});

	test('commands: pytest node ids, unittest dotted names, the pytest check and its unittest fallback', () => {
		const venv = { ...posix, runtime: ['/p/.venv/bin/python'] };
		assert.strictEqual(buildTestCommand('pytest', [], venv).command, '/p/.venv/bin/python -m pytest -v -rN --no-header --junitxml=/tmp/r -o junit_family=xunit1');
		assert.strictEqual(buildTestCommand('pytest', [select('tests/test_a.py', ['TestX', 'test_b[1-2]'])], venv).command, `/p/.venv/bin/python -m pytest -v -rN --no-header --junitxml=/tmp/r -o junit_family=xunit1 'tests/test_a.py::TestX::test_b[1-2]'`);
		assert.strictEqual(buildTestCommand('pytest', [select('tests/test a.py')], { ...windows, runtime: ['C:\\p\\.venv\\Scripts\\python.exe'] }).command, `C:\\p\\.venv\\Scripts\\python.exe -m pytest -v -rN --no-header --junitxml=C:\\Temp\\r -o junit_family=xunit1 "tests/test a.py"`);
		assert.match(buildTestCommand('pytest', [], { ...venv, coverage: true }).command, / --cov --cov-report=lcov:\/tmp\/r\.lcov$/);
		assert.strictEqual(buildTestCommand('pytest', [], { ...posix, runtime: ['uv', 'run', 'python'] }).command.split(' -m ')[0], 'uv run python');
		const check = testAdapter('pytest').probe!(venv)!;
		assert.strictEqual(check.command, `/p/.venv/bin/python -c 'import pytest'`);
		assert.deepStrictEqual([check.fallback, check.missing], ['unittest', { what: 'pytest', for: '/p/.venv/bin/python', install: '/p/.venv/bin/python -m pip install pytest' }]);
		assert.strictEqual(testAdapter('pytest').probe!({ ...posix, runtime: ['uv', 'run', 'python'] })!.missing.install, 'uv add --dev pytest');
		assert.strictEqual(testAdapter('pytest').probe!({ ...posix, runtime: ['poetry', 'run', 'python'] })!.missing.install, 'poetry add --group dev pytest');
		assert.strictEqual(buildTestCommand('unittest', [], venv).command, '/p/.venv/bin/python -m unittest discover -v');
		assert.strictEqual(buildTestCommand('unittest', [select('tests/test_wallet.py', ['WalletTest', 'test_deposit'])], venv).command, '/p/.venv/bin/python -m unittest -v tests.test_wallet.WalletTest.test_deposit');
		assert.strictEqual(buildTestCommand('unittest', [select('tests/test_wallet.py')], venv).command, '/p/.venv/bin/python -m unittest -v tests/test_wallet.py');
		assert.deepStrictEqual(testAdapter('pytest').missing!('/opt/homebrew/bin/python3.15: No module named pytest\n', 1, posix), { what: 'pytest', for: 'python3', install: 'python3 -m pip install pytest' }, 'the case the old runner reported as three failed tests');
	});

	test('pytest: recorded JUnit (parametrized rows, expected/actual, skip), a collection error on its file, live output', () => {
		const report = parseTestReport('junit-pytest', recorded.PYTEST_REPORT);
		assert.deepStrictEqual(states(report), ['passed test_line_total', 'passed TestOrder > test_order_total', 'failed TestOrder > test_order_total_with_tax', 'passed TestOrder > test_bulk [1-5]', 'passed TestOrder > test_bulk [2-10]', 'failed TestOrder > test_bulk [3-16]', 'skipped test_refund']);
		const failure = failed(report, 'test_order_total_with_tax');
		assert.deepStrictEqual([failure.file, failure.line, failure.expected, failure.actual], ['tests/test_checkout.py', 14, '11.0', '12.0']);
		assert.deepStrictEqual(failure.stack?.map(frame => `${frame.path}:${frame.line}`), ['tests/test_checkout.py:15']);
		const collect = parseTestReport('junit-pytest', recorded.PYTEST_COLLECT_REPORT);
		assert.strictEqual(collect.outcomes.length, 0, 'pytest stops at a collection error: nothing ran, nothing failed');
		assert.deepStrictEqual(collect.errors.map(error => error.file), ['tests/test_broken.py']);
		assert.match(collect.errors[0].message, /ModuleNotFoundError: No module named 'nothing_here'/);
		assert.deepStrictEqual(streamed('pytest-verbose', recorded.PYTEST_OUTPUT).events, ['passed test_line_total', 'passed TestOrder > test_order_total', 'failed TestOrder > test_order_total_with_tax', 'passed TestOrder > test_bulk [1-5]', 'passed TestOrder > test_bulk [2-10]', 'failed TestOrder > test_bulk [3-16]', 'skipped test_refund']);
		assert.deepStrictEqual(streamed('pytest-verbose', '[gw1] [ 50%] FAILED tests/test_a.py::TestX::test_b[x y]\n').events, ['failed TestX > test_b [x y]'], 'pytest-xdist lines');
	});

	test('unittest: recorded output (docstring lines, failure block, skip) and a module that does not import', () => {
		const report = parseTestReport('unittest-text', recorded.UNITTEST_OUTPUT);
		assert.deepStrictEqual(states(report), ['passed WalletTest > test_deposit', 'skipped WalletTest > test_transfer', 'failed WalletTest > test_withdraw']);
		const failure = failed(report, 'test_withdraw');
		assert.deepStrictEqual([failure.fileHint, failure.expected, failure.actual], ['tests/test_wallet', '0', '-5']);
		assert.match(failure.message ?? '', /^AssertionError: -5 != 0/);
		assert.deepStrictEqual(failure.stack?.map(frame => `${frame.path}:${frame.line}`), ['/work/py-unittest/tests/test_wallet.py:10']);
		assert.deepStrictEqual(streamed('unittest-text', recorded.UNITTEST_OUTPUT).events, ['passed WalletTest > test_deposit', 'skipped WalletTest > test_transfer', 'failed WalletTest > test_withdraw']);
		const broken = parseTestReport('unittest-text', recorded.UNITTEST_IMPORT_OUTPUT);
		assert.strictEqual(broken.outcomes.length, 0);
		assert.deepStrictEqual(broken.errors.map(error => error.fileHint), ['tests/test_bad']);
		assert.match(broken.errors[0].message, /No module named 'missing_module'/);
		assert.deepStrictEqual(states(parseTestReport('unittest-text', 'test_a (tests.test_x.TestC) ... ok\n')), ['passed TestC > test_a'], 'Python before 3.11 leaves the method out of the parentheses');
	});
});

suite('Volt test adapters: Go and Rust', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('go: detection by go.mod (the module name is kept), commands by package, test and subtest', () => {
		assert.deepStrictEqual(testAdapter('go').detect(probe({ 'go.mod': 'module example.com/shop\n\ngo 1.22\n' })), { data: { module: 'example.com/shop' } });
		assert.strictEqual(projectOf('services/cart/cart_test.go', { '': { 'go.work': 'use ./services/cart' }, 'services/cart': { 'go.mod': 'module x/cart' } }), 'go@services/cart', 'a go.work workspace: each module is its own project');
		assert.strictEqual(buildTestCommand('go', [], posix).command, 'go test -json ./...');
		assert.strictEqual(buildTestCommand('go', [select('pkg/a_test.go', ['TestA']), select('pkg/a_test.go', ['TestB'])], posix).command, `go test -json -run '^(?:TestA|TestB)$' ./pkg`);
		assert.strictEqual(buildTestCommand('go', [select('a_test.go', ['TestDiv', 'by zero'])], posix).command, `go test -json -run '^(?:TestDiv)$/^(?:by_zero)$' .`);
		assert.strictEqual(buildTestCommand('go', [select('pkg/a_test.go', ['TestA'])], windows).command, `go test -json -run "^(?:TestA)$" ./pkg`);
		assert.strictEqual(buildTestCommand('go', [], { ...posix, coverage: true }).command, 'go test -json -coverprofile=/tmp/r.cover ./...');
		const debug = testAdapter('go').debug!([select('mathx/mathx_test.go', ['TestAdd'])], { ...posix, cwd: '/p' });
		assert.deepStrictEqual(typeof debug === 'string' ? debug : [debug.type, debug.config.program, debug.config.args], ['go', '/p/mathx', ['-test.v', '-test.run', '^(?:TestAdd)$']]);
	});

	test('go: recorded events (subtests are cases of their test), a package that does not build, live output', () => {
		const report = parseTestReport('go-json', recorded.GO_OUTPUT);
		assert.deepStrictEqual(states(report), ['passed TestAdd', 'failed TestDiv', 'passed TestDiv exact', 'failed TestDiv by_zero', 'skipped TestSkipped']);
		assert.strictEqual(report.outcomes[0].package, 'example.com/gomod/mathx');
		assert.strictEqual(failed(report, 'TestDiv').message, 'A subtest failed.');
		const subtest = report.outcomes.find(outcome => outcome.variant === 'by_zero')!;
		assert.match(subtest.message ?? '', /Div\(1, 0\) = 0, want 1/);
		assert.deepStrictEqual(subtest.stack?.map(frame => `${frame.path}:${frame.line}`), ['mathx_test.go:22']);
		const broken = parseTestReport('go-json', recorded.GO_BUILD_OUTPUT);
		assert.strictEqual(broken.outcomes.length, 0);
		assert.deepStrictEqual(broken.errors.map(error => [error.file, error.line, error.message]), [['mathx/broken_test.go', 6, 'undefined: undefinedCall']]);
		const live = streamed('go-json', recorded.GO_OUTPUT);
		assert.deepStrictEqual(live.events, ['started TestAdd', 'passed TestAdd', 'started TestDiv', 'started TestDiv exact', 'passed TestDiv exact', 'started TestDiv by_zero', 'failed TestDiv by_zero', 'failed TestDiv', 'started TestSkipped', 'skipped TestSkipped']);
		assert.match(live.display ?? '', /^=== RUN   TestAdd\n--- PASS: TestAdd/, 'the user sees go\'s text, not its JSON');
		assert.ok(!live.display?.includes('"Action"'));
	});

	test('cargo: workspace manifests, the crate name, commands by module, test and integration file', () => {
		assert.strictEqual(cargoPackageName('[workspace]\nmembers = ["crates/*"]\n'), undefined);
		assert.strictEqual(cargoPackageName('[package]\nname = "shop-core"\nversion = "0.1.0"\n\n[dependencies]\nname = "x"\n'), 'shop-core');
		const tree = { '': { 'Cargo.toml': '[workspace]\nmembers = ["crates/*"]\n' }, 'crates/core': { 'Cargo.toml': '[package]\nname = "core"\n' } };
		assert.strictEqual(projectOf('crates/core/src/lib.rs', tree), 'cargo@crates/core', 'a workspace\'s own manifest holds no tests');
		assert.strictEqual(projectOf('src/lib.rs', tree), undefined);
		const data = { data: { package: 'core' } };
		assert.strictEqual(buildTestCommand('cargo', [], { ...posix, ...data }).command, 'cargo test -p core --no-fail-fast');
		assert.strictEqual(buildTestCommand('cargo', [select('src/lib.rs', ['tests', 'adds'])], { ...posix, ...data }).command, 'cargo test -p core --no-fail-fast -- tests::adds --exact');
		assert.strictEqual(buildTestCommand('cargo', [select('src/net/http.rs', ['net', 'http', 'tests'], { kind: 'suite' })], posix).command, 'cargo test --no-fail-fast -- net::http::tests');
		assert.strictEqual(buildTestCommand('cargo', [select('tests/api.rs', ['public_add'])], posix).command, 'cargo test --no-fail-fast --test api -- public_add --exact');
		assert.deepStrictEqual(testAdapter('cargo').prefix!('src/net/http.rs'), ['net', 'http']);
	});

	test('cargo: recorded output (module paths, an integration test file, left/right), a build error, live output', () => {
		const report = parseTestReport('cargo-text', recorded.CARGO_OUTPUT);
		assert.deepStrictEqual(states(report), ['skipped tests > slow', 'passed geometry > tests > area_of_square', 'passed tests > adds', 'failed tests > adds_wrong', 'passed public_add']);
		assert.strictEqual(report.outcomes.at(-1)!.file, 'tests/api.rs');
		const failure = failed(report, 'adds_wrong');
		assert.deepStrictEqual([failure.expected, failure.actual], ['5', '4']);
		assert.deepStrictEqual(failure.stack?.map(frame => `${frame.path}:${frame.line}`), ['src/lib.rs:18']);
		assert.ok(!failure.message?.includes('RUST_BACKTRACE'));
		const broken = parseTestReport('cargo-text', recorded.CARGO_BUILD_OUTPUT);
		assert.deepStrictEqual([broken.outcomes.length, broken.errors.map(error => [error.file, error.line, error.message])], [0, [['tests/broken.rs', 5, 'mismatched types']]]);
		assert.deepStrictEqual(streamed('cargo-text', recorded.CARGO_OUTPUT).events, ['skipped tests > slow', 'passed geometry > tests > area_of_square', 'passed tests > adds', 'failed tests > adds_wrong', 'passed public_add']);
	});
});

suite('Volt test adapters: C++ (written after the tools\' documented formats; cmake and ctest are not on the recording machine)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('static parsing: GoogleTest suites, Catch2 sections, doctest suites and subcases', () => {
		const gtest = ['#include <gtest/gtest.h>', 'TEST(MathTest, Adds) {', '  EXPECT_EQ(add(1, 2), 3);', '}', 'TEST_F(CartFixture, Totals) { EXPECT_EQ(1, 1); }', 'TEST(MathTest, Divides)', '{', '  EXPECT_EQ(divide(6, 3), 2);', '}', 'TEST_P(ParamTest, Works) {}', 'INSTANTIATE_TEST_SUITE_P(Small, ParamTest, ::testing::Values(1, 2));'].join('\n');
		assert.strictEqual(cppTestFlavor(gtest), 'gtest');
		const suites = parseCppTests(gtest);
		assert.deepStrictEqual(shape(suites), [{ MathTest: ['Adds', 'Divides'] }, { CartFixture: ['Totals'] }, { ParamTest: ['Works'] }]);
		assert.deepStrictEqual(suites[0].children.map(test => [test.line, test.endLine]), [[2, 4], [6, 9]]);
		const catch2 = ['#include <catch2/catch_test_macros.hpp>', 'TEST_CASE("vectors can be sized", "[vector]") {', '    std::vector<int> v(5);', '    SECTION("resizing bigger") {', '        v.resize(10);', '        SECTION("then smaller") { v.resize(1); }', '    }', '    SECTION("reserving") {', '        v.reserve(10);', '    }', '}', 'SCENARIO("a cart", "[cart]") {', '    GIVEN("an empty cart") {', '        WHEN("an item is added") { THEN("it has one") { REQUIRE(1 == 1); } }', '    }', '}'].join('\n');
		assert.strictEqual(cppTestFlavor(catch2), 'catch2');
		assert.deepStrictEqual(shape(parseCppTests(catch2)), [{ 'vectors can be sized': [{ 'resizing bigger': ['then smaller'] }, 'reserving'] }, { 'Scenario: a cart': [{ 'Given: an empty cart': ['When: an item is added'] }] }]);
		const doctest = ['#include "doctest.h"', 'TEST_SUITE("math") {', '    TEST_CASE("adds") {', '        SUBCASE("small") { CHECK(1 + 1 == 2); }', '        SUBCASE("big") {', '            CHECK(1000 + 1 == 1001);', '        }', '    }', '}', 'TEST_CASE("free case") { CHECK(true); }'].join('\n');
		assert.strictEqual(cppTestFlavor(doctest), 'doctest');
		const parsed = parseCppTests(doctest);
		assert.deepStrictEqual(shape(parsed), [{ math: [{ adds: ['small', 'big'] }] }, 'free case']);
		assert.deepStrictEqual([parsed[0].kind, parsed[0].children[0].kind, parsed[0].children[0].children[0].kind], ['suite', 'test', 'test'], 'a subcase is a part of its test');
		assert.deepStrictEqual(parseCppTests('int main() { return 0; }'), []);
	});

	test('detection: the CMake project root, whether CTest is on, the test binaries', () => {
		const info = cmakeInfo('cmake_minimum_required(VERSION 3.21)\nproject(shop CXX)\n# enable_testing()\nadd_executable(shop_tests tests/math_test.cpp)\ntarget_link_libraries(shop_tests PRIVATE GTest::gtest_main)\nadd_executable(shop main.cpp)\n');
		assert.deepStrictEqual(info, { project: true, ctest: false, testBinaries: ['shop_tests'] });
		assert.strictEqual(cmakeInfo('project(shop)\ninclude(CTest)\nadd_subdirectory(tests)\n').ctest, true);
		const tree = { '': { 'CMakeLists.txt': 'project(shop)\nenable_testing()\nadd_subdirectory(tests)\n' }, 'tests': { 'CMakeLists.txt': 'add_executable(t math_test.cpp)\ngtest_discover_tests(t)\n' } };
		assert.strictEqual(projectOf('tests/math_test.cpp', tree), 'ctest@.', 'a subdirectory\'s CMakeLists.txt belongs to the project above it');
	});

	test('commands: build then ctest with a JUnit report; a selection by name; a lone test binary run directly', () => {
		const ctest = { ...posix, data: { ctest: 'yes', binaries: '' }, runtime: ['/p/build/CMakeCache.txt'] };
		assert.strictEqual(buildTestCommand('ctest', [], ctest).command, 'cmake --build /p/build && ctest --test-dir /p/build --output-junit /tmp/r --output-on-failure');
		assert.strictEqual(buildTestCommand('ctest', [], { ...posix, data: { ctest: 'yes', binaries: '' }, runtime: ['build'] }).command, 'cmake -S . -B build && cmake --build build && ctest --test-dir build --output-junit /tmp/r --output-on-failure', 'not configured yet: configure first');
		assert.strictEqual(
			buildTestCommand('ctest', [select('tests/math_test.cpp', ['MathTest', 'Adds'], { flavor: 'gtest' }), select('tests/math_test.cpp', ['CartFixture'], { flavor: 'gtest', kind: 'suite' })], ctest).command,
			`cmake --build /p/build && ctest --test-dir /p/build --output-junit /tmp/r --output-on-failure -R '(?:^|/)MathTest\\.Adds(?:/|$)|(?:^|/)CartFixture\\.'`);
		assert.strictEqual(ctestPattern([select('a.cpp', ['vectors can be sized', 'resizing bigger'], { flavor: 'catch2' })]), '^vectors can be sized$', 'a section runs with its test case');
		assert.strictEqual(ctestPattern([select('a.cpp', ['math', 'adds', 'small'], { flavor: 'doctest', suiteDepth: 1 })]), '^adds$');
		const direct = { ...posix, data: { ctest: '', binaries: 'shop_tests' }, runtime: ['/p/build/CMakeCache.txt'] };
		assert.strictEqual(buildTestCommand('ctest', [select('tests/math_test.cpp', ['MathTest', 'Adds'], { flavor: 'gtest' })], direct).command, `cmake --build /p/build --target shop_tests && /p/build/shop_tests --gtest_output=xml:/tmp/r '--gtest_filter=MathTest.Adds:*/MathTest.Adds/*'`);
		assert.strictEqual(buildTestCommand('ctest', [select('tests/math_test.cpp', ['MathTest', 'Adds'], { flavor: 'gtest' })], direct).format, 'junit-gtest');
		assert.strictEqual(buildTestCommand('ctest', [select('t.cpp', ['vectors, sized'], { flavor: 'catch2' })], direct).command, `cmake --build /p/build --target shop_tests && /p/build/shop_tests -r junit -o /tmp/r 'vectors\\, sized'`);
		assert.strictEqual(buildTestCommand('ctest', [select('t.cpp', ['math', 'adds'], { flavor: 'doctest', suiteDepth: 1 })], { ...direct, windows: true }).command, 'cmake --build /p/build --target shop_tests && /p/build/shop_tests.exe --reporters=junit --out=/tmp/r --test-case=adds');
		assert.strictEqual(testAdapter('ctest').missing!('/bin/sh: cmake: command not found\n', 127, posix)?.what, 'CMake (cmake and ctest)');
	});

	test('reports: ctest JUnit (discovered tests, a failure\'s output, a whole binary as one test), GoogleTest XML', () => {
		const ctest = [
			'<?xml version="1.0" encoding="UTF-8"?>',
			'<testsuite name="(empty)" tests="4" failures="1" disabled="0" skipped="1" hostname="" time="0" timestamp="2026-11-17T10:00:00">',
			'	<testcase name="MathTest.Adds" classname="MathTest.Adds" time="0.004" status="run"><system-out>[       OK ] MathTest.Adds (0 ms)</system-out></testcase>',
			'	<testcase name="MathTest.Divides" classname="MathTest.Divides" time="0.005" status="fail">',
			'		<failure message=""/>',
			'		<system-out>Running main() from gtest_main.cc',
			'[ RUN      ] MathTest.Divides',
			'/work/cpp/tests/math_test.cpp:14: Failure',
			'Expected equality of these values:',
			'  divide(6, 3)',
			'    Which is: 3',
			'  2',
			'[  FAILED  ] MathTest.Divides (0 ms)',
			'</system-out>',
			'	</testcase>',
			'	<testcase name="Small/ParamTest.Works/1" classname="Small/ParamTest.Works/1" time="0.001" status="run"/>',
			'	<testcase name="MathTest.Later" classname="MathTest.Later" time="0" status="notrun"><skipped message="DISABLED"/></testcase>',
			'</testsuite>',
		].join('\n');
		const report = parseTestReport('junit-ctest', ctest);
		assert.deepStrictEqual(states(report), ['passed MathTest > Adds', 'failed MathTest > Divides', 'passed ParamTest > Works Small/1', 'skipped MathTest > Later']);
		const failure = failed(report, 'Divides');
		assert.deepStrictEqual([failure.expected, failure.actual], ['2', '3']);
		assert.deepStrictEqual(failure.stack?.map(frame => `${frame.path}:${frame.line}`), ['/work/cpp/tests/math_test.cpp:14']);
		const binary = '<testsuite name="x" tests="1" failures="1"><testcase name="shop_tests" classname="shop_tests" time="0.01" status="fail"><failure message=""/><system-out>[==========] Running 2 tests from 1 test suite.\n[ RUN      ] MathTest.Adds\n[       OK ] MathTest.Adds (0 ms)\n[ RUN      ] MathTest.Divides\ntests/math_test.cpp:14: Failure\nValue of: divide(6, 3)\n  Actual: 3\nExpected: 2\n[  FAILED  ] MathTest.Divides (1 ms)\n[  PASSED  ] 1 test.\n[  FAILED  ] 1 test, listed below:\n[  FAILED  ] MathTest.Divides\n</system-out></testcase></testsuite>';
		assert.deepStrictEqual(states(parseTestReport('junit-ctest', binary)), ['passed MathTest > Adds', 'failed MathTest > Divides'], 'add_test(NAME shop_tests ...): the binary\'s own output names its tests');
		assert.deepStrictEqual(parseGtestText('[  FAILED  ] MathTest.Divides (1 ms)\n[  FAILED  ] MathTest.Divides\n').length, 1, 'the summary repeats a failure');
		const gtest = '<?xml version="1.0" encoding="UTF-8"?>\n<testsuites tests="3" failures="1" name="AllTests">\n  <testsuite name="MathTest" tests="2" failures="1">\n    <testcase name="Adds" file="/work/cpp/tests/math_test.cpp" line="5" status="run" result="completed" time="0." classname="MathTest" />\n    <testcase name="Divides" file="/work/cpp/tests/math_test.cpp" line="12" status="run" result="completed" time="0.001" classname="MathTest">\n      <failure message="/work/cpp/tests/math_test.cpp:14&#x0A;Expected equality of these values:&#x0A;  divide(6, 3)&#x0A;    Which is: 3&#x0A;  2" type=""><![CDATA[/work/cpp/tests/math_test.cpp:14\nExpected equality of these values:\n  divide(6, 3)\n    Which is: 3\n  2]]></failure>\n    </testcase>\n  </testsuite>\n  <testsuite name="Small/ParamTest" tests="1">\n    <testcase name="Works/0" value_param="1" status="run" result="completed" time="0." classname="Small/ParamTest" />\n  </testsuite>\n</testsuites>';
		const direct = parseTestReport('junit-gtest', gtest);
		assert.deepStrictEqual(states(direct), ['passed MathTest > Adds', 'failed MathTest > Divides', 'passed ParamTest > Works Small/0']);
		assert.deepStrictEqual([direct.outcomes[1].file, direct.outcomes[1].line, direct.outcomes[1].expected, direct.outcomes[1].actual], ['/work/cpp/tests/math_test.cpp', 12, '2', '3']);
		assert.deepStrictEqual(parseCompileErrors('/work/cpp/tests/math_test.cpp:9:3: error: use of undeclared identifier \'dvide\'\n  dvide(6, 3);\n  ^\n1 warning and 1 error generated.\n').map(error => [error.file, error.line]), [['/work/cpp/tests/math_test.cpp', 9]]);
	});
});

suite('Volt test adapters: C# (dotnet test)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const source = [
		'using Xunit;', '', 'namespace Shop.Tests', '{', '    /* a helper', '       [Fact] public void NotATest() {} */', '    public class CartTests', '    {',
		'        [Fact]', '        public void Adds()', '        {', '            Assert.Equal(3, 1 + 2);', '        }', '',
		'        [Theory]', '        [InlineData(1, 2, 3)]', '        [InlineData(2, 2, 5)]', '        public async Task Sums(int a, int b, int expected) { await Task.Yield(); }', '',
		'        [Fact(Skip = "later")] public void Refunds() { }', '',
		'        private int Helper() => 1;', '',
		'        public class WhenEmpty', '        {', '            [Fact]', '            public void TotalIsZero() => Assert.Equal(0, 0);', '        }', '    }', '',
		'    [TestFixture]', '    public class NUnitStyle', '    {', '        [Test, Category("fast")]', '        public void Works() { }', '        [TestCase(1)]', '        [TestCase(2)]', '        public void Rows(int n) { }', '    }', '',
		'    [TestClass]', '    public sealed class MsTestStyle', '    {', '        [TestMethod]', '        public void Runs() { }', '    }', '',
		'    public class NoTests { public void Nothing() { } }', '}',
	].join('\n');

	test('static parsing: xUnit, NUnit and MSTest attributes, nested classes, namespaces (block and file-scoped)', () => {
		const tests = parseCsharpTests(source);
		assert.deepStrictEqual(shape(tests), [{ CartTests: ['Adds', 'Sums', 'Refunds', { WhenEmpty: ['TotalIsZero'] }] }, { NUnitStyle: ['Works', 'Rows'] }, { MsTestStyle: ['Runs'] }]);
		assert.deepStrictEqual(tests.map(test => test.scope), ['Shop.Tests', 'Shop.Tests', 'Shop.Tests']);
		assert.deepStrictEqual([tests[0].line, tests[0].children[0].line, tests[0].children[1].line], [7, 10, 18]);
		const fileScoped = parseCsharpTests('namespace Shop.Tests;\n\npublic class A\n{\n    [Fact]\n    public void X() { }\n}\n');
		assert.deepStrictEqual([shape(fileScoped), fileScoped[0].scope], [[{ A: ['X'] }], 'Shop.Tests']);
	});

	test('detection by a test project file; commands with a TRX report and a fully qualified name filter', () => {
		assert.deepStrictEqual(testAdapter('dotnet').detect(probe({ 'Shop.Tests.csproj': '<Project Sdk="Microsoft.NET.Sdk"><ItemGroup><PackageReference Include="Microsoft.NET.Test.Sdk" Version="17.14.1" /></ItemGroup></Project>' })), { data: { project: 'Shop.Tests.csproj' } });
		assert.strictEqual(testAdapter('dotnet').detect(probe({ 'Shop.csproj': '<Project Sdk="Microsoft.NET.Sdk"></Project>' })), undefined, 'an app project is not a test project');
		const data = { data: { project: 'Shop.Tests.csproj' } };
		assert.strictEqual(buildTestCommand('dotnet', [], { ...posix, ...data }).command, `dotnet test Shop.Tests.csproj --nologo --logger trx --results-directory /tmp/r --logger 'console;verbosity=normal'`);
		const one = select('CartTests.cs', ['CartTests', 'Sums'], { scope: 'Shop.Tests' });
		const nested = select('CartTests.cs', ['CartTests', 'WhenEmpty'], { scope: 'Shop.Tests', kind: 'suite' });
		assert.strictEqual(dotnetFilter([one]), 'FullyQualifiedName=Shop.Tests.CartTests.Sums|FullyQualifiedName~Shop.Tests.CartTests.Sums\\(');
		assert.strictEqual(dotnetFilter([nested]), 'FullyQualifiedName~Shop.Tests.CartTests+WhenEmpty.|FullyQualifiedName~Shop.Tests.CartTests+WhenEmpty+');
		assert.strictEqual(buildTestCommand('dotnet', [one], { ...posix, ...data }).command, `dotnet test Shop.Tests.csproj --nologo --logger trx --results-directory /tmp/r --logger 'console;verbosity=normal' --filter 'FullyQualifiedName=Shop.Tests.CartTests.Sums|FullyQualifiedName~Shop.Tests.CartTests.Sums\\('`);
		assert.match(buildTestCommand('dotnet', [one], { ...windows, ...data }).command, /--logger "console;verbosity=normal" --filter "FullyQualifiedName=Shop\.Tests\.CartTests\.Sums\|FullyQualifiedName~Shop\.Tests\.CartTests\.Sums\\\("$/);
		assert.match(buildTestCommand('dotnet', [], { ...posix, coverage: true }).command, / --collect 'XPlat Code Coverage'$/);
		assert.strictEqual(testAdapter('dotnet').missing!('zsh:1: command not found: dotnet\n', 127, posix)?.what, 'the .NET SDK (dotnet)');
		assert.match(testAdapter('dotnet').missing!('No .NET SDKs were found.\n', 1, posix)?.what ?? '', /only a runtime/);
	});

	test('recorded TRX (theory rows, a nested class, expected/actual, skip), a build error on its file, live output', () => {
		const report = parseTestReport('trx', recorded.TRX_REPORT);
		assert.deepStrictEqual(states(report).sort(), [
			'failed CartTests > Subtracts', 'failed CartTests > Sums (a: 2, b: 2, expected: 5)', 'passed CartTests > Adds', 'passed CartTests > Sums (a: 1, b: 2, expected: 3)', 'passed CartTests > WhenEmpty > TotalIsZero', 'skipped CartTests > Refunds',
		]);
		assert.ok(report.outcomes.every(outcome => outcome.scope === 'Shop.Tests'));
		assert.strictEqual(report.errors.length, 0, 'the run\'s notes only repeat the failures');
		const failure = failed(report, 'Subtracts');
		assert.deepStrictEqual([failure.expected, failure.actual], ['1', '3']);
		assert.deepStrictEqual(failure.stack?.map(frame => `${frame.path}:${frame.line}`), ['/work/cs-xunit/UnitTest1.cs:16']);
		assert.deepStrictEqual(parseCompileErrors(recorded.DOTNET_BUILD_OUTPUT).map(error => [error.file, error.line, error.message]), [['/work/cs/UnitTest1.cs', 10, 'CS1002: ; expected']]);
		assert.deepStrictEqual(streamed('dotnet-console', recorded.DOTNET_OUTPUT).events.sort(), [
			'failed CartTests > Subtracts', 'failed CartTests > Sums (a: 2, b: 2, expected: 5)', 'passed CartTests > Adds', 'passed CartTests > Sums (a: 1, b: 2, expected: 3)', 'passed CartTests > WhenEmpty > TotalIsZero', 'skipped CartTests > Refunds',
		]);
	});
});

suite('Volt test adapters: Java and Kotlin (JUnit 4/5, TestNG; reports written after Surefire\'s and Gradle\'s format: mvn and gradle are not on the recording machine)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('static parsing: @Test, @ParameterizedTest, @Nested, annotations with arguments, Kotlin names in backticks', () => {
		const java = [
			'package com.shop;', '', 'import org.junit.jupiter.api.Test;', '', '/** {@code @Test void notATest()} in a comment. */', 'class CartTest {', '    @Test', '    void adds() {', '        assertEquals(3, 1 + 2);', '    }', '',
			'    @ParameterizedTest(name = "{0} + {1}")', '    @CsvSource({"1, 2, 3", "2, 2, 5"})', '    void sums(int a, int b, int expected) {}', '',
			'    @Test @DisplayName("refunds an order") public void refunds() throws Exception {}', '', '    private void helper() {}', '',
			'    @Nested', '    class WhenEmpty {', '        @RepeatedTest(3)', '        void isEmpty() {}', '    }', '}', '', 'class Unrelated { void nothing() {} }',
		].join('\n');
		const tests = parseJvmTests(java);
		assert.deepStrictEqual(shape(tests), [{ CartTest: ['adds', 'sums', 'refunds', { WhenEmpty: ['isEmpty'] }] }]);
		assert.deepStrictEqual([tests[0].scope, tests[0].line, tests[0].children[1].line], ['com.shop', 6, 14]);
		const kotlin = ['package com.shop', '', 'class CartSpec {', '    @Test', '    fun `adds two items`() {', '        assertEquals(2, 1 + 1)', '    }', '', '    @Test fun plain() = assertTrue(true)', '', '    @Nested', '    inner class Empty {', '        @org.testng.annotations.Test', '        fun isEmpty() {}', '    }', '}'].join('\n');
		assert.deepStrictEqual(shape(parseJvmTests(kotlin)), [{ CartSpec: ['adds two items', 'plain', { Empty: ['isEmpty'] }] }]);
	});

	test('detection: Maven, Gradle, a folder with both; the wrapper when the project has one', () => {
		assert.strictEqual(projectOf('src/test/java/com/shop/CartTest.java', { '': { 'pom.xml': '<project/>' } }), 'maven@.');
		assert.strictEqual(projectOf('app/src/test/kotlin/com/shop/CartSpec.kt', { '': { 'settings.gradle.kts': '' }, 'app': { 'build.gradle.kts': 'plugins { kotlin("jvm") }' } }), 'gradle@app');
		assert.strictEqual(projectOf('src/test/java/A/CartTest.java', { '': { 'pom.xml': '<project/>', 'build.gradle': '' } }), 'gradle@.');
		assert.strictEqual(projectOf('src/test/java/A/CartTest.java', { '': { 'pom.xml': '<project/>', 'build.gradle': '', 'mvnw': '' } }), 'maven@.');
		assert.deepStrictEqual(testAdapter('maven').runtimes!(false).map(candidate => [candidate.exists?.[0] ?? '', candidate.argv[0]]), [['mvnw', '{}'], ['', 'mvn']]);
		assert.deepStrictEqual(testAdapter('gradle').runtimes!(true).map(candidate => [candidate.exists?.[0] ?? '', candidate.argv[0]]), [['gradlew.cmd', '{}'], ['', 'gradle']]);
	});

	test('commands: Surefire -Dtest and Gradle --tests for a class, a nested class and a method', () => {
		const method = select('src/test/java/com/shop/CartTest.java', ['CartTest', 'adds'], { scope: 'com.shop' });
		const nested = select('src/test/java/com/shop/CartTest.java', ['CartTest', 'WhenEmpty'], { scope: 'com.shop', kind: 'suite' });
		assert.strictEqual(surefireFilter([method, nested]), 'com.shop.CartTest#adds,com.shop.CartTest$WhenEmpty');
		assert.deepStrictEqual(gradleFilters([method, nested]), ['com.shop.CartTest.adds', 'com.shop.CartTest$WhenEmpty*']);
		assert.strictEqual(buildTestCommand('maven', [], { ...posix, runtime: ['/p/mvnw'] }).command, '/p/mvnw -B test');
		assert.strictEqual(buildTestCommand('maven', [method, nested], posix).command, `mvn -B test '-Dtest=com.shop.CartTest#adds,com.shop.CartTest$WhenEmpty' -Dsurefire.failIfNoSpecifiedTests=false -DfailIfNoTests=false`);
		assert.strictEqual(buildTestCommand('maven', [method], windows).command, 'mvn -B test "-Dtest=com.shop.CartTest#adds" -Dsurefire.failIfNoSpecifiedTests=false -DfailIfNoTests=false');
		assert.strictEqual(buildTestCommand('gradle', [method, nested], { ...posix, runtime: ['/p/gradlew'] }).command, `/p/gradlew cleanTest test --console=plain --continue --tests com.shop.CartTest.adds --tests 'com.shop.CartTest$WhenEmpty*'`);
		assert.deepStrictEqual(buildTestCommand('maven', [], posix).report, { kind: 'project', globs: ['target/surefire-reports/TEST-*.xml', '**/target/surefire-reports/TEST-*.xml'] });
		assert.deepStrictEqual(buildTestCommand('gradle', [], posix).report, { kind: 'project', globs: ['build/test-results/test/TEST-*.xml', '**/build/test-results/test/TEST-*.xml'] });
		assert.strictEqual(testAdapter('maven').missing!('zsh:1: command not found: mvn\n', 127, posix)?.what, 'Maven (mvn; the project has no ./mvnw wrapper)');
		assert.strictEqual(testAdapter('gradle').missing!('ERROR: JAVA_HOME is not set and no \'java\' command could be found in your PATH.\n', 1, posix)?.what, 'a JDK (java)');
	});

	test('reports: Surefire and Gradle JUnit XML (parameter rows, nested classes, expected/actual, skip), a class that failed to start', () => {
		const surefire = [
			'<?xml version="1.0" encoding="UTF-8"?>',
			'<testsuite xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" name="com.shop.CartTest" time="0.042" tests="6" errors="1" skipped="1" failures="1">',
			'  <properties><property name="java.version" value="17.0.4.1"/></properties>',
			'  <testcase name="adds" classname="com.shop.CartTest" time="0.012"/>',
			'  <testcase name="sums(int, int, int)[1]" classname="com.shop.CartTest" time="0.002"/>',
			'  <testcase name="sums(int, int, int)[2]" classname="com.shop.CartTest" time="0.003">',
			'    <failure message="expected: &lt;5&gt; but was: &lt;4&gt;" type="org.opentest4j.AssertionFailedError"><![CDATA[org.opentest4j.AssertionFailedError: expected: <5> but was: <4>',
			'	at org.junit.jupiter.api.AssertionFailureBuilder.build(AssertionFailureBuilder.java:151)',
			'	at org.junit.jupiter.api.Assertions.assertEquals(Assertions.java:531)',
			'	at com.shop.CartTest.sums(CartTest.java:24)',
			'	at java.base/java.lang.reflect.Method.invoke(Method.java:568)',
			']]></failure>',
			'  </testcase>',
			'  <testcase name="refunds" classname="com.shop.CartTest" time="0"><skipped message="later"/></testcase>',
			'  <testcase name="isEmpty" classname="com.shop.CartTest$WhenEmpty" time="0.001"/>',
			'  <testcase name="loads" classname="com.shop.CartTest" time="0.004">',
			'    <error message="boom" type="java.lang.IllegalStateException"><![CDATA[java.lang.IllegalStateException: boom',
			'	at com.shop.Cart.load(Cart.java:9)',
			'	at com.shop.CartTest.loads(CartTest.java:40)',
			']]></error>',
			'    <system-out><![CDATA[loading...',
			']]></system-out>',
			'  </testcase>',
			'</testsuite>',
		].join('\n');
		const report = parseTestReport('junit-jvm', surefire);
		assert.deepStrictEqual(states(report), ['passed CartTest > adds', 'passed CartTest > sums (int, int, int)[1]', 'failed CartTest > sums (int, int, int)[2]', 'skipped CartTest > refunds', 'passed CartTest > WhenEmpty > isEmpty', 'errored CartTest > loads']);
		assert.deepStrictEqual([report.outcomes[0].scope, report.outcomes[0].fileHint, report.outcomes[4].fileHint], ['com.shop', 'com/shop/CartTest', 'com/shop/CartTest']);
		const failure = failed(report, 'sums');
		assert.deepStrictEqual([failure.expected, failure.actual], ['5', '4']);
		assert.deepStrictEqual(failure.stack?.map(frame => `${frame.path}:${frame.line}`), ['CartTest.java:24'], 'JUnit\'s own frames are left out');
		assert.strictEqual(failed(report, 'loads').output, 'loading...\n');
		const gradle = '<?xml version="1.0" encoding="UTF-8"?>\n<testsuite name="com.shop.CartSpec" tests="2" skipped="0" failures="1" errors="0" timestamp="2026-11-17T10:00:00" hostname="host" time="0.02">\n  <properties/>\n  <testcase name="adds two items()" classname="com.shop.CartSpec" time="0.01"/>\n  <testcase name="[2] a=2, b=2" classname="com.shop.CartSpec" time="0.01">\n    <failure message="org.opentest4j.AssertionFailedError: expected: &lt;5&gt; but was: &lt;4&gt;" type="org.opentest4j.AssertionFailedError">org.opentest4j.AssertionFailedError: expected: &lt;5&gt; but was: &lt;4&gt;\n\tat com.shop.CartSpec.sums(CartSpec.kt:18)\n</failure>\n  </testcase>\n  <system-out><![CDATA[]]></system-out>\n</testsuite>';
		const fromGradle = parseTestReport('junit-jvm', gradle);
		assert.deepStrictEqual(states(fromGradle), ['passed CartSpec > adds two items', 'failed CartSpec [2] a=2, b=2']);
		const crashed = '<testsuite name="com.shop.CartTest" tests="1" errors="1"><testcase name="initializationError" classname="com.shop.CartTest" time="0"><error type="java.lang.ExceptionInInitializerError">java.lang.ExceptionInInitializerError\n\tat com.shop.CartTest.&lt;clinit&gt;(CartTest.java:8)\n</error></testcase></testsuite>';
		const broken = parseTestReport('junit-jvm', crashed);
		assert.deepStrictEqual([broken.outcomes.length, broken.errors.map(error => error.fileHint)], [0, ['com/shop/CartTest']], 'one error on the class\'s file, not a failed test');
		assert.deepStrictEqual(parseCompileErrors('[ERROR] /work/java/src/test/java/com/shop/CartTest.java:[12,9] cannot find symbol\n[ERROR]   symbol:   method asertEquals(int,int)\ne: file:///work/kt/src/test/kotlin/CartSpec.kt:7:9 Unresolved reference: asertEquals\n').map(error => [error.file, error.line]), [['/work/java/src/test/java/com/shop/CartTest.java', 12], ['/work/kt/src/test/kotlin/CartSpec.kt', 7]]);
	});
});

suite('Volt test adapters: shared readers', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('the XML reader: attributes, entities, CDATA, self-closing elements, a truncated file', () => {
		const root = parseXml('<?xml version="1.0"?><!-- c --><a x="1 &amp; 2" y=\'z\'><b/><c>t &lt; u<![CDATA[ <raw> ]]></c><d><e>cut');
		const a = root.children[0];
		assert.deepStrictEqual([a.name, a.attrs, a.children.map(child => child.name), a.children[1].text], ['a', { x: '1 & 2', y: 'z' }, ['b', 'c', 'd'], 't < u <raw> ']);
		assert.strictEqual(a.children[2].children[0].text, 'cut', 'what a truncated report held is kept');
	});

	test('a crash without a report: the format parsers answer nothing rather than throw on empty output', () => {
		for (const format of ['go-json', 'cargo-text', 'unittest-text', 'junit-pytest', 'junit-jvm', 'junit-ctest', 'trx'] as const) {
			assert.deepStrictEqual(parseTestReport(format, ''), { outcomes: [], errors: [] }, format);
		}
		assert.throws(() => parseTestReport('jest-json', ''), 'a JSON report that is not there is the controller\'s "no report was written"');
	});

	test('coverage: LCOV with functions and branches', () => {
		const [file] = parseLcovDetailed('TN:\nSF:src/calculator.js\nFN:1,add\nFN:2,subtract\nFN:7,factorial\nFNDA:3,add\nFNDA:1,subtract\nFNDA:0,factorial\nDA:1,3\nDA:2,1\nDA:7,0\nBRDA:4,0,0,1\nBRDA:4,0,1,-\nend_of_record\n');
		assert.deepStrictEqual([file.path, [...file.lines], file.functions, file.branches], ['src/calculator.js', [[1, 3], [2, 1], [7, 0]], [{ name: 'add', line: 1, hits: 3 }, { name: 'subtract', line: 2, hits: 1 }, { name: 'factorial', line: 7, hits: 0 }], { covered: 1, total: 2 }]);
	});
});
