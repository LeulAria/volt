/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * `volt-plugin/1` (spec H.3) without processes: framing and its limits, the identity rule (IPC-1),
 * schemas, deadlines, cancellation and backpressure, with two `PluginRpc` ends wired together.
 * The same rules over a real sandboxed host are in `test/node/pluginHost.test.ts`.
 */

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { apiVersionSatisfies, encodeMessage, FrameDecoder, IPluginMethod, PLUGIN_PROTOCOL_LIMITS, PluginProtocolError, PluginProtocolLimits, PluginSchema, validatePluginValue, VoltPluginError } from '../../common/pluginProtocol.js';
import { IPluginRpcHandlers, PluginRpc } from '../../common/pluginRpc.js';

const ECHO: Readonly<Record<string, IPluginMethod>> = {
	'echo': { params: { type: 'object', properties: { text: { type: 'string', maxLength: 32 }, data: { type: 'bytes' } } }, result: { type: 'object', properties: { text: { type: 'string' }, data: { type: 'bytes' } } } },
	'slow': { params: { type: 'object', properties: { ms: { type: 'integer', minimum: 0 } }, required: ['ms'] }, result: { type: 'object', properties: {} } },
	'bad': { params: { type: 'object', properties: {} }, result: { type: 'object', properties: { n: { type: 'integer' } }, required: ['n'] } },
};

function pair(serve: Partial<IPluginRpcHandlers> = {}, limits: Partial<PluginProtocolLimits> = {}, clientLimits = limits): { client: PluginRpc; server: PluginRpc; cancelled: number[]; fatal: PluginProtocolError[] } {
	const cancelled: number[] = [];
	const fatal: PluginProtocolError[] = [];
	const ends: { server?: PluginRpc } = {};
	const client: PluginRpc = new PluginRpc({
		write: bytes => queueMicrotask(() => ends.server!.receive(bytes.slice())),
		handlers: { methods: {}, notifications: {}, handleRequest: () => Promise.reject(new Error('no')) },
		remote: ECHO,
		limits: clientLimits,
	});
	const server = ends.server = new PluginRpc({
		write: bytes => queueMicrotask(() => client.receive(bytes.slice())),
		handlers: {
			methods: ECHO,
			notifications: { '$/cancel': { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] } },
			handleRequest: async (method, params, signal) => {
				const p = params as { text?: string; data?: Uint8Array; ms?: number };
				if (method === 'slow') {
					await new Promise<void>(resolve => {
						const timer = setTimeout(resolve, p.ms);
						signal.addEventListener('abort', () => { clearTimeout(timer); cancelled.push(p.ms!); resolve(); });
					});
					return {};
				}
				if (method === 'bad') {
					return { n: 'not a number' };
				}
				return { ...(p.text !== undefined ? { text: p.text } : {}), ...(p.data ? { data: p.data } : {}) };
			},
			...serve,
		},
		remote: {},
		limits,
		onFatal: error => fatal.push(error),
	});
	return { client, server, cancelled, fatal };
}

async function rejects(promise: Promise<unknown>, type: VoltPluginError['type'], pattern?: RegExp): Promise<VoltPluginError> {
	try {
		await promise;
	} catch (err) {
		assert.ok(err instanceof VoltPluginError, `a typed error, got ${err}`);
		assert.strictEqual(err.type, type, err.message);
		if (pattern) {
			assert.match(err.message, pattern);
		}
		return err;
	}
	assert.fail(`expected ${type}`);
}

suite('volt-plugin/1 protocol (H.3)', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('T2-RPC-1: a frame is a 4-byte big-endian length and UTF-8 JSON; split anywhere, it decodes the same', () => {
		const frames = encodeMessage({ jsonrpc: '2.0', id: 7, method: 'echo', params: { text: 'h\u00e9llo' } }, () => 1);
		assert.strictEqual(frames.length, 2);
		const length = new DataView(frames[0].buffer).getUint32(0, false);
		assert.strictEqual(length, frames[1].byteLength);
		assert.strictEqual(new TextDecoder().decode(frames[1]), '{"jsonrpc":"2.0","id":7,"method":"echo","params":{"text":"h\u00e9llo"}}');
		const bytes = new Uint8Array([...frames[0], ...frames[1], ...frames[0], ...frames[1]]);
		for (const cut of [1, 3, 4, 5, 20, bytes.length - 1]) {
			const decoder = new FrameDecoder();
			const out = [...decoder.push(bytes.subarray(0, cut)), ...decoder.push(bytes.subarray(cut))];
			assert.strictEqual(out.length, 2, `cut at ${cut}`);
			assert.deepStrictEqual(out[0], { jsonrpc: '2.0', id: 7, method: 'echo', params: { text: 'h\u00e9llo' } });
		}
	});

	test('T2-RPC-2: binary payloads travel as their own frames, named by id; a dangling reference breaks the stream', () => {
		let id = 0;
		const data = new Uint8Array([0, 1, 2, 255]);
		const frames = encodeMessage({ jsonrpc: '2.0', id: 1, method: 'echo', params: { data } }, () => ++id);
		assert.strictEqual(frames.length, 5, 'header + id + bytes, then the JSON frame');
		assert.ok(new DataView(frames[0].buffer).getUint32(0, false) & 0x80000000, 'the binary flag');
		const decoded = new FrameDecoder().push(new Uint8Array(frames.flatMap(frame => [...frame]))) as { params: { data: Uint8Array } }[];
		assert.deepStrictEqual([...decoded[0].params.data], [0, 1, 2, 255]);
		const json = encodeMessage({ jsonrpc: '2.0', method: 'x', params: { data: { $bin: 9 } } } as never, () => 1);
		assert.throws(() => new FrameDecoder().push(new Uint8Array(json.flatMap(frame => [...frame]))), PluginProtocolError);
	});

	test('T2-RPC-3: frames over the 16 MiB limit are refused at both ends: never sent, and fatal when received', () => {
		assert.strictEqual(PLUGIN_PROTOCOL_LIMITS.maxFrameBytes, 16 * 1024 * 1024);
		assert.throws(() => encodeMessage({ jsonrpc: '2.0', method: 'x', params: { text: 'a'.repeat(PLUGIN_PROTOCOL_LIMITS.maxFrameBytes) } }, () => 1), (err: VoltPluginError) => err.type === 'InvalidArgument');
		const header = new Uint8Array(4);
		new DataView(header.buffer).setUint32(0, PLUGIN_PROTOCOL_LIMITS.maxFrameBytes + 1, false);
		assert.throws(() => new FrameDecoder().push(header), /over the 16777216-byte limit/, 'refused from the length alone, before buffering the body');
		const notJson = new Uint8Array([0, 0, 0, 3, 0x7b, 0x7b, 0x7b]);
		assert.throws(() => new FrameDecoder().push(notJson), /not JSON/);
		const notUtf8 = new Uint8Array([0, 0, 0, 2, 0xc3, 0x28]);
		assert.throws(() => new FrameDecoder().push(notUtf8), /not UTF-8/);
	});

	test('IPC-1: a payload naming extensionId, principal or caller, at any depth, is refused', () => {
		const schema: PluginSchema = { type: 'object', properties: { args: { type: 'object', properties: {}, values: { type: 'json' } } } };
		for (const field of ['extensionId', 'principal', 'caller']) {
			assert.throws(() => validatePluginValue({ [field]: 'volt.other' }, { type: 'object', properties: { [field]: { type: 'string' } } }), /identity is the channel's/, `${field} even where a schema names it`);
			assert.throws(() => validatePluginValue({ args: { deep: [{ x: { [field]: 'x' } }] } }, schema), /identity is the channel's/, `${field} nested in free-form arguments`);
		}
		validatePluginValue({ args: { callerName: 'fine', principalText: 'fine' } }, schema);
	});

	test('IPC-1: identity claimed in the envelope, beside JSON-RPC\'s fields, is no message: the stream breaks', () => {
		for (const field of ['principal', 'extensionId', 'caller', 'onBehalfOf', 'subject']) {
			const { server, fatal } = pair();
			const [head, body] = encodeMessage({ jsonrpc: '2.0', id: 1, method: 'echo', params: { text: 'a' }, [field]: 'plugin:volt.other@volt' } as never, () => 1);
			server.receive(new Uint8Array([...head, ...body]));
			assert.strictEqual(fatal.length, 1, field);
			assert.match(fatal[0].message, /not a JSON-RPC 2.0 message/);
			assert.ok(server.isClosed, `${field}: the channel closed`);
		}
	});

	test('T2-RPC-4: schemas refuse unknown fields, wrong types, non-NFC and over-long strings, and deep nesting', () => {
		const schema: PluginSchema = { type: 'object', properties: { name: { type: 'string', maxLength: 5 }, n: { type: 'integer', minimum: 0 } }, required: ['name'] };
		validatePluginValue({ name: 'abc', n: 2 }, schema);
		assert.throws(() => validatePluginValue({ name: 'abc', extra: 1 }, schema), /unknown field/);
		assert.throws(() => validatePluginValue({ n: 1 }, schema), /is required/);
		assert.throws(() => validatePluginValue({ name: 'abcdef' }, schema), /longer than 5/);
		assert.throws(() => validatePluginValue({ name: 'e\u0301' }, schema), /NFC/);
		assert.throws(() => validatePluginValue({ name: 'a', n: -1 }, schema), /whole number/);
		assert.throws(() => validatePluginValue({ name: 'a', n: 1.5 }, schema), /whole number/);
		let deep: unknown = 1;
		for (let i = 0; i < 40; i++) {
			deep = [deep];
		}
		assert.throws(() => validatePluginValue(deep, { type: 'json' }), /nested deeper/);
	});

	test('T2-RPC-5: requests round-trip, with bytes; params that fail the schema come back InvalidArgument; unknown methods NotFound', async () => {
		const { client } = pair();
		assert.deepStrictEqual(await client.request('echo', { text: 'hi' }), { text: 'hi' });
		const back = await client.request('echo', { data: new Uint8Array([9, 8]) }) as { data: Uint8Array };
		assert.deepStrictEqual([...back.data], [9, 8]);
		await rejects(client.request('echo', { text: 'x'.repeat(33) }), 'InvalidArgument', /longer than 32/);
		await rejects(client.request('echo', { text: 'hi', principal: 'plugin:other@local' }), 'InvalidArgument', /identity/);
		await rejects(client.request('nope', {}), 'NotFound');
		await rejects(client.request('bad', {}), 'Internal', /malformed result/);
		client.close();
	});

	test('T2-RPC-6: deadlines: a request past its deadline is DeadlineExceeded and the other end is cancelled; a caller can cancel too', async () => {
		const { client, cancelled } = pair();
		await rejects(client.request('slow', { ms: 5_000 }, { deadlineMs: 50 }), 'DeadlineExceeded');
		const controller = new AbortController();
		const pending = client.request('slow', { ms: 4_000 }, { signal: controller.signal });
		setTimeout(() => controller.abort(), 20);
		await rejects(pending, 'Cancelled');
		await new Promise(resolve => setTimeout(resolve, 20));
		assert.deepStrictEqual(cancelled.sort(), [4000, 5000], 'the handlers saw $/cancel');
		assert.strictEqual(client.inFlight, 0);
		assert.strictEqual(PLUGIN_PROTOCOL_LIMITS.defaultDeadlineMs, 30_000);
		assert.strictEqual(PLUGIN_PROTOCOL_LIMITS.maxDeadlineMs, 600_000);
		client.close();
	});

	test('T2-RPC-7: backpressure: at most 64 requests in flight per direction, then RateLimited; and a token bucket on calls per second', async () => {
		const { client, server } = pair();
		const slow = Array.from({ length: 64 }, () => client.request('slow', { ms: 200 }));
		await rejects(client.request('echo', { text: 'x' }), 'RateLimited', /64 requests are in flight/);
		await Promise.all(slow);
		assert.deepStrictEqual(await client.request('echo', { text: 'after' }), { text: 'after' });
		client.close();
		server.close();
		// The receiving end enforces its own limit too: a sender that ignores it gets RateLimited answers.
		const flood = pair({}, {}, { maxInFlight: 1000 });
		const answers = await Promise.allSettled(Array.from({ length: 70 }, () => flood.client.request('slow', { ms: 100 })));
		const refused = answers.filter(answer => answer.status === 'rejected');
		assert.strictEqual(refused.length, 6, 'the 6 over the receiver\'s 64 are refused there');
		assert.ok(refused.every(answer => (answer.reason as VoltPluginError).type === 'RateLimited'));
		flood.client.close();
		// Rate: a burst of 3 at 1 call per second.
		const rated = pair({}, { burst: 3, callsPerSecond: 1 });
		const results = await Promise.allSettled(Array.from({ length: 5 }, () => rated.client.request('echo', { text: 'r' })));
		assert.deepStrictEqual(results.map(result => result.status === 'fulfilled' ? 'ok' : (result.reason as VoltPluginError).type), ['ok', 'ok', 'ok', 'RateLimited', 'RateLimited']);
		rated.client.close();
	});

	test('T2-RPC-8: a broken stream is fatal: pending requests fail Cancelled and the channel closes', async () => {
		const { client, server, fatal } = pair();
		const pending = client.request('slow', { ms: 5_000 });
		server.receive(new Uint8Array([0, 0, 0, 3, 0x5b, 0x31, 0x5d]));
		assert.strictEqual(fatal.length, 1, `fatal: ${fatal.map(f => f.message)}`);
		assert.match(fatal[0].message, /not a JSON-RPC 2.0 message/);
		assert.ok(server.isClosed);
		client.close();
		await rejects(pending, 'Cancelled');
	});

	test('T2-RPC-9: typed errors keep their type and the capability fields across the wire', async () => {
		const { client } = pair({ handleRequest: () => Promise.reject(new VoltPluginError('VoltCapabilityError', 'denied', { capability: 'files.write', target: '/x', deniedBy: 'authority' })) });
		const error = await rejects(client.request('echo', { text: 'a' }), 'VoltCapabilityError');
		assert.deepStrictEqual(error.capability, { capability: 'files.write', target: '/x', deniedBy: 'authority' });
		client.close();
	});

	test('H.4: engines.volt ranges against the running API', () => {
		assert.ok(apiVersionSatisfies('1.0.0', '^1.0.0'));
		assert.ok(apiVersionSatisfies('1.4.2', '^1.0.0'));
		assert.ok(!apiVersionSatisfies('2.0.0', '^1.0.0'));
		assert.ok(!apiVersionSatisfies('1.0.0', '^1.1.0'));
		assert.ok(apiVersionSatisfies('1.0.0', '1.x'));
		assert.ok(apiVersionSatisfies('1.0.0', '*'));
		assert.ok(!apiVersionSatisfies('1.0.0', '>=1.2.0'));
		assert.ok(apiVersionSatisfies('1.2.5', '~1.2.0'));
		assert.ok(!apiVersionSatisfies('1.3.0', '~1.2.0'));
		assert.ok(!apiVersionSatisfies('1.0.0', 'garbage'));
	});
});
