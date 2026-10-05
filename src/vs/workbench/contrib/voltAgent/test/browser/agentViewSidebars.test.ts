/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { $ } from '../../../../../base/browser/dom.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { EditorInput } from '../../../../common/editor/editorInput.js';
import { QUICK_OPEN_NARROW_CHAT_WIDTH, QUICK_OPEN_NARROW_WINDOW_WIDTH, agentQuickOpenActionsHost, dockOpenTabs, dockTabKey, mountAgentQuickOpenActions, quickOpenCollapsedForWidth, quickOpenNarrowForSpace } from '../../browser/chrome/agentViewSidebars.js';

suite('Agent view sidebars', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('puts Quick Open Actions in the chat scroller before a transcript exists', () => {
		const editorPart = $('.editor');
		const chat = editorPart.appendChild($('.volt-agent-editor'));
		const thread = chat.appendChild($('.volt-agent-thread'));
		const scroll = thread.appendChild($('.monaco-scrollable-element'));
		const fallback = $('.root');

		assert.strictEqual(agentQuickOpenActionsHost(editorPart, fallback), scroll);
	});

	test('floats Quick Open Actions on the chat column of a new chat, then moves them to the scroller', () => {
		const editorPart = $('.editor');
		const chat = editorPart.appendChild($('.volt-agent-editor'));
		const main = chat.appendChild($('.volt-agent-editor-main'));
		const thread = main.appendChild($('.volt-agent-thread'));
		const scroll = thread.appendChild($('.monaco-scrollable-element'));
		const fallback = $('.root');

		assert.strictEqual(agentQuickOpenActionsHost(editorPart, fallback), main);
		chat.classList.add('has-turns');
		assert.strictEqual(agentQuickOpenActionsHost(editorPart, fallback), scroll);
	});

	test('puts Quick Open Actions in the chat scroller once a transcript exists', () => {
		const editorPart = $('.editor');
		const chat = editorPart.appendChild($('.volt-agent-editor'));
		const thread = chat.appendChild($('.volt-agent-thread'));
		const scroll = thread.appendChild($('.monaco-scrollable-element'));
		scroll.appendChild($('.volt-agent-turn'));
		const fallback = $('.root');

		assert.strictEqual(agentQuickOpenActionsHost(editorPart, fallback), scroll);
	});

	test('collapses Quick Open Actions by default on a narrow window', () => {
		assert.strictEqual(quickOpenCollapsedForWidth(QUICK_OPEN_NARROW_WINDOW_WIDTH, false), true);
		assert.strictEqual(quickOpenCollapsedForWidth(800, false), true);
		assert.strictEqual(quickOpenCollapsedForWidth(QUICK_OPEN_NARROW_WINDOW_WIDTH + 1, false), false);
	});

	test('a chat column squeezed by tools beside it counts as narrow on a wide window', () => {
		assert.strictEqual(quickOpenNarrowForSpace(1800, 1400), false);
		assert.strictEqual(quickOpenNarrowForSpace(1800, QUICK_OPEN_NARROW_CHAT_WIDTH), true);
		assert.strictEqual(quickOpenNarrowForSpace(1800, 0), false, 'an unmeasured column does not collapse');
		assert.strictEqual(quickOpenNarrowForSpace(QUICK_OPEN_NARROW_WINDOW_WIDTH, 0), true);
	});

	test('keeps a manual Quick Open choice on a large window', () => {
		assert.strictEqual(quickOpenCollapsedForWidth(1400, true), true);
		assert.strictEqual(quickOpenCollapsedForWidth(1400, false), false);
		assert.strictEqual(quickOpenCollapsedForWidth(800, false, false), false);
	});

	test('keeps Quick Open Actions on the editor part when no chat is mounted', () => {
		const editorPart = $('.editor');
		const fallback = $('.root');

		assert.strictEqual(agentQuickOpenActionsHost(editorPart, fallback), editorPart);
		assert.strictEqual(agentQuickOpenActionsHost(undefined, fallback), fallback);
	});

	test('an open tab keeps its row when the title changes', () => {
		const browser = { typeId: 'volt.browser', resource: { toString: () => 'volt-browser://abc' }, getName: () => 'Google' };

		assert.strictEqual(dockTabKey(browser), dockTabKey({ ...browser, getName: () => 'Google Search' }));
		assert.notStrictEqual(dockTabKey(browser), dockTabKey({ typeId: browser.typeId, resource: { toString: () => 'volt-browser://other' }, getName: () => 'Other' }));
	});

	test('open tabs include a right-side browser and skip the chat', () => {
		const chat = { id: 'chat' } as EditorInput;
		const browser = { id: 'browser' } as EditorInput;
		const tabs = dockOpenTabs(
			[{ editors: [chat] }, { editors: [browser, browser] }],
			editor => editor === chat,
		);

		assert.deepStrictEqual(tabs, [browser]);
	});

	test('keeps Quick Open Actions an in-flow sibling of the transcript on the chat scroller', () => {
		const scroll = $('.monaco-scrollable-element');
		const inner = scroll.appendChild($('.volt-agent-thread-inner'));
		const scrollbar = scroll.appendChild($('.scrollbar.vertical'));
		const quickOpen = $('.volt-agent-quick-open-actions');
		const leftover = $('.root');
		leftover.appendChild(quickOpen);

		mountAgentQuickOpenActions(scroll, quickOpen);

		assert.strictEqual(quickOpen.parentElement, scroll);
		assert.strictEqual(quickOpen.previousElementSibling, inner);
		assert.strictEqual(quickOpen.nextElementSibling, scrollbar);
		assert.strictEqual(leftover.contains(quickOpen), false);
	});
});
