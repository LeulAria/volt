/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { $ } from '../../../../../base/browser/dom.js';
import { mainWindow } from '../../../../../base/browser/window.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { AgentThreadView, isBottomFadeClear } from '../../browser/editor/agentThreadView.js';

suite('Agent thread view', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('restores the thread into the chat column in front of the composer', () => {
		const editor = $('.volt-agent-editor');
		const column = editor.appendChild($('.volt-agent-editor-main'));
		const thread = store.add(new AgentThreadView());
		const composer = column.appendChild($('.volt-agent-composer'));
		column.insertBefore(thread.element, composer);
		thread.rememberHome();

		const host = $('.volt-browser-dock-body');
		thread.mount(host);
		assert.strictEqual(thread.element.parentElement, host);

		thread.restore();
		assert.strictEqual(thread.element.parentElement, column);
		assert.strictEqual(thread.element.nextElementSibling, composer);
	});

	test('a native scroll is adopted in the next frame, without a layout read in the scroll event', async () => {
		const thread = store.add(new AgentThreadView());
		thread.element.style.height = '100px';
		thread.inner.style.height = '100px';
		thread.inner.style.overflow = 'hidden';
		mainWindow.document.body.appendChild(thread.element);
		try {
			const content = thread.inner.appendChild($('div'));
			content.style.height = '1000px';
			// The thread's stylesheet (loaded once another suite imports it) makes the inner element a flex column.
			content.style.flexShrink = '0';
			thread.scroll.scanDomNode();
			let reads = 0;
			const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop')!;
			Object.defineProperty(thread.inner, 'scrollTop', {
				configurable: true,
				get() { reads++; return descriptor.get!.call(this); },
				set(value: number) { descriptor.set!.call(this, value); },
			});
			// A scrollIntoView or find moves the element under the scrollable.
			thread.inner.scrollTop = 300;
			thread.inner.dispatchEvent(new Event('scroll'));
			assert.strictEqual(reads, 0, 'nothing is read in the event');
			await new Promise(resolve => mainWindow.requestAnimationFrame(() => setTimeout(resolve, 0)));
			assert.strictEqual(thread.scroll.getScrollPosition().scrollTop, 300, `the scrollable caught up (element at ${descriptor.get!.call(thread.inner)})`);
			// Several scroll events in one frame share one read.
			reads = 0;
			for (let i = 0; i < 5; i++) {
				thread.inner.dispatchEvent(new Event('scroll'));
			}
			await new Promise(resolve => mainWindow.requestAnimationFrame(() => setTimeout(resolve, 0)));
			assert.strictEqual(reads, 1);
		} finally {
			thread.element.remove();
		}
	});

	test('the scrollbar slider is drawn once at the end of the frame, not in each scroll write', async () => {
		const thread = store.add(new AgentThreadView());
		thread.element.style.height = '100px';
		thread.inner.style.height = '100px';
		thread.inner.style.overflow = 'hidden';
		mainWindow.document.body.appendChild(thread.element);
		try {
			const content = thread.inner.appendChild($('div'));
			content.style.height = '1000px';
			content.style.flexShrink = '0';
			thread.scroll.scanDomNode();
			await new Promise(resolve => mainWindow.requestAnimationFrame(() => setTimeout(resolve, 0)));
			const slider = thread.scroll.getDomNode().querySelector<HTMLElement>('.scrollbar.vertical > .slider')!;
			assert.ok(slider, 'the thread has a vertical slider');
			const before = slider.style.top;
			// A follow step and a scroll sync write the position several times in one frame: the slider's
			// style stays untouched until the frame's end, so no later layout read in the frame is forced.
			thread.scroll.setScrollPosition({ scrollTop: 300 });
			thread.scroll.setScrollPosition({ scrollTop: 450 });
			assert.strictEqual(slider.style.top, before, 'the slider is not drawn in the scroll write');
			await new Promise(resolve => mainWindow.requestAnimationFrame(() => setTimeout(resolve, 0)));
			assert.notStrictEqual(slider.style.top, before, 'the slider is drawn by the end of the frame');
			assert.strictEqual(thread.inner.scrollTop, 450, 'the element itself scrolled at once');
		} finally {
			thread.element.remove();
		}
	});

	test('the bottom fade is marked clear only while no content reaches its band', () => {
		assert.strictEqual(isBottomFadeClear(220, 300), true);
		assert.strictEqual(isBottomFadeClear(220.5, 300), false);

		const thread = store.add(new AgentThreadView());
		thread.element.style.height = '300px';
		thread.inner.style.height = '300px';
		thread.inner.style.overflow = 'hidden';
		thread.inner.style.boxSizing = 'border-box';
		// Stands in for the empty space under the last exchange (`.volt-agent-thread-inner::after`).
		thread.inner.style.paddingBottom = '200px';
		mainWindow.document.body.appendChild(thread.element);
		try {
			const content = thread.inner.appendChild($('div'));
			content.style.height = '1000px';
			content.style.flexShrink = '0';
			thread.scroll.scanDomNode();
			const scroller = thread.scroll.getDomNode();
			const at = (scrollTop: number) => {
				thread.scroll.setScrollPosition({ scrollTop });
				thread.syncStuckTurns();
				return scroller.classList.contains('bottom-clear');
			};
			assert.strictEqual(at(900), true, 'at the end only the empty space is under the fade');
			assert.strictEqual(at(780), true, 'the last line is just above the fade');
			assert.strictEqual(at(700), false, 'content in the fade keeps the mask');
			assert.strictEqual(at(0), false);
			assert.strictEqual(at(900), true);

			// The side toolbar's rows opened as a card over the transcript (outside the toolbar's own box) count too.
			scroller.style.position = 'relative';
			const toolbar = scroller.appendChild($('.volt-agent-quick-open-actions'));
			// The stylesheet (once another suite loads it) hides the toolbar outside the agent layout.
			toolbar.style.cssText = 'display: block; position: absolute; top: 0; right: 0; width: 28px; height: 28px;';
			const card = toolbar.appendChild($('.volt-agent-quick-open-body'));
			card.style.cssText = 'position: absolute; top: 0; right: 0; width: 200px; height: 260px;';
			assert.strictEqual(at(900), false, 'a toolbar card reaching the fade keeps the mask');
			toolbar.classList.add('expanded');
			assert.strictEqual(at(900), true, 'a toolbar shown as its own column is outside the fade');
			toolbar.classList.add('overlay');
			assert.strictEqual(at(900), false, 'an expanded toolbar laid over the transcript is inside it');
			card.style.height = '200px';
			assert.strictEqual(at(900), true);
		} finally {
			thread.element.remove();
		}
	});

	test('under a pinned sent card a tall reply is masked row by row, only in the card\'s band; a short one whole', () => {
		const thread = store.add(new AgentThreadView());
		thread.element.style.cssText = 'position: fixed; top: 0; left: 0; width: 300px; height: 300px;';
		thread.inner.style.height = '300px';
		thread.inner.style.overflow = 'hidden';
		// The pixel positions below assume no gaps, margins or padding, which the thread's stylesheet
		// adds once another suite loads it.
		thread.inner.style.padding = '0';
		thread.inner.style.gap = '0';
		mainWindow.document.body.appendChild(thread.element);
		try {
			const exchange = thread.inner.appendChild($('.volt-agent-exchange'));
			exchange.style.cssText = 'margin: 0; gap: 0;';
			const card = exchange.appendChild($('.volt-agent-turn.user'));
			card.style.cssText = 'position: sticky; top: 0; height: 40px; margin: 0; padding: 0;';
			const reply = exchange.appendChild($('.volt-agent-turn.agent'));
			reply.style.cssText = 'margin: 0; gap: 0;';
			const body = reply.appendChild($('.volt-agent-thread-body'));
			body.style.gap = '0';
			const rows: HTMLElement[] = [];
			for (let i = 0; i < 40; i++) {
				const row = body.appendChild($('.volt-agent-reply'));
				// Row 12 is hidden (no box): the search steps over it.
				row.style.cssText = i === 12 ? 'display: none;' : 'height: 50px;';
				rows.push(row);
			}
			const footer = reply.appendChild($('.volt-agent-footer'));
			footer.style.height = '20px';
			thread.scroll.scanDomNode();
			const masked = () => rows.map((row, i) => row.classList.contains('volt-under-stuck') ? i : -1).filter(i => i >= 0);
			const at = (scrollTop: number) => {
				thread.scroll.setScrollPosition({ scrollTop });
				thread.syncStuckTurns();
				return masked();
			};

			assert.deepStrictEqual(at(0), [], 'the card is not pinned at rest');
			assert.strictEqual(reply.classList.contains('volt-under-stuck'), false);
			// Scrolled 500px: rows 0-8 are above the viewport (the card's 40px + 9 rows = 490px), row 9 is cut by its
			// top edge, the card covers down to 40px and the fade to 74px: rows 9 and 10 (10px to 110px) are in the band.
			assert.deepStrictEqual(at(500), [9, 10]);
			assert.strictEqual(reply.classList.contains('volt-under-stuck'), false, 'the tall reply itself is not masked');
			assert.strictEqual(body.classList.contains('volt-under-stuck'), false);
			assert.strictEqual(rows[9].style.getPropertyValue('--volt-sticky-fade-end'), '50px', 'the card\'s bottom, from the row\'s own top (-10px)');
			assert.strictEqual(rows[10].style.getPropertyValue('--volt-sticky-fade-end'), '0px');
			// The band moves on: rows that left it are unmasked. Row 12 has no box.
			assert.deepStrictEqual(at(650), [13, 14], 'row 12 is hidden; row 13 spans -10px to 40px, row 14 starts at 40px, above the fade\'s end at 74px');
			assert.strictEqual(rows[9].classList.contains('volt-under-stuck'), false);
			assert.strictEqual(rows[9].style.getPropertyValue('--volt-sticky-fade-end'), '');
			assert.deepStrictEqual(at(0), []);

			// A short reply is masked whole, as before.
			for (const row of rows.slice(4)) {
				row.remove();
			}
			thread.inner.appendChild($('div')).style.height = '600px';
			thread.scroll.scanDomNode();
			assert.deepStrictEqual(at(100), []);
			assert.strictEqual(reply.classList.contains('volt-under-stuck'), true);
			assert.strictEqual(reply.style.getPropertyValue('--volt-sticky-fade-end'), '100px');
		} finally {
			thread.element.remove();
		}
	});
});
