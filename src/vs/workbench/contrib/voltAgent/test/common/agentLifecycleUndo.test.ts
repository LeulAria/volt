/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { AgentLifecycleUndoStack, IAgentLifecycleUndoItem, lifecycleUndoLabel } from '../../common/agentLifecycleUndo.js';

function item(sessionId: string, previous: IAgentLifecycleUndoItem['previous'] = {}): IAgentLifecycleUndoItem {
	return { sessionId, title: sessionId, previous };
}

suite('Agent lifecycle undo', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('offers the latest action for five seconds after it', () => {
		const stack = new AgentLifecycleUndoStack(5_000);
		stack.record('settle', item('a'), 1_000);
		assert.strictEqual(stack.current(5_999)?.items.length, 1);
		assert.strictEqual(stack.current(6_000), undefined);
		assert.strictEqual(stack.take(6_000), undefined);
	});

	test('consecutive actions of one kind undo together, and each one extends the notice', () => {
		const stack = new AgentLifecycleUndoStack(5_000);
		stack.record('settle', item('a'), 0);
		stack.record('settle', item('b'), 4_000);
		const entry = stack.current(8_000);
		assert.deepStrictEqual(entry?.items.map(i => i.sessionId), ['a', 'b']);
		assert.strictEqual(entry?.expiresAt, 9_000);
	});

	test('another kind replaces the offer; a late action of the same kind starts a new one', () => {
		const stack = new AgentLifecycleUndoStack(5_000);
		stack.record('settle', item('a'), 0);
		stack.record('archive', item('b'), 1_000);
		assert.deepStrictEqual(stack.current(1_000)?.items.map(i => i.sessionId), ['b']);
		stack.record('archive', item('c'), 7_000);
		assert.deepStrictEqual(stack.current(7_000)?.items.map(i => i.sessionId), ['c']);
	});

	test('a chat acted on twice keeps the state from before the first time', () => {
		const stack = new AgentLifecycleUndoStack(5_000);
		stack.record('snooze', item('a', { snoozed: undefined }), 0);
		stack.record('snooze', item('a', { snoozed: true, snoozedUntil: 9 }), 1_000);
		assert.deepStrictEqual(stack.current(1_000)?.items, [item('a', { snoozed: undefined })]);
	});

	test('take hands the offer out once', () => {
		const stack = new AgentLifecycleUndoStack(5_000);
		stack.record('pin', item('a'), 0);
		assert.ok(stack.take(1));
		assert.strictEqual(stack.take(1), undefined);
		stack.record('unpin', item('a'), 2);
		stack.clear();
		assert.strictEqual(stack.current(2), undefined);
	});

	test('the notice names one chat or counts several', () => {
		assert.strictEqual(lifecycleUndoLabel({ action: 'settle', items: [{ ...item('a'), title: 'Fix login' }] }), 'Settled "Fix login"');
		assert.strictEqual(lifecycleUndoLabel({ action: 'archive', items: [item('a'), item('b'), item('c')] }), 'Archived 3 chats');
		assert.strictEqual(lifecycleUndoLabel({ action: 'wake', items: [{ ...item('a'), title: '' }] }), 'Unsnoozed "New Agent"');
	});
});
