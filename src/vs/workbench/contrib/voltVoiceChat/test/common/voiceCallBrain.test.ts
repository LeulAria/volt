/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Emitter } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { IVoltVoiceCall } from '../../../../../platform/voltVoiceChat/common/voltVoiceChat.js';
import { IAgentHistoryService } from '../../../../services/voltRuntime/common/history/agentHistory.js';
import { IVoltHostToolService } from '../../../../services/voltRuntime/common/hostTools.js';
import { IAgentOrchestratorService, IOrchChange, IOrchPrompt, IOrchThread, OrchDelivery } from '../../../../services/voltRuntime/common/orchestration/orchestrator.js';
import { IAgentRuntimeService } from '../../../../services/voltRuntime/common/runtime.js';
import { IVoiceBrainHost, IVoiceSource, VoiceCallBrain } from '../../common/voiceCallBrain.js';

interface ISubmit {
	readonly threadId: string;
	readonly prompt: IOrchPrompt;
	readonly delivery: OrchDelivery;
	/** The orchestrator opens the turn under this id. */
	readonly turnId?: string;
}

class Fixture {
	readonly onDidChange = new Emitter<IOrchChange>();
	readonly threads = new Map<string, Partial<IOrchThread>>();
	readonly submits: ISubmit[] = [];
	readonly spoken: string[] = [];
	readonly started: string[] = [];
	readonly chats: string[] = [];
	readonly replies = new Map<string, { turnId: string; prompt: string; reply: string }>();
	record: IVoltVoiceCall | undefined;

	readonly orchestrator = {
		onDidChange: this.onDidChange.event,
		getThread: (id: string) => this.threads.get(id) as IOrchThread | undefined,
		submit: async (threadId: string, prompt: IOrchPrompt, delivery: OrchDelivery, turnId?: string) => {
			this.submits.push({ threadId, prompt, delivery, turnId });
			return { outcome: delivery === 'now' ? 'steered' as const : 'started' as const };
		},
	} as unknown as IAgentOrchestratorService;

	readonly runtime = {
		canSteer: () => true,
		getOrCreateSession: () => ({ messages: [] }),
	} as unknown as IAgentRuntimeService;

	readonly history = {
		get: () => undefined,
		open: (id: string) => ({
			load: async () => {
				const reply = this.replies.get(id);
				return {
					turns: reply ? [{ id: reply.turnId, user: { type: 'user', turn: reply.turnId, at: 1, text: reply.prompt, message: undefined }, assistant: { type: 'agent', turn: reply.turnId, at: 2, final: true, status: 'done', text: reply.reply, message: undefined } }] : [],
				};
			},
		}),
	} as unknown as IAgentHistoryService;

	readonly hostTools = {
		invokeTool: async (name: string) => ({ text: `${name} result` }),
	} as unknown as IVoltHostToolService;

	host(overrides: Partial<IVoiceBrainHost> = {}): IVoiceBrainHost {
		return {
			speak: note => this.spoken.push(note),
			onChat: id => this.chats.push(id),
			onRecord: record => this.record = record,
			save: async () => { },
			earlierCalls: async () => [],
			startChat: async (text: string, _source: IVoiceSource) => {
				this.started.push(text);
				return 'new-chat';
			},
			...overrides,
		};
	}

	brain(store: Pick<DisposableStore, 'add'>, chatId: string | undefined, host = this.host()): VoiceCallBrain {
		return store.add(new VoiceCallBrain('call-1234abcd', chatId, 'xai', 'ara', host, { orchestrator: this.orchestrator, runtime: this.runtime, history: this.history, hostTools: this.hostTools, logService: new NullLogService() }));
	}
}

suite('Volt voice chat: call brain', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();
	let fixture: Fixture;

	setup(() => {
		fixture = new Fixture();
		store.add(fixture.onDidChange);
	});

	test('send_task to an idle chat sends a voice-marked prompt that starts a turn', async () => {
		fixture.threads.set('chat-1', { id: 'chat-1', inputs: [], queue: [], last: { turnId: 'old', kind: 'prompt', outcome: 'done', at: 1 } });
		const brain = fixture.brain(store, 'chat-1');
		const result = await brain.runTool('send_task', JSON.stringify({ request: 'Add subtract to math.js.' }));
		assert.deepStrictEqual(result.output, { receipt: 'under way' });
		assert.ok(result.respond && /sent it/.test(result.instructions ?? ''));
		assert.strictEqual(fixture.submits.length, 1);
		assert.strictEqual(fixture.submits[0].delivery, 'auto');
		assert.deepStrictEqual(fixture.submits[0].prompt.host, { fromThread: { kind: 'voice', id: 'call-1234abcd', title: 'Voice call' } });
		// The card goes after the reply that was last when the call began.
		assert.deepStrictEqual(brain.record.anchors, { 'chat-1': { turnId: 'old' } });
		// The same request again is the same errand.
		const again = await brain.runTool('send_task', JSON.stringify({ request: 'Add subtract to math.js.' }));
		assert.deepStrictEqual(again.output, { receipt: 'already under way' });
		assert.strictEqual(fixture.submits.length, 1);
	});

	test('send_task steers a running turn', async () => {
		fixture.threads.set('chat-1', { id: 'chat-1', inputs: [], queue: [], active: { id: 'turn-1', kind: 'prompt', phase: 'running', at: 1, prompt: { text: 'x' } } });
		const brain = fixture.brain(store, 'chat-1');
		const result = await brain.runTool('send_task', '{"request":"Also add multiply."}');
		assert.deepStrictEqual(result.output, { receipt: 'under way', steered: true });
		assert.strictEqual(fixture.submits[0].delivery, 'now');
	});

	test('send_task refuses an empty or blocked request', async () => {
		fixture.threads.set('chat-1', { id: 'chat-1', inputs: [{ id: 'q', kind: 'question', at: 1 }], queue: [] });
		const brain = fixture.brain(store, 'chat-1');
		assert.deepStrictEqual((await brain.runTool('send_task', '{"request":"  "}')).output, { error: 'Refused: the request was empty.' });
		assert.deepStrictEqual((await brain.runTool('send_task', '{"request":"do it"}')).output, { relay: 'refused', spoken: 'The agent needs the person in the chat. Say that.' });
		assert.match(JSON.stringify((await brain.runTool('send_task', JSON.stringify({ request: 'x'.repeat(2001) }))).output), /exceeds 2000 characters/);
		assert.strictEqual(fixture.submits.length, 0);
	});

	test('the first task on a new chat starts it, and the call moves into it', async () => {
		const brain = fixture.brain(store, undefined);
		const result = await brain.runTool('send_task', '{"request":"Scaffold a CLI."}');
		assert.deepStrictEqual(result.output, { receipt: 'under way' });
		assert.deepStrictEqual(fixture.started, ['Scaffold a CLI.']);
		assert.deepStrictEqual(fixture.chats, ['new-chat']);
		assert.strictEqual(brain.chatId, 'new-chat');
		assert.deepStrictEqual(brain.record.chatIds, ['new-chat']);
	});

	test('no chat to start: the voice is told to say so', async () => {
		const brain = fixture.brain(store, undefined, fixture.host({ startChat: async () => undefined }));
		const result = await brain.runTool('send_task', '{"request":"Scaffold a CLI."}');
		assert.strictEqual((result.output as { relay: string }).relay, 'unreachable');
		assert.strictEqual(brain.chatId, undefined);
	});

	test('when the turn it sent finishes, the voice gets the reply as work_landed', async () => {
		fixture.threads.set('chat-1', { id: 'chat-1', inputs: [], queue: [] });
		const brain = fixture.brain(store, 'chat-1');
		await brain.runTool('send_task', '{"request":"Add subtract."}');
		const turnId = fixture.submits[0].turnId!;
		fixture.threads.set('chat-1', { id: 'chat-1', inputs: [], queue: [], active: { id: turnId, kind: 'prompt', phase: 'running', at: 1, prompt: { text: 'Add subtract.' } } });
		fixture.onDidChange.fire({ threads: ['chat-1'], tasks: [] });
		// No earlier reply when the call began: the card follows this first turn's reply.
		assert.deepStrictEqual(brain.record.anchors?.['chat-1'], { turnId });
		fixture.replies.set('chat-1', { turnId, prompt: 'Add subtract.', reply: 'Looking.\n\nuse_tool\n{"tool_name":"x","tool_input":{}}\n\nAdded subtract(a, b).' });
		fixture.threads.set('chat-1', { id: 'chat-1', inputs: [], queue: [], last: { turnId, kind: 'prompt', outcome: 'done', at: 2 } });
		fixture.onDidChange.fire({ threads: ['chat-1'], tasks: [] });
		for (let i = 0; i < 20 && !fixture.spoken.length; i++) {
			await new Promise(resolve => setTimeout(resolve, 5));
		}
		assert.deepStrictEqual(fixture.spoken, ['work_landed: This answers "Add subtract.": Looking.\n\nAdded subtract(a, b).']);
		assert.strictEqual(brain.record.turns.at(-1)?.role, 'note');
	});

	test('stay_silent is refused right after the caller spoke; end_the_call asks to hang up', async () => {
		const brain = fixture.brain(store, undefined);
		brain.addTurn({ role: 'user', text: 'Hello?' });
		assert.deepStrictEqual(await brain.runTool('stay_silent', '{}'), { output: { error: 'They just talked to you. Answer them.' }, respond: true });
		brain.addTurn({ role: 'assistant', text: 'Hi.' });
		assert.deepStrictEqual(await brain.runTool('stay_silent', '{}'), { output: {}, respond: false });
		assert.deepStrictEqual(await brain.runTool('end_the_call', '{}'), { output: {}, respond: false, end: true });
		assert.deepStrictEqual((await brain.runTool('nope', '{}')).output, { error: 'unknown tool nope' });
		// Caller turns the transcriber split join up.
		brain.addTurn({ role: 'user', text: 'one' });
		brain.addTurn({ role: 'user', text: 'two' });
		assert.strictEqual(brain.record.turns.at(-1)?.text, 'one two');
	});

	test('ending saves the record once as ended', async () => {
		const saved: IVoltVoiceCall[] = [];
		const brain = fixture.brain(store, undefined, fixture.host({ save: async record => { saved.push(record); } }));
		brain.connected();
		await brain.end('ended');
		await brain.end('failed');
		assert.strictEqual(saved.length, 1);
		assert.strictEqual(saved[0].status, 'ended');
		assert.ok(saved[0].endedAt && saved[0].connectedAt);
	});
});
