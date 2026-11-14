/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { parseInlineMarkdown } from '../../browser/composer/agentInlineMarkdown.js';

suite('Agent inline markdown (prompts)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const runs = (text: string) => parseInlineMarkdown(text).map(span => `${span.styles.join('+')}:${text.slice(span.start + span.open, span.end - span.close)}`);

	test('dunder and snake_case names stay as typed', () => {
		assert.deepStrictEqual(runs('query select:mcp__volt__memory_list please'), []);
		assert.deepStrictEqual(runs('set my_var_name and MAX__LIMIT__X'), []);
		assert.deepStrictEqual(runs('a___b___c'), []);
	});

	test('underscore emphasis at word edges still styles', () => {
		assert.deepStrictEqual(runs('this is __bold__ text'), ['bold:bold']);
		assert.deepStrictEqual(runs('this is ___both___ text'), ['bold+italic:both']);
		assert.deepStrictEqual(runs('this is _it_ text'), ['italic:it']);
		assert.deepStrictEqual(runs('(__bold__)'), ['bold:bold']);
	});

	test('asterisks, code and strikethrough are unchanged', () => {
		assert.deepStrictEqual(runs('**b** *i* ***bi*** `c` ~~s~~'), ['bold:b', 'italic:i', 'bold+italic:bi', 'code:c', 'strike:s']);
		assert.deepStrictEqual(runs('x**y**z'), ['bold:y']);
		assert.deepStrictEqual(runs('`mcp__volt__x` and **a `b` c**'), ['code:mcp__volt__x', 'bold:a `b` c', 'code:b']);
	});
});
