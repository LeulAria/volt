/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { lineRange, originalFromPatch, parseUnifiedPatch } from '../../common/agentPrDiff.js';

suite('agentPrDiff', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('numbers context, added and removed lines and counts what was skipped', () => {
		const patch = [
			'@@ -41,5 +41,5 @@ if (main) {',
			' const port = 1;',
			' const { server } = createApp();',
			'-server.listen(port, "Pulse");',
			'+server.listen(port, "Ton");',
			' }',
			'@@ -60,2 +60,3 @@',
			' a',
			'+b',
			' c',
		].join('\n');
		const hunks = parseUnifiedPatch(patch);
		assert.strictEqual(hunks.length, 2);
		assert.strictEqual(hunks[0].skippedBefore, 40);
		assert.strictEqual(hunks[0].section, 'if (main) {');
		assert.deepStrictEqual(hunks[0].lines.map(line => [line.kind, line.oldLine, line.newLine]), [
			['context', 41, 41],
			['context', 42, 42],
			['del', 43, undefined],
			['add', undefined, 43],
			['context', 44, 44],
		]);
		// Old side of hunk one ends at 41 + 5 = 46; the next starts at 60.
		assert.strictEqual(hunks[1].skippedBefore, 14);
		assert.deepStrictEqual(hunks[1].lines.map(line => line.newLine), [60, 61, 62]);
	});

	test('a new file skips nothing and a trailing newline adds no line', () => {
		const hunks = parseUnifiedPatch('@@ -0,0 +1,2 @@\n+one\n+two\n');
		assert.strictEqual(hunks.length, 1);
		assert.strictEqual(hunks[0].skippedBefore, 0);
		assert.deepStrictEqual(hunks[0].lines.map(line => line.text), ['one', 'two']);
	});

	test('keeps an empty context line inside a hunk and drops the no-newline marker', () => {
		const hunks = parseUnifiedPatch('@@ -1,3 +1,3 @@\n a\n\n-b\n+c\n\\ No newline at end of file');
		assert.deepStrictEqual(hunks[0].lines.map(line => [line.kind, line.text]), [['context', 'a'], ['context', ''], ['del', 'b'], ['add', 'c']]);
	});

	test('single-line hunk headers default their counts to one', () => {
		const hunks = parseUnifiedPatch('@@ -5 +5 @@\n-x\n+y');
		assert.strictEqual(hunks[0].oldLines, 1);
		assert.strictEqual(hunks[0].newLines, 1);
		assert.strictEqual(hunks[0].skippedBefore, 4);
	});

	test('line ranges prefer the new side', () => {
		const [hunk] = parseUnifiedPatch('@@ -1,2 +1,2 @@\n-a\n+b\n c');
		assert.deepStrictEqual(lineRange(hunk.lines), { start: 1, end: 2, side: 'new' });
		assert.deepStrictEqual(lineRange(hunk.lines.filter(line => line.kind === 'del')), { start: 1, end: 1, side: 'old' });
		assert.strictEqual(lineRange([]), undefined);
	});
	test('the old file comes back from the new file and its patch', () => {
		const patch = ['@@ -1,5 +1,6 @@', ' a', '-b', '+B', ' c', ' d', ' e', '+f'].join('\n');
		assert.strictEqual(originalFromPatch('a\nB\nc\nd\ne\nf\n', patch), 'a\nb\nc\nd\ne\n');
		// Added and deleted files.
		assert.strictEqual(originalFromPatch('x\ny\n', '@@ -0,0 +1,2 @@\n+x\n+y'), '');
		assert.strictEqual(originalFromPatch('', '@@ -1,2 +0,0 @@\n-x\n-y'), 'x\ny\n');
		// A removal without context names the line before it.
		assert.strictEqual(originalFromPatch('a\nc\n', '@@ -2 +1,0 @@\n-b'), 'a\nb\nc\n');
		// CRLF lines keep their \r on both sides.
		assert.strictEqual(originalFromPatch('A\r\nb\r\n', '@@ -1,2 +1,2 @@\n-a\r\n+A\r\n b\r'), 'a\r\nb\r\n');
	});

	test('the old file\'s last newline follows the patch, else the new file', () => {
		const patch = ['@@ -1,2 +1,3 @@', ' a', '-b', '\\ No newline at end of file', '+b', '+c'].join('\n');
		assert.strictEqual(originalFromPatch('a\nb\nc\n', patch), 'a\nb');
		// The end is untouched: it ends as the new file does.
		assert.strictEqual(originalFromPatch('A\nb\nc\nd\ne\nf', '@@ -1,4 +1,4 @@\n-a\n+A\n b\n c\n d'), 'a\nb\nc\nd\ne\nf');
	});

	test('a patch that does not fit the file gives nothing', () => {
		assert.strictEqual(originalFromPatch('a\nX\n', '@@ -1,2 +1,2 @@\n a\n-b\n+B'), undefined);
		assert.strictEqual(originalFromPatch('a\n', '@@ -5,1 +5,1 @@\n-x\n+y'), undefined);
	});
});
