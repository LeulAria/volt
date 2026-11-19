/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { clipForPrediction, clipPiecesForPrediction, composerDraftShape, lastLines } from '../../browser/editor/agentComposerDraft.js';

suite('agentComposerDraft', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('one more letter on a line keeps the shape, so the keystroke needs no layout', () => {
		assert.strictEqual(composerDraftShape('ad'), composerDraftShape('ade'));
	});

	test('emptying the draft, filling it and a new line each change the shape', () => {
		assert.notStrictEqual(composerDraftShape(''), composerDraftShape('a'));
		assert.strictEqual(composerDraftShape('  '), composerDraftShape(''));
		assert.notStrictEqual(composerDraftShape('a'), composerDraftShape('a\nb'));
	});
	/** The whole-text versions these replace. */
	const clipWhole = (text: string, max: number) => {
		const flat = text.replace(/\s+/g, ' ').trim();
		return flat.length <= max ? flat : `${flat.slice(0, max)}...`;
	};
	const lastLinesWhole = (text: string, count: number) => text.trimEnd().split('\n').slice(-count).join('\n');

	/** Texts of words, spaces, tabs and newlines, some with long whitespace runs. */
	function texts(): string[] {
		let seed = 7;
		const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
		const out = ['', ' ', '\n\n', 'a', ' a ', '\nabc', 'a\n\nb', 'x'.repeat(5000), ' '.repeat(3000) + 'tail', 'head' + ' \n'.repeat(4000) + 'tail'];
		for (let i = 0; i < 300; i++) {
			let text = '';
			const length = Math.floor(random() * (i % 3 === 0 ? 6000 : 400));
			while (text.length < length) {
				const r = random();
				text += r < 0.6 ? 'word'.slice(0, 1 + Math.floor(random() * 4)) : r < 0.8 ? ' ' : r < 0.9 ? '\n' : r < 0.97 ? '\t' : ' '.repeat(Math.floor(random() * 2000));
			}
			out.push(text);
		}
		return out;
	}

	test('the ghost text clip reads a prefix and cuts as the whole text would', () => {
		for (const text of texts()) {
			for (const max of [1, 80, 160, 600]) {
				assert.strictEqual(clipForPrediction(text, max), clipWhole(text, max), JSON.stringify(text.slice(0, 40)));
			}
		}
	});

	test('a streaming reply clipped from its pieces matches the joined text', () => {
		for (const text of texts()) {
			const pieces: string[] = [];
			for (let at = 0; at < text.length; at += 37) {
				pieces.push(text.slice(at, at + 37));
			}
			assert.strictEqual(clipPiecesForPrediction(pieces, 600), clipWhole(text, 600));
		}
		// Only the pieces the cut needs are read.
		let read = 0;
		const pieces = function* () {
			for (let i = 0; i < 10_000; i++) {
				read++;
				yield 'some reply text ';
			}
		};
		assert.strictEqual(clipPiecesForPrediction(pieces(), 600).length, 603);
		assert.ok(read < 200, `read ${read} pieces`);
	});

	test('the last lines of a command output, without splitting it whole', () => {
		for (const text of texts()) {
			for (const count of [1, 2, 3]) {
				assert.strictEqual(lastLines(text, count), lastLinesWhole(text, count), JSON.stringify(text.slice(-40)));
			}
		}
	});
});
