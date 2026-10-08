/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { toDisposable } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
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

	listCatalog() {
		return [{ kind: 'model', providerId: 'cursor-acp', id: 'composer-2.5', label: 'Composer 2.5' }];
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
			{ stat: () => Promise.reject(new Error('no file service')) } as unknown as IFileService,
		));
		const changes: IAgentSessionChange[] = [];
		store.add(controller.onDidChange(change => changes.push(change)));
		return { runtime, host, controller, records, changes, attention };
	}

	test('the handoff divider names the model the provider reports running', () => {
		const { runtime, host } = setup();
		const user = host.messages[0] as { handoff?: { toLabel: string; by: string; at: number } };
		user.handoff = { toLabel: 'Claude Haiku 4.5', by: 'user', at: 0 };
		runtime.emit({ type: 'run.start', runId: 'run-1', mode: 'agent' });
		runtime.emit({ type: 'model.reported', provider: 'cursor-acp', model: 'composer-2.5' });
		assert.strictEqual(user.handoff?.toLabel, 'Composer 2.5');
		// A later report of the same model leaves the divider alone.
		runtime.emit({ type: 'model.reported', provider: 'cursor-acp', model: 'composer-2.5' });
		assert.strictEqual(user.handoff?.toLabel, 'Composer 2.5');
	});

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

	test('text from a new message of the same run starts a new paragraph', () => {
		const { runtime, host } = setup();
		runtime.emit({ type: 'run.start', runId: 'run-1', mode: 'agent' });
		runtime.emit({ type: 'text.delta', id: 'msg-a', delta: 'Waiting for subagent B' });
		runtime.emit({ type: 'text.delta', id: 'msg-a', delta: ' to finish...' });
		runtime.emit({ type: 'text.delta', id: 'msg-b', delta: 'Both subagents completed.' });
		const reply = host.messages.at(-1) as IAgentAssistantMessage;
		assert.strictEqual(reply.text, 'Waiting for subagent B to finish...\n\nBoth subagents completed.');
		assert.deepStrictEqual(reply.segments.map(segment => segment.kind === 'text' ? segment.text : segment.kind), ['Waiting for subagent B to finish...\n\nBoth subagents completed.']);
	});

	test('a turn starts with no panel: its prompt is recorded first, then the run fills its reply', () => {
		const { runtime, host, controller, changes } = setup();
		const users: string[] = [];
		host.recordUser = message => users.push(message.text);
		runtime.emit({ type: 'run.end', runId: 'run-1', reason: 'done' });
		const reply = controller.beginTurn({ turnId: 'turn-2', text: 'model text', display: { text: 'Check the build' }, mode: 'Agent' });
		assert.deepStrictEqual(users, ['Check the build']);
		assert.deepStrictEqual(changes.at(-1), { kind: 'turnStart', turnId: 'turn-2' });
		const user = host.messages.at(-2);
		assert.ok(user?.kind === 'user' && user.agentText === 'model text' && user.id === 'turn-2');
		runtime.emit({ type: 'run.start', runId: 'run-2', mode: 'agent' }, 'run-2');
		runtime.emit({ type: 'text.delta', id: 't', delta: 'Built.' }, 'run-2');
		assert.strictEqual(reply.text, 'Built.');
		assert.strictEqual(controller.beginTurn({ turnId: 'turn-2', text: 'model text', mode: 'Agent' }), reply, 'a retried start reuses its messages');
	});

	test('a subagent report arrives as a notification card, and a turn that never started is closed', () => {
		const { host, controller, changes, records } = setup();
		controller.beginTurn({ turnId: 'n1', text: '[Volt] Delegated task finished', display: { text: 'Task finished: README' }, mode: 'Agent', origin: 'notification', taskIds: ['t-1'] });
		const user = host.messages.at(-2);
		assert.ok(user?.kind === 'user' && user.origin === 'notification' && user.taskIds?.[0] === 't-1');
		controller.endUnstartedTurn('n1', 'No model is connected');
		const reply = host.messages.at(-1) as IAgentAssistantMessage;
		assert.strictEqual(reply.outcome, 'failed');
		assert.strictEqual(reply.activity?.streaming, false);
		assert.deepStrictEqual(records.at(-1), { final: true, status: 'error' });
		assert.deepStrictEqual(changes.at(-1), { kind: 'runEnd', aborted: false, failed: true });
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

	test('end-of-turn totals do not replace the occupancy the run reported', () => {
		const { runtime, host } = setup();
		runtime.emit({ type: 'run.start', runId: 'run-1', mode: 'agent' });
		runtime.emit({ type: 'usage', input: 0, output: 0, used: 27_930, size: 200_000 });
		runtime.emit({ type: 'usage', input: 60, output: 1_623, cache: 175_841 });
		assert.strictEqual(host.contextUsed, 27_930);
		const last = host.messages.at(-1) as IAgentAssistantMessage;
		assert.strictEqual(last.tokensUsed, 27_930);
		assert.strictEqual(last.tokensCache, 175_841, 'the chips still show the turn totals');
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

	test('the live line returns to the model after the last running tool ends', () => {
		const { runtime, host } = setup();
		runtime.emit({ type: 'run.start', runId: 'run-1', mode: 'agent' });
		runtime.emit({ type: 'tool.start', callId: 'a', name: 'grep', title: 'Search files', input: '{"pattern":"x"}', kind: 'search' });
		runtime.emit({ type: 'tool.start', callId: 'b', name: 'shell', title: 'Run tests', input: '{"command":"npm test"}', kind: 'execute' });
		const reply = host.messages.at(-1) as IAgentAssistantMessage;
		const running = reply.activity!.status;
		runtime.emit({ type: 'tool.end', callId: 'a', result: 'ok' });
		assert.strictEqual(reply.activity!.status, running, 'the command is still running');
		runtime.emit({ type: 'tool.end', callId: 'b', result: 'ok', exitCode: 0 });
		assert.strictEqual(reply.activity!.status, 'Thinking', 'a quiet model after tools can read "Taking longer than expected"');
	});

	test('a failed run keeps the error and run id, and leaves the queue waiting', () => {
		const { runtime, host, changes } = setup();
		runtime.emit({ type: 'run.start', runId: 'run-1', mode: 'agent' });
		runtime.emit({ type: 'text.delta', id: 't', delta: 'Working on it.' });
		runtime.emit({ type: 'error', message: 'Provider returned 529 overloaded', retryable: true });
		runtime.emit({ type: 'run.end', runId: 'run-1', reason: 'fail' });
		const reply = host.messages.at(-1) as IAgentAssistantMessage;
		assert.strictEqual(reply.outcome, 'failed');
		assert.deepStrictEqual(reply.failure, { message: 'Provider returned 529 overloaded', retryable: true });
		assert.strictEqual(reply.runId, 'run-1');
		assert.deepStrictEqual(changes.at(-1), { kind: 'runEnd', aborted: false, failed: true });
	});

	test('a stopped run marks running sub-agents stopped', () => {
		const { runtime, host, changes } = setup();
		runtime.emit({ type: 'run.start', runId: 'run-1', mode: 'agent' });
		runtime.emit({ type: 'tool.start', callId: 'sub', name: 'task', title: 'Task', input: '{"description":"Explore the API"}' });
		runtime.emit({ type: 'tool.progress', callId: 'sub', status: 'Reading server.js' });
		runtime.emit({ type: 'run.end', runId: 'run-1', reason: 'abort' });
		const reply = host.messages.at(-1) as IAgentAssistantMessage;
		assert.strictEqual(reply.outcome, 'stopped');
		assert.strictEqual(reply.cancelled, true);
		const block = reply.segments.find(segment => segment.kind === 'block' && segment.block.type === 'tool');
		assert.ok(block?.kind === 'block' && block.block.type === 'tool' && block.block.stopped === true && block.block.status === 'complete');
		assert.deepStrictEqual(changes.at(-1), { kind: 'runEnd', aborted: true, failed: false });
	});

	test('a loop finding becomes a supervisor tray, not a plain error line', () => {
		const { runtime, host } = setup();
		runtime.emit({ type: 'run.start', runId: 'run-1', mode: 'agent' });
		runtime.emit({ type: 'error', message: 'The same tools were called three times in a row with the same arguments. Trying a different approach.', retryable: true });
		runtime.emit({ type: 'notice', severity: 'warning', title: 'Context window 80% full' });
		const notices = (host.messages.at(-1) as IAgentAssistantMessage).segments.filter(segment => segment.kind === 'notice');
		assert.deepStrictEqual(notices.map(notice => notice.kind === 'notice' ? notice.supervision : 'x'), ['loop', undefined]);
	});

	test('a new turn continues the chat\'s to-do list', () => {
		const { runtime, host, controller } = setup();
		runtime.emit({ type: 'run.start', runId: 'run-1', mode: 'agent' });
		runtime.emit({ type: 'plan', entries: [{ content: 'Lint', status: 'in_progress' }] });
		runtime.emit({ type: 'plan', entries: [{ content: 'Lint', status: 'completed' }] });
		const first = (host.messages.at(-1) as IAgentAssistantMessage).steps[0];
		runtime.emit({ type: 'run.end', runId: 'run-1', reason: 'done' });
		const reply = controller.beginTurn({ turnId: 'turn-2', text: 'Format too', mode: 'Agent' });
		runtime.emit({ type: 'run.start', runId: 'run-2', mode: 'agent' }, 'run-2');
		runtime.emit({ type: 'plan', entries: [{ content: 'Lint', status: 'completed' }, { content: 'Format', status: 'pending' }] }, 'run-2');
		assert.deepStrictEqual(reply.steps[0], first, 'the finished to-do keeps its times');
		const notes = reply.segments.flatMap(segment => segment.kind === 'activity' && segment.item.kind === 'note' ? [segment.item.label] : []);
		assert.deepStrictEqual(notes, ['Added 1 to-do']);
	});

	test('the native plan tool streams into a plan card', () => {
		const { runtime, host } = setup();
		runtime.emit({ type: 'run.start', runId: 'run-1', mode: 'plan' });
		runtime.emit({ type: 'tool.start', callId: 'p', name: 'create_plan', title: 'create_plan', card: 'generic' });
		runtime.emit({ type: 'tool.input.delta', callId: 'p', delta: '{"name":"Fix DELETE",', append: true });
		runtime.emit({ type: 'tool.input.delta', callId: 'p', delta: '"plan":"1. Parse the id"}', append: true });
		const reply = host.messages.at(-1) as IAgentAssistantMessage;
		const blocks = reply.segments.flatMap(segment => segment.kind === 'block' ? [segment.block] : []);
		assert.deepStrictEqual(blocks.map(block => block.type), ['plan']);
		const plan = blocks[0];
		assert.ok(plan.type === 'plan' && plan.name === 'Fix DELETE' && plan.markdown === '1. Parse the id');
		assert.strictEqual(reply.segments.some(segment => segment.kind === 'activity'), false, 'no extra step row for the plan tool');
	});

	test('a new run clears the last run\'s outcome', () => {
		const { runtime, host } = setup();
		const reply = host.messages.at(-1) as IAgentAssistantMessage;
		reply.outcome = 'failed';
		reply.failure = { message: 'old' };
		runtime.emit({ type: 'run.start', runId: 'run-2', mode: 'agent' }, 'run-2');
		assert.strictEqual(reply.outcome, undefined);
		assert.strictEqual(reply.failure, undefined);
		assert.strictEqual(reply.runId, 'run-2');
	});
});
