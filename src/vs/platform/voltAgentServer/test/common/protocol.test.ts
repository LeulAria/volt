/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Emitter } from '../../../../base/common/event.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { CollectionMirror, ReplicatedCollection } from '../../common/collections.js';
import { AgentServerConnection, backoffDelay, DEFAULT_BACKOFF, IAgentServerWelcomeEvent, IWebSocketLike } from '../../common/connection.js';
import { AgentServerCloseCode, AgentServerTopic, IAgentServerEvent, ICollectionDelta } from '../../common/protocol.js';
import { AgentServerProtocol, IServerSocket, tokensEqual } from '../../common/protocolServer.js';

const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));

async function until(condition: () => boolean, what: string, ms = 2000): Promise<void> {
	const start = Date.now();
	while (!condition()) {
		if (Date.now() - start > ms) {
			throw new Error(`timed out waiting for ${what}`);
		}
		await tick();
	}
}

/** A server-side socket whose frames land in its client twin after a microtask, like a network. */
class FakeServerSocket implements IServerSocket {
	private readonly _onMessage = new Emitter<string>();
	readonly onMessage = this._onMessage.event;
	private readonly _onClose = new Emitter<void>();
	readonly onClose = this._onClose.event;
	bufferedAmount = 0;
	closed = false;
	/** Drops server → client frames that match (to simulate a lost frame). */
	dropIf: ((text: string) => boolean) | undefined;

	constructor(readonly client: FakeClientSocket) { }

	send(text: string): void {
		if (this.closed || this.dropIf?.(text)) {
			return;
		}
		queueMicrotask(() => this.client.deliver(text));
	}

	close(code: number, reason: string): void {
		this.client.remoteClose(code, reason);
	}

	receive(text: string): void {
		if (!this.closed) {
			this._onMessage.fire(text);
		}
	}

	finish(): void {
		if (!this.closed) {
			this.closed = true;
			this._onClose.fire();
			this._onMessage.dispose();
			this._onClose.dispose();
		}
	}
}

class FakeClientSocket implements IWebSocketLike {
	readyState = 0;
	onopen: ((ev: unknown) => void) | null = null;
	onmessage: ((ev: { readonly data: unknown }) => void) | null = null;
	onclose: ((ev: { readonly code: number; readonly reason: string }) => void) | null = null;
	onerror: ((ev: unknown) => void) | null = null;
	readonly server = new FakeServerSocket(this);
	readonly sent: string[] = [];

	send(data: string): void {
		this.sent.push(data);
		queueMicrotask(() => this.server.receive(data));
	}

	close(code = 1000, reason = ''): void {
		this.remoteClose(code, reason);
	}

	deliver(text: string): void {
		if (this.readyState === 1) {
			this.onmessage?.({ data: text });
		}
	}

	remoteClose(code: number, reason: string): void {
		if (this.readyState === 3) {
			return;
		}
		this.readyState = 3;
		queueMicrotask(() => {
			this.server.finish();
			this.onclose?.({ code, reason });
		});
	}
}

/** Routes new sockets to whichever protocol instance is "listening" (swap it to simulate a restart). */
class FakeNetwork {
	server: AgentServerProtocol | undefined;
	readonly sockets: FakeClientSocket[] = [];

	createSocket = (_url: string): IWebSocketLike => {
		const socket = new FakeClientSocket();
		this.sockets.push(socket);
		const server = this.server;
		queueMicrotask(() => {
			if (!server || server !== this.server) {
				socket.remoteClose(1006, 'connection refused');
				return;
			}
			socket.readyState = 1;
			server.accept(socket.server);
			socket.onopen?.({});
		});
		return socket;
	};

	get live(): FakeClientSocket {
		return this.sockets[this.sockets.length - 1];
	}
}

suite('Agent server protocol', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	interface IServer {
		readonly protocol: AgentServerProtocol;
		readonly threads: ReplicatedCollection;
	}

	function startServer(disposables: Pick<DisposableStore, 'add'>, network: FakeNetwork, epoch: string, opts: { maxEvents?: number; token?: string } = {}): IServer {
		const cols = new Map<string, ReplicatedCollection>();
		const protocol = disposables.add(new AgentServerProtocol({
			token: opts.token ?? 'secret',
			epoch,
			serverVersion: 'test',
			pid: 1,
			snapshot: () => ({ collections: Object.fromEntries([...cols].map(([name, col]) => [name, col.snapshot()])) }),
			logLimits: { maxEvents: opts.maxEvents ?? 1000, maxBytes: Number.MAX_SAFE_INTEGER },
		}));
		const threads = new ReplicatedCollection('threads', delta => protocol.publish('col', delta));
		cols.set('threads', threads);
		network.server = protocol;
		return { protocol, threads };
	}

	interface IClient {
		readonly connection: AgentServerConnection;
		readonly mirror: CollectionMirror;
		readonly welcomes: IAgentServerWelcomeEvent[];
		readonly events: IAgentServerEvent[];
	}

	function connectClient(disposables: Pick<DisposableStore, 'add'>, network: FakeNetwork, opts: { token?: string; topics?: AgentServerTopic[] } = {}): IClient {
		const connection = disposables.add(new AgentServerConnection({
			endpoint: async () => ({ url: 'ws://test/ws', token: opts.token ?? 'secret' }),
			createSocket: network.createSocket,
			client: { kind: 'test', id: 'c1', capabilities: ['browser'], topics: opts.topics },
			backoff: { initialMs: 1, maxMs: 4, stableMs: 1_000_000 },
		}));
		const mirror = new CollectionMirror();
		disposables.add({ dispose: () => mirror.dispose() });
		const welcomes: IAgentServerWelcomeEvent[] = [];
		const events: IAgentServerEvent[] = [];
		disposables.add(connection.onDidWelcome(w => {
			welcomes.push(w);
			if (w.snapshot) {
				mirror.applySnapshot(w.snapshot.collections);
			}
		}));
		disposables.add(connection.onEvent(e => {
			events.push(e);
			if (e.topic === 'col') {
				mirror.applyDelta(e.data as ICollectionDelta);
			}
		}));
		connection.connect();
		return { connection, mirror, welcomes, events };
	}

	test('first connection loads a snapshot, then follows events in order', async () => {
		const network = new FakeNetwork();
		const server = startServer(store, network, 'e1');
		server.threads.update({ t1: { title: 'one' } });
		const client = connectClient(store, network);
		await until(() => client.connection.isOpen, 'open');
		assert.deepStrictEqual(client.welcomes.map(w => [w.resumed, w.newEpoch, w.seq]), [[false, true, 1]]);
		assert.deepStrictEqual(client.mirror.get('threads', 't1'), { title: 'one' });

		server.threads.update({ t2: { title: 'two' } });
		server.threads.update({ t1: undefined });
		await until(() => client.events.length === 2, 'events');
		assert.deepStrictEqual(client.events.map(e => e.seq), [2, 3]);
		assert.deepStrictEqual(client.mirror.entries('threads'), [['t2', { title: 'two' }]]);
	});

	test('a dropped client resumes and receives exactly the events it missed', async () => {
		const network = new FakeNetwork();
		const server = startServer(store, network, 'e1');
		const client = connectClient(store, network);
		await until(() => client.connection.isOpen, 'open');
		server.threads.update({ a: 1 });
		await until(() => client.events.length === 1, 'first event');

		network.live.close(1006, 'network');
		await until(() => !client.connection.isOpen, 'drop');
		server.threads.update({ b: 2 });
		server.threads.update({ c: 3 });
		await until(() => client.connection.isOpen && client.events.length === 3, 'replay');

		assert.deepStrictEqual(client.welcomes.map(w => [w.resumed, w.newEpoch]), [[false, true], [true, false]]);
		assert.deepStrictEqual(client.events.map(e => e.seq), [1, 2, 3]);
		assert.deepStrictEqual(client.mirror.entries('threads'), [['a', 1], ['b', 2], ['c', 3]]);
		const hello = JSON.parse(network.live.sent[0]);
		assert.deepStrictEqual(hello.resume, { epoch: 'e1', seq: 1 });
	});

	test('a client that fell behind the buffer reloads a snapshot instead', async () => {
		const network = new FakeNetwork();
		const server = startServer(store, network, 'e1', { maxEvents: 2 });
		const client = connectClient(store, network);
		await until(() => client.connection.isOpen, 'open');
		network.live.close(1006, 'network');
		await until(() => !client.connection.isOpen, 'drop');
		for (let i = 0; i < 5; i++) {
			server.threads.update({ [`k${i}`]: i });
		}
		await until(() => client.welcomes.length === 2, 'second welcome');
		assert.strictEqual(client.welcomes[1].resumed, false);
		assert.strictEqual(client.welcomes[1].newEpoch, false);
		assert.strictEqual(client.connection.seq, 5);
		assert.deepStrictEqual(client.mirror.values('threads'), [0, 1, 2, 3, 4]);
		server.threads.update({ k5: 5 });
		await until(() => client.mirror.has('threads', 'k5'), 'live after snapshot');
	});

	test('a server restart (new epoch) makes clients reload everything', async () => {
		const network = new FakeNetwork();
		const first = startServer(store, network, 'boot-1');
		first.threads.update({ old: true });
		const client = connectClient(store, network);
		await until(() => client.connection.isOpen, 'open');

		const restartStore = store.add(new DisposableStore());
		first.protocol.dispose();
		network.server = undefined;
		await until(() => !client.connection.isOpen, 'drop');
		const second = startServer(restartStore, network, 'boot-2');
		second.threads.update({ fresh: true });
		await until(() => client.connection.isOpen, 'reopen');

		const last = client.welcomes[client.welcomes.length - 1];
		assert.deepStrictEqual([last.epoch, last.resumed, last.newEpoch], ['boot-2', false, true]);
		assert.deepStrictEqual(client.mirror.entries('threads'), [['fresh', true]]);
	});

	test('skipped topics do not look like holes, a lost frame does', async () => {
		const network = new FakeNetwork();
		const server = startServer(store, network, 'e1');
		const web = connectClient(store, network, { topics: ['col'] });
		await until(() => web.connection.isOpen, 'open');

		server.protocol.publish('runtime.event', { delta: 'x' });
		server.threads.update({ a: 1 });
		server.protocol.publish('runtime.event', { delta: 'y' });
		server.threads.update({ b: 2 });
		await until(() => web.events.length === 2, 'col events');
		assert.deepStrictEqual(web.events.map(e => [e.seq, e.after]), [[2, 0], [4, 2]]);
		assert.strictEqual(web.welcomes.length, 1, 'no reconnect for skipped topics');

		// Lose one frame on the wire: the next one exposes the hole and the client resumes.
		let lost = false;
		network.live.server.dropIf = text => !lost && text.includes('"c"') ? (lost = true) : false;
		server.threads.update({ c: 3 });
		server.threads.update({ d: 4 });
		await until(() => web.mirror.has('threads', 'd') && web.mirror.has('threads', 'c'), 'refill');
		assert.strictEqual(web.welcomes.length, 2);
		assert.strictEqual(web.welcomes[1].resumed, true);
		assert.deepStrictEqual(web.events.map(e => e.seq), [2, 4, 5, 6]);
	});

	test('calls wait for a connection; a call in flight when the link drops fails and is not resent', async () => {
		const network = new FakeNetwork();
		const server = startServer(store, network, 'e1');
		let runs = 0;
		let release: (() => void) | undefined;
		store.add(server.protocol.registerMethods('thread', {
			send: (_ctx, text) => { runs++; return `ok:${text}`; },
			slow: () => { runs++; return new Promise<void>(resolve => release = resolve); },
		}));
		const client = connectClient(store, network);
		const early = client.connection.call('thread.send', 'queued before open');
		assert.strictEqual(await early, 'ok:queued before open');

		const slow = client.connection.call('thread.slow');
		await until(() => !!release, 'slow call to run');
		network.live.close(1006, 'network');
		await assert.rejects(slow, /dropped before it answered/);
		await until(() => client.connection.isOpen, 'reopen');
		release!();
		assert.strictEqual(runs, 2, 'never resent');

		await assert.rejects(client.connection.call('thread.nope'), /Unknown method/);
	});

	test('the server can call a client that advertised a capability', async () => {
		const network = new FakeNetwork();
		const server = startServer(store, network, 'e1');
		await assert.rejects(server.protocol.callClient('browser', 'browser.snapshot', []), /No Volt window/);
		const client = connectClient(store, network);
		store.add(client.connection.registerHandler('browser.snapshot', (url) => ({ url, title: 'Page' })));
		await until(() => client.connection.isOpen, 'open');
		assert.deepStrictEqual(await server.protocol.callClient('browser', 'browser.snapshot', ['http://x']), { url: 'http://x', title: 'Page' });
		await assert.rejects(server.protocol.callClient('codeIntel', 'markers', []), /No Volt window/);
	});

	test('a wrong token is refused and reported', async () => {
		const network = new FakeNetwork();
		startServer(store, network, 'e1');
		const client = connectClient(store, network, { token: 'wrong' });
		const failure = await new Promise<{ code: number }>(resolve => store.add(client.connection.onDidFail(resolve)));
		assert.strictEqual(failure.code, AgentServerCloseCode.Unauthorized);
		assert.strictEqual(client.welcomes.length, 0);
		client.connection.dispose();
	});

	test('token comparison and backoff bounds', () => {
		assert.ok(tokensEqual('abc', 'abc'));
		assert.ok(!tokensEqual('abc', 'abd'));
		assert.ok(!tokensEqual('abc', 'abcd'));
		for (let attempt = 0; attempt < 12; attempt++) {
			const ceiling = Math.min(DEFAULT_BACKOFF.maxMs, DEFAULT_BACKOFF.initialMs * 2 ** attempt);
			assert.strictEqual(backoffDelay(attempt, DEFAULT_BACKOFF, () => 0), Math.round(ceiling / 2));
			assert.strictEqual(backoffDelay(attempt, DEFAULT_BACKOFF, () => 1), ceiling);
		}
	});
});
