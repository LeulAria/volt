/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { browserBlockedMessage, browserBlockReason } from '../../common/browserAccess.js';

suite('Volt browser access for agents', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('the chat\'s own choice wins over the setting, both ways', () => {
		assert.strictEqual(browserBlockReason(true, undefined), undefined);
		assert.strictEqual(browserBlockReason(false, undefined), 'setting');
		assert.strictEqual(browserBlockReason(true, false), 'chat');
		assert.strictEqual(browserBlockReason(false, true), undefined);
	});

	test('the refusal names the tool and the reason, and tells the agent not to work around it', () => {
		const chat = browserBlockedMessage('browser_click', 'chat');
		assert.ok(chat.startsWith('browser_click was not run: the user turned off browser access for agents in this chat.'));
		assert.ok(chat.includes('Do not retry'));
		assert.ok(chat.includes('curl'));
		assert.ok(browserBlockedMessage('browser_navigate', 'setting').includes('volt.browser.allowAgents'));
	});
});
