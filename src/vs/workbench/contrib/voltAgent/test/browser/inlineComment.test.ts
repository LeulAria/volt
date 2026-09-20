/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	buildInlineAskPrompt,
	buildInlineEditPrompt,
	extractReplacementCode,
	formatLineLabel,
	selectionLineRange,
} from '../../browser/review/inlineCommentModel.js';

suite('Inline comment', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('normalizes a selection that ends at column 1 of the next line', () => {
		const range = selectionLineRange({
			startLineNumber: 3,
			startColumn: 1,
			endLineNumber: 4,
			endColumn: 1,
		});
		assert.deepStrictEqual(range, { startLineNumber: 3, endLineNumber: 3 });
	});

	test('keeps a single-line selection', () => {
		const range = selectionLineRange({
			startLineNumber: 8,
			startColumn: 4,
			endLineNumber: 8,
			endColumn: 12,
		});
		assert.deepStrictEqual(range, { startLineNumber: 8, endLineNumber: 8 });
	});

	test('formats a line label for chat mentions', () => {
		assert.strictEqual(formatLineLabel({ startLineNumber: 12, endLineNumber: 12 }), '12');
		assert.strictEqual(formatLineLabel({ startLineNumber: 3, endLineNumber: 5 }), '3-5');
	});

	test('strips markdown fences from replacement code', () => {
		assert.strictEqual(extractReplacementCode('```json\n{\n  "a": 1\n}\n```'), '{\n  "a": 1\n}');
		assert.strictEqual(extractReplacementCode('here\n```\nfoo\n```\n'), 'foo');
	});

	test('ask prompt includes the file, line numbers, and question', () => {
		const prompt = buildInlineAskPrompt('.lsifrc.json', { startLineNumber: 3, endLineNumber: 3 }, '"source": "./package.json"', 'what is source');
		assert.ok(prompt.includes('.lsifrc.json'));
		assert.ok(prompt.includes('3'));
		assert.ok(prompt.includes('"source": "./package.json"'));
		assert.ok(prompt.includes('what is source'));
	});

	test('edit prompt asks for replacement code only', () => {
		const prompt = buildInlineEditPrompt('src/app.ts', { startLineNumber: 10, endLineNumber: 12 }, 'const x = 1;', 'rename x to count');
		assert.ok(/ONLY the replacement code/i.test(prompt));
		assert.ok(prompt.includes('10-12'));
		assert.ok(prompt.includes('rename x to count'));
	});
});
