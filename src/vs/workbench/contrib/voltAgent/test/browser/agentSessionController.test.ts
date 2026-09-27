/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { toDisposable } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { IVoltEvent, IVoltEventEnvelope } from '../../../../services/voltRuntime/common/events.js';
import { AgentSessionAttention, AgentSessionStatus, IAgentHistoryService } from '../../../../services/voltRuntime/common/history/agentHistory.js';
import { IAgentRuntimeService } from '../../../../services/voltRuntime/common/runtime.js';
import { IVoltSessionContextService } from '../../../../services/voltRuntime/common/sessionContext.js';
import type { IAgentAssistantMessage, IAgentMessage } from '../../browser/editor/agentEditor.js';
import { AgentSessionController, IAgentSessionChange, IAgentSessionHost } from '../../browser/editor/agentSessionController.js';
import { IAgentWorkspaceService } from '../../browser/workspace/agentWorkspace.js';

class FakeRuntime {
	private readonly listeners = new Set<(e: IVoltEventEnvelope) => void>();
	private seq = 0;
	status: 'running' | 'done' = 'running';

	onEvent(_sessionId: string, listener: (e: IVoltEventEnvelope) => void) {
		this.listeners.add(listener);
		return toDisposable(() => this.listeners.delete(listener));
	}

	getOrCreateSession() {
		return { activeRun: { status: this.status } };
	}

	emit(event: IVoltEvent, runId = 'run-1'): void {
		const envelope: IVoltEventEnvelope = { seq: ++this.seq, runId, sessionId: 's1', timestamp: Date.now(), event };
		for (const listener of [...this.listeners]) {
			listener(envelope);
		}
	}
}

function streamingReply(): IAgentAssistantMessage {
	return {
		kind: 'agent',
		id: 'turn-1',
		title: '',
		steps: [],
		segments: [],
		blockState: {},
		activity: { status: 'Thinking', expanded: false, streaming: true, items: [] },
	};
}

suite('Agent session controller', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function setup() {
		const runtime = new FakeRuntime();
		const records: { final: boolean; status: AgentSessionStatus }[] = [];
		const attention: { value: AgentSessionAttention | undefined } = { value: undefined };
		const history = {
			get: () => ({ attention: attention.value }),
			setAttention: async (_id: string, value: AgentSessionAttention | undefined) => { attention.value = value; },
		} as unknown as IAgentHistoryService;
		const host: IAgentSessionHost = {
			sessionId: 's1',
			messages: [{ kind: 'user', id: 'turn-1', text: 'hi' }, streamingReply()] as IAgentMessage[],
			recordAssistant: (_message, final, status) => records.push({ final, status }),
		};
		const controller = store.add(new AgentSessionController(
			host,
			runtime as unknown as IAgentRuntimeService,
			{ rootFor: () => undefined } as unknown as IVoltSessionContextService,
			{ getWorkspace: () => ({ folders: [] }) } as unknown as IWorkspaceContextService,
			{ openSurface: () => undefined } as unknown as IAgentWorkspaceService,
			history,
		));
		const changes: IAgentSessionChange[] = [];
		store.add(controller.onDidChange(change => changes.push(change)));
		return { runtime, host, controller, records, changes, attention };
	}

	test('an approval request needs attention until every approval is answered', () => {
		const { runtime, attention } = setup();
		runtime.emit({ type: 'run.start', runId: 'run-1', mode: 'agent' });
		const request = (id: string) => ({ id, action: 'shell', resource: { kind: 'command', value: 'rm -rf build' }, risk: 'high', reason: 'deletes files' });
		runtime.emit({ type: 'access.ask', request: request('a') } as unknown as IVoltEvent);
		runtime.emit({ type: 'access.ask', request: request('b') } as unknown as IVoltEvent);
		assert.strictEqual(attention.value, 'approval');
		runtime.emit({ type: 'access.resolved', requestId: 'a', effect: 'allow', scope: 'once' });
		assert.strictEqual(attention.value, 'approval', 'one approval is still open');
		runtime.emit({ type: 'access.resolved', requestId: 'b', effect: 'deny', scope: 'once' });
		assert.strictEqual(attention.value, undefined);
	});

	test('a clarifying question needs attention', () => {
		const { runtime, attention } = setup();
		runtime.emit({ type: 'run.start', runId: 'run-1', mode: 'agent' });
		runtime.emit({ type: 'clarify', question: 'Which database?', reasons: [] });
		assert.strictEqual(attention.value, 'question');
	});

	test('reduces a run with no panel attached and records the final reply', () => {
		const { runtime, host, controller, records } = setup();
		runtime.emit({ type: 'run.start', runId: 'run-1', mode: 'agent' });
		runtime.emit({ type: 'text.delta', id: 't', delta: 'Done.' });
		assert.strictEqual(controller.isRunning, true);
		runtime.status = 'done';
		runtime.emit({ type: 'run.end', runId: 'run-1', reason: 'done' });

		const reply = host.messages.at(-1) as IAgentAssistantMessage;
		assert.strictEqual(reply.text, 'Done.');
		assert.strictEqual(reply.activity?.streaming, false);
		assert.deepStrictEqual(records.at(-1), { final: true, status: 'done' });
		assert.strictEqual(controller.isRunning, false);
	});

	test('a finished run leaves its queue for the next panel, once', () => {
		const { runtime, controller, changes } = setup();
		runtime.emit({ type: 'run.start', runId: 'run-1', mode: 'agent' });
		runtime.emit({ type: 'run.end', runId: 'run-1', reason: 'done' });
		assert.deepStrictEqual(changes.at(-1), { kind: 'runEnd', aborted: false });
		assert.strictEqual(controller.consumePendingDrain(), true);
		assert.strictEqual(controller.consumePendingDrain(), false);
	});

	test('usage lands on the host even when no panel is listening', () => {
		const { runtime, host } = setup();
		runtime.emit({ type: 'run.start', runId: 'run-1', mode: 'agent' });
		runtime.emit({ type: 'usage', input: 10, output: 5, size: 200_000 });
		assert.strictEqual(host.contextUsed, 15);
		assert.strictEqual(host.contextWindow, 200_000);
	});

	test('usage without used includes cache in session occupancy', () => {
		const { runtime, host } = setup();
		runtime.emit({ type: 'run.start', runId: 'run-1', mode: 'agent' });
		runtime.emit({ type: 'usage', input: 2, output: 3, cache: 16_800 });
		assert.strictEqual(host.contextUsed, 16_805);
		const last = host.messages.at(-1) as IAgentAssistantMessage;
		assert.strictEqual(last.tokensUsed, 16_805);
		assert.strictEqual(last.tokensIn, 2);
		assert.strictEqual(last.tokensOut, 3);
		assert.strictEqual(last.tokensCache, 16_800);
	});

	test('events from another run are ignored', () => {
		const { runtime, host } = setup();
		runtime.emit({ type: 'run.start', runId: 'run-1', mode: 'agent' });
		runtime.emit({ type: 'text.delta', id: 't', delta: 'stale' }, 'run-0');
		assert.strictEqual((host.messages.at(-1) as IAgentAssistantMessage).text, undefined);
	});

	test('a new host takes over the live transcript', () => {
		const { runtime, host, controller } = setup();
		runtime.emit({ type: 'run.start', runId: 'run-1', mode: 'agent' });
		const next: IAgentSessionHost = { ...host, messages: host.messages, recordAssistant: () => undefined };
		controller.setHost(next);
		runtime.emit({ type: 'text.delta', id: 't', delta: 'after' });
		assert.strictEqual((next.messages.at(-1) as IAgentAssistantMessage).text, 'after');
	});
});
