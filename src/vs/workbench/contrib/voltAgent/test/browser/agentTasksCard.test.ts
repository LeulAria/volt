/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { tasksCard } from '../../browser/chrome/agentTimeline.js';
import { AgentTasksCard } from '../../browser/composer/agentTasksCard.js';

suite('Agent Tasks card', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	const card = tasksCard([
		{ label: 'Verify the saved benchmark setup', state: 'done', startedAt: 0, endedAt: 92_000 },
		{ label: 'Run matched tasks', state: 'current', startedAt: 92_000 },
		{ label: 'Implement improvements', state: 'pending' },
		{ label: 'Rerun benchmarks', state: 'pending' },
	], true);

	test('one line with the current to-do, the count and a segment per to-do', () => {
		const view = store.add(new AgentTasksCard(() => { }));
		view.set(card);
		const el = view.element;
		assert.strictEqual(el.classList.contains('hidden'), false);
		assert.strictEqual(el.querySelector('.volt-agent-tasks-title')?.textContent, 'Tasks');
		assert.strictEqual(el.querySelector('.volt-agent-tasks-current')?.textContent, 'Run matched tasks');
		assert.strictEqual(el.querySelector('.volt-agent-tasks-count')?.textContent, '1/4');
		assert.deepStrictEqual([...el.querySelectorAll('.volt-agent-tasks-seg')].map(seg => seg.classList[1]), ['done', 'current', 'pending', 'pending']);
		assert.strictEqual(el.querySelector('.volt-agent-tasks-list'), null, 'starts folded');
	});

	test('opens into the list with states and times', () => {
		const view = store.add(new AgentTasksCard(() => { }));
		view.set(card);
		const head = view.element.querySelector<HTMLButtonElement>('.volt-agent-tasks-head')!;
		head.click();
		assert.strictEqual(head.isConnected, false, 'redrawn');
		const rows = [...view.element.querySelectorAll('.volt-agent-tasks-item')];
		assert.deepStrictEqual(rows.map(row => row.classList[1]), ['done', 'current', 'pending', 'pending']);
		assert.deepStrictEqual(rows.map(row => row.querySelector('.volt-agent-tasks-time')?.textContent), ['1m 32s', 'now', undefined, undefined]);
		assert.strictEqual(view.element.querySelector('.volt-agent-tasks-head')?.getAttribute('aria-expanded'), 'true');
		// The same list again keeps the card open and untouched.
		const list = view.element.querySelector('.volt-agent-tasks-list');
		view.set(tasksCard(card!.items.map(item => ({ label: item.label, state: item.state, ...(item.state === 'done' ? { startedAt: 0, endedAt: 92_000 } : {}) })), true));
		assert.strictEqual(view.element.querySelector('.volt-agent-tasks-list'), list);
	});

	test('hides with no to-dos and reports the change', () => {
		let changes = 0;
		const view = store.add(new AgentTasksCard(() => changes++));
		view.set(card);
		view.set(undefined);
		assert.strictEqual(view.visible, false);
		assert.strictEqual(view.element.classList.contains('hidden'), true);
		assert.strictEqual(changes, 2);
	});
});
