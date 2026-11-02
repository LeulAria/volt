/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { onDidChangeShownAgentChat, setShownAgentChat, shownAgentChat } from '../../browser/editor/agentShownChat.js';

suite('Agent shown chat', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	teardown(() => setShownAgentChat(undefined));

	test('names the chat drawn last, and fires once per change', () => {
		const seen: (string | undefined)[] = [];
		store.add(onDidChangeShownAgentChat(() => seen.push(shownAgentChat())));
		setShownAgentChat('agent-a');
		setShownAgentChat('agent-a');
		setShownAgentChat('agent-b');
		setShownAgentChat(undefined);
		assert.deepStrictEqual(seen, ['agent-a', 'agent-b', undefined]);
		assert.strictEqual(shownAgentChat(), undefined);
	});
});
