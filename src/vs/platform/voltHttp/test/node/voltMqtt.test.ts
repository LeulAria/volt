/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import * as net from 'net';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { IVoltHttpStreamSpec } from '../../common/voltHttpStreams.js';
import { encodeMqttRemainingLength, openMqtt } from '../../node/voltMqtt.js';
import { IVoltStreamConnection } from '../../node/voltStreamConnection.js';
import { delay, EventLog, ITestWsServer, startWsTestServer, waitUntil } from './streamTestUtils.js';

interface IBrokerPacket {
	readonly type: number;
	readonly flags: number;
	readonly body: Buffer;
}

interface IBrokerConnect {
	readonly protocol: string;
	readonly level: number;
	readonly flags: number;
	readonly keepAlive: number;
	readonly clientId: string;
	readonly username: string | undefined;
	readonly password: string | undefined;
}

function packet(first: number, ...parts: Buffer[]): Buffer {
	const body = Buffer.concat(parts);
	return Buffer.concat([Buffer.from([first]), encodeMqttRemainingLength(body.length), body]);
}

function str(value: string): Buffer {
	const bytes = Buffer.from(value, 'utf8');
	return Buffer.concat([Buffer.from([bytes.length >> 8, bytes.length & 0xff]), bytes]);
}

function publish(topic: string, payload: Buffer | string, qos = 0, id = 0, retain = false): Buffer {
	const parts = [str(topic)];
	if (qos > 0) {
		parts.push(Buffer.from([id >> 8, id & 0xff]));
	}
	parts.push(typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload);
	return packet(0x30 | (qos << 1) | (retain ? 1 : 0), ...parts);
}

/** Just enough of an MQTT 3.1.1 broker, on any byte stream. */
class TestBroker {

	readonly packets: IBrokerPacket[] = [];
	connect: IBrokerConnect | undefined;
	private buffer: Buffer = Buffer.alloc(0);

	constructor(readonly write: (data: Buffer) => void, private readonly end: () => void) { }

	ofType(type: number): IBrokerPacket[] {
		return this.packets.filter(item => item.type === type);
	}

	feed(chunk: Buffer): void {
		this.buffer = Buffer.concat([this.buffer, chunk]);
		while (this.buffer.length >= 2) {
			let length = 0;
			let multiplier = 1;
			let index = 1;
			let byte: number;
			do {
				if (index >= this.buffer.length) {
					return;
				}
				byte = this.buffer[index++];
				length += (byte & 0x7f) * multiplier;
				multiplier *= 128;
			} while (byte & 0x80);
			if (this.buffer.length < index + length) {
				return;
			}
			const received: IBrokerPacket = { type: this.buffer[0] >> 4, flags: this.buffer[0] & 0x0f, body: Buffer.from(this.buffer.subarray(index, index + length)) };
			this.buffer = this.buffer.subarray(index + length);
			this.packets.push(received);
			this.answer(received);
		}
	}

	private answer({ type, flags, body }: IBrokerPacket): void {
		if (type === 1) {
			let offset = 0;
			const read = () => {
				const length = body.readUInt16BE(offset);
				const value = body.subarray(offset + 2, offset + 2 + length).toString('utf8');
				offset += 2 + length;
				return value;
			};
			const protocol = read();
			const level = body[offset++];
			const connectFlags = body[offset++];
			const keepAlive = body.readUInt16BE(offset);
			offset += 2;
			const clientId = read();
			const username = connectFlags & 0x80 ? read() : undefined;
			const password = connectFlags & 0x40 ? read() : undefined;
			this.connect = { protocol, level, flags: connectFlags, keepAlive, clientId, username, password };
			this.write(packet(0x20, Buffer.from([0, username === 'intruder' ? 5 : 0])));
		} else if (type === 8) {
			const granted: number[] = [];
			let offset = 2;
			while (offset < body.length) {
				const length = body.readUInt16BE(offset);
				const filter = body.subarray(offset + 2, offset + 2 + length).toString('utf8');
				const qos = body[offset + 2 + length];
				offset += 3 + length;
				granted.push(filter.startsWith('forbidden') ? 0x80 : qos);
			}
			this.write(packet(0x90, body.subarray(0, 2), Buffer.from(granted)));
		} else if (type === 3 && ((flags >> 1) & 3) === 1) {
			const topicLength = body.readUInt16BE(0);
			this.write(packet(0x40, body.subarray(2 + topicLength, 4 + topicLength)));
		} else if (type === 12) {
			this.write(packet(0xD0));
		} else if (type === 14) {
			this.end();
		}
	}
}

suite('Volt Client streams: MQTT', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const cleanups: (() => Promise<unknown>)[] = [];
	const connections: IVoltStreamConnection[] = [];

	teardown(async () => {
		for (const connection of connections.splice(0)) {
			connection.close();
		}
		await Promise.all(cleanups.splice(0).map(cleanup => cleanup()));
	});

	async function serveTcp(): Promise<{ port: number; brokers: TestBroker[] }> {
		const brokers: TestBroker[] = [];
		const sockets = new Set<net.Socket>();
		const server = net.createServer(socket => {
			socket.setNoDelay(true);
			sockets.add(socket);
			socket.on('error', () => { /* the client went away */ });
			const broker = new TestBroker(data => socket.write(data), () => socket.end());
			brokers.push(broker);
			socket.on('data', chunk => broker.feed(chunk));
		});
		await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
		cleanups.push(() => {
			for (const socket of sockets) {
				socket.destroy();
			}
			return new Promise(resolve => server.close(resolve));
		});
		return { port: (server.address() as net.AddressInfo).port, brokers };
	}

	function connect(spec: Omit<IVoltHttpStreamSpec, 'kind'>): { log: EventLog; connection: IVoltStreamConnection } {
		const log = new EventLog();
		const connection = openMqtt({ kind: 'mqtt', ...spec }, log.emit);
		connections.push(connection);
		return { log, connection };
	}

	test('remaining length is a varint of one to four bytes', () => {
		assert.deepStrictEqual([...encodeMqttRemainingLength(0)], [0]);
		assert.deepStrictEqual([...encodeMqttRemainingLength(127)], [0x7f]);
		assert.deepStrictEqual([...encodeMqttRemainingLength(128)], [0x80, 0x01]);
		assert.deepStrictEqual([...encodeMqttRemainingLength(16383)], [0xff, 0x7f]);
		assert.deepStrictEqual([...encodeMqttRemainingLength(16384)], [0x80, 0x80, 0x01]);
		assert.deepStrictEqual([...encodeMqttRemainingLength(2097152)], [0x80, 0x80, 0x80, 0x01]);
		assert.deepStrictEqual([...encodeMqttRemainingLength(268435455)], [0xff, 0xff, 0xff, 0x7f]);
		assert.throws(() => encodeMqttRemainingLength(268435456));
	});

	test('connects with credentials, subscribes, and shows publishes of every QoS as text or base64', async () => {
		const { port, brokers } = await serveTcp();
		const { log } = connect({ url: `mqtt://127.0.0.1:${port}`, mqtt: { clientId: 'volt-test', username: 'ada', password: 's3cret', subscribe: ['sensors/#', 'forbidden/topic'], qos: 1 } });

		const open = await log.next('open');
		assert.ok(open.text?.includes('volt-test'), open.text);
		const broker = brokers[0];
		assert.deepStrictEqual(broker.connect, { protocol: 'MQTT', level: 4, flags: 0xC2, keepAlive: 60, clientId: 'volt-test', username: 'ada', password: 's3cret' });

		assert.strictEqual((await log.next('info')).text, 'Subscribed to sensors/# (QoS 1)');
		assert.strictEqual((await log.next('info')).text, 'The broker refused the subscription to forbidden/topic');
		assert.strictEqual(broker.ofType(8)[0].flags, 2, 'SUBSCRIBE carries the reserved flags 0010');

		broker.write(publish('sensors/temp', '{"c":21.5}'));
		assert.deepStrictEqual(await log.next('message'), { type: 'message', target: 'sensors/temp', data: '{"c":21.5}', size: 10 });

		broker.write(publish('sensors/raw', Buffer.from([0xff, 0xfe, 0x00]), 0, 0, true));
		assert.deepStrictEqual(await log.next('message'), { type: 'message', target: 'sensors/raw', data: Buffer.from([0xff, 0xfe, 0x00]).toString('base64'), binary: true, text: 'retained', size: 3 });

		broker.write(publish('sensors/q1', 'once at least', 1, 77));
		assert.strictEqual((await log.next('message')).text, 'QoS 1');
		await waitUntil(() => broker.ofType(4).length === 1, 'the PUBACK');
		assert.strictEqual(broker.ofType(4)[0].body.readUInt16BE(0), 77);

		// QoS 2: PUBREC, shown once even when delivered again, PUBCOMP after the PUBREL.
		broker.write(publish('sensors/q2', 'exactly once', 2, 78));
		broker.write(publish('sensors/q2', 'exactly once', 2, 78));
		assert.strictEqual((await log.next('message')).data, 'exactly once');
		await waitUntil(() => broker.ofType(5).length === 2, 'two PUBRECs');
		broker.write(packet(0x62, Buffer.from([0, 78])));
		await waitUntil(() => broker.ofType(7).length === 1, 'the PUBCOMP');
		assert.strictEqual(broker.ofType(7)[0].body.readUInt16BE(0), 78);
		assert.strictEqual(log.events.filter(event => event.type === 'message').length, 4);
	});

	test('publishes: QoS 0, QoS 1 with retain and the broker\'s PUBACK, binary, long payloads; a topic is required', async () => {
		const { port, brokers } = await serveTcp();
		const { log, connection } = connect({ url: `tcp://127.0.0.1:${port}` });
		assert.throws(() => connection.send({ target: 'a', data: 'early' }), /Not connected/);
		await log.next('open');
		const broker = brokers[0];
		assert.ok(/^volt-[0-9a-f]{8}$/.test(broker.connect?.clientId ?? ''), broker.connect?.clientId);
		assert.strictEqual(broker.connect?.flags, 0x02, 'clean session, no credentials');
		assert.strictEqual(broker.ofType(8).length, 0, 'nothing to subscribe to');

		assert.throws(() => connection.send({ data: 'no topic' }), /topic is required/);
		assert.throws(() => connection.send({ target: 'a/#', data: 'x' }), /wildcards/);

		connection.send({ target: 'lights/kitchen', data: 'on' });
		assert.deepStrictEqual(await log.next('sent'), { type: 'sent', target: 'lights/kitchen', data: 'on', size: 2 });

		connection.send({ target: 'lights/hall', data: 'off', qos: 1, retain: true });
		assert.deepStrictEqual(await log.next('sent'), { type: 'sent', target: 'lights/hall', data: 'off', text: 'QoS 1, retained', size: 3 });
		const acknowledged = await log.next('info');
		assert.ok(acknowledged.text?.includes('acknowledged') && acknowledged.text.includes('lights/hall'), acknowledged.text);

		const long = 'z'.repeat(20000);
		connection.send({ target: 'blob', data: Buffer.from([1, 2, 255]).toString('base64'), binary: true });
		connection.send({ target: 'long', data: long });
		await waitUntil(() => broker.ofType(3).length === 4, 'four publishes at the broker');

		const [first, second, third, fourth] = broker.ofType(3);
		assert.strictEqual(first.flags, 0);
		assert.strictEqual(first.body.toString(), '\u0000\u000elights/kitchenon');
		assert.strictEqual(second.flags, 0x03, 'QoS 1 and retain');
		assert.strictEqual(second.body.subarray(0, 13).toString(), '\u0000\u000blights/hall');
		assert.strictEqual(second.body.readUInt16BE(13), 1, 'the first packet id');
		assert.strictEqual(second.body.subarray(15).toString(), 'off');
		assert.deepStrictEqual([...third.body.subarray(6)], [1, 2, 255]);
		assert.strictEqual(fourth.body.subarray(6).toString(), long);
	});

	test('packets split across chunks and several packets in one chunk are all read', async () => {
		const { port, brokers } = await serveTcp();
		const { log } = connect({ url: `mqtt://127.0.0.1:${port}`, mqtt: { subscribe: ['#'] } });
		await log.next('open');
		// The SUBACK must be out before a packet is written in pieces, or it would land inside it.
		await log.next('info');
		const broker = brokers[0];

		// 300 bytes: a two-byte remaining length, sent a few bytes at a time (the first write ends inside the length).
		const payload = 'p'.repeat(300);
		const split = publish('split/topic', payload);
		for (const [from, to] of [[0, 2], [2, 3], [3, 10], [10, 200], [200, split.length]]) {
			broker.write(split.subarray(from, to));
			await delay(5);
		}
		assert.deepStrictEqual(await log.next('message'), { type: 'message', target: 'split/topic', data: payload, size: 300 });

		broker.write(Buffer.concat([publish('merged/1', 'one'), publish('merged/2', 'two', 1, 5), publish('merged/3', 'three').subarray(0, 4)]));
		await delay(15);
		broker.write(publish('merged/3', 'three').subarray(4));
		assert.strictEqual((await log.next('message')).data, 'one');
		assert.strictEqual((await log.next('message')).data, 'two');
		assert.deepStrictEqual(await log.next('message'), { type: 'message', target: 'merged/3', data: 'three', size: 5 });
	});

	test('a refused CONNACK is an error that says why, then close', async () => {
		const { port } = await serveTcp();
		const { log } = connect({ url: `mqtt://intruder:pw@127.0.0.1:${port}` });
		const error = await log.next('error');
		assert.strictEqual(error.text, 'The broker refused the connection: not authorized');
		await log.next('close');
		assert.deepStrictEqual(log.types(), ['error', 'close']);
	});

	test('keeps alive with PINGREQ at half the interval and says DISCONNECT when closing', async () => {
		const { port, brokers } = await serveTcp();
		const { log, connection } = connect({ url: `mqtt://127.0.0.1:${port}`, mqtt: { keepAliveSeconds: 1 } });
		await log.next('open');
		const broker = brokers[0];
		assert.strictEqual(broker.connect?.keepAlive, 1);
		await waitUntil(() => broker.ofType(12).length >= 1, 'a PINGREQ');

		connection.close();
		connection.close();
		await log.next('close');
		assert.strictEqual(broker.ofType(14).length, 1);
		assert.deepStrictEqual(log.types(), ['open', 'close']);
		assert.throws(() => connection.send({ target: 'a', data: 'late' }), /closed/);
	});

	test('a server that is not there, or is not a broker, is an error then close', async () => {
		const gone = connect({ url: 'mqtt://127.0.0.1:1' });
		await gone.log.next('error');
		await gone.log.next('close');
		assert.deepStrictEqual(gone.log.types(), ['error', 'close']);

		assert.throws(() => openMqtt({ kind: 'mqtt', url: 'http://127.0.0.1:1883' }, () => { }), /Not an MQTT URL/);
	});

	test('over WebSocket: the mqtt subprotocol and binary frames', async () => {
		const brokers: TestBroker[] = [];
		const server: ITestWsServer = await startWsTestServer({
			protocol: 'mqtt',
			onPeer: peer => {
				const broker = new TestBroker(data => void peer.sendFrame(2, data), () => peer.socket.end());
				brokers.push(broker);
				peer.onFrame = frame => broker.feed(frame.payload);
			}
		});
		cleanups.push(() => server.close());
		const { log, connection } = connect({ url: `ws://127.0.0.1:${server.port}/mqtt`, mqtt: { subscribe: ['news/#'] } });

		await log.next('open');
		assert.strictEqual(server.peers[0].request.headers['sec-websocket-protocol'], 'mqtt');
		assert.strictEqual(server.peers[0].request.url, '/mqtt');
		assert.strictEqual((await log.next('info')).text, 'Subscribed to news/# (QoS 0)');
		assert.ok(server.peers[0].frames.every(frame => frame.opcode === 2), 'only binary frames');

		// One MQTT packet over two WebSocket frames.
		const news = publish('news/today', 'hello');
		await server.peers[0].sendFrame(2, news.subarray(0, 5));
		await server.peers[0].sendFrame(2, news.subarray(5));
		assert.deepStrictEqual(await log.next('message'), { type: 'message', target: 'news/today', data: 'hello', size: 5 });

		connection.send({ target: 'news/reply', data: 'hi', qos: 1 });
		await log.next('sent');
		await log.next('info');

		connection.close();
		await log.next('close');
		assert.strictEqual(brokers[0].ofType(14).length, 1);
	});
});
