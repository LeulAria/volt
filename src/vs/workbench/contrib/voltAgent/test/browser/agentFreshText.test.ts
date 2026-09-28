/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { FRESH_TEXT_CLASS, FRESH_TEXT_FADE_MS, FreshTextTracker } from '../../browser/chrome/agentFreshText.js';

/** A reply as the thread rebuilds it on each streamed frame. */
function render(html: string): HTMLElement {
	const root = document.createElement('div');
	root.innerHTML = html;
	return root;
}

function fresh(root: HTMLElement): { text: string; delay: string }[] {
	return [...root.querySelectorAll<HTMLElement>(`.${FRESH_TEXT_CLASS}`)].map(span => ({ text: span.textContent ?? '', delay: span.style.animationDelay }));
}

suite('Fresh streamed text', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('marks each new stretch with how long ago it arrived', () => {
		const tracker = new FreshTextTracker();
		const reply = {};
		const first = render('<p>Hello</p>');
		tracker.apply(reply, [first], true, 1000);
		assert.deepStrictEqual(fresh(first), [{ text: 'Hello', delay: '0ms' }]);

		const second = render('<p>Hello <strong>world</strong></p>');
		tracker.apply(reply, [second], true, 1300);
		assert.deepStrictEqual(fresh(second), [{ text: 'Hello', delay: '-300ms' }, { text: ' ', delay: '0ms' }, { text: 'world', delay: '0ms' }]);
		assert.strictEqual(second.textContent, 'Hello world', 'wrapping keeps the text');
		assert.ok(second.querySelector('strong > .volt-agent-fresh-text'), 'markup stays around the fresh text');
	});

	test('text older than the fade is left alone', () => {
		const tracker = new FreshTextTracker();
		const reply = {};
		tracker.apply(reply, [render('<p>One.</p>')], true, 0);
		const later = render('<p>One. Two.</p>');
		tracker.apply(reply, [later], true, FRESH_TEXT_FADE_MS + 10);
		assert.deepStrictEqual(fresh(later), [{ text: ' Two.', delay: '0ms' }]);
	});

	test('counts text across several reply blocks in reading order', () => {
		const tracker = new FreshTextTracker();
		const reply = {};
		tracker.apply(reply, [render('<p>Intro</p>')], true, 0);
		const a = render('<p>Intro</p>');
		const b = render('<p>Next</p>');
		tracker.apply(reply, [a, b], true, FRESH_TEXT_FADE_MS + 1);
		assert.deepStrictEqual(fresh(a), []);
		assert.deepStrictEqual(fresh(b), [{ text: 'Next', delay: '0ms' }]);
	});

	test('a finished reply seen for the first time does not flash', () => {
		const tracker = new FreshTextTracker();
		const root = render('<p>Restored answer</p>');
		tracker.apply({}, [root], false, 0);
		assert.deepStrictEqual(fresh(root), []);
	});

	test('the last words keep fading after the stream ends', () => {
		const tracker = new FreshTextTracker();
		const reply = {};
		tracker.apply(reply, [render('<p>Done</p>')], true, 0);
		const final = render('<p>Done</p>');
		tracker.apply(reply, [final], false, 400);
		assert.deepStrictEqual(fresh(final), [{ text: 'Done', delay: '-400ms' }]);
	});
});
