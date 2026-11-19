/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { clampReadAloudSpeed, speakableMarkdown, splitSpeech, splitSpeechQuickStart } from '../../common/agentReadAloud.js';

suite('Agent read aloud', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('reads prose and leaves code blocks out', () => {
		const spoken = speakableMarkdown([
			'## What I changed',
			'',
			'The **parser** now uses `splitSpeech` from [the helper](https://example.com/a).',
			'',
			'```ts',
			'const a = { b: 1 };',
			'```',
			'',
			'- First item',
			'2. Second item!',
		].join('\n'));
		assert.strictEqual(spoken, [
			'What I changed.',
			'The parser now uses splitSpeech from the helper.',
			'First item.',
			'Second item!',
		].join('\n'));
	});

	test('reads a table row by row, without its rule', () => {
		assert.strictEqual(
			speakableMarkdown('| Option | Size |\n|---|---:|\n| Kokoro | 90 MB |'),
			'Option, Size.\nKokoro, 90 MB.',
		);
	});

	test('drops an unclosed code block, bare links and images', () => {
		assert.strictEqual(speakableMarkdown('See https://example.com/x for more.\n![shot](a.png)\n```sh\nnpm run build'), 'See for more.');
		assert.strictEqual(speakableMarkdown('```\nonly code\n```'), '');
	});

	test('keeps snake_case names and stars in math', () => {
		assert.strictEqual(speakableMarkdown('Set max_token_count to 2 * 3 * 4.'), 'Set max_token_count to 2 * 3 * 4.');
	});

	test('splits speech at sentence ends and keeps every word', () => {
		const text = 'One short sentence. Another one here! And a third?\nA new line.';
		assert.deepStrictEqual(splitSpeech(text, 40), ['One short sentence. Another one here!', 'And a third? A new line.']);
		const long = Array.from({ length: 30 }, (_, index) => `word${index}`).join(' ');
		const chunks = splitSpeech(long, 50);
		assert.ok(chunks.every(chunk => chunk.length <= 50));
		assert.strictEqual(chunks.join(' '), long);
		assert.deepStrictEqual(splitSpeech(''), []);
	});

	test('keeps the words around a dot inside a name or a number', () => {
		assert.deepStrictEqual(
			splitSpeech('The reader in agentReadAloud.ts took 3.5 ms. Next, e.g. on Ubuntu 24.04, it runs.', 60),
			['The reader in agentReadAloud.ts took 3.5 ms.', 'Next, e.g. on Ubuntu 24.04, it runs.'],
		);
		assert.deepStrictEqual(splitSpeech('Done... Really?! Yes'), ['Done... Really?! Yes']);
	});

	test('starts with a short piece and grows, cutting at sentence ends, then commas, then words', () => {
		const text = 'The cart now applies the coupon before tax, and the total matches the checkout page. I also added a test that covers an expired coupon. Two files changed, the cart reducer and its test. Nothing else was touched and the build passes on my machine.';
		const chunks = splitSpeechQuickStart(text, [48, 70, 100]);
		assert.deepStrictEqual(chunks, [
			'The cart now applies the coupon before tax,',
			'and the total matches the checkout page.',
			'I also added a test that covers an expired coupon. Two files changed, the cart reducer and its test.',
			'Nothing else was touched and the build passes on my machine.',
		]);
		assert.strictEqual(chunks.join(' '), text);
		assert.deepStrictEqual(splitSpeechQuickStart('On it.'), ['On it.']);
		assert.deepStrictEqual(splitSpeechQuickStart('Hi.\nWhat should I work on?'), ['Hi. What should I work on?']);
		assert.deepStrictEqual(splitSpeechQuickStart(''), []);
		// A dot inside a name ends nothing, and a word longer than the limit is still said.
		assert.deepStrictEqual(splitSpeechQuickStart('See agentReadAloud.ts for it now', [20]), ['See', 'agentReadAloud.ts', 'for it now']);
		assert.deepStrictEqual(splitSpeechQuickStart('abcdefghij', [4]), ['abcd', 'efgh', 'ij']);
	});

	test('clamps the speed', () => {
		assert.strictEqual(clampReadAloudSpeed(5), 2);
		assert.strictEqual(clampReadAloudSpeed(0.1), 0.5);
		assert.strictEqual(clampReadAloudSpeed('fast'), 1);
	});
});
