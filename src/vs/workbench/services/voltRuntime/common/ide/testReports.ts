/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { findLastIdx } from '../../../../../base/common/arraysFind.js';
import type { TestReportFormat } from './testAdapter.js';

/** A source position in a failure's stack (path as the runner printed it: absolute or relative). */
export interface IStackLocation {
	readonly path: string;
	readonly line: number;
	readonly column?: number;
	readonly label?: string;
}

/** Where a test is, as far as the runner said. */
export interface ITestRef {
	/** The test file as the runner reported it (absolute or relative to the project), when it said. */
	readonly file?: string;
	/** The end of the file's path without its extension, when only a module or class name is known (`com/shop/CartTest`, `tests/test_cart`). */
	readonly fileHint?: string;
	/** Go: the package import path, to find the file among the package's test files. */
	readonly package?: string;
	/** The namespace or package of the first suite (C#, Java). */
	readonly scope?: string;
	/** Suite names then the test name, as the file declares them. */
	readonly path: readonly string[];
	/** One generated case of the test: a parameter set, a subtest, a data row (`[1-2]`, `empty_cart`, `(a: 1)`). */
	readonly variant?: string;
}

/** One test's outcome, whatever runner produced it. */
export interface ITestOutcome extends ITestRef {
	readonly state: 'passed' | 'failed' | 'skipped' | 'errored';
	readonly durationMs?: number;
	/** The failure message, ANSI-free, trimmed. */
	readonly message?: string;
	readonly expected?: string;
	readonly actual?: string;
	readonly stack?: readonly IStackLocation[];
	/** Where the runner says the test is (jest --testLocationInResults, junit line). */
	readonly line?: number;
	/** The test's own output (go, cargo, junit system-out). */
	readonly output?: string;
}

/** A failure not tied to one test (a file that does not compile or import, a crashed run). */
export interface ITestFileError {
	readonly file?: string;
	readonly fileHint?: string;
	readonly line?: number;
	readonly message: string;
}

export interface ITestReport {
	readonly outcomes: readonly ITestOutcome[];
	readonly errors: readonly ITestFileError[];
}

const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

export function stripAnsi(text: string): string {
	return text.replace(ANSI, '');
}

/** Stack frames that point into the project (not node_modules, not node internals), as path:line:column. */
export function parseStack(text: string, limit = 6): IStackLocation[] {
	const out: IStackLocation[] = [];
	const seen = new Set<string>();
	const patterns = [
		/at (?:(.+?) \()?(?:file:\/\/)?((?:[A-Za-z]:)?[^\s():]+):(\d+):(\d+)\)?/g, // V8: at fn (file:1:2) / at file:1:2 / at file:///abs:1:2
		/File "([^"]+)", line (\d+)(?:, in (\S+))?/g, // Python
		/^\s*((?:[A-Za-z]:)?[^\s:]+\.(?:go|rs|py|cpp|cc|cxx|h|hpp|rb|php|dart|swift|exs?)):(\d+)(?::(\d+))?/gm, // go / rust / pytest short / gtest / ...
		/at ([\w.$<>]+)\(([\w$]+\.(?:java|kt|scala|groovy)):(\d+)\)/g, // JVM: at pkg.Class.method(File.java:12)
		/at (.+?) in ((?:[A-Za-z]:)?[^\n]+?\.(?:cs|fs|vb)):line (\d+)/g, // .NET: at Ns.Class.Method() in /path/File.cs:line 12
	];
	for (const [index, pattern] of patterns.entries()) {
		for (const match of stripAnsi(text).matchAll(pattern)) {
			const [path, line, column, label] = index === 0 ? [match[2], match[3], match[4], match[1]] : index === 1 ? [match[1], match[2], undefined, match[3]] : index === 2 ? [match[1], match[2], match[3], undefined] : [match[2], match[3], undefined, match[1]];
			if (!path || /node_modules|node:internal|^internal\/|<anonymous>|site-packages|\/rustc\/|\/go\/src\/(?:testing|runtime)\/|^(?:java|jdk|sun|org\.junit|org\.testng|org\.gradle|org\.apache\.maven)\./.test(index === 3 ? label ?? '' : path)) {
				continue;
			}
			const key = `${path}:${line}`;
			if (seen.has(key)) {
				continue;
			}
			seen.add(key);
			out.push({ path: path.replace(/^file:\/\//, ''), line: Number(line), ...(column ? { column: Number(column) } : {}), ...(label ? { label } : {}) });
			if (out.length >= limit) {
				return out;
			}
		}
	}
	return out;
}

/** Expected / actual from the shapes assertion libraries print (jest, chai/vitest, node assert, pytest, unittest, JUnit, xUnit, NUnit, testify, GoogleTest, Rust). */
export function parseExpectedActual(message: string): { expected?: string; actual?: string } {
	const text = stripAnsi(message);
	const pair = (expected: string | undefined, actual: string | undefined) => expected !== undefined && actual !== undefined ? { expected: expected.trim(), actual: actual.trim() } : {};
	const jest = /Expected:?\s+(.+)\n\s*(?:Received|Actual|But was|Got):?\s+(.+)/i.exec(text);
	if (jest) {
		return pair(jest[1], jest[2]);
	}
	// node:assert prints the two values as a diff: "+ actual - expected", then "+ <actual>" and "- <expected>".
	const node = /\+ actual - expected\s*\n\s*\n?\s*\+ (.+)\n\s*- (.+)/.exec(text);
	if (node) {
		return pair(node[2], node[1]);
	}
	// GoogleTest's EXPECT_* with a value: "Value of: x", "Actual: 3", "Expected: 2".
	const actualFirst = /Actual:\s+(.+)\n\s*Expected:\s+(.+)/.exec(text);
	if (actualFirst) {
		return pair(actualFirst[2], actualFirst[1]);
	}
	const junit = /expected:? ?<(.*?)> but was:? ?<(.*?)>/s.exec(text);
	if (junit) {
		return pair(junit[1], junit[2]);
	}
	const testify = /expected\s*:\s*(.+)\n\s*actual\s*:\s*(.+)/.exec(text);
	if (testify) {
		return pair(testify[1], testify[2]);
	}
	const gtest = /Expected equality of these values:\n\s*(.+)\n(?:\s*Which is: (.+)\n)?\s*(.+)(?:\n\s*Which is: (.+))?/.exec(text);
	if (gtest) {
		return pair(gtest[4] ?? gtest[3], gtest[2] ?? gtest[1]);
	}
	const chai = /expected (.+?) to (?:deeply )?(?:equal|be|strictly equal) (.+?)(?:\s*\/\/|$)/m.exec(text);
	if (chai) {
		return pair(chai[2], chai[1]);
	}
	const unittest = /AssertionError: (.+?) != (.+?)$/m.exec(text);
	if (unittest) {
		return pair(unittest[2], unittest[1]);
	}
	// pytest's failure text quotes the source line (`>   assert f(x) == 11.0`) before the evaluated
	// one (`E   assert 12.0 == 11.0`): the values are on the `E` line.
	const pytest = /^E\s+assert (.+?) == (.+?)$/m.exec(text) ?? /assert (.+?) == (.+?)$/m.exec(text);
	if (pytest) {
		return pair(pytest[2], pytest[1]);
	}
	const rust = /left: (.+)\n\s*right: (.+)/.exec(text);
	if (rust) {
		return pair(rust[2], rust[1]);
	}
	return {};
}

/** A failure's message, expected/actual and project stack frames, from the text a runner printed for it. */
export function failureFromText(message: string | undefined): Pick<ITestOutcome, 'message' | 'expected' | 'actual' | 'stack'> {
	return failure(message);
}

function failure(message: string | undefined): Pick<ITestOutcome, 'message' | 'expected' | 'actual' | 'stack'> {
	if (!message?.trim()) {
		return {};
	}
	const clean = stripAnsi(message).trim();
	const stack = parseStack(clean);
	const firstFrame = clean.search(/\n\s+at |\nTraceback|\n\s*File "/);
	const head = (firstFrame > 0 ? clean.slice(0, firstFrame) : clean).trim();
	return { message: head.slice(0, 4_000), ...parseExpectedActual(clean), ...(stack.length ? { stack } : {}) };
}

/** `name[params]`, `name(args)`: the declared name and the generated case. */
function splitVariant(name: string): { readonly base: string; readonly variant?: string } {
	const index = name.search(/[[({]/);
	if (index <= 0) {
		return { base: name };
	}
	const rest = name.slice(index);
	// `adds()` is the method itself.
	return /^\(\)$/.test(rest) ? { base: name.slice(0, index) } : { base: name.slice(0, index), variant: rest };
}

// --- Jest / Vitest / Mocha JSON ----------------------------------------------------------------

interface IJestJson {
	readonly testResults?: readonly {
		readonly name?: string;
		readonly testFilePath?: string;
		readonly message?: string;
		readonly status?: string;
		readonly assertionResults?: readonly {
			readonly ancestorTitles?: readonly string[];
			readonly title?: string;
			readonly status?: string;
			readonly duration?: number | null;
			readonly failureMessages?: readonly string[];
			readonly location?: { readonly line?: number } | null;
		}[];
	}[];
}

/** Jest's `--json` report; Vitest's json reporter writes the same shape. */
export function parseJestJson(raw: string): ITestReport {
	const json = JSON.parse(raw) as IJestJson;
	const outcomes: ITestOutcome[] = [];
	const errors: ITestFileError[] = [];
	for (const file of json.testResults ?? []) {
		const path = file.name ?? file.testFilePath;
		const assertions = file.assertionResults ?? [];
		if (!assertions.length && file.message?.trim()) {
			// Jest explains Babel at length before the error: the headline and its "Details:" are the error.
			const message = stripAnsi(file.message).trim();
			const details = message.indexOf('Details:');
			errors.push({ ...(path ? { file: path } : {}), message: (details > 0 ? `${message.split('\n')[0].replace(/^\s*\u25cf\s*/, '')}\n${message.slice(details + 8).trim()}` : message).slice(0, 4_000) });
		}
		for (const result of assertions) {
			const state = result.status === 'passed' ? 'passed' : result.status === 'failed' ? 'failed' : 'skipped';
			outcomes.push({
				...(path ? { file: path } : {}),
				path: [...(result.ancestorTitles ?? []).filter(Boolean), result.title ?? ''],
				state,
				...(typeof result.duration === 'number' ? { durationMs: result.duration } : {}),
				...(result.location?.line ? { line: result.location.line } : {}),
				...(state === 'failed' ? failure(result.failureMessages?.join('\n')) : {}),
			});
		}
	}
	return { outcomes, errors };
}

interface IMochaJson {
	readonly tests?: readonly {
		readonly title?: string;
		readonly fullTitle?: string;
		readonly file?: string;
		readonly duration?: number;
		readonly pending?: boolean;
		readonly err?: { readonly message?: string; readonly stack?: string; readonly expected?: unknown; readonly actual?: unknown };
	}[];
}

/** Mocha's json reporter. Suite names are not separated in it: the full title minus the test title is one suite name. */
export function parseMochaJson(raw: string): ITestReport {
	const json = JSON.parse(raw) as IMochaJson;
	const outcomes = (json.tests ?? []).map((test): ITestOutcome => {
		const title = test.title ?? '';
		const suite = test.fullTitle && test.fullTitle.endsWith(title) ? test.fullTitle.slice(0, test.fullTitle.length - title.length).trim() : '';
		const failed = !!test.err && Object.keys(test.err).length > 0;
		const base = failed ? failure(test.err?.stack ?? test.err?.message) : {};
		return {
			...(test.file ? { file: test.file } : {}),
			path: suite ? [suite, title] : [title],
			state: test.pending ? 'skipped' : failed ? 'failed' : 'passed',
			...(typeof test.duration === 'number' ? { durationMs: test.duration } : {}),
			...base,
			...(failed && test.err?.expected !== undefined ? { expected: show(test.err.expected) } : {}),
			...(failed && test.err?.actual !== undefined ? { actual: show(test.err.actual) } : {}),
		};
	});
	return { outcomes, errors: [] };
}

function show(value: unknown): string {
	return typeof value === 'string' ? value : JSON.stringify(value);
}

// --- XML ---------------------------------------------------------------------------------------

export interface IXmlNode {
	readonly name: string;
	readonly attrs: Readonly<Record<string, string>>;
	readonly children: IXmlNode[];
	/** The element's own text and CDATA, joined. */
	text: string;
}

function xmlUnescape(text: string): string {
	return text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, '\'')
		.replace(/&#x([0-9a-fA-F]+);/g, (_, code: string) => String.fromCodePoint(parseInt(code, 16)))
		.replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code))).replace(/&amp;/g, '&');
}

/** A small, forgiving XML reader: elements, attributes, text and CDATA. Enough for test reports; a truncated file yields what it held. */
export function parseXml(raw: string): IXmlNode {
	const root: IXmlNode = { name: '', attrs: {}, children: [], text: '' };
	const stack: IXmlNode[] = [root];
	const token = /<!\[CDATA\[([\s\S]*?)\]\]>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<\/([\w:.-]+)\s*>|<([\w:.-]+)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
	for (const match of raw.matchAll(token)) {
		const top = stack[stack.length - 1];
		if (match[1] !== undefined) {
			top.text += match[1];
		} else if (match[2]) {
			// Close up to the matching open element; a stray close tag is ignored.
			const index = findLastIdx(stack, node => node.name === match[2]);
			if (index > 0) {
				stack.length = index;
			}
		} else if (match[3]) {
			const attrs: Record<string, string> = {};
			for (const attr of (match[4] ?? '').matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
				attrs[attr[1]] = xmlUnescape(attr[2] ?? attr[3] ?? '');
			}
			const node: IXmlNode = { name: match[3], attrs, children: [], text: '' };
			top.children.push(node);
			if (!match[5]) {
				stack.push(node);
			}
		} else if (match[6] !== undefined) {
			top.text += xmlUnescape(match[6]);
		}
	}
	return root;
}

function child(node: IXmlNode, ...names: string[]): IXmlNode | undefined {
	return node.children.find(item => names.includes(item.name));
}

// --- JUnit XML and its dialects ------------------------------------------------------------------

export type JunitDialect = 'pytest' | 'jvm' | 'ctest' | 'gtest' | 'node' | 'playwright' | 'rspec' | 'phpunit' | 'minitest' | 'mix';

const GTEST_NAME = /^(?:([\w-]+)\/)?(\w+)\.(\w+)(?:\/(\w+))?$/;

/** GoogleTest's console output, when ctest ran a whole test binary as one test: one outcome per `[ OK ]` / `[ FAILED ]` line. */
export function parseGtestText(raw: string): ITestOutcome[] {
	const text = stripAnsi(raw);
	const outcomes: ITestOutcome[] = [];
	const seen = new Set<string>();
	for (const match of text.matchAll(/^\[\s+(OK|FAILED|SKIPPED)\s+\] (\S+?)(?:,.*?)?(?: \((\d+) ms\))?$/gm)) {
		const name = GTEST_NAME.exec(match[2]);
		if (!name || seen.has(match[2])) {
			continue; // the summary repeats the failed tests
		}
		seen.add(match[2]);
		const state = match[1] === 'OK' ? 'passed' : match[1] === 'FAILED' ? 'failed' : 'skipped';
		const start = text.indexOf(`[ RUN      ] ${match[2]}`);
		const detail = state === 'failed' && start >= 0 ? text.slice(text.indexOf('\n', start) + 1, match.index).trim() : undefined;
		const variant = name[1] || name[4] ? [name[1], name[4]].filter(Boolean).join('/') : undefined;
		outcomes.push({ path: [name[2], name[3]], ...(variant ? { variant } : {}), state, ...(match[3] ? { durationMs: Number(match[3]) } : {}), ...(state === 'failed' ? failure(detail || 'Failed') : {}) });
	}
	return outcomes;
}

function pytestRef(classname: string, name: string, file: string | undefined): ITestRef {
	const { base, variant } = splitVariant(name);
	const parts = classname.split('.').filter(Boolean);
	let moduleLength: number;
	if (file) {
		moduleLength = file.replace(/\\/g, '/').replace(/\.py$/, '').split('/').length;
	} else {
		// Without the file attribute: the module ends at its test_ part, else where the class names start.
		const testPart = findLastIdx(parts, part => /^test_|_test$/.test(part));
		const firstClass = parts.findIndex(part => /^[A-Z]/.test(part));
		moduleLength = testPart >= 0 ? testPart + 1 : firstClass >= 0 ? firstClass : parts.length;
	}
	const module = parts.slice(0, moduleLength);
	return {
		...(file ? { file } : module.length ? { fileHint: module.join('/') } : {}),
		path: [...parts.slice(moduleLength), base],
		...(variant ? { variant } : {}),
	};
}

function jvmRef(classname: string, name: string): ITestRef {
	const dot = classname.lastIndexOf('.');
	const scope = dot >= 0 ? classname.slice(0, dot) : '';
	const classes = classname.slice(dot + 1).split('$').filter(Boolean);
	// JUnit 5 names: `adds()`, `sums(int, int)[1]`, `[1] a=1` (display name of a row), `sums{int}[1]`.
	const row = /^\[\d+\]/.test(name);
	const { base, variant } = row ? { base: '', variant: name } : splitVariant(name);
	return {
		...(scope ? { scope } : {}),
		fileHint: [...(scope ? scope.split('.') : []), classes[0] ?? ''].join('/'),
		path: [...classes, ...(base ? [base] : [])],
		...(variant ? { variant } : {}),
	};
}

/**
 * JUnit XML, as each runner writes it. `dialect` says how a test case's names map to the file's
 * declarations: pytest (module.Class + name[params]), the JVM (package.Class$Nested + method),
 * ctest and GoogleTest (Suite.Test), node/bun (nested suites, file attribute), Playwright.
 */
export function parseJunit(raw: string, dialect: JunitDialect = 'pytest'): ITestReport {
	const outcomes: ITestOutcome[] = [];
	const errors: ITestFileError[] = [];
	const walk = (node: IXmlNode, suites: readonly string[], suiteFile: string | undefined) => {
		for (const item of node.children) {
			if (item.name === 'testsuite' || item.name === 'testsuites') {
				const name = item.attrs.name ?? '';
				const file = item.attrs.file ?? item.attrs.filepath ?? suiteFile;
				// A suite named after its file (bun, Playwright, PHPUnit) is not a describe block.
				const namesFile = name === item.attrs.file || /\.(?:[cm]?[jt]sx?|py|php|rb|dart|exs?|swift)$/.test(name);
				const isFile = !name || namesFile || item.name === 'testsuites' || name === 'pytest' || name === 'node';
				walk(item, item.name === 'testsuite' && !isFile ? [...suites, name] : suites, file ?? (item.name === 'testsuite' && namesFile ? name : undefined));
				continue;
			}
			if (item.name !== 'testcase') {
				continue;
			}
			const name = item.attrs.name ?? '';
			const classname = item.attrs.classname ?? item.attrs.class ?? '';
			const file = item.attrs.file ?? item.attrs.filepath ?? suiteFile;
			const failed = child(item, 'failure', 'error');
			const skipped = child(item, 'skipped') || item.attrs.status === 'notrun' && !failed || item.attrs.result === 'skipped' || item.attrs.result === 'suppressed';
			const systemOut = child(item, 'system-out')?.text ?? '';
			// The element's text is the full failure; its message attribute repeats the first line (with the line breaks gone).
			// ctest says nothing in the failure itself: the test's output is the failure.
			const detail = failed ? (failed.text.trim() ? failed.text : failed.attrs.message) || (dialect === 'ctest' ? systemOut.trim() : '') || failed.attrs.type || 'Failed' : undefined;
			const state: ITestOutcome['state'] = failed ? (failed.name === 'error' ? 'errored' : 'failed') : skipped ? 'skipped' : 'passed';
			const time = item.attrs.time;
			const line = item.attrs.line ?? item.attrs.lineno;
			let ref: ITestRef;
			switch (dialect) {
				case 'pytest':
					if (failed && (!classname || !name) && !/^test/.test(name.split('.').pop() ?? '') || failed && /collection failure|collection error/i.test(failed.attrs.message ?? '')) {
						// A module that could not be imported or collected.
						const module = name || classname;
						errors.push({ ...(file ? { file } : module ? { file: /\.py$|[\\/]/.test(module) ? module : `${module.split('.').join('/')}.py` } : {}), message: (detail ?? 'collection error').slice(0, 4_000) });
						continue;
					}
					ref = pytestRef(classname, name, item.attrs.file);
					break;
				case 'jvm': {
					if (failed && (!name || /^(?:initializationError|classMethod|executionError|initializationFailed)$/.test(name) || name === classname)) {
						errors.push({ fileHint: jvmRef(classname, '').fileHint, message: (detail ?? 'The class failed before its tests ran.').slice(0, 4_000) });
						continue;
					}
					ref = jvmRef(classname, name);
					break;
				}
				case 'ctest':
				case 'gtest': {
					const full = dialect === 'gtest' ? `${classname}.${name}` : name;
					const gtest = GTEST_NAME.exec(full);
					if (dialect === 'ctest' && !gtest) {
						// One ctest test that is a whole GoogleTest binary: its output names the tests.
						const inner = parseGtestText(systemOut || failed?.text || '');
						if (inner.length) {
							outcomes.push(...inner);
							continue;
						}
					}
					const variant = gtest && (gtest[1] || gtest[4]) ? [gtest[1], gtest[4]].filter(Boolean).join('/') : undefined;
					ref = gtest ? { path: [gtest[2], gtest[3]], ...(variant ? { variant } : {}), ...(item.attrs.file ? { file: item.attrs.file } : {}) } : { path: [...suites, name], ...(item.attrs.file ? { file: item.attrs.file } : {}) };
					break;
				}
				case 'playwright':
					ref = { ...(classname ? { file: classname } : file ? { file } : {}), path: name.split(' \u203a ').filter(Boolean) };
					break;
				case 'phpunit': {
					const { base, variant } = /^(\w+) with data set (.+)$/.exec(name) ? { base: /^(\w+)/.exec(name)![1], variant: name.replace(/^\w+ with data set /, '') } : { base: name, variant: undefined };
					ref = { ...(file ? { file } : {}), path: [(item.attrs.class ?? classname).split('\\').pop() ?? '', base].filter(Boolean), ...(variant ? { variant } : {}) };
					break;
				}
				case 'rspec':
					// RSpec: classname is the spec file as a dotted path, name the full description; the file attribute says where.
					ref = { ...(file ? { file: file.replace(/^\.\//, '') } : {}), path: [name] };
					break;
				case 'minitest':
					ref = { ...(file ? { file } : {}), path: [...classname.split('::').filter(Boolean), name] };
					break;
				case 'mix':
					ref = { ...(file ? { file } : {}), path: [classname.replace(/^Elixir\./, ''), name.replace(/^test /, '')] };
					break;
				default: {
					// node --test and bun: nested <testsuite> elements are the describe blocks.
					ref = { ...(file ? { file } : {}), path: [...suites, name] };
				}
			}
			outcomes.push({
				...ref,
				state,
				...(time ? { durationMs: Math.round(Number(time) * 1000) } : {}),
				// pytest counts lines from 0.
				...(line && Number.isFinite(Number(line)) ? { line: Number(line) + (dialect === 'pytest' ? 1 : 0) } : {}),
				...(failed ? failure(detail) : {}),
				...(systemOut.trim() ? { output: systemOut.slice(-4_000) } : {}),
			});
		}
	};
	walk(parseXml(raw), [], undefined);
	return { outcomes, errors };
}

// --- TRX (dotnet test) ---------------------------------------------------------------------------

function trxDuration(value: string | undefined): number | undefined {
	const match = /^(\d+):(\d+):(\d+(?:\.\d+)?)$/.exec(value ?? '');
	return match ? Math.round((Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3])) * 1000) : undefined;
}

/** Visual Studio's TRX, which `dotnet test --logger trx` writes for xUnit, NUnit and MSTest alike. */
export function parseTrx(raw: string): ITestReport {
	const root = parseXml(raw);
	const run = child(root, 'TestRun') ?? root;
	const methods = new Map<string, { className: string; name: string }>();
	for (const test of child(run, 'TestDefinitions')?.children ?? []) {
		const method = child(test, 'TestMethod');
		if (test.attrs.id && method) {
			methods.set(test.attrs.id, { className: (method.attrs.className ?? '').split(',')[0].trim(), name: method.attrs.name ?? '' });
		}
	}
	const outcomes: ITestOutcome[] = [];
	const collect = (results: readonly IXmlNode[]) => {
		for (const result of results) {
			if (result.name !== 'UnitTestResult') {
				continue;
			}
			// A data-driven MSTest result holds its rows inside.
			const inner = child(result, 'InnerResults');
			if (inner?.children.length) {
				collect(inner.children);
				continue;
			}
			const testName = result.attrs.testName ?? '';
			const method = methods.get(result.attrs.testId ?? '');
			const className = method?.className || testName.replace(/\(.*$/, '').split('.').slice(0, -1).join('.');
			const methodName = splitVariant((method?.name || testName.replace(/\(.*$/, '').split('.').pop() || testName).split('.').pop() ?? '').base;
			const dot = className.lastIndexOf('.');
			const scope = dot >= 0 ? className.slice(0, dot) : '';
			const classes = className.slice(dot + 1).split('+').filter(Boolean);
			// The row of a theory or test case: what the display name adds after the method's name.
			const at = testName.lastIndexOf(methodName);
			const rest = at >= 0 ? testName.slice(at + methodName.length).trim() : '';
			const variant = rest && rest !== '()' ? rest : undefined;
			const error = child(child(result, 'Output') ?? result, 'ErrorInfo');
			const message = error ? child(error, 'Message')?.text ?? '' : '';
			const stackText = error ? child(error, 'StackTrace')?.text ?? '' : '';
			const outcome = (result.attrs.outcome ?? '').toLowerCase();
			const state: ITestOutcome['state'] = outcome === 'passed' ? 'passed' : outcome === 'failed' ? 'failed' : outcome === 'error' || outcome === 'timeout' || outcome === 'aborted' ? 'errored' : 'skipped';
			const stack = parseStack(stackText);
			const duration = trxDuration(result.attrs.duration);
			const stdout = child(child(result, 'Output') ?? result, 'StdOut')?.text ?? '';
			outcomes.push({
				...(scope ? { scope } : {}),
				path: [...classes, methodName],
				...(variant ? { variant } : {}),
				state,
				...(duration !== undefined ? { durationMs: duration } : {}),
				...(state === 'failed' || state === 'errored' ? { message: (stripAnsi(message).trim() || 'Failed').slice(0, 4_000), ...parseExpectedActual(message), ...(stack.length ? { stack } : {}) } : {}),
				...(stdout.trim() ? { output: stdout.slice(-4_000) } : {}),
			});
		}
	};
	collect(child(run, 'Results')?.children ?? []);
	const errors: ITestFileError[] = [];
	// The run's own errors (a test host that crashed, a project that did not load). With results they only repeat the failures.
	for (const info of outcomes.length ? [] : child(child(run, 'ResultSummary') ?? run, 'RunInfos')?.children ?? []) {
		const text = child(info, 'Text')?.text.trim();
		if (text && (info.attrs.outcome ?? '').toLowerCase() === 'error') {
			errors.push({ message: text.slice(0, 4_000) });
		}
	}
	return { outcomes, errors };
}

// --- go test -json -------------------------------------------------------------------------------

interface IGoEvent { Action?: string; Package?: string; ImportPath?: string; Test?: string; Elapsed?: number; Output?: string }

function goRef(pkg: string | undefined, test: string): ITestRef {
	const slash = test.indexOf('/');
	return { ...(pkg ? { package: pkg } : {}), path: [slash < 0 ? test : test.slice(0, slash)], ...(slash < 0 ? {} : { variant: test.slice(slash + 1) }) };
}

/** Where compilers say an error is, from their output: `file:line:col: message` and each toolchain's own shape. */
export function parseCompileErrors(output: string): ITestFileError[] {
	const text = stripAnsi(output);
	const errors: ITestFileError[] = [];
	const seen = new Set<string>();
	const add = (file: string, line: string | undefined, message: string) => {
		const key = `${file}:${line}`;
		if (!seen.has(key) && errors.length < 20) {
			seen.add(key);
			errors.push({ file: file.replace(/^file:\/\//, ''), ...(line ? { line: Number(line) } : {}), message: message.trim().slice(0, 2_000) });
		}
	};
	for (const match of text.matchAll(/^(?:\[ERROR\] |e: |error: )?(?:file:\/\/)?((?:[A-Za-z]:)?[^\s:(\[]+\.(?:go|c|cc|cpp|cxx|h|hpp|java|kt|swift|dart|ts|tsx|cs)):\[?(\d+)(?:[,:](\d+))?\]?:? (?:error:? |fatal error: )?(.+)$/gm)) {
		if (!/^\s*warning\b/.test(match[4]) && !/\bwarning(?: CS\d+)?:/.test(match[0])) {
			add(match[1], match[2], match[4]);
		}
	}
	// C#: /path/File.cs(12,5): error CS1002: ; expected [/path/x.csproj]
	for (const match of text.matchAll(/^\s*((?:[A-Za-z]:)?[^\s(]+\.(?:cs|fs|vb|ts|tsx))\((\d+),\d+\): error (\w+: .+?)(?: \[[^\]]+\])?$/gm)) {
		add(match[1], match[2], match[3]);
	}
	// rustc: error[E0425]: cannot find value `x`\n  --> src/lib.rs:5:9
	for (const match of text.matchAll(/^error(?:\[\w+\])?: (.+)\n\s*--> ([^\s:]+):(\d+):\d+/gm)) {
		add(match[2], match[3], match[1]);
	}
	// Python: a SyntaxError or ImportError while a module loads.
	for (const match of text.matchAll(/File "([^"]+\.py)", line (\d+)[^\n]*\n(?:.*\n){0,3}?(\w*(?:SyntaxError|IndentationError)\b.*)$/gm)) {
		add(match[1], match[2], match[3]);
	}
	return errors;
}

/** `go test -json` events: one outcome per test and per subtest (a subtest is a variant of its test). */
export function parseGoJson(raw: string): ITestReport {
	const tests = new Map<string, { package: string; test: string; state?: ITestOutcome['state']; elapsed?: number; output: string[] }>();
	const errors: ITestFileError[] = [];
	const packageOutput = new Map<string, string[]>();
	const failedPackages: string[] = [];
	for (const line of raw.split('\n')) {
		if (!line.startsWith('{')) {
			if (line.trim() && !/^(?:FAIL|ok|PASS|\?)\b|^# /.test(line.trim())) {
				packageOutput.set('', [...(packageOutput.get('') ?? []), `${line}\n`]);
			}
			continue;
		}
		let event: IGoEvent;
		try {
			event = JSON.parse(line) as IGoEvent;
		} catch {
			continue;
		}
		const pkg = event.Package ?? event.ImportPath?.replace(/ \[.*$/, '') ?? '';
		if (!event.Test) {
			if ((event.Action === 'output' || event.Action === 'build-output') && event.Output) {
				packageOutput.set(pkg, [...(packageOutput.get(pkg) ?? []), event.Output]);
			}
			if (event.Action === 'fail' || event.Action === 'build-fail') {
				failedPackages.push(pkg);
			}
			continue;
		}
		const key = `${pkg}\u0000${event.Test}`;
		const entry = tests.get(key) ?? { package: pkg, test: event.Test, output: [] };
		tests.set(key, entry);
		if (event.Action === 'output' && event.Output) {
			entry.output.push(event.Output);
		} else if (event.Action === 'pass' || event.Action === 'fail' || event.Action === 'skip') {
			entry.state = event.Action === 'pass' ? 'passed' : event.Action === 'fail' ? 'failed' : 'skipped';
			entry.elapsed = event.Elapsed;
		}
	}
	const reported = [...tests.values()].filter(entry => entry.state);
	const outcomes = reported.map((entry): ITestOutcome => {
		const output = entry.output.join('');
		const relevant = output.split('\n').filter(line => !/^(?:=== (?:RUN|PAUSE|CONT|NAME)|--- (?:PASS|SKIP|FAIL))/.test(line.trim())).join('\n').trim();
		// A test whose subtests failed fails with them: the subtests carry the messages.
		const failedThroughSubtests = entry.state === 'failed' && !relevant && reported.some(other => other !== entry && other.package === entry.package && other.test.startsWith(`${entry.test}/`) && other.state === 'failed');
		return {
			...goRef(entry.package, entry.test),
			state: entry.state!,
			...(entry.elapsed !== undefined ? { durationMs: Math.round(entry.elapsed * 1000) } : {}),
			...(entry.state === 'failed' ? (failedThroughSubtests ? { message: 'A subtest failed.' } : failure(relevant || 'Failed')) : {}),
			...(output.trim() ? { output: output.slice(-4_000) } : {}),
		};
	});
	// A package that failed without a failed test did not build (or panicked outside a test).
	for (const pkg of new Set([...failedPackages, ...(packageOutput.has('') ? [''] : [])])) {
		if (outcomes.some(outcome => outcome.package === pkg && outcome.state === 'failed')) {
			continue;
		}
		const output = (packageOutput.get(pkg) ?? []).join('').split('\n').filter(line => !/^(?:FAIL|ok|PASS|exit status)\b|^\s*$/.test(line)).join('\n').trim();
		if (!output) {
			continue;
		}
		const compile = parseCompileErrors(output);
		if (compile.length) {
			// The compiler names files relative to the folder go ran in: the project's.
			errors.push(...compile.map(error => ({ ...error, ...(error.file ? { file: error.file.replace(/^\.\//, '') } : {}) })));
		} else {
			errors.push({ message: `${pkg ? `${pkg}: ` : ''}${output.slice(-2_000)}` });
		}
	}
	return { outcomes, errors };
}

// --- cargo test ----------------------------------------------------------------------------------

/** libtest's plain output (`test a::b ... ok`) and its failures section. */
export function parseCargoText(raw: string): ITestReport {
	const text = stripAnsi(raw);
	const outcomes: ITestOutcome[] = [];
	const failures = new Map<string, string>();
	for (const section of text.matchAll(/^---- (\S+) stdout ----\n([\s\S]*?)(?=^---- \S+ stdout ----|^failures:\s*$|^test result:)/gm)) {
		failures.set(section[1], section[2].replace(/^note: run with `RUST_BACKTRACE=1`.*$/m, '').trim());
	}
	// "Running tests/api.rs (target/...)" starts an integration test file's own tests.
	let target: string | undefined;
	for (const line of text.split('\n')) {
		const running = /^\s*Running (?:unittests )?(\S+) \(/.exec(line);
		if (running) {
			target = /(?:^|\/)tests\//.test(running[1]) ? running[1] : undefined;
			continue;
		}
		const match = /^test (\S+) \.\.\. (ok|FAILED|ignored)\b/.exec(line) ?? /^test (\S+) - should panic \.\.\. (ok|FAILED|ignored)\b/.exec(line);
		if (!match) {
			continue;
		}
		const state = match[2] === 'ok' ? 'passed' : match[2] === 'FAILED' ? 'failed' : 'skipped';
		const detail = failures.get(match[1]);
		outcomes.push({ ...(target ? { file: target } : {}), path: match[1].split('::'), state, ...(state === 'failed' ? failure(detail || 'Failed') : {}), ...(detail ? { output: detail.slice(-4_000) } : {}) });
	}
	const compile = outcomes.length ? [] : parseCompileErrors(text);
	const errors: ITestFileError[] = compile.length ? compile : /^error(?:\[E\d+\])?: .+$/m.test(text) && !outcomes.length ? [{ message: text.slice(text.search(/^error/m)).slice(0, 4_000) }] : [];
	return { outcomes, errors };
}

// --- python -m unittest -v -----------------------------------------------------------------------

/** `test_a (pkg.mod.Class.test_a)`: the module's path, the class and the method. Python before 3.11 leaves the method out of the parentheses. */
function unittestRef(method: string, dotted: string): ITestRef {
	const parts = dotted.split('.');
	if (parts.at(-1) === method) {
		parts.pop();
	}
	const cls = parts.pop() ?? '';
	return { ...(parts.length ? { fileHint: parts.join('/') } : {}), path: [cls, method].filter(Boolean) };
}

const UNITTEST_STATE = /^(ok|FAIL|ERROR|skipped\b.*|expected failure|unexpected success)$/;

function unittestState(word: string): ITestOutcome['state'] {
	return word === 'ok' || word === 'expected failure' ? 'passed' : word === 'FAIL' || word === 'unexpected success' ? 'failed' : word === 'ERROR' ? 'errored' : 'skipped';
}

/** `python -m unittest -v`: a line per test, then a block per failure. */
export function parseUnittestText(raw: string): ITestReport {
	const text = stripAnsi(raw).replace(/\r\n/g, '\n');
	const outcomes = new Map<string, ITestOutcome>();
	const errors: ITestFileError[] = [];
	let pending: { method: string; dotted: string } | undefined;
	for (const line of text.split('\n')) {
		const head = /^(\w+) \(([\w.]+)\)(?: \.\.\. (.*))?$/.exec(line);
		if (head) {
			if (head[3] !== undefined && UNITTEST_STATE.test(head[3].trim())) {
				outcomes.set(`${head[2]}\u0000${head[1]}`, { ...unittestRef(head[1], head[2]), state: unittestState(head[3].trim()) });
				pending = undefined;
			} else {
				// A docstring's first line follows on the next line, with the state at its end.
				pending = { method: head[1], dotted: head[2] };
			}
			continue;
		}
		const tail = pending ? / \.\.\. (ok|FAIL|ERROR|skipped\b.*|expected failure|unexpected success)$/.exec(line) : null;
		if (pending && tail) {
			outcomes.set(`${pending.dotted}\u0000${pending.method}`, { ...unittestRef(pending.method, pending.dotted), state: unittestState(tail[1]) });
			pending = undefined;
		}
	}
	for (const block of text.split(/^={50,}$/m).slice(1)) {
		// A module that failed to import is named by its dotted path (`ERROR: tests.test_x (...)`).
		const head = /^\s*(FAIL|ERROR): ([\w.]+) \(([\w.]+)\)/.exec(block);
		if (!head) {
			continue;
		}
		const body = block.slice(block.indexOf('\n', block.indexOf(head[0])) + 1).replace(/^-{50,}\n/m, '').replace(/\n-{50,}\nRan \d+ tests?[\s\S]*$/, '').trim();
		if (/^unittest\.loader\._FailedTest|_FailedTest$/.test(head[3]) || !/^test/.test(head[2])) {
			// A module that could not be imported: `ERROR: tests.test_x (unittest.loader._FailedTest.tests.test_x)`.
			const module = head[3].replace(/^unittest\.loader\._FailedTest\.?/, '') || head[2];
			errors.push({ fileHint: module.split('.').join('/'), message: body.slice(0, 4_000) });
			continue;
		}
		const key = `${head[3]}\u0000${head[2]}`;
		const ref = unittestRef(head[2], head[3]);
		const lastLine = body.split('\n').filter(line => line.trim()).pop() ?? '';
		const details = failure(body);
		outcomes.set(key, { ...ref, state: head[1] === 'FAIL' ? 'failed' : 'errored', ...details, message: `${lastLine}\n${details.message ?? ''}`.trim().slice(0, 4_000) });
	}
	return { outcomes: [...outcomes.values()], errors };
}

export function parseTestReport(format: TestReportFormat, raw: string): ITestReport {
	switch (format) {
		case 'jest-json': return parseJestJson(raw);
		case 'mocha-json': return parseMochaJson(raw);
		case 'junit': case 'junit-pytest': return parseJunit(raw, 'pytest');
		case 'junit-jvm': return parseJunit(raw, 'jvm');
		case 'junit-ctest': return parseJunit(raw, 'ctest');
		case 'junit-gtest': return parseJunit(raw, 'gtest');
		case 'junit-node': return parseJunit(raw, 'node');
		case 'junit-playwright': return parseJunit(raw, 'playwright');
		case 'junit-rspec': return parseJunit(raw, 'rspec');
		case 'junit-phpunit': return parseJunit(raw, 'phpunit');
		case 'junit-minitest': return parseJunit(raw, 'minitest');
		case 'junit-mix': return parseJunit(raw, 'mix');
		case 'go-json': return parseGoJson(raw);
		case 'cargo-text': return parseCargoText(raw);
		case 'unittest-text': return parseUnittestText(raw);
		case 'trx': return parseTrx(raw);
		case 'dart-json': case 'swift-text': return { outcomes: [], errors: [] };
	}
}

/** Several report files of one run (one per class, per project) as one report. */
export function mergeTestReports(reports: readonly ITestReport[]): ITestReport {
	return { outcomes: reports.flatMap(report => report.outcomes), errors: reports.flatMap(report => report.errors) };
}
