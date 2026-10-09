/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Emitter } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ISessionPatch, ISessionState, SessionPatcher, SessionTopicData } from '../../../../../platform/voltAgentServer/common/sessionPatch.js';
import { IAgentServerClientService, IAgentServerResync } from '../../../../services/voltAgentServer/common/agentServerClient.js';
import type { IAgentAssistantMessage, IAgentMessage } from '../../browser/editor/agentEditor.js';
import { IAgentSessionChange } from '../../browser/editor/agentSessionController.js';
import { RemoteAgentSessionControl } from '../../browser/editor/remoteAgentSessionControl.js';

function reply(id: string, text: string, streaming = true): IAgentAssistantMessage {
	return {
		kind: 'agent', id, title: '', steps: [], blockState: {}, startedAt: 1,
		segments: [{ kind: 'text', text }],
		activity: { status: 'Thinking', expanded: false, streaming, items: [] },
	} as unknown as IAgentAssistantMessage;
}

/** The server side of one chat as a test sees it: its messages, a patcher, and a client. */
class FakeServer {
	messages: IAgentMessage[] = [{ kind: 'user', id: 't1', text: 'hi' } as IAgentMessage];
	readonly patcher = new SessionPatcher('s1');
	readonly calls: { method: string; args: unknown[] }[] = [];
	readonly onSessionEvent = new Emitter<SessionTopicData>();
	readonly onDidResync = new Emitter<IAgentServerResync>();
	/** Patches published while the next `session.open` is in flight. */
	duringOpen: (() => void) | undefined;

	constructor() {
		this.patcher.reset(this.json());
	}

	json(): unknown[] {
		return JSON.parse(JSON.stringify(this.messages));
	}

	/** The server changed its messages: publish what changed. */
	publish(): ISessionPatch | undefined {
		const patch = this.patcher.diff(this.json());
		if (patch) {
			this.onSessionEvent.fire({ type: 'patch', ...patch });
		}
		return patch;
	}

	client(): IAgentServerClientService {
		return {
			whenReady: Promise.resolve(),
			isReady: true,
			onSessionEvent: this.onSessionEvent.event,
			onDidResync: this.onDidResync.event,
			call: async (method: string, ...args: unknown[]) => {
				this.calls.push({ method, args });
				if (method === 'session.open') {
					const state: ISessionState = { id: 's1', rev: this.patcher.rev, messages: this.json(), running: true };
					const during = this.duringOpen;
					this.duringOpen = undefined;
					during?.();
					return state;
				}
				return undefined;
			},
			send: (method: string, ...args: unknown[]) => void this.calls.push({ method, args }),
		} as unknown as IAgentServerClientService;
	}

	dispose(): void {
		this.onSessionEvent.dispose();
		this.onDidResync.dispose();
	}
}

suite('RemoteAgentSessionControl', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function setUp(disposables: Pick<DisposableStore, 'add'>) {
		const server = new FakeServer();
		disposables.add({ dispose: () => server.dispose() });
		const host = { sessionId: 's1', messages: [] as IAgentMessage[], contextUsed: undefined as number | undefined, contextWindow: undefined as number | undefined, recordAssistant: () => { } };
		const control = disposables.add(new RemoteAgentSessionControl(host as never, server.client()));
		const changes: IAgentSessionChange['kind'][] = [];
		disposables.add(control.onDidChange(change => changes.push(change.kind)));
		return { server, host, control, changes };
	}

	test('loads the transcript into the input and applies patches that raced the open', async () => {
		const { server, host, control } = setUp(store);
		server.duringOpen = () => {
			// The answer is computed, then a patch goes out before the client has it.
			server.messages.push(reply('t1', 'Hel'));
			server.publish();
		};
		await control.loadTranscript();
		assert.deepStrictEqual(host.messages.map(m => m.kind), ['user', 'agent']);
		assert.strictEqual((host.messages[1] as IAgentAssistantMessage).segments[0].kind, 'text');
	});

	test('patches apply in place: untouched messages and objects keep their identity', async () => {
		const { server, host, control, changes } = setUp(store);
		server.messages.push(reply('t1', 'He'));
		server.patcher.reset(server.json());
		await control.loadTranscript();
		const user = host.messages[0];
		const agent = host.messages[1] as IAgentAssistantMessage;
		const segments = agent.segments;
		(server.messages[1] as IAgentAssistantMessage).segments = [{ kind: 'text', text: 'Hello' }];
		server.publish();
		assert.strictEqual(host.messages[0], user);
		assert.strictEqual(host.messages[1], agent);
		assert.strictEqual(agent.segments, segments);
		assert.deepStrictEqual(agent.segments[0], { kind: 'text', text: 'Hello' });
		assert.deepStrictEqual(changes, ['render']);
	});

	test('a missed patch reopens the chat and catches up', async () => {
		const { server, host, control } = setUp(store);
		await control.loadTranscript();
		server.messages.push(reply('t1', 'one'));
		server.patcher.diff(server.json()); // lost on the way
		(server.messages[1] as IAgentAssistantMessage).segments = [{ kind: 'text', text: 'two' }];
		server.publish();
		await new Promise(resolve => setTimeout(resolve, 0));
		assert.strictEqual(server.calls.filter(c => c.method === 'session.open').length, 2);
		assert.deepStrictEqual((host.messages[1] as IAgentAssistantMessage).segments, [{ kind: 'text', text: 'two' }]);
	});

	test('a resync (the server restarted) reopens the chat', async () => {
		const { server, host, control, changes } = setUp(store);
		server.messages.push(reply('t1', 'partial'));
		server.patcher.reset(server.json());
		await control.loadTranscript();
		// After the restart the reply was settled from history.
		server.messages[1] = reply('t1', 'partial', false);
		server.onDidResync.fire({ newEpoch: true });
		await new Promise(resolve => setTimeout(resolve, 0));
		assert.strictEqual((host.messages[1] as IAgentAssistantMessage).activity?.streaming, false);
		assert.ok(changes.includes('runEnd'), 'the view learns the run is over');
	});

	test('what the reader opened stays open when the reply streams on', async () => {
		const { server, host, control } = setUp(store);
		const agent = reply('t1', 'x');
		agent.segments.push({ kind: 'block', block: { type: 'tool', id: 'b1', expanded: false } } as never);
		server.messages.push(agent);
		server.patcher.reset(server.json());
		await control.loadTranscript();
		const local = host.messages[1] as IAgentAssistantMessage;
		local.blockState['b1'] = { expanded: true };
		(local.segments[1] as { block: { expanded: boolean } }).block.expanded = true;
		(server.messages[1] as IAgentAssistantMessage).segments[0] = { kind: 'text', text: 'xy' };
		server.publish();
		assert.deepStrictEqual(local.blockState['b1'], { expanded: true });
		assert.strictEqual((local.segments[1] as { block: { expanded: boolean } }).block.expanded, true);
	});

	test('a view\'s own change to the transcript goes to the server; lifecycle events pass through', async () => {
		const { server, host, control, changes } = setUp(store);
		server.messages.push(reply('t1', 'working'));
		server.patcher.reset(server.json());
		await control.loadTranscript();
		let idle = 0;
		store.add(control.onDidBecomeIdle(() => idle++));
		assert.ok(control.isRunning);
		const stopped = host.messages[1] as IAgentAssistantMessage;
		control.forwardRecord({ kind: 'assistant', message: stopped, final: true, status: 'cancelled' });
		control.forwardRecord({ kind: 'truncate', messageId: 't1' });
		await new Promise(resolve => setTimeout(resolve, 0));
		assert.deepStrictEqual(server.calls.filter(c => c.method !== 'session.open').map(c => [c.method, c.args[0]]), [['session.recordAssistant', 's1'], ['session.truncate', 's1']]);
		server.onSessionEvent.fire({ type: 'change', id: 's1', change: { kind: 'runEnd', aborted: true } });
		server.onSessionEvent.fire({ type: 'idle', id: 's1' });
		server.onSessionEvent.fire({ type: 'idle', id: 'other' });
		assert.deepStrictEqual(changes, ['runEnd']);
		assert.strictEqual(idle, 1);
	});
});
