/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { $ } from '../../../../../base/browser/dom.js';
import { mainWindow } from '../../../../../base/browser/window.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { AgentThreadView } from '../../browser/editor/agentThreadView.js';

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
});
