/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { alignedFadeDelay, FRESH_TEXT_CLASS, FRESH_TEXT_COALESCE_MS, FRESH_TEXT_FADE_MS, FRESH_TEXT_STEP_MS, FreshTextTracker, steppedEaseOut } from '../../browser/chrome/agentFreshText.js';

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

	test('text landing within a few frames of the last chunk joins its fade: one span, not one per chunk', () => {
		const tracker = new FreshTextTracker();
		const reply = {};
		tracker.apply(reply, [render('<p>Hello</p>')], true, 1000);
		const second = render('<p>Hello world</p>');
		tracker.apply(reply, [second], true, 1050);
		assert.deepStrictEqual(fresh(second), [{ text: 'Hello world', delay: '-50ms' }]);
		// Past the coalescing window, a chunk starts its own fade.
		const third = render('<p>Hello world again</p>');
		tracker.apply(reply, [third], true, 1000 + FRESH_TEXT_COALESCE_MS + 100);
		assert.deepStrictEqual(fresh(third), [{ text: 'Hello world', delay: `-${FRESH_TEXT_COALESCE_MS + 100}ms` }, { text: ' again', delay: '0ms' }]);
	});

	test('chips render as they are: only prose fades in', () => {
		const tracker = new FreshTextTracker();
		const root = render('<p><code class="volt-agent-path-pill">src/server.js</code> is not the default port.</p>');
		tracker.apply({}, [root], true, 1000);
		assert.deepStrictEqual(fresh(root), [{ text: ' is not the default port.', delay: '0ms' }]);
		assert.strictEqual(root.querySelector('code')!.innerHTML, 'src/server.js', 'the chip is not wrapped');
	});

	test('quotes render in their own color without fading in', () => {
		const tracker = new FreshTextTracker();
		const root = render('<blockquote><p>Lorem ipsum</p></blockquote><p>After.</p>');
		tracker.apply({}, [root], true, 1000);
		assert.deepStrictEqual(fresh(root), [{ text: 'After.', delay: '0ms' }]);
	});

	test('a table keeps its structure: only cell text fades in', () => {
		const tracker = new FreshTextTracker();
		const root = render('<table>\n<thead>\n<tr>\n<th>#</th>\n<th>Item</th>\n</tr>\n</thead>\n<tbody>\n<tr>\n<td>1</td>\n<td>Verify</td>\n</tr>\n</tbody>\n</table>');
		tracker.apply({}, [root], true, 1000);
		assert.deepStrictEqual(fresh(root).map(span => span.text), ['#', 'Item', '1', 'Verify']);
		const row = root.querySelector('tbody tr')!;
		assert.deepStrictEqual([...row.children].map(child => child.tagName), ['TD', 'TD'], 'no span becomes an extra cell');
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
	test('text added in place after its chunk joins that chunk\'s span; a later chunk gets its own', () => {
		const tracker = new FreshTextTracker();
		const reply = {};
		const root = render('<p>Hello</p>');
		const p = root.querySelector('p')!;
		tracker.apply(reply, [root], true, 1000);
		// The block grew in place (no re-render): the new text node joins the coalesced chunk's span.
		p.append(' world');
		tracker.apply(reply, [root], true, 1050);
		assert.deepStrictEqual(fresh(root), [{ text: 'Hello world', delay: '0ms' }]);
		// Past the coalescing window, the next words fade on their own.
		p.append(' again');
		tracker.apply(reply, [root], true, 1050 + FRESH_TEXT_COALESCE_MS + 10);
		assert.deepStrictEqual(fresh(root), [{ text: 'Hello world', delay: '0ms' }, { text: ' again', delay: '0ms' }]);
		assert.strictEqual(root.textContent, 'Hello world again');
	});

	test('the fade holds its colour between steps and follows ease-out at each step', () => {
		const steps = Math.round(FRESH_TEXT_FADE_MS / FRESH_TEXT_STEP_MS);
		assert.strictEqual(steps, 66);
		const easing = steppedEaseOut(steps);
		const stops = easing.slice('linear('.length, -1).split(', ').map(stop => stop.split(' '));
		assert.strictEqual(stops.length, steps + 1);
		assert.deepStrictEqual(stops[0], ['0', '0%', '1.5152%']);
		assert.deepStrictEqual(stops.at(-1), ['1', '100%']);
		let previous = -1;
		for (const [index, [value, from, to]] of stops.slice(0, -1).entries()) {
			// Each step starts where the one before ended, and the values only rise.
			assert.strictEqual(from, index === 0 ? '0%' : stops[index - 1][2]);
			assert.ok(parseFloat(to) > parseFloat(from));
			assert.ok(Number(value) > previous && Number(value) < 1, `${value} after ${previous}`);
			previous = Number(value);
		}
		// cubic-bezier(0, 0, 0.58, 1) at a half is about 0.685.
		assert.ok(Math.abs(Number(stops[33][0]) - 0.685) < 0.005, stops[33][0]);
	});

	test('every span steps on the same clock', () => {
		const step = FRESH_TEXT_STEP_MS;
		for (const [age, timeline] of [[0, 0], [0, 5], [130, 1000.4], [1099, 123456.7], [16.6, 8.33], [40, 3]]) {
			const delay = alignedFadeDelay(age, timeline);
			assert.ok(delay >= age - 0.01 && delay < age + step + 0.01, `${delay} for age ${age}`);
			// The animation starts at `timeline`, `delay` into its fade: its steps fall on multiples of the step.
			const phase = (((timeline - delay) % step) + step) % step;
			assert.ok(Math.min(phase, step - phase) < 0.011, `phase ${phase} for age ${age} at ${timeline}`);
		}
		const tracker = new FreshTextTracker(() => 1000);
		const reply = {};
		const first = render('<p>Hello</p>');
		tracker.apply(reply, [first], true, 5000);
		const second = render('<p>Hello there</p>');
		tracker.apply(reply, [second], true, 5300);
		const spans = [...second.querySelectorAll<HTMLElement>(`.${FRESH_TEXT_CLASS}`)];
		assert.deepStrictEqual(spans.map(span => span.textContent), ['Hello', ' there']);
		for (const span of spans) {
			const phase = (((1000 + parseFloat(span.style.animationDelay)) % step) + step) % step;
			assert.ok(Math.min(phase, step - phase) < 0.011, span.style.animationDelay);
			assert.ok(span.style.animationTimingFunction.startsWith('linear('));
		}
	});
});
