/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { guessInlineCodeLanguage } from '../../browser/blocks/agentBlockRenderers.js';

suite('Agent inline code language', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('reads CSS rules', () => {
		assert.strictEqual(guessInlineCodeLanguage('.a { color: red }'), 'css');
		assert.strictEqual(guessInlineCodeLanguage('div > p { margin: 0 }'), 'css');
		assert.strictEqual(guessInlineCodeLanguage('#id.cls span{x:1}'), 'css');
		assert.strictEqual(guessInlineCodeLanguage('div.card .title { font-weight: 600 }'), 'css');
	});

	test('a long run of words fails the CSS check at once', () => {
		// Each of these took seconds with the old selector pattern, which froze switching to the chat.
		const spans = [
			'git rev-parse --abbrev-ref HEAD && git rev-parse --short HEAD && echo "---porcelain"',
			'git merge-base --is-ancestor revamp/hotel-frontoffice HEAD || git rebase revamp/hotel-frontoffice',
			't031a-rate-guarantee-1024-{light,dark}.png',
			`${'a-b '.repeat(55)}x`,
		];
		const started = performance.now();
		assert.deepStrictEqual(spans.map(guessInlineCodeLanguage), ['shellscript', 'shellscript', undefined, undefined]);
		assert.ok(performance.now() - started < 50);
	});
});
