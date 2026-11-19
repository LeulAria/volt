/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { IChannel, ProxyChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { IVoltHttpStreamEvent, IVoltHttpStreamMessage, IVoltHttpStreams, IVoltHttpStreamSpec } from '../../common/voltHttpStreams.js';
import { VoltHttpStreamsMainService } from '../../electron-main/voltHttpStreamsMain.js';
import { IVoltStreamConnection, VoltStreamEmit } from '../../node/voltStreamConnection.js';
import { delay, ITestWsServer, startWsTestServer, waitUntil } from '../node/streamTestUtils.js';

interface IFake {
	readonly spec: IVoltHttpStreamSpec;
	readonly emit: VoltStreamEmit;
	readonly sent: IVoltHttpStreamMessage[];
	closes: number;
}

/** The service with protocol modules a test drives by hand (the URL picks how they behave). */
class TestStreams extends VoltHttpStreamsMainService {

	readonly fakes: IFake[] = [];

	protected override connect(spec: IVoltHttpStreamSpec, emit: VoltStreamEmit): IVoltStreamConnection {
		if (spec.url.startsWith('real:')) {
			return super.connect({ ...spec, url: spec.url.slice(5) }, emit);
		}
		if (spec.url === 'fake://throws') {
			throw new Error('cannot even start');
		}
		const fake: IFake = { spec, emit, sent: [], closes: 0 };
		this.fakes.push(fake);
		return {
			send: message => {
				if (message.data === 'refuse') {
					throw new Error('this kind cannot send');
				}
				fake.sent.push(message);
			},
			close: () => {
				fake.closes++;
				if (spec.url === 'fake://polite') {
					emit({ type: 'close', code: 1000, text: 'done' });
				}
			}
		};
	}
}

suite('Volt Client streams (main process service)', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();
	const servers: ITestWsServer[] = [];

	teardown(async () => {
		await Promise.all(servers.splice(0).map(server => server.close()));
	});

	function create(): { service: TestStreams; events: IVoltHttpStreamEvent[]; types(id: string): string[] } {
		const service = store.add(new TestStreams());
		const events: IVoltHttpStreamEvent[] = [];
		store.add(service.onDidStreamEvent(event => events.push(event)));
		return { service, events, types: id => events.filter(event => event.id === id).map(event => event.type) };
	}

	test('stamps every event with the connection\'s id and the time, and passes sends on', async () => {
		const { service, events } = create();
		const before = Date.now();
		await service.open('a', { kind: 'ws', url: 'fake://polite' });
		await service.open('b', { kind: 'sse', url: 'fake://polite' });
		service.fakes[0].emit({ type: 'open', status: 101, text: 'Connected' });
		service.fakes[1].emit({ type: 'message', target: 'tick', data: '1' });

		assert.deepStrictEqual(events.map(event => [event.id, event.type]), [['a', 'open'], ['b', 'message']]);
		assert.ok(events.every(event => event.at >= before && event.at <= Date.now()));
		assert.strictEqual(events[0].status, 101);
		assert.strictEqual(events[1].target, 'tick');

		await service.send('a', { data: 'hello', target: 't' });
		assert.deepStrictEqual(service.fakes[0].sent, [{ data: 'hello', target: 't' }]);
		await assert.rejects(() => service.send('a', { data: 'refuse' }), /this kind cannot send/);
		await assert.rejects(() => service.send('nobody', { data: 'x' }), /connection nobody is not open/);
	});

	test('exactly one close per connection: the module\'s own, and nothing after it', async () => {
		const { service, events, types } = create();
		await service.open('a', { kind: 'ws', url: 'fake://polite' });
		const fake = service.fakes[0];
		fake.emit({ type: 'open' });

		await service.close('a');
		assert.deepStrictEqual(types('a'), ['open', 'close']);
		assert.strictEqual(events[1].code, 1000, 'the module\'s close, with its code');

		fake.emit({ type: 'message', data: 'late' });
		fake.emit({ type: 'close' });
		await service.close('a');
		await service.close('never-opened');
		assert.deepStrictEqual(types('a'), ['open', 'close']);
		await assert.rejects(() => service.send('a', { data: 'x' }), /not open/);
	});

	test('a module that throws while starting is an error then close; an unknown kind too', async () => {
		const { service, events, types } = create();
		await service.open('a', { kind: 'mqtt', url: 'fake://throws' });
		assert.deepStrictEqual(types('a'), ['error', 'close']);
		assert.strictEqual(events[0].text, 'cannot even start');

		await service.open('b', { kind: 'carrier-pigeon', url: 'real:x://y' } as unknown as IVoltHttpStreamSpec);
		assert.deepStrictEqual(types('b'), ['error', 'close']);
		assert.ok(events[2].text?.includes('carrier-pigeon'), events[2].text);
	});

	test('connecting may take connectTimeoutMs; an open in time stops the clock', async () => {
		const { service, events, types } = create();
		await service.open('slow', { kind: 'ws', url: 'fake://silent', connectTimeoutMs: 30 });
		await service.open('fast', { kind: 'ws', url: 'fake://silent', connectTimeoutMs: 30 });
		service.fakes[1].emit({ type: 'open' });

		await waitUntil(() => types('slow').includes('close'), 'the timeout');
		assert.deepStrictEqual(types('slow'), ['error', 'close']);
		assert.strictEqual(events.find(event => event.id === 'slow')?.text, 'Timed out connecting after 30 ms');
		assert.strictEqual(service.fakes[0].closes, 1, 'the connection was told to close');

		await delay(60);
		assert.deepStrictEqual(types('fast'), ['open']);
	});

	test('a message\'s data is cut to 1 MB, with an info line saying so', async () => {
		const { service, events } = create();
		await service.open('a', { kind: 'ws', url: 'fake://silent' });
		service.fakes[0].emit({ type: 'message', data: 'x'.repeat(1024 * 1024) });
		service.fakes[0].emit({ type: 'message', data: 'y'.repeat(1024 * 1024 + 10), size: 1048586 });

		assert.deepStrictEqual(events.map(event => event.type), ['message', 'message', 'info']);
		assert.strictEqual(events[0].data?.length, 1024 * 1024);
		assert.strictEqual(events[1].data?.length, 1024 * 1024);
		assert.strictEqual(events[1].size, 1048586);
		assert.ok(events[2].text?.includes('1 MB'), events[2].text);
	});

	test('opening an id that is open closes the old connection first', async () => {
		const { service, events } = create();
		await service.open('a', { kind: 'ws', url: 'fake://silent' });
		service.fakes[0].emit({ type: 'open', text: 'first' });
		await service.open('a', { kind: 'ws', url: 'fake://silent' });
		service.fakes[1].emit({ type: 'open', text: 'second' });
		service.fakes[0].emit({ type: 'message', data: 'from the old one' });

		assert.deepStrictEqual(events.map(event => [event.type, event.text]), [['open', 'first'], ['close', undefined], ['open', 'second']]);
		assert.strictEqual(service.fakes[0].closes, 1);
		await service.send('a', { data: 'to the new one' });
		assert.deepStrictEqual(service.fakes.map(fake => fake.sent.length), [0, 1]);
	});

	test('an error is followed by a close even when the module forgets; disposing closes everything', async () => {
		const { service, types } = create();
		await service.open('a', { kind: 'ws', url: 'fake://silent' });
		await service.open('b', { kind: 'ws', url: 'fake://polite' });
		service.fakes[0].emit({ type: 'error', text: 'broke' });
		assert.deepStrictEqual(types('a'), ['error']);

		service.dispose();
		assert.deepStrictEqual(types('a'), ['error', 'close']);
		assert.deepStrictEqual(types('b'), ['close']);
		assert.deepStrictEqual(service.fakes.map(fake => fake.closes), [1, 1]);
	});

	test('through the IPC channel: a real WebSocket opened, used and closed from the window\'s side', async () => {
		const server = await startWsTestServer({ onPeer: peer => peer.onFrame = frame => void peer.sendFrame(frame.opcode, frame.payload) });
		servers.push(server);
		const service = store.add(new TestStreams());
		const channel = ProxyChannel.fromService(service, store.add(new DisposableStore()));
		const client = ProxyChannel.toService<IVoltHttpStreams>({
			call: (command: string, arg?: unknown) => channel.call(undefined, command, arg),
			listen: (event: string, arg?: unknown) => channel.listen(undefined, event, arg)
		} as IChannel);
		const events: IVoltHttpStreamEvent[] = [];
		store.add(client.onDidStreamEvent(event => events.push(event)));
		const types = () => events.map(event => event.type);

		await client.open('w1', { kind: 'ws', url: `real:ws://127.0.0.1:${server.port}/` });
		await waitUntil(() => types().includes('open'), 'open');
		await client.send('w1', { data: 'ping me' });
		await waitUntil(() => types().includes('message'), 'the echo');
		await client.close('w1');
		await waitUntil(() => types().includes('close'), 'close');

		assert.deepStrictEqual(types(), ['open', 'sent', 'message', 'close']);
		assert.ok(events.every(event => event.id === 'w1'));
		assert.strictEqual(events[2].data, 'ping me');
		assert.strictEqual(events[3].code, 1000);
		await assert.rejects(() => client.send('w1', { data: 'late' }), /not open/);
	});
});
