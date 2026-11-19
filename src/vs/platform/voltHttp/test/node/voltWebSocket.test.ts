/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import * as net from 'net';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { IVoltStreamConnection } from '../../node/voltStreamConnection.js';
import { openWebSocket, webSocketAcceptKey } from '../../node/voltWebSocket.js';
import { EventLog, ITestWsServer, ITestWsServerOptions, startWsTestServer, waitUntil } from './streamTestUtils.js';

suite('Volt Client streams: WebSocket', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const servers: ITestWsServer[] = [];
	const connections: IVoltStreamConnection[] = [];

	teardown(async () => {
		for (const connection of connections.splice(0)) {
			connection.close();
		}
		await Promise.all(servers.splice(0).map(server => server.close()));
	});

	async function serve(options: ITestWsServerOptions = {}): Promise<ITestWsServer> {
		const server = await startWsTestServer(options);
		servers.push(server);
		return server;
	}

	function connect(url: string, headers?: Record<string, string>): { log: EventLog; connection: IVoltStreamConnection } {
		const log = new EventLog();
		const connection = openWebSocket({ kind: 'ws', url, headers }, log.emit);
		connections.push(connection);
		return { log, connection };
	}

	test('the handshake answer key is the one RFC 6455 gives as its example', () => {
		assert.strictEqual(webSocketAcceptKey('dGhlIHNhbXBsZSBub25jZQ=='), 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
	});

	test('echoes text and binary, sends custom headers and the subprotocol, masks its frames', async () => {
		const server = await serve({
			protocol: 'chat.v2',
			onPeer: peer => peer.onFrame = frame => void peer.sendFrame(frame.opcode, frame.payload)
		});
		const { log, connection } = connect(`ws://127.0.0.1:${server.port}/echo?room=1`, { 'X-Volt-Test': 'abc', 'Sec-WebSocket-Protocol': 'chat.v2, chat.v1', 'Connection': 'close' });

		assert.throws(() => connection.send({ data: 'too early' }), /still connecting/);

		const open = await log.next('open');
		assert.strictEqual(open.status, 101);
		assert.strictEqual(open.headers?.['x-test-server'], 'volt');
		assert.strictEqual(open.headers?.['sec-websocket-protocol'], 'chat.v2');
		assert.ok(open.text?.includes('chat.v2'), open.text);

		const request = server.peers[0].request;
		assert.strictEqual(request.url, '/echo?room=1');
		assert.strictEqual(request.headers['x-volt-test'], 'abc');
		assert.strictEqual(request.headers['sec-websocket-protocol'], 'chat.v2, chat.v1');
		assert.strictEqual(request.headers['sec-websocket-version'], '13');
		assert.strictEqual(request.headers['connection'], 'Upgrade', 'the handshake headers cannot be overridden');
		assert.strictEqual(request.headers['sec-websocket-extensions'], undefined, 'no extension is offered');

		connection.send({ data: 'héllo' });
		const sent = await log.next('sent');
		assert.deepStrictEqual(sent, { type: 'sent', data: 'héllo', size: 6 });
		assert.deepStrictEqual(await log.next('message'), { type: 'message', data: 'héllo', size: 6 });

		const bytes = Buffer.from([0, 255, 1, 254, 128]);
		connection.send({ data: bytes.toString('base64'), binary: true });
		assert.deepStrictEqual(await log.next('sent'), { type: 'sent', data: bytes.toString('base64'), binary: true, size: 5 });
		assert.deepStrictEqual(await log.next('message'), { type: 'message', data: bytes.toString('base64'), binary: true, size: 5 });

		assert.ok(server.peers[0].frames.every(frame => frame.masked), 'every client frame is masked');
	});

	test('joins a fragmented message, answers pings between the fragments, and reports pings only occasionally', async () => {
		const server = await serve();
		const { log } = connect(`ws://127.0.0.1:${server.port}/`);
		await log.next('open');
		const peer = server.peers[0];

		await peer.sendFrame(1, 'Hel', false);
		await peer.sendFrame(9, 'p1');
		await peer.sendFrame(0, 'lo ', false);
		await peer.sendFrame(9, 'p2');
		await peer.sendFrame(0, 'world', true);

		assert.deepStrictEqual(await log.next('message'), { type: 'message', data: 'Hello world', size: 11 });
		await waitUntil(() => peer.frames.filter(frame => frame.opcode === 10).length === 2, 'two pongs');
		assert.deepStrictEqual(peer.frames.filter(frame => frame.opcode === 10).map(frame => frame.payload.toString()), ['p1', 'p2']);
		assert.strictEqual(log.events.filter(event => event.type === 'info').length, 1, 'one info line for the two pings');
	});

	test('reads frames with 16 and 64 bit lengths that arrive in pieces, and sends large ones', async () => {
		const server = await serve();
		const { log, connection } = connect(`ws://127.0.0.1:${server.port}/`);
		await log.next('open');
		const peer = server.peers[0];

		const medium = 'm'.repeat(300);
		const large = Buffer.alloc(70000, 7);
		await peer.sendFrame(1, medium, true, 3);
		await peer.sendFrame(1, medium, true, 101);
		assert.strictEqual((await log.next('message')).data, medium);
		assert.strictEqual((await log.next('message')).data, medium);
		await peer.sendFrame(2, large, true, 30000);
		const received = await log.next('message');
		assert.strictEqual(received.size, 70000);
		assert.ok(Buffer.from(received.data ?? '', 'base64').equals(large));

		// Two frames in one write.
		peer.socket.write(Buffer.concat([Buffer.from([0x81, 1, 0x61]), Buffer.from([0x81, 1, 0x62])]));
		assert.strictEqual((await log.next('message')).data, 'a');
		assert.strictEqual((await log.next('message')).data, 'b');

		connection.send({ data: large.toString('base64'), binary: true });
		await waitUntil(() => peer.frames.some(frame => frame.opcode === 2), 'the large frame');
		assert.ok(peer.frames.find(frame => frame.opcode === 2)?.payload.equals(large));
	});

	test('the server\'s close code and reason come with the close event, and the close frame is echoed', async () => {
		const server = await serve();
		const { log, connection } = connect(`ws://127.0.0.1:${server.port}/`);
		await log.next('open');
		const peer = server.peers[0];

		peer.sendClose(4001, 'bye for now');
		assert.deepStrictEqual(await log.next('close'), { type: 'close', code: 4001, text: 'bye for now' });
		await waitUntil(() => peer.frames.some(frame => frame.opcode === 8), 'the close echo');
		assert.strictEqual(peer.frames.find(frame => frame.opcode === 8)?.payload.readUInt16BE(0), 4001);
		assert.deepStrictEqual(log.types(), ['open', 'close']);
		assert.throws(() => connection.send({ data: 'late' }), /closed/);
	});

	test('closing from this side does the close handshake with code 1000, once', async () => {
		const server = await serve();
		const { log, connection } = connect(`ws://127.0.0.1:${server.port}/`);
		await log.next('open');

		connection.close();
		connection.close();
		assert.deepStrictEqual(await log.next('close'), { type: 'close', code: 1000 });
		assert.strictEqual(server.peers[0].frames.find(frame => frame.opcode === 8)?.payload.readUInt16BE(0), 1000);
		assert.deepStrictEqual(log.types(), ['open', 'close']);
	});

	test('an answer other than 101 is an error with the status and the start of the body, then close', async () => {
		const server = await serve({
			refuse: (_request, socket) => {
				socket.end('HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\nX-Why: token\r\nContent-Length: 13\r\nConnection: close\r\n\r\nmissing token');
				return true;
			}
		});
		const { log } = connect(`ws://127.0.0.1:${server.port}/private`);

		const error = await log.next('error');
		assert.strictEqual(error.status, 403);
		assert.strictEqual(error.headers?.['x-why'], 'token');
		assert.ok(error.text?.includes('403 Forbidden') && error.text.includes('missing token'), error.text);
		await log.next('close');
		assert.deepStrictEqual(log.types(), ['error', 'close']);
	});

	test('a server that is not there is an error, then close; http:// is taken as ws://', async () => {
		const probe = net.createServer();
		await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve));
		const port = (probe.address() as net.AddressInfo).port;
		await new Promise(resolve => probe.close(resolve));

		const { log } = connect(`http://127.0.0.1:${port}/`);
		const error = await log.next('error');
		assert.ok(error.text?.includes('ECONNREFUSED'), error.text);
		await log.next('close');
		assert.deepStrictEqual(log.types(), ['error', 'close']);

		assert.throws(() => openWebSocket({ kind: 'ws', url: 'ftp://example.test/' }, () => { }), /Not a WebSocket URL/);
	});

	test('a frame with reserved bits (an extension nobody agreed on) ends the connection with an error', async () => {
		const server = await serve();
		const { log } = connect(`ws://127.0.0.1:${server.port}/`);
		await log.next('open');

		server.peers[0].socket.write(Buffer.from([0xC1, 1, 0x61]));
		const error = await log.next('error');
		assert.ok(error.text?.includes('reserved bits'), error.text);
		await log.next('close');
	});
});
