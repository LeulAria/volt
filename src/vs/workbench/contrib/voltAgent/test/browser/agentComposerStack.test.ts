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
import { ISubagentView } from '../../browser/chrome/agentSubagents.js';
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

	test('subagents get their own card, apart from the queued prompts', () => {
		const view = queue();
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
			assert.strictEqual(el.querySelector('.volt-agent-terminal-runs-label')?.textContent, 'Serve test screenshots');
			assert.ok(el.querySelector('.volt-agent-terminal-runs-more'), 'chevron for the menu');

			list.push(terminal('watch', 'Watch', 'running'));
			change.fire('chat');
			assert.ok(el.classList.contains('summary'));
			assert.strictEqual(el.querySelector('.volt-agent-terminal-runs-label')?.textContent, '2 terminals running');
			assert.strictEqual(el.querySelectorAll('.volt-agent-terminal-runs-dots .dot').length, 2);
			assert.ok(el.querySelector('.volt-agent-terminal-status .volt-browser-dock-dots'), 'the row\'s dot loader leads a live chip');

			list[1] = terminal('watch', 'Watch', 'completed');
			change.fire('chat');
			assert.strictEqual(el.querySelector('.volt-agent-terminal-runs-label')?.textContent, '1 terminal running');

			change.fire('another chat');
			assert.strictEqual(changes, 3, 'other chats do not redraw it');

			list.length = 0;
			change.fire('chat');
			assert.strictEqual(view.visible, false);
		});
	});
});
