/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { tasksCard } from '../../browser/chrome/agentTimeline.js';
import { AgentTasksCard, TaskOutcomeTarget } from '../../browser/composer/agentTasksCard.js';

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

	test('a finished to-do shows what it produced, and a single file or canvas opens', () => {
		const opened: TaskOutcomeTarget[] = [];
		const view = store.add(new AgentTasksCard(() => { }, target => opened.push(target)));
		view.set(tasksCard([
			{ label: 'Design the flow', state: 'done', outcome: { files: 0, additions: 0, deletions: 0, canvas: { id: 'c1', title: 'Onboarding', created: true } } },
			{ label: 'Build it', state: 'done', outcome: { files: 1, additions: 120, deletions: 8, file: { path: '/w/src/app.ts', created: false } } },
			{ label: 'Wire the rest', state: 'done', outcome: { files: 3, additions: 40, deletions: 0 } },
			{ label: 'Rerun', state: 'current', startedAt: 0 },
		], true));
		view.element.querySelector<HTMLButtonElement>('.volt-agent-tasks-head')!.click();
		const rows = [...view.element.querySelectorAll('.volt-agent-tasks-item')];
		assert.deepStrictEqual(rows.map(row => row.querySelector('.volt-agent-tasks-outcome')?.textContent), ['New design: Onboarding', 'app.ts+120-8', '3 files+40', undefined]);
		assert.strictEqual(rows[2].querySelector('.volt-agent-tasks-outcome-link'), null, 'several files: nothing single to open');
		const links = [...view.element.querySelectorAll<HTMLButtonElement>('.volt-agent-tasks-outcome-link')];
		links.forEach(link => link.click());
		assert.deepStrictEqual(opened, [{ kind: 'canvas', id: 'c1' }, { kind: 'file', path: '/w/src/app.ts' }]);
		assert.ok(view.element.querySelector('.volt-agent-tasks-list'), 'opening an outcome leaves the card open');
		// The to-do in progress shimmers.
		assert.deepStrictEqual(rows.map(row => row.querySelector('.volt-agent-tasks-label')!.classList.contains('shimmer')), [false, false, false, true]);
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
