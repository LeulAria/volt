/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { $ } from '../../../../../base/browser/dom.js';
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
});
