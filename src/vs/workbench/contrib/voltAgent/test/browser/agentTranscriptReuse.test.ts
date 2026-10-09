/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { FRESH_TEXT_CLASS, settleFreshText } from '../../browser/chrome/agentFreshText.js';
import { hashString, reconcileChildren, splitMarkdownChunks, TranscriptReuse, TranscriptRowCache } from '../../browser/chrome/agentTranscriptReuse.js';

function el(id: string): HTMLElement {
	const node = document.createElement('div');
	node.id = id;
	return node;
}

function ids(parent: Node): string[] {
	return Array.from(parent.childNodes, node => (node as HTMLElement).id);
}

suite('Transcript reuse', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	suite('splitMarkdownChunks', () => {

		function split(text: string): string[] {
			const pieces = splitMarkdownChunks(text);
			assert.strictEqual(pieces.join(''), text, 'joining the pieces gives the text back');
			return pieces;
		}

		test('breaks between top-level blocks', () => {
			assert.deepStrictEqual(split('# Title\n\nFirst paragraph.\n\nSecond paragraph.'), ['# Title\n\n', 'First paragraph.\n\n', 'Second paragraph.']);
		});

		test('a trailing blank run stays with the last piece', () => {
			assert.deepStrictEqual(split('One.\n\nTwo.\n\n\n'), ['One.\n\n', 'Two.\n\n\n']);
		});

		test('never breaks inside a fence, even at blank lines', () => {
			const fence = '```js\nconst a = 1;\n\nconst b = 2;\n```';
			assert.deepStrictEqual(split(`Intro.\n\n${fence}\n\nAfter.`), ['Intro.\n\n', `${fence}\n\n`, 'After.']);
		});

		test('an unclosed fence (still streaming) keeps the rest of the text', () => {
			assert.deepStrictEqual(split('Intro.\n\n~~~\nline\n\nmore'), ['Intro.\n\n', '~~~\nline\n\nmore']);
		});

		test('a loose list stays one list', () => {
			assert.deepStrictEqual(split('- one\n\n- two\n\n- three\n\nAfter.'), ['- one\n\n- two\n\n- three\n\n', 'After.']);
			assert.deepStrictEqual(split('1. one\n\n2. two\n\nAfter.'), ['1. one\n\n2. two\n\n', 'After.']);
		});

		test('indented continuation lines stay with their item', () => {
			assert.deepStrictEqual(split('1. item\n\n   more about it\n\nNext.'), ['1. item\n\n   more about it\n\n', 'Next.']);
		});

		test('display math, raw HTML blocks and comments are kept whole', () => {
			assert.deepStrictEqual(split('$$\na\n\nb\n$$\n\nAfter.'), ['$$\na\n\nb\n$$\n\n', 'After.']);
			assert.deepStrictEqual(split('<pre>\na\n\nb\n</pre>\n\nAfter.'), ['<pre>\na\n\nb\n</pre>\n\n', 'After.']);
			assert.deepStrictEqual(split('<!-- a\n\nb -->\n\nAfter.'), ['<!-- a\n\nb -->\n\n', 'After.']);
		});

		test('text with link reference definitions is one piece', () => {
			assert.deepStrictEqual(split('See [the docs][d].\n\nMore.\n\n[d]: https://example.com'), ['See [the docs][d].\n\nMore.\n\n[d]: https://example.com']);
		});

		test('footnote definitions do not count as link definitions', () => {
			assert.strictEqual(split('Claim.[^1]\n\n[^1]: Source.').length, 2);
		});
	});

	suite('reconcileChildren', () => {

		test('keeps nodes already in place and inserts the rest where they belong', () => {
			const parent = document.createElement('div');
			const [a, b, c, d] = ['a', 'b', 'c', 'd'].map(el);
			parent.append(a, b, c);
			const observer = new MutationObserver(() => { });
			observer.observe(parent, { childList: true });
			const unwanted = reconcileChildren(parent, [a, d, c]);
			const records = observer.takeRecords();
			observer.disconnect();
			assert.deepStrictEqual(ids(parent), ['a', 'b', 'd', 'c'], 'unwanted nodes stay attached for the caller');
			assert.deepStrictEqual(unwanted, [b]);
			assert.ok(records.every(record => !Array.from(record.removedNodes).some(node => node === a || node === c)), 'nodes in place are not moved');
		});

		test('reorders when needed', () => {
			const parent = document.createElement('div');
			const [a, b, c] = ['a', 'b', 'c'].map(el);
			parent.append(a, b, c);
			assert.deepStrictEqual(reconcileChildren(parent, [c, a, b]), []);
			assert.deepStrictEqual(ids(parent), ['c', 'a', 'b']);
		});

		test('fills an empty parent', () => {
			const parent = document.createElement('div');
			reconcileChildren(parent, ['x', 'y'].map(el));
			assert.deepStrictEqual(ids(parent), ['x', 'y']);
		});
	});

	suite('TranscriptRowCache', () => {

		function entryStore(log: string[], name: string): DisposableStore {
			const rowStore = new DisposableStore();
			rowStore.add(toDisposable(() => log.push(name)));
			return rowStore;
		}

		test('hands a row back while its signature holds, once per pass', () => {
			const log: string[] = [];
			const cache = store.add(new TranscriptRowCache());
			const node = el('row');
			cache.put('r', 'sig1', [node], [], entryStore(log, 'r'));
			cache.sweep();
			assert.strictEqual(cache.take('r', 'sig1')?.nodes[0], node);
			assert.strictEqual(cache.take('r', 'sig1'), undefined, 'not twice in one pass');
			cache.sweep();
			assert.strictEqual(cache.take('r', 'sig1')?.nodes[0], node, 'again in the next pass');
			assert.deepStrictEqual(log, []);
		});

		test('a changed signature drops the row and its listeners', () => {
			const log: string[] = [];
			const cache = store.add(new TranscriptRowCache());
			cache.put('r', 'sig1', [el('row')], [], entryStore(log, 'r'));
			cache.sweep();
			assert.strictEqual(cache.take('r', 'sig2'), undefined);
			assert.deepStrictEqual(log, ['r']);
			assert.strictEqual(cache.size, 0);
		});

		test('a sweep disposes the rows and views a pass did not use', () => {
			const log: string[] = [];
			const cache = store.add(new TranscriptRowCache());
			cache.put('kept', 's', [el('kept')], [], entryStore(log, 'kept'));
			cache.put('gone', 's', [el('gone')], [], entryStore(log, 'gone'));
			const view = cache.view('v', () => toDisposable(() => log.push('view')));
			cache.sweep();
			cache.take('kept', 's');
			assert.strictEqual(cache.view('v', () => { throw new Error('should reuse the view'); }), view);
			cache.sweep();
			assert.deepStrictEqual(log, ['gone']);
			cache.sweep();
			assert.deepStrictEqual(log, ['gone', 'kept', 'view']);
			assert.strictEqual(cache.size, 0);
		});

		test('putting into a disposed cache disposes the row at once', () => {
			const log: string[] = [];
			const cache = new TranscriptRowCache();
			cache.dispose();
			cache.put('r', 's', [], [], entryStore(log, 'late'));
			assert.deepStrictEqual(log, ['late']);
		});

		test('TranscriptReuse drops the caches of replies no longer drawn from it', () => {
			const log: string[] = [];
			const reuse = store.add(new TranscriptReuse());
			const first = {};
			const second = {};
			reuse.for(first).put('r', 's', [], [], entryStore(log, 'first'));
			reuse.for(second).put('r', 's', [], [], entryStore(log, 'second'));
			assert.strictEqual(reuse.for(first), reuse.for(first));
			reuse.retain(new Set([second]));
			assert.deepStrictEqual(log, ['first']);
		});
	});

	test('hashString tells values apart and is stable', () => {
		assert.strictEqual(hashString('abc'), hashString('abc'));
		assert.notStrictEqual(hashString('abc'), hashString('abd'));
		assert.notStrictEqual(hashString('ab'), hashString('abc'));
	});

	test('a finished fade is unwrapped', () => {
		const root = document.createElement('div');
		root.innerHTML = `<p>Old <span class="${FRESH_TEXT_CLASS}">new</span> text</p>`;
		store.add(settleFreshText(root));
		const span = root.querySelector(`.${FRESH_TEXT_CLASS}`)!;
		span.dispatchEvent(new AnimationEvent('animationend', { animationName: 'other', bubbles: true }));
		assert.ok(root.querySelector(`.${FRESH_TEXT_CLASS}`), 'another animation ending leaves it');
		span.dispatchEvent(new AnimationEvent('animationend', { animationName: FRESH_TEXT_CLASS, bubbles: true }));
		assert.strictEqual(root.querySelector(`.${FRESH_TEXT_CLASS}`), null);
		assert.strictEqual(root.textContent, 'Old new text');
	});
});
