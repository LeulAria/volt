/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { WorkflowValue } from '../../../common/workflows/workflowTypes.js';
import { parseYaml, stringifyYaml, YAML_MAX_DEPTH } from '../../../common/workflows/workflowYaml.js';

/** Lines joined with \n, so samples read like files. */
function lines(...text: string[]): string {
	return text.join('\n') + '\n';
}

function value(text: string): WorkflowValue | undefined {
	const result = parseYaml(text);
	assert.deepStrictEqual(result.errors, [], `unexpected errors for:\n${text}`);
	return result.value;
}

function firstError(text: string): { message: string; line: number; column: number } {
	const result = parseYaml(text);
	assert.ok(result.errors.length, `expected an error for:\n${text}`);
	return { ...result.errors[0] };
}

/** A backslash, so escapes in samples stay visible as YAML wrote them. */
const BS = '\\';

suite('Volt workflow YAML', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	suite('parse', () => {

		test('block maps, lists, compact items, nesting and comments', () => {
			assert.deepStrictEqual(value(lines(
				'# a workflow',
				'name: Ship it   # trailing comment',
				'nodes:',
				'  - id: start',
				'    type: start',
				'',
				'  - id: work',
				'    config:',
				'      model: claude',
				'      tags:',
				'      - a',
				'      - b',
				'  -',
				'    id: late',
				'  - - nested',
				'    - list',
				'top: done',
			)), {
				name: 'Ship it',
				nodes: [
					{ id: 'start', type: 'start' },
					{ id: 'work', config: { model: 'claude', tags: ['a', 'b'] } },
					{ id: 'late' },
					['nested', 'list'],
				],
				top: 'done',
			});
		});

		test('scalars: multi-word plain text, numbers, booleans, null', () => {
			assert.deepStrictEqual(value(lines(
				'text: hello there world',
				'url: https://example.com/a#b',
				'ints: [0, 42, -7, +3]',
				'floats: [1.5, -0.25, .5, 1., 1e3, 2.5E-3, -1e+2]',
				'strings: [007, 0x1F, 1_000, .inf, 12:30, 1.2.3, 1e]',
				'bools: [true, True, FALSE, yes, no, on]',
				'nulls: [null, Null, ~]',
				'empty:',
				'colon: a:b',
				'hash: a#b',
			)), {
				text: 'hello there world',
				url: 'https://example.com/a#b',
				ints: [0, 42, -7, 3],
				floats: [1.5, -0.25, 0.5, 1, 1000, 0.0025, -100],
				strings: ['007', '0x1F', '1_000', '.inf', '12:30', '1.2.3', '1e'],
				bools: [true, true, false, 'yes', 'no', 'on'],
				nulls: [null, null, null],
				empty: null,
				colon: 'a:b',
				hash: 'a#b',
			});
			assert.ok(Object.is(value('-0'), -0));
		});

		test('plain text folds over more-indented lines', () => {
			assert.deepStrictEqual(value(lines(
				'description: one',
				'  two',
				'',
				'  three',
				'next: x',
			)), { description: 'one two\nthree', next: 'x' });
			assert.deepStrictEqual(value(lines('- a', '  b', '- c')), ['a b', 'c']);
		});

		test('quoted strings: escapes, doubled single quotes, folding', () => {
			assert.deepStrictEqual(value(lines(
				`single: 'it''s # not a comment: really'`,
				`double: "tab${BS}tnew${BS}nquote${BS}"back${BS}${BS}"`,
				`unicode: "caf${BS}u00e9 ${BS}x41 ${BS}U0001F600"`,
				`spaces: '  kept  '`,
				`folded: "one`,
				`  two`,
				``,
				`  three"`,
				`joined: "a${BS}`,
				`  b"`,
				`empty: ''`,
				`'quoted key': 1`,
				`"other key": 2`,
			)), {
				single: 'it\'s # not a comment: really',
				double: 'tab\tnew\nquote"back\\',
				unicode: `caf${String.fromCharCode(0xe9)} A ${String.fromCodePoint(0x1f600)}`,
				spaces: '  kept  ',
				folded: 'one two\nthree',
				joined: 'ab',
				empty: '',
				'quoted key': 1,
				'other key': 2,
			});
		});

		test('block scalars: literal, folded, chomping and indentation indicators', () => {
			const parsed = value(lines(
				'literal: |',
				'  line one',
				'    indented',
				'  # not a comment',
				'',
				'strip: |-',
				'  no newline',
				'keep: |+',
				'  two newlines',
				'',
				'folded: >',
				'  joined',
				'  together',
				'',
				'  new paragraph',
				'    more indented',
				'  back',
				'foldStrip: >-',
				'  a',
				'  b',
				'indicator: |2',
				'    starts indented',
				'  base',
				'leading: |',
				'',
				'  after a blank line',
				'empty: |',
				'last: x',
			)) as Record<string, WorkflowValue>;
			assert.deepStrictEqual(parsed, {
				literal: 'line one\n  indented\n# not a comment\n',
				strip: 'no newline',
				keep: 'two newlines\n\n',
				folded: 'joined together\nnew paragraph\n  more indented\nback\n',
				foldStrip: 'a b',
				indicator: '  starts indented\nbase\n',
				leading: '\nafter a blank line\n',
				empty: '',
				last: 'x',
			});
			assert.deepStrictEqual(value(lines('- |', '  in a list', '- >-', '  folded', '  item')), ['in a list\n', 'folded item']);
		});

		test('flow collections, also over several lines', () => {
			assert.deepStrictEqual(value(lines(
				'position: [120, -40]',
				'map: {a: 1, b: [x, "y, z"], c: {}, d: [], e}',
				'multi: [',
				'  one,   # comment',
				'  two,',
				']',
				'json: {"a":1, "b": null}',
				'url: {link: http://x.y/z}',
			)), {
				position: [120, -40],
				map: { a: 1, b: ['x', 'y, z'], c: {}, d: [], e: null },
				multi: ['one', 'two'],
				json: { a: 1, b: null },
				url: { link: 'http://x.y/z' },
			});
		});

		test('documents: markers, empty input, BOM, CRLF', () => {
			assert.strictEqual(value(''), null);
			assert.strictEqual(value('# only a comment\n'), null);
			assert.deepStrictEqual(value(lines('---', 'a: 1', '...', '# after the end')), { a: 1 });
			assert.deepStrictEqual(value(`${String.fromCharCode(0xfeff)}a: 1\r\nb:\r\n  - x\r\n`), { a: 1, b: ['x'] });
			assert.strictEqual(value('just text'), 'just text');
		});

		test('map keys stay data (__proto__ does not set a prototype)', () => {
			const parsed = value('__proto__: {polluted: true}\n') as Record<string, WorkflowValue>;
			assert.strictEqual(Object.getPrototypeOf(parsed), Object.prototype);
			assert.deepStrictEqual(Object.keys(parsed), ['__proto__']);
			assert.strictEqual(({} as Record<string, unknown>).polluted, undefined);
		});
	});

	suite('errors', () => {

		test('report a clear message with a 1-based line and column', () => {
			const cases: [string, string, number, number][] = [
				['a:\n\tb: 1\n', 'Tabs cannot be used for indentation', 2, 1],
				['a:\n  b: 1\n c: 2\n', 'Bad indentation', 3, 2],
				['a: 1\n  b: 2\n', 'Unexpected ": "', 2, 4],
				['a: &anchor 1\n', 'Anchors (&) are not supported in workflow files', 1, 4],
				['a: *alias\n', 'Aliases (*) are not supported in workflow files', 1, 4],
				['cron: */5 * * * *\n', 'quote values that start with *', 1, 7],
				['a: !!str 1\n', 'Tags (!) are not supported in workflow files', 1, 4],
				['a: 1\n---\nb: 2\n', 'Multiple documents (---) are not supported in workflow files', 2, 1],
				['a: 1\n...\nb: 2\n', 'Multiple documents are not supported in workflow files', 3, 1],
				['%YAML 1.2\n---\na: 1\n', 'YAML directives', 1, 1],
				['a: "never closed\nb: 2\n', 'Unterminated string: missing the closing "', 1, 4],
				[`a: 'open\n`, 'Unterminated string', 1, 4],
				['a: [1, 2\nb: 3\n', 'Expected "," or "]" (is the "]" of line 1 missing?)', 2, 1],
				['a: [1, 2\n', 'Unterminated list: missing "]"', 1, 4],
				['a: {b: 1\n', 'Unterminated mapping: missing "}"', 1, 4],
				['a: - b\n', 'A list cannot start on the same line as its key', 1, 4],
				['prompt: {{ inputs.task }}\n', 'must be quoted', 1, 9],
				['? complex\n: key\n', 'Complex keys (?) are not supported', 1, 1],
				['a: [1, 2] extra\n', 'Unexpected text after the value', 1, 11],
				[`a: "bad ${BS}q escape"\n`, 'Unknown escape', 1, 9],
				['a: |x\n  b\n', 'Invalid block scalar header', 1, 5],
				['- a\nb: 1\n', 'Unexpected content after the end of the document', 2, 1],
				['a: 1\n- b\n', 'A list item cannot follow', 2, 1],
				['a: @x\n', 'cannot start a plain value', 1, 4],
			];
			for (const [text, message, line, column] of cases) {
				const error = firstError(text);
				assert.ok(error.message.includes(message), `${JSON.stringify(text)}: "${error.message}" should mention "${message}"`);
				assert.deepStrictEqual([error.line, error.column], [line, column], `${JSON.stringify(text)}: ${error.message}`);
				assert.strictEqual(parseYaml(text).value, undefined);
			}
		});

		test('duplicate keys are all reported, the first value is kept', () => {
			const result = parseYaml(lines('a: 1', 'b: {x: 1, x: 2}', 'a: 3'));
			assert.deepStrictEqual(result.errors.map(error => [error.message, error.line, error.column]), [
				['Duplicate key "x"', 2, 11],
				['Duplicate key "a"', 3, 1],
			]);
			assert.deepStrictEqual(result.value, { a: 1, b: { x: 1 } });
		});

		test('size and depth caps', () => {
			const big = parseYaml(`a: '${'x'.repeat(1_000_001)}'`);
			assert.ok(big.errors[0].message.includes('too large'));
			assert.strictEqual(big.value, undefined);
			const deep = parseYaml('['.repeat(YAML_MAX_DEPTH + 1) + ']'.repeat(YAML_MAX_DEPTH + 1));
			assert.ok(deep.errors[0].message.includes('Nesting is too deep'));
			let nested = '';
			for (let i = 0; i <= YAML_MAX_DEPTH; i++) {
				nested += `${'  '.repeat(i)}k${i}:\n`;
			}
			assert.ok(parseYaml(`${nested}${'  '.repeat(YAML_MAX_DEPTH + 1)}v: 1\n`).errors[0].message.includes('Nesting is too deep'));
			assert.deepStrictEqual(parseYaml('['.repeat(YAML_MAX_DEPTH) + ']'.repeat(YAML_MAX_DEPTH)).errors, []);
		});
	});

	suite('locate', () => {

		test('map entries at their key, list items at their dash, flow items where they start', () => {
			const result = parseYaml(lines(
				'name: x',
				'nodes:',
				'  - id: start',
				'    config:',
				'      prompt: |',
				'        hi',
				'  -   id: second',
				'tags: [a, "b"]',
			));
			assert.deepStrictEqual(result.locate([]), { line: 1, column: 1 });
			assert.deepStrictEqual(result.locate(['nodes']), { line: 2, column: 1 });
			assert.deepStrictEqual(result.locate(['nodes', 0]), { line: 3, column: 3 });
			assert.deepStrictEqual(result.locate(['nodes', 0, 'id']), { line: 3, column: 5 });
			assert.deepStrictEqual(result.locate(['nodes', 0, 'config', 'prompt']), { line: 5, column: 7 });
			assert.deepStrictEqual(result.locate(['nodes', 1]), { line: 7, column: 3 });
			assert.deepStrictEqual(result.locate(['nodes', 1, 'id']), { line: 7, column: 7 });
			assert.deepStrictEqual(result.locate(['tags', 1]), { line: 8, column: 11 });
			assert.strictEqual(result.locate(['nodes', 2]), undefined);
			assert.strictEqual(result.locate(['nodes', '0']), undefined);
		});
	});

	suite('stringify', () => {

		test('deterministic block style with inline short arrays and a header', () => {
			const text = stringifyYaml({
				version: 1,
				name: 'Ship it',
				tags: ['a', 'b'],
				empty: {},
				none: [],
				nodes: [
					{ id: 'start', position: [0, 0], config: {} },
					{ id: 'work', config: { prompt: 'Line one\nLine two\n', note: 'trimmed\nend', list: [{ a: 1 }, [1, 2, 3, 4, 5, 6, 7, 8, 9]] } },
				],
			}, { header: ['Volt workflow', '', 'second line'], inlineArrayMax: 8 });
			assert.strictEqual(text, lines(
				'# Volt workflow',
				'#',
				'# second line',
				'version: 1',
				'name: Ship it',
				'tags: [a, b]',
				'empty: {}',
				'none: []',
				'nodes:',
				'  - id: start',
				'    position: [0, 0]',
				'    config: {}',
				'  - id: work',
				'    config:',
				'      prompt: |',
				'        Line one',
				'        Line two',
				'      note: |-',
				'        trimmed',
				'        end',
				'      list:',
				'        - a: 1',
				'        - - 1',
				'          - 2',
				'          - 3',
				'          - 4',
				'          - 5',
				'          - 6',
				'          - 7',
				'          - 8',
				'          - 9',
			));
			assert.strictEqual(stringifyYaml({ tags: ['a', 'b'] }), lines('tags:', '  - a', '  - b'));
		});

		test('quotes only strings that need it', () => {
			const strings: [string, string][] = [
				['plain words', 'plain words'],
				['it\'s fine', 'it\'s fine'],
				['true', '\'true\''],
				['yes', '\'yes\''],
				['null', '\'null\''],
				['~', '\'~\''],
				['007', '\'007\''],
				['1e5', '\'1e5\''],
				['12', '\'12\''],
				['', '\'\''],
				[' padded', '\' padded\''],
				['a: b', '\'a: b\''],
				['a #b', '\'a #b\''],
				['ends:', '\'ends:\''],
				['-x', '\'-x\''],
				['*/5 * * * *', '\'*/5 * * * *\''],
				['{{ inputs.task }}', '\'{{ inputs.task }}\''],
				['[x', '\'[x\''],
				['---', '\'---\''],
				['quote\'s \'here\'', 'quote\'s \'here\''],
				['\'start', '\'\'\'start\''],
				['tab\there', '"tab\\there"'],
				[' lead\nline', '" lead\\nline"'],
				['cr\r\nlf', '"cr\\r\\nlf"'],
			];
			for (const [input, expected] of strings) {
				assert.strictEqual(stringifyYaml({ k: input }), `k: ${expected}\n`, JSON.stringify(input));
			}
			assert.strictEqual(stringifyYaml({ k: ['a,b', 'c', 'x:y'] }, { inlineArrayMax: 4 }), 'k: [\'a,b\', c, \'x:y\']\n');
			// JavaScript lists integer-like keys first; the order is otherwise kept
			assert.strictEqual(stringifyYaml({ 'a key': 1, 'b: c': 2, '': 3, '200': 4, '-': 5 }), lines('200: 4', 'a key: 1', '\'b: c\': 2', '\'\': 3', '\'-\': 5'));
			assert.strictEqual(stringifyYaml({ n: [-0, 1e21, 5e-7, 0.1, Infinity] }), lines('n:', '  - -0', '  - 1e+21', '  - 5e-7', '  - 0.1', '  - null'));
		});

		test('multi-line strings as blocks with the right chomping', () => {
			assert.strictEqual(stringifyYaml({ a: 'x\ny' }), lines('a: |-', '  x', '  y'));
			assert.strictEqual(stringifyYaml({ a: 'x\ny\n' }), lines('a: |', '  x', '  y'));
			assert.strictEqual(stringifyYaml({ a: 'x\n\n\n', b: 1 }), lines('a: |+', '  x', '', '', 'b: 1'));
			assert.strictEqual(stringifyYaml({ a: 'x\n\n  y\n' }), lines('a: |', '  x', '', '    y'));
			assert.strictEqual(stringifyYaml(['one\ntwo']), lines('- |-', '  one', '  two'));
			assert.strictEqual(stringifyYaml('root\ntext\n'), lines('|', '  root', '  text'));
		});

		test('round trip of hand-picked values', () => {
			const samples: WorkflowValue[] = [
				null, true, 0, -0, 'x', '', [], {}, [[]], [{}], { a: [] }, { a: { b: {} } },
				{ 'key with: colon': 'v', '#hash': '# value', 'nested': [[1, [2, [3]]], { deep: { deeper: ['x\ny'] } }] },
				{ text: '\n\nleading blank lines', tail: 'trailing\n\n\n', only: '\n', spaces: 'a\n  \nb', tabs: 'a\n\tb' },
				['- dash', '? question', ': colon', '| pipe', '> gt', '% pct', '@ at', '` tick', '! bang', '& amp', '* star', '#'],
			];
			for (const sample of samples) {
				for (const options of [{}, { inlineArrayMax: 4 }]) {
					const text = stringifyYaml(sample, options);
					assert.deepStrictEqual(value(text), sample, text);
				}
			}
		});

		test('round trip of generated values (seeded fuzz)', () => {
			let seed = 0x5eed1234;
			const random = () => {
				// mulberry32: small, fast and reproducible
				seed = (seed + 0x6d2b79f5) | 0;
				let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
				t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
				return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
			};
			const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)];
			const pieces = [
				'a', 'b', 'Volt', 'x y', ' ', '  ', '\n', '\n\n', '\t', ':', ': ', '#', ' #', '-', '- ', '?', '"', '\'', BS, '{', '}', '[', ']', ',',
				'&', '*', '!', '|', '>', '%', '@', '`', '~', '0', '7', '1e3', '.', '-1', 'true', 'null', 'yes', '---', '...', '{{ inputs.task }}',
				'http://x.y/z#k', '__proto__', String.fromCharCode(0xe9), String.fromCodePoint(0x1f600), String.fromCharCode(0x2028), String.fromCharCode(0xa0),
				String.fromCharCode(0x85), String.fromCharCode(0xfeff), String.fromCharCode(0), String.fromCharCode(0x7f), String.fromCharCode(0xd800), '\r', '\r\n',
			];
			const text = (): string => {
				let out = '';
				for (let n = Math.floor(random() * 6); n > 0; n--) {
					out += pick(pieces);
				}
				return out;
			};
			const numbers = [0, -0, 1, -1, 42, 3.14, -2.5e-7, 1e21, 123456789012, Number.MAX_SAFE_INTEGER, 0.1, 5e-324];
			const generate = (depth: number): WorkflowValue => {
				const roll = random();
				if (depth > 4 || roll < 0.55) {
					const kind = random();
					return kind < 0.55 ? text() : kind < 0.75 ? (random() < 0.5 ? pick(numbers) : Math.round(random() * 1e6) / 100 - 5000) : kind < 0.9 ? random() < 0.5 : null;
				}
				const size = Math.floor(random() * 5);
				if (roll < 0.78) {
					return Array.from({ length: size }, () => generate(depth + 1));
				}
				const map: Record<string, WorkflowValue> = {};
				for (let i = 0; i < size; i++) {
					Object.defineProperty(map, text(), { value: generate(depth + 1), writable: true, enumerable: true, configurable: true });
				}
				return map;
			};
			for (let i = 0; i < 600; i++) {
				const sample = generate(0);
				const options = pick([{}, { inlineArrayMax: 4 }, { header: ['generated'], inlineArrayMax: 8 }]);
				const yaml = stringifyYaml(sample, options);
				const result = parseYaml(yaml);
				assert.deepStrictEqual(result.errors, [], `sample ${i}:\n${yaml}`);
				assert.deepStrictEqual(result.value, sample, `sample ${i}:\n${yaml}`);
				assert.strictEqual(stringifyYaml(result.value!, options), yaml, `sample ${i} is not stable`);
			}
		});
	});
});
