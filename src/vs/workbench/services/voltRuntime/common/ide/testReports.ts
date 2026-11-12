/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { TestReportFormat } from './testFrameworks.js';

/** A source position in a failure's stack (path as the runner printed it: absolute or relative). */
export interface IStackLocation {
	readonly path: string;
	readonly line: number;
	readonly column?: number;
	readonly label?: string;
}

/** One test's outcome, whatever runner produced it. */
export interface ITestOutcome {
	/** The test file as the runner reported it (absolute or relative to the project), when it said. */
	readonly file?: string;
	/** Go: the package import path, to find the file among the package's test files. */
	readonly package?: string;
	/** Suite names then the test name. */
	readonly path: readonly string[];
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

export interface ITestReport {
	readonly outcomes: readonly ITestOutcome[];
	/** Failures not tied to one test (a file that does not compile, a crashed run). */
	readonly errors: readonly { readonly file?: string; readonly message: string }[];
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
		/at (?:(.+?) \()?((?:[A-Za-z]:)?[^\s():]+):(\d+):(\d+)\)?/g, // V8: at fn (file:1:2) / at file:1:2
		/File "([^"]+)", line (\d+)(?:, in (\S+))?/g, // Python
		/^\s*((?:[A-Za-z]:)?[^\s:]+\.(?:go|rs|py)):(\d+)(?::(\d+))?/gm, // go / rust / pytest short
	];
	for (const [index, pattern] of patterns.entries()) {
		for (const match of stripAnsi(text).matchAll(pattern)) {
			const [path, line, column, label] = index === 0 ? [match[2], match[3], match[4], match[1]] : index === 1 ? [match[1], match[2], undefined, match[3]] : [match[1], match[2], match[3], undefined];
			if (!path || /node_modules|node:internal|^internal\/|<anonymous>|site-packages|\/rustc\/|\/go\/src\/(?:testing|runtime)\//.test(path)) {
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

/** Expected / actual from the shapes assertion libraries print (jest, chai/vitest, node assert, pytest). */
export function parseExpectedActual(message: string): { expected?: string; actual?: string } {
	const text = stripAnsi(message);
	const jest = /Expected:?\s+(.+)\n\s*Received:?\s+(.+)/.exec(text);
	if (jest) {
		return { expected: jest[1].trim(), actual: jest[2].trim() };
	}
	const chai = /expected (.+?) to (?:deeply )?(?:equal|be|strictly equal) (.+?)(?:\s*\/\/|$)/m.exec(text);
	if (chai) {
		return { expected: chai[2].trim(), actual: chai[1].trim() };
	}
	const pytest = /assert (.+?) == (.+?)$/m.exec(text);
	if (pytest) {
		return { expected: pytest[2].trim(), actual: pytest[1].trim() };
	}
	const rust = /left: (.+)\n\s*right: (.+)/.exec(text);
	if (rust) {
		return { expected: rust[2].trim(), actual: rust[1].trim() };
	}
	return {};
}

function failure(message: string | undefined): Pick<ITestOutcome, 'message' | 'expected' | 'actual' | 'stack'> {
	if (!message?.trim()) {
		return {};
	}
	const clean = stripAnsi(message).trim();
	const stack = parseStack(clean);
	const firstFrame = clean.search(/\n\s+at |\nTraceback|\n\s*File "/);
	const head = (firstFrame > 0 ? clean.slice(0, firstFrame) : clean).trim();
	return { message: head.slice(0, 4_000), ...parseExpectedActual(head), ...(stack.length ? { stack } : {}) };
}

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
	const errors: { file?: string; message: string }[] = [];
	for (const file of json.testResults ?? []) {
		const path = file.name ?? file.testFilePath;
		const assertions = file.assertionResults ?? [];
		if (!assertions.length && file.message?.trim()) {
			errors.push({ ...(path ? { file: path } : {}), message: stripAnsi(file.message).trim().slice(0, 4_000) });
		}
		for (const result of assertions) {
			const state = result.status === 'passed' ? 'passed' : result.status === 'failed' ? 'failed' : 'skipped';
			outcomes.push({
				...(path ? { file: path } : {}),
				path: [...(result.ancestorTitles ?? []), result.title ?? ''],
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

function xmlUnescape(text: string): string {
	return text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, '\'').replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code))).replace(/&amp;/g, '&');
}

function attr(tag: string, name: string): string | undefined {
	const match = new RegExp(`\\s${name}="([^"]*)"`).exec(tag);
	return match ? xmlUnescape(match[1]) : undefined;
}

/** JUnit XML (pytest --junitxml). Class names become suites; the module part is dropped (the file says it). */
export function parseJunit(raw: string): ITestReport {
	const outcomes: ITestOutcome[] = [];
	const errors: { file?: string; message: string }[] = [];
	for (const match of raw.matchAll(/<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g)) {
		const tag = match[1];
		const body = match[2] ?? '';
		const name = attr(tag, 'name') ?? '';
		const classname = attr(tag, 'classname') ?? '';
		const file = attr(tag, 'file');
		const line = attr(tag, 'line');
		const time = attr(tag, 'time');
		const classes = classname.split('.').filter(part => /^[A-Z]/.test(part));
		const failed = /<(?:failure|error)\b([^>]*)>([\s\S]*?)<\/(?:failure|error)>|<(?:failure|error)\b([^>]*)\/>/.exec(body);
		const skipped = /<skipped\b/.test(body);
		const out = /<system-out>([\s\S]*?)<\/system-out>/.exec(body);
		const detail = failed ? xmlUnescape(failed[2] ?? '') || attr(failed[1] ?? failed[3] ?? '', 'message') : undefined;
		if (!name && failed) {
			errors.push({ ...(file ? { file } : {}), message: (detail ?? 'collection error').slice(0, 4_000) });
			continue;
		}
		outcomes.push({
			...(file ? { file } : {}),
			path: [...classes, name],
			state: failed ? (/<error\b/.test(body) ? 'errored' : 'failed') : skipped ? 'skipped' : 'passed',
			...(time ? { durationMs: Math.round(Number(time) * 1000) } : {}),
			...(line ? { line: Number(line) + 1 } : {}),
			...(failed ? failure(detail) : {}),
			...(out ? { output: xmlUnescape(out[1]).slice(-4_000) } : {}),
		});
	}
	return { outcomes, errors };
}

/** `go test -json` events: one outcome per top-level test (subtests fold into their parent's output). */
export function parseGoJson(raw: string): ITestReport {
	const tests = new Map<string, { package: string; name: string; state?: ITestOutcome['state']; elapsed?: number; output: string[] }>();
	const errors: { message: string }[] = [];
	const buildOutput = new Map<string, string[]>();
	for (const line of raw.split('\n')) {
		if (!line.startsWith('{')) {
			if (line.trim()) {
				errors.push({ message: line.trim() });
			}
			continue;
		}
		let event: { Action?: string; Package?: string; Test?: string; Elapsed?: number; Output?: string };
		try {
			event = JSON.parse(line) as typeof event;
		} catch {
			continue;
		}
		if (!event.Test) {
			if (event.Action === 'output' && event.Package && event.Output) {
				buildOutput.set(event.Package, [...(buildOutput.get(event.Package) ?? []), event.Output]);
			}
			if (event.Action === 'fail' && event.Package) {
				const output = buildOutput.get(event.Package)?.join('') ?? '';
				if (!/^(?:---|===|ok|FAIL|PASS)/m.test(output) || /cannot|undefined:|syntax error|build failed/.test(output)) {
					errors.push({ message: `${event.Package}: ${output.trim().slice(-2_000) || 'failed'}` });
				}
			}
			continue;
		}
		const top = event.Test.split('/')[0];
		const key = `${event.Package}\u0000${top}`;
		const entry = tests.get(key) ?? { package: event.Package ?? '', name: top, output: [] };
		tests.set(key, entry);
		if (event.Action === 'output' && event.Output) {
			entry.output.push(event.Output);
		} else if (event.Test === top && (event.Action === 'pass' || event.Action === 'fail' || event.Action === 'skip')) {
			entry.state = event.Action === 'pass' ? 'passed' : event.Action === 'fail' ? 'failed' : 'skipped';
			entry.elapsed = event.Elapsed;
		}
	}
	const outcomes = [...tests.values()].filter(entry => entry.state).map((entry): ITestOutcome => {
		const output = entry.output.join('');
		const relevant = output.split('\n').filter(line => !/^(?:=== (?:RUN|PAUSE|CONT)|--- (?:PASS|SKIP))/.test(line.trim())).join('\n').trim();
		return {
			package: entry.package,
			path: [entry.name],
			state: entry.state!,
			...(entry.elapsed !== undefined ? { durationMs: Math.round(entry.elapsed * 1000) } : {}),
			...(entry.state === 'failed' ? failure(relevant) : {}),
			output: output.slice(-4_000),
		};
	});
	return { outcomes, errors };
}

/** libtest's plain output (`test a::b ... ok`) and its failures section. */
export function parseCargoText(raw: string): ITestReport {
	const text = stripAnsi(raw);
	const outcomes: ITestOutcome[] = [];
	const failures = new Map<string, string>();
	for (const section of text.matchAll(/^---- (\S+) stdout ----\n([\s\S]*?)(?=^---- \S+ stdout ----|^failures:\s*$|^test result:)/gm)) {
		failures.set(section[1], section[2].trim());
	}
	for (const match of text.matchAll(/^test (\S+) \.\.\. (ok|FAILED|ignored)/gm)) {
		const state = match[2] === 'ok' ? 'passed' : match[2] === 'FAILED' ? 'failed' : 'skipped';
		const detail = failures.get(match[1]);
		outcomes.push({ path: match[1].split('::'), state, ...(state === 'failed' ? failure(detail) : {}), ...(detail ? { output: detail.slice(-4_000) } : {}) });
	}
	const errors = /^error(?:\[E\d+\])?: .+$/m.test(text) && !outcomes.length ? [{ message: text.slice(text.search(/^error/m)).slice(0, 4_000) }] : [];
	return { outcomes, errors };
}

export function parseTestReport(format: TestReportFormat, raw: string): ITestReport {
	switch (format) {
		case 'jest-json': return parseJestJson(raw);
		case 'mocha-json': return parseMochaJson(raw);
		case 'junit': return parseJunit(raw);
		case 'go-json': return parseGoJson(raw);
		case 'cargo-text': return parseCargoText(raw);
	}
}
