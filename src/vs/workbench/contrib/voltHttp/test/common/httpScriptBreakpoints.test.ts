/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { HTTP_SCRIPT_BREAK_NAME, httpScriptBreakableLines, instrumentHttpScript, snapHttpScriptBreakpoint } from '../../common/httpScriptBreakpoints.js';

/** A script from its lines: the array index + 1 is the line number. */
function script(...lines: string[]): string {
	return lines.join('\n');
}

/** The names each breakpoint of an instrumented script reads, by line. */
function namesByLine(instrumented: string): Map<number, string[]> {
	const found = new Map<number, string[]>();
	const call = /__voltBreak\((\d+),"([^"]*)"/g;
	for (let match = call.exec(instrumented); match; match = call.exec(instrumented)) {
		found.set(Number(match[1]), match[2] ? match[2].split(',') : []);
	}
	return found;
}

/** Breakpoints on every line: the script must still parse, and keep its lines. */
function instrumentAll(text: string): { script: string; lines: number[] } {
	const count = text.split('\n').length;
	const done = instrumentHttpScript(text, Array.from({ length: count }, (_, index) => index + 1));
	assert.strictEqual(done.script.split('\n').length, count, 'no line is added or removed');
	assert.doesNotThrow(() => new Function(HTTP_SCRIPT_BREAK_NAME, 'pm', 'console', done.script), `the instrumented script parses:\n${done.script}`);
	return done;
}

const TRICKY = script(
	/*  1 */ '// only a comment',
	/*  2 */ 'const a = "{ not a block }";',
	/*  3 */ 'const t = `x ${ { y: 1 }.y } { ${ `in ${ a }` }`;',
	/*  4 */ 'const re = /[/{]\\}/g;',
	/*  5 */ '/* a block',
	/*  6 */ '   comment { */',
	/*  7 */ 'const o = {',
	/*  8 */ '	k: 1,',
	/*  9 */ '	m() {',
	/* 10 */ '		return 2;',
	/* 11 */ '	},',
	/* 12 */ '	f: function () { return 3; },',
	/* 13 */ '};',
	/* 14 */ '',
	/* 15 */ 'pm.test("x", function () {',
	/* 16 */ '	const body = pm.response.json();',
	/* 17 */ '	pm.expect(body.id)',
	/* 18 */ '		.to.equal(7);',
	/* 19 */ '	[1, 2].forEach(n => {',
	/* 20 */ '		a.length + n / 2;',
	/* 21 */ '	});',
	/* 22 */ '});',
);

const STATEMENTS = script(
	/*  1 */ 'function helper(x, { y, z: [w] }, ...rest) {',
	/*  2 */ '	if (x) return y;',
	/*  3 */ '	else',
	/*  4 */ '		return w;',
	/*  5 */ '}',
	/*  6 */ 'async function load() {',
	/*  7 */ '	for (const [k, v] of Object.entries({ a: 1 })) {',
	/*  8 */ '		console.log(k, v);',
	/*  9 */ '	}',
	/* 10 */ '	try {',
	/* 11 */ '		await 1;',
	/* 12 */ '	} catch (err) {',
	/* 13 */ '		console.log(err);',
	/* 14 */ '	} finally {',
	/* 15 */ '		console.log("done");',
	/* 16 */ '	}',
	/* 17 */ '}',
	/* 18 */ 'class Box {',
	/* 19 */ '	static count = 0;',
	/* 20 */ '	constructor(v) {',
	/* 21 */ '		this.v = v;',
	/* 22 */ '	}',
	/* 23 */ '	get value() { return this.v; }',
	/* 24 */ '}',
	/* 25 */ 'switch (helper(1, { y: 2, z: [3] })) {',
	/* 26 */ '	case 2:',
	/* 27 */ '		console.log("two");',
	/* 28 */ '		break;',
	/* 29 */ '	default:',
	/* 30 */ '		console.log("other");',
	/* 31 */ '}',
	/* 32 */ 'let late = 1;',
	/* 33 */ 'while (late < 3) late++;',
	/* 34 */ 'do late--; while (late > 0)',
	/* 35 */ 'label: for (;;) { break label; }',
);

suite('HTTP client script breakpoints', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('breakable lines: strings, templates, regex and comments are not code; object literals and multi-line expressions are not statements', () => {
		assert.deepStrictEqual(httpScriptBreakableLines(TRICKY), [2, 3, 4, 7, 10, 12, 15, 16, 17, 19, 20]);
		// Without the semicolon, line 19 starts with `[` and goes on from line 18: the language puts none in there.
		assert.deepStrictEqual(httpScriptBreakableLines(TRICKY.replace('.to.equal(7);', '.to.equal(7)')), [2, 3, 4, 7, 10, 12, 15, 16, 17, 20]);
	});

	test('breakable lines: functions, async, classes, loops, switch cases, try/catch/finally, brace-less bodies, labels', () => {
		assert.deepStrictEqual(httpScriptBreakableLines(STATEMENTS), [2, 4, 7, 8, 10, 11, 13, 15, 18, 21, 23, 25, 27, 28, 30, 32, 33, 34, 35]);
	});

	test('breakable lines: where a statement goes on to the next line, and where it ends without a semicolon', () => {
		assert.deepStrictEqual(httpScriptBreakableLines(script(
			'let a = 1',
			'let b = a',
			'	+ 2',
			'a++',
			'b = a ? {',
			'	k: 1 } : [',
			'	2 ]',
			'const f = function () { return 1 }',
			'(function () { })',
			'var g = a',
			'pm.test(`t`, () => {})',
		)), [1, 2, 4, 5, 8, 10, 11]);
		// A directive stays the first thing in its function: nothing may go in front of it.
		assert.deepStrictEqual(httpScriptBreakableLines(script('"use strict";', 'const a = 1;', 'function f() {', '	"use strict"', '	return a;', '}')), [2, 5]);
		assert.deepStrictEqual(httpScriptBreakableLines(''), []);
		assert.deepStrictEqual(httpScriptBreakableLines('\n// nothing\n/* at all */\n'), []);
	});

	test('a script that does not parse has no breakable lines and is left as it is', () => {
		for (const broken of ['pm.test("never", () => {', 'const a = "cut off', 'const t = `cut ${ off', 'foo(1));', '/* open', 'if (x) { } else else { }', 'a = [1, 2);']) {
			assert.deepStrictEqual(httpScriptBreakableLines(broken), [], broken);
			assert.deepStrictEqual(instrumentHttpScript(broken, [1]), { script: broken, lines: [] }, broken);
		}
	});

	test('a breakpoint snaps to the next breakable line, and is dropped past the last', () => {
		assert.deepStrictEqual(instrumentHttpScript(TRICKY, [1, 2, 5, 6, 8, 22, 99, 0, -3, Number.NaN]).lines, [2, 7, 10]);
		assert.strictEqual(snapHttpScriptBreakpoint([2, 7, 10], 3), 7);
		assert.strictEqual(snapHttpScriptBreakpoint([2, 7, 10], 10), 10);
		assert.strictEqual(snapHttpScriptBreakpoint([2, 7, 10], 11), undefined);
		assert.deepStrictEqual(instrumentHttpScript(TRICKY, []), { script: TRICKY, lines: [] });
	});

	test('instrumenting keeps every line where it is and the script parses', () => {
		const tricky = instrumentAll(TRICKY);
		assert.deepStrictEqual(tricky.lines, httpScriptBreakableLines(TRICKY));
		const before = TRICKY.split('\n');
		const after = tricky.script.split('\n');
		for (let index = 0; index < before.length; index++) {
			if (tricky.lines.includes(index + 1)) {
				assert.ok(after[index].includes(`${HTTP_SCRIPT_BREAK_NAME}(${index + 1},`), after[index]);
				assert.strictEqual(after[index].replace(/__voltBreak\(\d+,"[^"]*",\[[^\]]*\]\);/, ''), before[index], 'the call is all that is added');
			} else {
				assert.strictEqual(after[index], before[index]);
			}
		}
		assert.deepStrictEqual(instrumentAll(STATEMENTS).lines, httpScriptBreakableLines(STATEMENTS));
		// One breakpoint: one line changes.
		const one = instrumentHttpScript(TRICKY, [16]).script.split('\n');
		assert.deepStrictEqual(one.filter((line, index) => line !== before[index]).length, 1);
	});

	test('a brace-less body is put in braces, so the breakpoint does not change what runs', () => {
		const text = script(
			'function pick(x) {',
			'	if (x > 1) return "big";',
			'	else if (x > 0)',
			'		return "small";',
			'	else',
			'		return "none";',
			'}',
			'let n = 0;',
			'for (let i = 0; i < 3; i++)',
			'	n += i;',
			'while (n < 10)',
			'	n++;',
			'do',
			'	n--',
			'while (n > 5)',
			'if (n) n = 100; else',
			'	n = -1;',
			'return [pick(2), pick(1), pick(0), n];',
		);
		const done = instrumentAll(text);
		assert.deepStrictEqual(done.lines, [2, 3, 4, 6, 8, 9, 10, 11, 12, 13, 14, 16, 17, 18]);
		const stops: number[] = [];
		const result = new Function(HTTP_SCRIPT_BREAK_NAME, done.script)((line: number) => { stops.push(line); });
		assert.deepStrictEqual(result, new Function(text)());
		assert.deepStrictEqual(result, ['big', 'small', 'none', 100]);
		// Only what runs stops, each time it runs: line 17's `else` body never does.
		assert.deepStrictEqual(stops, [8, 9, 10, 10, 10, 11, 12, 12, 12, 12, 12, 12, 12, 13, 14, 14, 14, 14, 14, 16, 18, 2, 2, 3, 4, 2, 3, 6]);
	});

	test('the names read at a breakpoint are those in reach: parameters, destructured names, hoisted and outer ones', () => {
		const names = namesByLine(instrumentAll(STATEMENTS).script);
		assert.deepStrictEqual(names.get(2), ['x', 'y', 'w', 'rest', 'helper', 'load', 'Box', 'late']);
		assert.deepStrictEqual(names.get(8), ['k', 'v', 'helper', 'load', 'Box', 'late']);
		assert.deepStrictEqual(names.get(13), ['err', 'helper', 'load', 'Box', 'late']);
		assert.deepStrictEqual(names.get(15), ['helper', 'load', 'Box', 'late']);
		assert.deepStrictEqual(names.get(21), ['v', 'helper', 'load', 'Box', 'late']);
		assert.deepStrictEqual(names.get(32), ['helper', 'load', 'Box', 'late']);

		const nested = namesByLine(instrumentAll(script(
			'const { id, profile: { admin = false, ...others }, tags: [first, , third = 3] } = pm.response.json();',
			'var early;',
			'pm.test("outer", function named(done) {',
			'	const local = id;',
			'	[1].map((item, index) => {',
			'		return item + index + local;',
			'	}).forEach(value => console.log(',
			'		[2].filter(x => { return x > value; })));',
			'	if (local) {',
			'		let inner = 1;',
			'		var hoisted = inner;',
			'	}',
			'	return hoisted;',
			'});',
			'{',
			'	let blocked = 1;',
			'	early = blocked;',
			'}',
			'early = 2;',
		)).script);
		const top = ['id', 'admin', 'others', 'first', 'third', 'early'];
		const inTest = ['named', 'done', 'local', 'hoisted', ...top];
		assert.deepStrictEqual(nested.get(4), inTest);
		assert.deepStrictEqual(nested.get(6), ['item', 'index', ...inTest]);
		assert.deepStrictEqual(nested.get(8), ['x', 'value', ...inTest]);
		assert.deepStrictEqual(nested.get(10), ['inner', ...inTest]);
		assert.deepStrictEqual(nested.get(13), inTest);
		assert.deepStrictEqual(nested.get(17), ['blocked', ...top]);
		assert.deepStrictEqual(nested.get(19), top);
	});
});
