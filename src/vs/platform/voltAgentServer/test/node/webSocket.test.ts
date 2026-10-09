/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import * as http from 'http';
import type { AddressInfo, Socket } from 'net';
import { DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { AgentServerConnection, IWebSocketLike } from '../../common/connection.js';
import { IAgentServerEvent } from '../../common/protocol.js';
import { AgentServerProtocol } from '../../common/protocolServer.js';
import { acceptWebSocket, NodeWebSocket } from '../../node/webSocket.js';

async function until(condition: () => boolean, what: string, ms = 5000): Promise<void> {
	const start = Date.now();
	while (!condition()) {
		if (Date.now() - start > ms) {
			throw new Error(`timed out waiting for ${what}`);
		}
		await new Promise(resolve => setTimeout(resolve, 5));
	}
}

suite('Agent server WebSocket transport', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	async function listen(disposables: Pick<DisposableStore, 'add'>): Promise<{ protocol: AgentServerProtocol; url: string; sockets: NodeWebSocket[] }> {
		const protocol = disposables.add(new AgentServerProtocol({
			token: 't0k3n', epoch: 'e1', serverVersion: 'test', pid: process.pid,
			snapshot: () => ({ collections: {} }),
		}));
		const sockets: NodeWebSocket[] = [];
		const server = http.createServer((_req, res) => res.end('ok'));
		server.on('upgrade', (req, socket: Socket) => {
			const ws = acceptWebSocket(req, socket, { pingIntervalMs: 0 });
			if (ws) {
				sockets.push(ws);
				protocol.accept(ws);
			}
		});
		await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
		disposables.add(toDisposable(() => { server.closeAllConnections(); server.close(); }));
		return { protocol, url: `ws://127.0.0.1:${(server.address() as AddressInfo).port}/ws`, sockets };
	}

	function connect(disposables: Pick<DisposableStore, 'add'>, url: string): { connection: AgentServerConnection; events: IAgentServerEvent[] } {
		const connection = disposables.add(new AgentServerConnection({
			endpoint: async () => ({ url, token: 't0k3n' }),
			createSocket: target => new WebSocket(target) as unknown as IWebSocketLike,
			client: { kind: 'test', id: 'node', capabilities: ['surface'] },
			backoff: { initialMs: 5, maxMs: 20 },
		}));
		const events: IAgentServerEvent[] = [];
		disposables.add(connection.onEvent(e => events.push(e)));
		connection.connect();
		return { connection, events };
	}

	test('carries calls, large events and client calls over a real socket', async () => {
		const { protocol, url } = await listen(store);
		store.add(protocol.registerMethod('echo.text', (_ctx, text) => `${text}!`));
		const { connection, events } = connect(store, url);
		store.add(connection.registerHandler('surface.open', (what) => `opened ${what}`));
		await until(() => connection.isOpen, 'open');

		assert.strictEqual(await connection.call('echo.text', 'héllo ✓'), 'héllo ✓!');
		const big = 'x'.repeat(300_000);
		protocol.publish('session', { big });
		protocol.publish('session', { small: 1 });
		await until(() => events.length === 2, 'events');
		assert.strictEqual((events[0].data as { big: string }).big.length, 300_000);
		assert.strictEqual(await protocol.callClient('surface', 'surface.open', ['preview']), 'opened preview');
	});

	test('resumes after the server drops the socket', async () => {
		const { protocol, url, sockets } = await listen(store);
		const { connection, events } = connect(store, url);
		await until(() => connection.isOpen, 'open');
		protocol.publish('col', { col: 'x', put: { a: 1 } });
		await until(() => events.length === 1, 'first');

		// Published while the socket is closing: the client only gets it by resuming.
		sockets[0].close(1011, 'test drop');
		protocol.publish('col', { col: 'x', put: { b: 2 } });
		await until(() => sockets.length === 2 && connection.isOpen && events.length === 2, 'resume');
		assert.deepStrictEqual(events.map(e => e.seq), [1, 2]);
		assert.strictEqual(sockets.length, 2);
	});

	test('refuses plain HTTP upgrades without a WebSocket key', async () => {
		const { url } = await listen(store);
		const port = new URL(url).port;
		const status = await new Promise<number>(resolve => {
			const req = http.request({ host: '127.0.0.1', port, path: '/ws', headers: { Connection: 'Upgrade', Upgrade: 'websocket' } });
			req.on('response', res => resolve(res.statusCode ?? 0));
			req.on('error', () => resolve(-1));
			req.on('upgrade', () => resolve(101));
			req.end();
		});
		assert.notStrictEqual(status, 101);
	});
});
