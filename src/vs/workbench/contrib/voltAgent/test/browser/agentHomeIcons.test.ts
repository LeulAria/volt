/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { AGENT_HOME_NEW_CHAT_ICON_PATH, AGENT_HOME_SEARCH_ICON_PATH, createHomeNewChatIcon, createHomeSearchIcon } from '../../browser/home/agentHomeIcons.js';

suite('Agent home icons', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('search icon uses the stroke magnifier path', () => {
		const icon = createHomeSearchIcon();
		const path = icon.querySelector('path');
		assert.ok(icon.classList.contains('search'));
		assert.strictEqual(path?.getAttribute('d'), AGENT_HOME_SEARCH_ICON_PATH);
		assert.strictEqual(path?.getAttribute('stroke'), 'currentColor');
		assert.strictEqual(path?.getAttribute('stroke-width'), '2');
	});

	test('new chat icon uses the folded-page stroke path', () => {
		const icon = createHomeNewChatIcon();
		const path = icon.querySelector('path');
		assert.ok(icon.classList.contains('new-chat'));
		assert.strictEqual(path?.getAttribute('d'), AGENT_HOME_NEW_CHAT_ICON_PATH);
		assert.strictEqual(path?.getAttribute('stroke'), 'currentColor');
		assert.strictEqual(path?.getAttribute('stroke-width'), '2');
		assert.ok(AGENT_HOME_NEW_CHAT_ICON_PATH.includes('8.87'));
	});
});
