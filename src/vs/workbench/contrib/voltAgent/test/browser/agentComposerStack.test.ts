/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IClipboardService } from '../../../../../platform/clipboard/common/clipboardService.js';
import { IContextViewService } from '../../../../../platform/contextview/browser/contextView.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { IAgentOrchestratorService, IOrchTask, OrchCommandBody } from '../../../../services/voltRuntime/common/orchestration/orchestrator.js';
import { ISubagentView, retryHarnessSubagent } from '../../browser/chrome/agentSubagents.js';
import { AgentComposerQueue } from '../../browser/composer/agentComposerQueue.js';
import { AgentTerminalChips } from '../../browser/terminals/agentTerminalChips.js';
import { IAgentTerminalInfo, IAgentTerminalsService } from '../../browser/terminals/agentTerminals.js';

suite('Agent composer stack', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function agent(key: string, title: string): ISubagentView {
		return { key, title, state: 'running', stateLabel: 'Running', openable: true, cancellable: true, source: 'volt' };
	}

	function queue(): AgentComposerQueue {
		return store.add(new AgentComposerQueue({ onRemove: () => { }, onClear: () => { }, onMultitask: () => { }, onReorder: () => { } }));
	}

	test('running subagents stay in the chip: no card while nothing waits for Resume', () => {
		const view = queue();
		view.setAgents({ views: [agent('a', 'Design system inventory')], conflicts: [{ path: 'src/a.ts', titles: ['A', 'B'] }] });
		assert.strictEqual(view.agentsElement.classList.contains('hidden'), true);
	});

	test('subagents waiting for Resume get their own card, apart from the queued prompts', () => {
		const view = queue();
		view.setState({ running: false, steer: false, paused: 'interrupted' });
		view.setAgents({ views: [agent('a', 'Design system inventory'), agent('b', 'Front office domain bugs')], conflicts: [] });
		assert.strictEqual(view.agentsElement.classList.contains('hidden'), false);
		assert.strictEqual(view.agentsElement.querySelector('.volt-agent-work-toggle')?.textContent, '2 subagents running');
		assert.strictEqual(view.element.contains(view.agentsElement), false, 'not inside the queue stack');
		assert.strictEqual(view.element.classList.contains('has-stack'), false, 'agents alone leave the stack empty');

		view.setQueue([{ id: 'q1', text: 'Next' }]);
		assert.strictEqual(view.element.classList.contains('has-stack'), true);
		assert.strictEqual(view.element.querySelector('.volt-agent-queue-card')?.classList.contains('hidden'), false);
		assert.strictEqual(view.element.querySelector('.volt-agent-work-section.agents'), null, 'subagents never in the queue card');

		view.setAgents({ views: [], conflicts: [] });
		assert.strictEqual(view.agentsElement.classList.contains('hidden'), true);
	});

	suite('terminal chip', () => {

		function terminal(id: string, label: string, status: IAgentTerminalInfo['status']): IAgentTerminalInfo {
			return { id, chatId: 'chat', command: `npm run ${id}`, label, cwd: undefined, status, startedAt: 1, lastActivity: 1, urls: [], viewable: true, kind: 'terminal' };
		}

		function chips(list: IAgentTerminalInfo[], change: Emitter<string>): AgentTerminalChips {
			const terminals: Partial<IAgentTerminalsService> = {
				onDidChange: change.event,
				onDidRequestReveal: Event.None,
				list: () => list,
				get: id => list.find(info => info.id === id),
			};
			return store.add(new AgentTerminalChips({ chatId: () => 'chat' }, terminals as IAgentTerminalsService, {} as IContextViewService, {} as IClipboardService, {} as IOpenerService));
		}

		test('one chip in the composer row: a terminal, then a count of several', () => {
			const list: IAgentTerminalInfo[] = [];
			const change = store.add(new Emitter<string>());
			const view = chips(list, change);
			const el = view.element;
			assert.ok(el.classList.contains('volt-agent-composer-chip') && el.classList.contains('terminal-runs'));
			assert.strictEqual(view.visible, false);

			let changes = 0;
			store.add(view.onDidChange(() => changes++));
			list.push(terminal('serve', 'Serve test screenshots', 'running'));
			change.fire('chat');
			assert.strictEqual(view.visible, true);
			assert.strictEqual(changes, 1);
			assert.ok(el.classList.contains('running') && !el.classList.contains('summary'));
			// The chip names no terminal, port or address: those are in its tooltip and menu.
			assert.strictEqual(el.querySelector('.volt-agent-terminal-runs-label')?.textContent, '1 terminal');
			assert.ok(el.querySelector('.volt-agent-terminal-runs-more'), 'chevron for the menu');

			list.push(terminal('watch', 'Watch', 'running'));
			change.fire('chat');
			assert.ok(el.classList.contains('summary'));
			assert.strictEqual(el.querySelector('.volt-agent-terminal-runs-label')?.textContent, '2 terminals');
			assert.ok(el.querySelector('.volt-agent-terminal-status .volt-browser-dock-dots'), 'the row\'s dot loader leads a live chip');

			list[1] = terminal('watch', 'Watch', 'completed');
			change.fire('chat');
			assert.strictEqual(el.querySelector('.volt-agent-terminal-runs-label')?.textContent, '1 terminal', 'the running count while any runs');

			change.fire('another chat');
			assert.strictEqual(changes, 3, 'other chats do not redraw it');

			list.length = 0;
			change.fire('chat');
			assert.strictEqual(view.visible, false);
		});
	});

	suite('subagent retry', () => {
		function harnessTask(overrides: Partial<IOrchTask> = {}): IOrchTask {
			return {
				id: 'call-1', source: 'harness', parentId: 'parent', rootId: 'parent', title: 'Cut web type errors', role: 'general', origin: 'agent',
				brief: 'Fix the type errors in apps/web.', isolation: 'shared', depth: 1, createdAt: 0, state: 'failed', steps: 3, files: [], delivery: 'none', rounds: 1,
				...overrides,
			};
		}

		/** An orchestrator that keeps tasks and spawns what it is told to, reusing a client request id as the real one does. */
		function fakeOrchestrator(tasks: IOrchTask[]): { readonly service: IAgentOrchestratorService; readonly spawns: OrchCommandBody[] } {
			const byId = new Map(tasks.map(task => [task.id, task]));
			const spawns: OrchCommandBody[] = [];
			const service = {
				getTask: (id: string) => byId.get(id),
				getThread: (id: string) => id === 'parent' ? { id, title: 'Implement PMS audit gaps', depth: 0, modelRef: 'claude:opus', modelLabel: 'Opus 5.5' } : undefined,
				getState: () => ({ tasks: Object.fromEntries(byId) }),
				ensureThreadLoaded: async () => undefined,
				dispatch: async (command: OrchCommandBody) => {
					if (command.type !== 'task.spawn') {
						return [];
					}
					spawns.push(command);
					const spawn = command.spawn;
					if ([...byId.values()].some(task => task.clientRequestId === spawn.clientRequestId)) {
						return [];
					}
					const task = harnessTask({ id: spawn.taskId, source: 'volt', childId: spawn.childId, clientRequestId: spawn.clientRequestId, state: 'queued' });
					byId.set(task.id, task);
					return [{ type: 'task.created', task }];
				},
			} as unknown as IAgentOrchestratorService;
			return { service, spawns };
		}

		test('a failed harness subagent runs again as a Volt subagent of the same parent, once', async () => {
			const { service, spawns } = fakeOrchestrator([harnessTask()]);
			const first = await retryHarnessSubagent(service, 'call-1');
			assert.ok(first);
			const spawn = spawns[0].type === 'task.spawn' ? spawns[0].spawn : undefined;
			assert.strictEqual(spawn?.parentId, 'parent');
			assert.strictEqual(spawn?.brief, 'Fix the type errors in apps/web.');
			assert.strictEqual(spawn?.modelRef, 'claude:opus', 'the parent ran it, so it runs on the parent model');
			assert.ok(spawn?.childPrompt.text.includes('This is a retry'));
			assert.deepStrictEqual(spawn?.childPrompt.display, { text: 'Fix the type errors in apps/web.', brief: true });
			// A second click opens the same retry instead of starting another.
			assert.strictEqual(await retryHarnessSubagent(service, 'call-1'), first);
		});

		test('only harness subagents with a brief are retried this way', async () => {
			assert.strictEqual(await retryHarnessSubagent(fakeOrchestrator([harnessTask({ source: 'volt' })]).service, 'call-1'), undefined);
			assert.strictEqual(await retryHarnessSubagent(fakeOrchestrator([harnessTask({ brief: '  ' })]).service, 'call-1'), undefined);
			assert.strictEqual(await retryHarnessSubagent(fakeOrchestrator([]).service, 'call-1'), undefined);
		});
	});
});
