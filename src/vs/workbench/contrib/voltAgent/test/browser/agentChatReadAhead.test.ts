/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DeferredPromise, timeout } from '../../../../../base/common/async.js';
import { runWithFakedTimers } from '../../../../../base/test/common/timeTravelScheduler.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { Event } from '../../../../../base/common/event.js';
import { URI } from '../../../../../base/common/uri.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IAgentHistoryService } from '../../../../services/voltRuntime/common/history/agentHistory.js';
import { IAgentRuntimeService } from '../../../../services/voltRuntime/common/runtime.js';
import { ChatReadAhead } from '../../browser/editor/agentChatReadAhead.js';
import { AgentEditorInput, setAgentSessionControlFactory } from '../../browser/editor/agentEditorInput.js';
import { IAgentSessionControl } from '../../browser/editor/agentSessionController.js';
import type { IAgentMessage } from '../../browser/editor/agentEditor.js';
import { estimateMessageTokens, hasManyUncountedMessages, IContextUsageMessage } from '../../browser/context/agentContextUsage.js';

suite('agentChatReadAhead', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	function rig(options = { dwellMs: 40, keepMs: 30_000, max: 2 }, live: ReadonlySet<string> = new Set()) {
		const started: string[] = [];
		const dropped: string[] = [];
		const loads = new Map<string, DeferredPromise<void>>();
		const readAhead = new ChatReadAhead<string>(
			id => {
				if (live.has(id)) {
					return undefined;
				}
				started.push(id);
				loads.set(id, new DeferredPromise<void>());
				return id;
			},
			id => loads.get(id)!.p,
			id => dropped.push(id),
			options,
		);
		return { readAhead, started, dropped, loads };
	}

	test('reads a chat once the pointer has rested on it, and the open takes it', () => runWithFakedTimers({ useFakeTimers: true }, async () => {
		const { readAhead, started, dropped } = rig();
		readAhead.intend('a');
		readAhead.intend('a');
		await timeout(39);
		assert.deepStrictEqual(started, [], 'not before the dwell');
		await timeout(1);
		assert.deepStrictEqual(started, ['a'], 'one read, however often the pointer reports the same row');
		assert.strictEqual(readAhead.take('a'), 'a');
		assert.strictEqual(readAhead.take('a'), undefined, 'taken once');
		await timeout(60_000);
		assert.deepStrictEqual(dropped, [], 'a taken chat is the opener\'s, never let go here');
		readAhead.dispose();
	}));

	test('a pointer passing over rows reads none of them', () => runWithFakedTimers({ useFakeTimers: true }, async () => {
		const { readAhead, started } = rig();
		readAhead.intend('a');
		await timeout(20);
		readAhead.intend('b');
		await timeout(20);
		readAhead.cancel();
		await timeout(100);
		assert.deepStrictEqual(started, []);
		readAhead.dispose();
	}));

	test('one read at a time: the latest chat asked for goes next', () => runWithFakedTimers({ useFakeTimers: true }, async () => {
		const { readAhead, started, loads } = rig({ dwellMs: 0, keepMs: 30_000, max: 3 });
		readAhead.intend('a');
		await timeout(0);
		readAhead.intend('b');
		await timeout(0);
		readAhead.intend('c');
		await timeout(0);
		assert.deepStrictEqual(started, ['a'], 'b and c wait for a');
		loads.get('a')!.complete();
		await timeout(0);
		assert.deepStrictEqual(started, ['a', 'c'], 'b was passed over by c');
		loads.get('c')!.error(new Error('gone'));
		await timeout(0);
		readAhead.intend('b');
		await timeout(0);
		assert.deepStrictEqual(started, ['a', 'c', 'b'], 'a failed read does not stop the next');
		readAhead.dispose();
	}));

	test('a chat not opened is let go after a while; the oldest goes past the cap', () => runWithFakedTimers({ useFakeTimers: true }, async () => {
		const { readAhead, dropped, loads } = rig({ dwellMs: 0, keepMs: 1_000, max: 2 });
		for (const id of ['a', 'b', 'c']) {
			readAhead.intend(id);
			await timeout(0);
			loads.get(id)!.complete();
			await timeout(0);
		}
		assert.deepStrictEqual(dropped, ['a'], 'two kept at most');
		await timeout(500);
		readAhead.intend('b');
		await timeout(600);
		assert.deepStrictEqual(dropped, ['a', 'c'], 'pointing at b again kept it');
		await timeout(500);
		assert.deepStrictEqual(dropped, ['a', 'c', 'b']);
		assert.strictEqual(readAhead.has('b'), false);
		readAhead.dispose();
	}));

	test('an open chat is not read again; dispose lets every kept chat go', () => runWithFakedTimers({ useFakeTimers: true }, async () => {
		const { readAhead, started, dropped } = rig({ dwellMs: 0, keepMs: 30_000, max: 2 }, new Set(['open']));
		readAhead.intend('open');
		await timeout(0);
		readAhead.intend('x');
		await timeout(0);
		assert.deepStrictEqual(started, ['x']);
		readAhead.dispose();
		assert.deepStrictEqual(dropped, ['x']);
		readAhead.intend('y');
		await timeout(10);
		assert.deepStrictEqual(started, ['x'], 'nothing after dispose');
	}));

	test('a chat whose messages were never counted is counted after its first frame', () => {
		const message = (text: string): IContextUsageMessage => ({ kind: 'user', text });
		const chat = Array.from({ length: 5 }, (_, i) => message(`prompt ${i}`));
		assert.strictEqual(hasManyUncountedMessages(chat, 5), true);
		assert.strictEqual(hasManyUncountedMessages(chat, 6), false);
		for (const m of chat.slice(0, 3)) {
			estimateMessageTokens(m);
		}
		assert.strictEqual(hasManyUncountedMessages(chat, 3), false, 'counted messages are cached');
		const streaming: IContextUsageMessage = { kind: 'agent', text: 'so far', activity: { streaming: true } };
		estimateMessageTokens(streaming);
		assert.strictEqual(hasManyUncountedMessages([streaming], 1), true, 'a streaming reply is always counted afresh');
	});
});

suite('AgentEditorInput read-ahead', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	/** A window that runs its chats in the agent server: each input's controller loads through `loadTranscript`. */
	function serverWindow() {
		const history = { get: () => undefined, has: () => false, onDidChange: Event.None, whenReady: Promise.resolve() } as unknown as IAgentHistoryService;
		const controls: { host: unknown; load: DeferredPromise<IAgentMessage[]>; disposed: boolean }[] = [];
		const instantiation = {
			createInstance: (_ctor: unknown, uri: URI) => new AgentEditorInput(uri, history, {} as IAgentRuntimeService, instantiation),
		} as unknown as IInstantiationService;
		setAgentSessionControlFactory(input => {
			const control = { host: input as unknown, load: new DeferredPromise<IAgentMessage[]>(), disposed: false };
			controls.push(control);
			return {
				onDidChange: Event.None,
				onDidBecomeIdle: Event.None,
				get isRunning() { return false; },
				setHost: (host: unknown) => { control.host = host; },
				loadTranscript: async () => ({ messages: await control.load.p, contextUsed: 7 }),
				dispose: () => { control.disposed = true; },
			} as unknown as IAgentSessionControl;
		});
		return { instantiation, controls };
	}

	teardown(() => {
		AgentEditorInput.resetReadAhead();
		setAgentSessionControlFactory(undefined);
	});

	test('the input that opens a chat takes the read-ahead one over, its transcript and controller', () => runWithFakedTimers({ useFakeTimers: true }, async () => {
		const { instantiation, controls } = serverWindow();
		AgentEditorInput.readAhead('chat-a', instantiation);
		await timeout(40);
		assert.strictEqual(controls.length, 1, 'read once the pointer rested on the row');
		const opened = store.add(instantiation.createInstance(AgentEditorInput, AgentEditorInput.uriForSession('chat-a')));
		assert.strictEqual(controls.length, 1, 'the open made no second controller');
		assert.strictEqual(controls[0].host, opened, 'the controller reports to the opener now');
		const message: IAgentMessage = { kind: 'user', text: 'hello' } as IAgentMessage;
		controls[0].load.complete([message]);
		await opened.ensureLoaded();
		assert.deepStrictEqual(opened.messages, [message]);
		assert.strictEqual(opened.contextUsed, 7);
		await timeout(0);
		assert.strictEqual(controls[0].disposed, false, 'the read-ahead input let go without closing the chat');
	}));

	test('a chat read ahead and never opened is let go, its controller closed', () => runWithFakedTimers({ useFakeTimers: true }, async () => {
		const { instantiation, controls } = serverWindow();
		AgentEditorInput.readAhead('chat-b', instantiation);
		await timeout(40);
		controls[0].load.complete([]);
		await timeout(30_000);
		assert.strictEqual(controls[0].disposed, true);
	}));

	test('a window that reads history itself reads nothing ahead here', () => runWithFakedTimers({ useFakeTimers: true }, async () => {
		let made = 0;
		AgentEditorInput.readAhead('chat-c', { createInstance: () => { made++; } } as unknown as IInstantiationService);
		await timeout(100);
		assert.strictEqual(made, 0);
	}));
});
