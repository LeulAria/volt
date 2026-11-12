/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Emitter } from '../../../../../base/common/event.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ReplicatedCollection } from '../../../../../platform/voltAgentServer/common/collections.js';
import { IWebSocketLike } from '../../../../../platform/voltAgentServer/common/connection.js';
import { AgentServerProtocol, IServerSocket } from '../../../../../platform/voltAgentServer/common/protocolServer.js';
import { AgentServerClient } from '../../common/agentServerClient.js';

const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));

async function until(condition: () => boolean, what: string): Promise<void> {
	const start = Date.now();
	while (!condition()) {
		if (Date.now() - start > 2000) {
			throw new Error(`timed out waiting for ${what}`);
		}
		await tick();
	}
}

/** One end of an in-memory socket pair: frames cross after a microtask, like a network. */
class FakeSocket implements IWebSocketLike {
	readyState = 0;
	onopen: ((ev: unknown) => void) | null = null;
	onmessage: ((ev: { readonly data: unknown }) => void) | null = null;
	onclose: ((ev: { readonly code: number; readonly reason: string }) => void) | null = null;
	onerror: ((ev: unknown) => void) | null = null;
	private readonly toServer = new Emitter<string>();
	private readonly serverClosed = new Emitter<void>();
	readonly server: IServerSocket = {
		send: text => queueMicrotask(() => this.readyState === 1 && this.onmessage?.({ data: text })),
		close: (code, reason) => this.close(code, reason),
		bufferedAmount: 0,
		onMessage: this.toServer.event,
		onClose: this.serverClosed.event,
	};

	send(data: string): void {
		queueMicrotask(() => this.toServer.fire(data));
	}

	close(code = 1000, reason = ''): void {
		if (this.readyState === 3) {
			return;
		}
		this.readyState = 3;
		queueMicrotask(() => {
			this.serverClosed.fire();
			this.toServer.dispose();
			this.serverClosed.dispose();
			this.onclose?.({ code, reason });
		});
	}
}

suite('Agent server client', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('every connection, a resumed one too, is announced: the server forgot the window\'s tools with the old socket', async () => {
		const protocol = store.add(new AgentServerProtocol({
			token: 'secret',
			epoch: 'e1',
			serverVersion: 'test',
			pid: 1,
			snapshot: () => ({ collections: { threads: threads.snapshot() } }),
			logLimits: { maxEvents: 1000, maxBytes: Number.MAX_SAFE_INTEGER },
		}));
		const threads = new ReplicatedCollection('threads', delta => protocol.publish('col', delta));
		const sockets: FakeSocket[] = [];
		const client = store.add(new AgentServerClient({
			endpoint: async () => ({ url: 'ws://test/ws', token: 'secret' }),
			createSocket: () => {
				const socket = new FakeSocket();
				sockets.push(socket);
				queueMicrotask(() => {
					socket.readyState = 1;
					protocol.accept(socket.server);
					socket.onopen?.({});
				});
				return socket;
			},
			client: { kind: 'test', id: 'w1' },
			backoff: { initialMs: 1, maxMs: 4, stableMs: 1_000_000 },
		}));
		let resyncs = 0;
		let connects = 0;
		store.add(client.onDidResync(() => resyncs++));
		store.add(client.onDidConnect(() => {
			assert.ok(client.isReady, 'the mirror is loaded first');
			connects++;
		}));
		client.connection.connect();
		await until(() => connects === 1, 'first connection');
		assert.strictEqual(resyncs, 1);

		threads.update({ a: 1 });
		await until(() => client.mirror.get('threads', 'a') === 1, 'an event');
		sockets[0].close(1006, 'network');
		await until(() => !client.connection.isOpen, 'drop');
		threads.update({ b: 2 });
		await until(() => connects === 2, 'the resumed connection');

		assert.strictEqual(resyncs, 1, 'a resumed connection brings no snapshot');
		assert.strictEqual(client.mirror.get('threads', 'b'), 2);
		assert.strictEqual(protocol.listClients().length, 1);
	});
});
