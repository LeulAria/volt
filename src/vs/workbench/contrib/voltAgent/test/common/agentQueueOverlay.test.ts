/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IOrchQueueItem } from '../../../../services/voltRuntime/common/orchestration/orchestrator.js';
import { AgentQueueOverlay } from '../../common/agentQueueOverlay.js';

function item(id: string, text = id): IOrchQueueItem {
	return { id, prompt: { text }, at: 0 };
}

const ids = (items: readonly IOrchQueueItem[]) => items.map(entry => entry.id);

suite('Agent queue overlay', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('with nothing in flight the orchestrator queue is shown as it is', () => {
		const overlay = new AgentQueueOverlay();
		const queue = [item('a')];
		assert.strictEqual(overlay.apply(queue), queue);
		assert.ok(overlay.isEmpty);
	});

	test('a prompt on its way shows at the end until its call settles, and never twice', () => {
		const overlay = new AgentQueueOverlay();
		const settle = overlay.add(item('b'));
		assert.deepStrictEqual(ids(overlay.apply([item('a')])), ['a', 'b']);
		// The server already published it: shown once.
		assert.deepStrictEqual(ids(overlay.apply([item('a'), item('b')])), ['a', 'b']);
		settle();
		assert.ok(overlay.isEmpty);
		assert.deepStrictEqual(ids(overlay.apply([item('a')])), ['a']);
	});

	test('Send now goes first, the newest ahead of earlier ones', () => {
		const overlay = new AgentQueueOverlay();
		overlay.add(item('x'), true);
		overlay.add(item('y'), true);
		overlay.add(item('z'));
		assert.deepStrictEqual(ids(overlay.apply([item('a')])), ['y', 'x', 'a', 'z']);
	});

	test('a removed prompt is gone at once, including one still on its way', () => {
		const overlay = new AgentQueueOverlay();
		overlay.add(item('b'));
		const settle = overlay.remove('a');
		overlay.remove('b');
		assert.deepStrictEqual(ids(overlay.apply([item('a'), item('c')])), ['c']);
		settle();
		assert.deepStrictEqual(ids(overlay.apply([item('a'), item('c')])), ['a', 'c']);
	});

	test('an edit shows its text until the update lands; a later edit outlives an earlier call', () => {
		const overlay = new AgentQueueOverlay();
		const first = overlay.edit('a', { text: 'one' });
		const second = overlay.edit('a', { text: 'two' });
		assert.strictEqual(overlay.apply([item('a', 'old')])[0].prompt.text, 'two');
		first();
		assert.strictEqual(overlay.apply([item('a', 'old')])[0].prompt.text, 'two');
		second();
		assert.strictEqual(overlay.apply([item('a', 'old')])[0].prompt.text, 'old');
	});

	test('a reorder holds until it lands; prompts it does not name stay after, in their order', () => {
		const overlay = new AgentQueueOverlay();
		const settle = overlay.reorder(['c', 'a']);
		overlay.add(item('d'));
		assert.deepStrictEqual(ids(overlay.apply([item('a'), item('b'), item('c')])), ['c', 'a', 'b', 'd']);
		settle();
		assert.deepStrictEqual(ids(overlay.apply([item('a'), item('b'), item('c')])), ['a', 'b', 'c', 'd']);
	});

	test('moving one prompt to the front leaves the rest as they were', () => {
		const overlay = new AgentQueueOverlay();
		overlay.reorder(['c']);
		assert.deepStrictEqual(ids(overlay.apply([item('a'), item('b'), item('c')])), ['c', 'a', 'b']);
	});
});
