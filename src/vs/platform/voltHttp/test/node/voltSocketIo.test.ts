/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { IVoltHttpStreamSpec } from '../../common/voltHttpStreams.js';
import { openSocketIo, parseSocketIoPacket } from '../../node/voltSocketIo.js';
import { IVoltStreamConnection } from '../../node/voltStreamConnection.js';
import { EventLog, ITestWsPeer, ITestWsServer, startWsTestServer, waitUntil } from './streamTestUtils.js';

suite('Volt Client streams: Socket.IO', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const servers: ITestWsServer[] = [];
	const connections: IVoltStreamConnection[] = [];

	teardown(async () => {
		for (const connection of connections.splice(0)) {
			connection.close();
		}
		await Promise.all(servers.splice(0).map(server => server.close()));
	});

	/**
	 * Just enough of a Socket.IO server: the Engine.IO open packet, the namespace connect answer
	 * (refused when the auth token is `wrong`), and `hello` answered with `welcome`.
	 */
	async function serve(): Promise<ITestWsServer> {
		const server = await startWsTestServer({
			onPeer: (peer: ITestWsPeer) => {
				peer.sendText('0{"sid":"engine-1","upgrades":[],"pingInterval":25000,"pingTimeout":20000,"maxPayload":1000000}');
				peer.onFrame = frame => {
					const text = frame.payload.toString('utf8');
					const packet = text[0] === '4' ? parseSocketIoPacket(text.slice(1)) : undefined;
					if (!packet) {
						return;
					}
					const prefix = packet.namespace === '/' ? '' : `${packet.namespace},`;
					if (packet.type === 0) {
						if (packet.json.includes('wrong')) {
							peer.sendText(`44${prefix}{"message":"Not authorized"}`);
						} else {
							peer.sendText(`40${prefix}{"sid":"socket-${packet.namespace}"}`);
						}
					} else if (packet.type === 2) {
						const [name, ...args] = JSON.parse(packet.json) as unknown[];
						if (name === 'hello') {
							peer.sendText(`42${prefix}${JSON.stringify(['welcome', ...args])}`);
						}
					}
				};
			}
		});
		servers.push(server);
		return server;
	}

	function connect(spec: Omit<IVoltHttpStreamSpec, 'kind'>): { log: EventLog; connection: IVoltStreamConnection } {
		const log = new EventLog();
		const connection = openSocketIo({ kind: 'socketio', ...spec }, log.emit);
		connections.push(connection);
		return { log, connection };
	}

	test('packet header: type, attachments, namespace, ack id and JSON', () => {
		assert.deepStrictEqual(parseSocketIoPacket('0'), { type: 0, attachments: 0, namespace: '/', ackId: undefined, json: '' });
		assert.deepStrictEqual(parseSocketIoPacket('0/admin,{"sid":"x"}'), { type: 0, attachments: 0, namespace: '/admin', ackId: undefined, json: '{"sid":"x"}' });
		assert.deepStrictEqual(parseSocketIoPacket('2["a",1]'), { type: 2, attachments: 0, namespace: '/', ackId: undefined, json: '["a",1]' });
		assert.deepStrictEqual(parseSocketIoPacket('2/admin,12["a"]'), { type: 2, attachments: 0, namespace: '/admin', ackId: 12, json: '["a"]' });
		assert.deepStrictEqual(parseSocketIoPacket('37[]'), { type: 3, attachments: 0, namespace: '/', ackId: 7, json: '[]' });
		assert.deepStrictEqual(parseSocketIoPacket('51-["file",{"_placeholder":true,"num":0}]'), { type: 5, attachments: 1, namespace: '/', ackId: undefined, json: '["file",{"_placeholder":true,"num":0}]' });
		assert.deepStrictEqual(parseSocketIoPacket('1/admin'), { type: 1, attachments: 0, namespace: '/admin', ackId: undefined, json: '' });
		assert.strictEqual(parseSocketIoPacket('x'), undefined);
	});

	test('default namespace: engine handshake, connect, an event round trip, argument forms, ping and pong, acks', async () => {
		const server = await serve();
		const { log, connection } = connect({ url: `http://127.0.0.1:${server.port}`, headers: { 'X-Token': 't1' } });

		const info = await log.next('info');
		assert.ok(info.text?.includes('engine-1') && info.text.includes('25000'), info.text);
		assert.throws(() => openSocketIo({ kind: 'socketio', url: `http://127.0.0.1:${server.port}`, socketio: { auth: '{nope' } }, () => { }), /not valid JSON/);

		const open = await log.next('open');
		assert.strictEqual(open.text, 'Connected to / (sid socket-/)');
		assert.strictEqual(open.status, 101);
		assert.strictEqual(open.headers?.['x-test-server'], 'volt');
		const peer = server.peers[0];
		assert.strictEqual(peer.request.url, '/socket.io/?EIO=4&transport=websocket');
		assert.strictEqual(peer.request.headers['x-token'], 't1');
		assert.deepStrictEqual(peer.texts(), ['40']);

		connection.send({ target: 'hello', data: '{"name":"volt"}' });
		assert.deepStrictEqual(await log.next('sent'), { type: 'sent', target: 'hello', data: '{"name":"volt"}', size: 27 });
		const welcome = await log.next('message');
		assert.strictEqual(welcome.target, 'welcome');
		assert.strictEqual(welcome.data, '{"name":"volt"}');

		// An array is the argument list, anything else one argument, text that is not JSON one string.
		connection.send({ data: '[1,"two",{"three":3}]' });
		connection.send({ target: 'note', data: 'plain text' });
		connection.send({ target: 'count', data: '5' });
		connection.send({ target: 'bare', data: '' });
		await waitUntil(() => peer.texts().length === 6, 'six frames from the client');
		assert.deepStrictEqual(peer.texts().slice(1), [
			'42["hello",{"name":"volt"}]',
			'42["message",1,"two",{"three":3}]',
			'42["note","plain text"]',
			'42["count",5]',
			'42["bare"]'
		]);

		peer.sendText('42["multi",1,"two"]');
		assert.deepStrictEqual(await log.next('message'), { type: 'message', target: 'multi', data: '[1,"two"]', size: 19 });
		peer.sendText('42["empty"]');
		assert.strictEqual((await log.next('message')).data, '[]');
		peer.sendText('437["done",true]');
		const ack = await log.next('message');
		assert.strictEqual(ack.target, 'ack');
		assert.strictEqual(ack.data, '["done",true]');
		peer.sendText('42/other,["not for us"]');
		peer.sendText('51-["file",{"_placeholder":true,"num":0}]');
		await peer.sendFrame(2, Buffer.from([1, 2, 3]));
		const binary = await log.next('info');
		assert.ok(binary.text?.includes('binary attachments are not shown'), binary.text);

		peer.sendText('2');
		await waitUntil(() => peer.texts().includes('3'), 'the pong');
		assert.strictEqual(log.events.filter(event => event.type === 'message').length, 4, 'the other namespace\'s event and the attachment are not messages');
		assert.strictEqual(log.events.filter(event => event.type === 'info').length, 2);
	});

	test('a namespace with auth on a custom engine path; closing disconnects the namespace', async () => {
		const server = await serve();
		const { log, connection } = connect({ url: `ws://127.0.0.1:${server.port}/admin?tenant=a`, socketio: { path: 'custom/', auth: '{ "token": "ok" }' } });

		const open = await log.next('open');
		assert.strictEqual(open.text, 'Connected to /admin (sid socket-/admin)');
		const peer = server.peers[0];
		assert.strictEqual(peer.request.url, '/custom/?tenant=a&EIO=4&transport=websocket');
		assert.deepStrictEqual(peer.texts(), ['40/admin,{"token":"ok"}']);

		connection.send({ target: 'hello', data: '"hi"' });
		const welcome = await log.next('message');
		assert.deepStrictEqual([welcome.target, welcome.data], ['welcome', '"hi"']);
		assert.strictEqual(peer.texts()[1], '42/admin,["hello","hi"]');

		connection.close();
		assert.strictEqual((await log.next('close')).code, 1000);
		assert.strictEqual(peer.texts()[2], '41/admin,');
		assert.throws(() => connection.send({ data: '1' }), /closed/);
		assert.deepStrictEqual(log.types().filter(type => type !== 'info' && type !== 'sent'), ['open', 'message', 'close']);
	});

	test('a refused namespace is an error with the server\'s message, then close; sending before the connect throws', async () => {
		const server = await serve();
		const { log, connection } = connect({ url: `http://127.0.0.1:${server.port}/`, socketio: { auth: '{"token":"wrong"}' } });
		assert.throws(() => connection.send({ data: '1' }), /Not connected/);

		const error = await log.next('error');
		assert.ok(error.text?.includes('Not authorized'), error.text);
		await log.next('close');
		assert.ok(!log.types().includes('open'));
	});

	test('the server\'s disconnect packet ends the connection', async () => {
		const server = await serve();
		const { log } = connect({ url: `http://127.0.0.1:${server.port}/` });
		await log.next('open');
		server.peers[0].sendText('41');
		await log.next('close');
		assert.deepStrictEqual(log.types(), ['info', 'open', 'info', 'close']);
	});
});
