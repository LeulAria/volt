/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { AgentNavHistory, agentSidebarNavChrome, agentSidebarNavDragClearance } from '../../browser/chrome/agentNavHistory.js';

suite('Agent navigation history', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	function entry(key: string, opened: string[]): { key: string; open(): Promise<void> } {
		return {
			key,
			open: async () => { opened.push(key); },
		};
	}

	test('back and forward walk the places that were opened', async () => {
		const history = new AgentNavHistory();
		const opened: string[] = [];
		history.push(entry('chat-a', opened));
		history.push(entry('chat-b', opened));
		history.push(entry('settings', opened));

		assert.strictEqual(history.canBack, true);
		assert.strictEqual(history.canForward, false);

		await history.back();
		assert.deepStrictEqual(opened, ['chat-b']);
		assert.strictEqual(history.canForward, true);

		await history.back();
		assert.deepStrictEqual(opened, ['chat-b', 'chat-a']);
		assert.strictEqual(history.canBack, false);

		await history.forward();
		assert.deepStrictEqual(opened, ['chat-b', 'chat-a', 'chat-b']);
	});

	test('a new place after going back drops the forward trail', async () => {
		const history = new AgentNavHistory();
		const opened: string[] = [];
		history.push(entry('chat-a', opened));
		history.push(entry('settings', opened));
		history.push(entry('chat-b', opened));
		await history.back();
		history.push(entry('chat-c', opened));

		assert.strictEqual(history.canForward, false);
		await history.forward();
		await history.back();
		await history.back();
		assert.deepStrictEqual(opened, ['settings', 'settings', 'chat-a']);
	});

	test('opening the place you are already on does not grow the stack', () => {
		const history = new AgentNavHistory();
		history.push(entry('chat-a', []));
		history.push(entry('chat-a', []));
		assert.strictEqual(history.canBack, false);
	});

	test('open sidebar drag strip stops before the history arrows', () => {
		assert.strictEqual(agentSidebarNavDragClearance(), 58);
		for (const sidebarWidth of [180, 290]) {
			const dragRight = sidebarWidth - agentSidebarNavDragClearance();
			const navWidth = agentSidebarNavChrome.button + agentSidebarNavChrome.gap + agentSidebarNavChrome.button;
			const navLeft = sidebarWidth - agentSidebarNavChrome.edge - navWidth;
			assert.ok(dragRight <= navLeft, `sidebar ${sidebarWidth}: drag ends at ${dragRight}, arrows start at ${navLeft}`);
			assert.ok(dragRight > 108, `sidebar ${sidebarWidth} keeps a drag strip beside the arrows`);
		}
	});

	test('restoring a place does not record that restore as a new visit', async () => {
		const history = new AgentNavHistory();
		history.push({
			key: 'chat-a',
			open: async () => history.push(entry('chat-a', [])),
		});
		history.push({
			key: 'settings',
			open: async () => history.push(entry('settings', [])),
		});

		await history.back();
		assert.strictEqual(history.canForward, true);
		assert.strictEqual(history.canBack, false);
	});
});
