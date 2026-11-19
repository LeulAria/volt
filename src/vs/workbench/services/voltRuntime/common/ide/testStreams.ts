/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { TestStreamFormat } from './testAdapter.js';
import { ITestOutcome, ITestRef, stripAnsi } from './testReports.js';

/** What a runner's output says while it runs: a test started, or finished with a state. Messages come with the report at the end. */
export type TestStreamEvent =
	| { readonly type: 'started'; readonly test: ITestRef }
	| { readonly type: 'finished'; readonly test: ITestRef; readonly state: ITestOutcome['state']; readonly durationMs?: number };

export interface ITestStream {
	/** Takes the next piece of output. `display`: what to show the user in its place (the text inside go's JSON events); undefined shows the output as it is. */
	push(chunk: string): { readonly events: TestStreamEvent[]; readonly display?: string };
}

type LineReader = (line: string, events: TestStreamEvent[]) => string | undefined | void;

/** Output arrives in pieces: lines are read whole, the unfinished tail waits for its end. */
function lineStream(read: LineReader, rewrites: boolean): ITestStream {
	let tail = '';
	return {
		push(chunk) {
			const text = tail + chunk;
			const end = text.lastIndexOf('\n');
			if (end < 0) {
				tail = text;
				return { events: [], ...(rewrites ? { display: '' } : {}) };
			}
			tail = text.slice(end + 1);
			const events: TestStreamEvent[] = [];
			const shown: string[] = [];
			for (const line of text.slice(0, end).split('\n')) {
				const display = read(line.replace(/\r$/, ''), events);
				if (rewrites && typeof display === 'string') {
					shown.push(display);
				}
			}
			return { events, ...(rewrites ? { display: shown.join('') } : {}) };
		},
	};
}

function seconds(value: string | undefined, unit: string | undefined): number | undefined {
	if (!value) {
		return undefined;
	}
	const number = Number(value);
	return Number.isFinite(number) ? Math.round(unit === 's' ? number * 1000 : unit === 'm' ? number * 60_000 : number) : undefined;
}

function goStream(): ITestStream {
	return lineStream((line, events) => {
		if (!line.startsWith('{')) {
			return line ? `${line}\n` : '';
		}
		let event: { Action?: string; Package?: string; Test?: string; Elapsed?: number; Output?: string };
		try {
			event = JSON.parse(line) as typeof event;
		} catch {
			return `${line}\n`;
		}
		if (event.Test) {
			const slash = event.Test.indexOf('/');
			const test: ITestRef = { ...(event.Package ? { package: event.Package } : {}), path: [slash < 0 ? event.Test : event.Test.slice(0, slash)], ...(slash < 0 ? {} : { variant: event.Test.slice(slash + 1) }) };
			if (event.Action === 'run') {
				events.push({ type: 'started', test });
			} else if (event.Action === 'pass' || event.Action === 'fail' || event.Action === 'skip') {
				events.push({ type: 'finished', test, state: event.Action === 'pass' ? 'passed' : event.Action === 'fail' ? 'failed' : 'skipped', ...(event.Elapsed !== undefined ? { durationMs: Math.round(event.Elapsed * 1000) } : {}) });
			}
		}
		return (event.Action === 'output' || event.Action === 'build-output') && event.Output ? event.Output : '';
	}, true);
}

function cargoStream(): ITestStream {
	let target: string | undefined;
	return lineStream((raw, events) => {
		const line = stripAnsi(raw);
		const running = /^\s*Running (?:unittests )?(\S+) \(/.exec(line);
		if (running) {
			target = /(?:^|\/)tests\//.test(running[1]) ? running[1] : undefined;
			return;
		}
		const match = /^test (\S+) \.\.\. (ok|FAILED|ignored)\b/.exec(line);
		if (match) {
			events.push({ type: 'finished', test: { ...(target ? { file: target } : {}), path: match[1].split('::') }, state: match[2] === 'ok' ? 'passed' : match[2] === 'FAILED' ? 'failed' : 'skipped' });
		}
	}, false);
}

const PYTEST_STATES: Readonly<Record<string, ITestOutcome['state']>> = { PASSED: 'passed', FAILED: 'failed', ERROR: 'errored', SKIPPED: 'skipped', XFAIL: 'skipped', XPASS: 'passed' };

function pytestRef(id: string): ITestRef {
	const [file, ...names] = id.split('::');
	const last = names.pop() ?? '';
	const bracket = last.indexOf('[');
	return { file, path: [...names, bracket > 0 ? last.slice(0, bracket) : last], ...(bracket > 0 ? { variant: last.slice(bracket) } : {}) };
}

function pytestStream(): ITestStream {
	return lineStream((raw, events) => {
		const line = stripAnsi(raw);
		// tests/test_a.py::TestC::test_x[1-2] PASSED [ 50%]   or, with xdist,   [gw0] [ 50%] PASSED tests/test_a.py::test_x
		const plain = /^(\S+\.py::.+?) (PASSED|FAILED|ERROR|SKIPPED|XFAIL|XPASS)\b/.exec(line);
		const xdist = plain ? null : /^\[gw\d+\] \[\s*\d+%\] (PASSED|FAILED|ERROR|SKIPPED|XFAIL|XPASS) (\S+\.py::.+?)\s*$/.exec(line);
		const id = plain?.[1] ?? xdist?.[2];
		const state = plain?.[2] ?? xdist?.[1];
		if (id && state) {
			events.push({ type: 'finished', test: pytestRef(id), state: PYTEST_STATES[state] });
		}
	}, false);
}

function unittestStream(): ITestStream {
	let pending: { method: string; dotted: string } | undefined;
	const ref = (method: string, dotted: string): ITestRef => {
		const parts = dotted.split('.');
		if (parts.at(-1) === method) {
			parts.pop();
		}
		const cls = parts.pop() ?? '';
		return { ...(parts.length ? { fileHint: parts.join('/') } : {}), path: [cls, method].filter(Boolean) };
	};
	const state = (word: string): ITestOutcome['state'] => word === 'ok' || word === 'expected failure' ? 'passed' : word === 'FAIL' || word === 'unexpected success' ? 'failed' : word === 'ERROR' ? 'errored' : 'skipped';
	return lineStream((raw, events) => {
		const line = stripAnsi(raw);
		const head = /^(test\w*) \(([\w.]+)\)(?: \.\.\. (ok|FAIL|ERROR|skipped\b.*|expected failure|unexpected success))?$/.exec(line);
		if (head) {
			if (head[3]) {
				events.push({ type: 'finished', test: ref(head[1], head[2]), state: state(head[3]) });
				pending = undefined;
			} else {
				pending = { method: head[1], dotted: head[2] };
			}
			return;
		}
		const tail = pending ? / \.\.\. (ok|FAIL|ERROR|skipped\b.*|expected failure|unexpected success)$/.exec(line) : null;
		if (pending && tail) {
			events.push({ type: 'finished', test: ref(pending.method, pending.dotted), state: state(tail[1]) });
			pending = undefined;
		}
	}, false);
}

/** The marks the JS runners print before a finished test: a check, a cross, a circle or arrow for skipped. */
const PASS_MARK = '[\\u2713\\u221a\\u2714]';
const FAIL_MARK = '[\\u2715\\u00d7\\u2717\\u2716\\u276f]';
const SKIP_MARK = '[\\u25cb\\u2193\\u270e\\u25cc-]';

function vitestStream(): ITestStream {
	//  (check) src/math.test.ts > math > adds 1ms      (cross) |project| src/math.test.ts > math > fails 3ms
	const pattern = new RegExp(`^\\s*(${PASS_MARK}|${FAIL_MARK}|${SKIP_MARK})\\s+(?:\\|[^|]+\\|\\s+)?(\\S+\\.[cm]?[jt]sx?) > (.+?)(?:\\s+(\\d+(?:\\.\\d+)?)\\s*(ms|s|m))?(?:\\s+\\[.*\\])?$`);
	const pass = new RegExp(PASS_MARK);
	const fail = new RegExp(FAIL_MARK);
	return lineStream((raw, events) => {
		const match = pattern.exec(stripAnsi(raw));
		if (match) {
			const duration = seconds(match[4], match[5]);
			events.push({ type: 'finished', test: { file: match[2], path: match[3].split(' > ') }, state: pass.test(match[1]) ? 'passed' : fail.test(match[1]) ? 'failed' : 'skipped', ...(duration !== undefined ? { durationMs: duration } : {}) });
		}
	}, false);
}

function jestStream(): ITestStream {
	// PASS src/math.test.js        then, indented by suite depth,       (check) adds (2 ms)
	const test = new RegExp(`^(\\s+)(${PASS_MARK}|${FAIL_MARK}|${SKIP_MARK})\\s+(.+?)(?:\\s+\\((\\d+(?:\\.\\d+)?)\\s*(ms|s)\\))?$`);
	const pass = new RegExp(PASS_MARK);
	const fail = new RegExp(FAIL_MARK);
	let file: string | undefined;
	let suites: { indent: number; name: string }[] = [];
	return lineStream((raw, events) => {
		const line = stripAnsi(raw);
		const header = /^\s*(?:PASS|FAIL)\s+(\S+)/.exec(line);
		if (header) {
			file = header[1];
			suites = [];
			return;
		}
		if (!file || !line.trim()) {
			return;
		}
		const match = test.exec(line);
		const indent = line.length - line.trimStart().length;
		if (match) {
			const duration = seconds(match[4], match[5]);
			// A skipped or todo test's name follows the word: "(circle) skipped name", "(pencil) todo name".
			const name = pass.test(match[2]) || fail.test(match[2]) ? match[3] : match[3].replace(/^(?:skipped|todo) /, '');
			events.push({ type: 'finished', test: { file, path: [...suites.filter(suite => suite.indent < match[1].length).map(suite => suite.name), name] }, state: pass.test(match[2]) ? 'passed' : fail.test(match[2]) ? 'failed' : 'skipped', ...(duration !== undefined ? { durationMs: duration } : {}) });
		} else if (indent >= 2 && indent % 2 === 0 && !/^\s*(?:\u25cf|at |Expected|Received|Tests:|Test Suites:|Snapshots:|Time:|Ran all)/.test(line)) {
			// A describe block's name, at its depth.
			suites = [...suites.filter(suite => suite.indent < indent), { indent, name: line.trim() }];
		} else if (indent === 0) {
			file = undefined;
		}
	}, false);
}

function dotnetStream(): ITestStream {
	//   Passed Shop.Tests.CartTests.Adds [3 ms]      Failed Shop.Tests.CartTests.Sums(a: 1, b: 2) [12 ms]
	return lineStream((raw, events) => {
		const match = /^\s+(Passed|Failed|Skipped) (\S+?)(\(.*\))?(?: \[(?:< )?(\d+(?:\.\d+)?) ?(ms|s|m)\])?$/.exec(stripAnsi(raw));
		if (!match || !match[2].includes('.')) {
			return;
		}
		const parts = match[2].split('.');
		const method = parts.pop()!;
		const classes = (parts.pop() ?? '').split('+');
		const duration = seconds(match[4], match[5]);
		events.push({ type: 'finished', test: { ...(parts.length ? { scope: parts.join('.') } : {}), path: [...classes, method], ...(match[3] ? { variant: match[3] } : {}) }, state: match[1] === 'Passed' ? 'passed' : match[1] === 'Failed' ? 'failed' : 'skipped', ...(duration !== undefined ? { durationMs: duration } : {}) });
	}, false);
}

/** A reader of a runner's live output, or undefined when the runner names no tests as it goes. */
export function createTestStream(format: TestStreamFormat | undefined): ITestStream | undefined {
	switch (format) {
		case 'go-json': return goStream();
		case 'cargo-text': return cargoStream();
		case 'pytest-verbose': return pytestStream();
		case 'unittest-text': return unittestStream();
		case 'vitest-verbose': return vitestStream();
		case 'jest-verbose': return jestStream();
		case 'dotnet-console': return dotnetStream();
	}
	return undefined;
}
