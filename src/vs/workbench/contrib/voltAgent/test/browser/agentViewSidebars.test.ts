/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { $ } from '../../../../../base/browser/dom.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { agentRightDockHost } from '../../browser/chrome/agentViewSidebars.js';

suite('Agent view sidebars', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('pins the right dock to the open chat editor', () => {
		const editorPart = $('.editor');
		const chat = editorPart.appendChild($('.volt-agent-editor'));
		const fallback = $('.root');

		assert.strictEqual(agentRightDockHost(editorPart, fallback), chat);
	});

	test('keeps the right dock on the editor part when no chat is mounted', () => {
		const editorPart = $('.editor');
		const fallback = $('.root');

		assert.strictEqual(agentRightDockHost(editorPart, fallback), editorPart);
		assert.strictEqual(agentRightDockHost(undefined, fallback), fallback);
	});
});
