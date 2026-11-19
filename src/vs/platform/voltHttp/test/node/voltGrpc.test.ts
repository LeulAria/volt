/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import * as http from 'http';
// eslint-disable-next-line local/code-import-patterns
import * as http2 from 'http2';
import type { AddressInfo } from 'net';
import * as zlib from 'zlib';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { IVoltHttpStreamEvent, IVoltHttpStreamSpec } from '../../common/voltHttpStreams.js';
import { parseProto, ProtoRegistry } from '../../common/voltProto.js';
import { describeGrpc, openGrpcCall } from '../../node/voltGrpc.js';
import { IVoltStreamConnection } from '../../node/voltStreamConnection.js';

const PROTO = `syntax = "proto3";
package test.v1;
service Users {
	rpc Get (GetRequest) returns (User);
	rpc List (ListRequest) returns (stream User);
	rpc Create (stream User) returns (Summary);
	rpc Chat (stream ChatMessage) returns (stream ChatMessage);
	rpc Fail (GetRequest) returns (User);
	rpc Zip (GetRequest) returns (User);
	rpc Hang (GetRequest) returns (User);
	rpc Plain (GetRequest) returns (User);
}
message GetRequest { string id = 1; }
message ListRequest { int32 count = 1; }
message User { string id = 1; string name = 2; int64 visits = 3; }
message Summary { int32 created = 1; repeated string names = 2; }
message ChatMessage { string text = 1; }`;

const registry = ProtoRegistry.fromProtos({ 'users.proto': PROTO });

/** The FileDescriptorProto of `PROTO` (flat messages, scalar and message fields), for reflection. */
function fileDescriptor(): Uint8Array {
	const file = parseProto(PROTO, 'users.proto');
	const short = (name: string) => name.slice(file.package.length + 1);
	return registry.encode('google.protobuf.FileDescriptorProto', {
		name: file.name,
		package: file.package,
		syntax: 'proto3',
		dependency: ['missing/options.proto'],
		messageType: file.messages.map(message => ({
			name: short(message.fullName),
			field: message.fields.map(field => ({
				name: field.name, number: field.number, jsonName: field.jsonName,
				label: field.repeated ? 'LABEL_REPEATED' : 'LABEL_OPTIONAL',
				type: `TYPE_${field.type.toUpperCase()}`,
			})),
		})),
		service: file.services.map(service => ({
			name: short(service.fullName),
			method: service.methods.map(method => ({
				name: method.name, inputType: `.${file.package}.${method.inputType}`, outputType: `.${file.package}.${method.outputType}`,
				clientStreaming: method.clientStreaming, serverStreaming: method.serverStreaming,
			})),
		})),
	});
}

function frame(payload: Uint8Array, compressed = false): Buffer {
	const out = Buffer.alloc(5 + payload.length);
	out.writeUInt8(compressed ? 1 : 0, 0);
	out.writeUInt32BE(payload.length, 1);
	out.set(payload, 5);
	return out;
}

function message(type: string, value: unknown): Buffer {
	return frame(registry.encode(type, value));
}

/** The request messages of a stream, as they complete. */
function onMessages(stream: http2.ServerHttp2Stream, type: string, handler: (value: Record<string, unknown>) => void): void {
	let pending = Buffer.alloc(0);
	stream.on('data', (chunk: Buffer) => {
		pending = Buffer.concat([pending, chunk]);
		while (pending.length >= 5 && pending.length >= 5 + pending.readUInt32BE(1)) {
			const length = pending.readUInt32BE(1);
			handler(registry.decode(type, pending.subarray(5, 5 + length)) as Record<string, unknown>);
			pending = pending.subarray(5 + length);
		}
	});
}

const RESPONSE_HEADERS = { ':status': 200, 'content-type': 'application/grpc+proto' };

/** Answers with the frames (each array item one write, a tick apart) and then the trailers. */
function respond(stream: http2.ServerHttp2Stream, writes: readonly Buffer[], trailers: Record<string, string>, headers: Record<string, string | number> = {}): void {
	stream.respond({ ...RESPONSE_HEADERS, ...headers }, { waitForTrailers: true });
	stream.on('wantTrailers', () => stream.sendTrailers(trailers));
	let i = 0;
	const next = () => {
		if (stream.destroyed) {
			return;
		}
		if (i === writes.length) {
			stream.end();
			return;
		}
		stream.write(writes[i++], () => setTimeout(next, 5));
	};
	next();
}

function trailersOnly(stream: http2.ServerHttp2Stream, status: number, text: string): void {
	stream.respond({ ...RESPONSE_HEADERS, 'grpc-status': String(status), 'grpc-message': encodeURIComponent(text) }, { endStream: true });
}

interface ITestServer {
	readonly url: string;
	readonly port: number;
	/** The request headers of every call, in order. */
	readonly calls: http2.IncomingHttpHeaders[];
	/** How each stream ended: `path:rstCode`. */
	readonly ended: string[];
	close(): Promise<void>;
}

const USERS: Record<string, Record<string, unknown>> = {
	u1: { id: 'u1', name: 'Ann', visits: '9007199254740993' },
	u2: { id: 'u2', name: 'Bob', visits: '0' },
};

async function startServer(reflection: 'none' | 'v1' | 'v1alpha'): Promise<ITestServer> {
	const calls: http2.IncomingHttpHeaders[] = [];
	const ended: string[] = [];
	const sessions = new Set<http2.ServerHttp2Session>();
	const server = http2.createServer();
	server.on('session', session => {
		sessions.add(session);
		session.on('close', () => sessions.delete(session));
	});
	server.on('stream', (stream, headers) => {
		calls.push(headers);
		const path = String(headers[':path']);
		stream.on('error', () => { });
		stream.on('close', () => ended.push(`${path}:${stream.rstCode}`));
		switch (path) {
			case '/test.v1.Users/Get':
				onMessages(stream, 'test.v1.GetRequest', request => {
					const user = USERS[String(request['id'])];
					if (user) {
						respond(stream, [message('test.v1.User', user)], { 'grpc-status': '0', 'x-served-by': 'test', 'x-trace-bin': 'AQID' }, { 'x-request-id': 'r-1' });
					} else {
						respond(stream, [], { 'grpc-status': '5', 'grpc-message': 'no%20such%20user%3A%20' + encodeURIComponent(String(request['id'])) });
					}
				});
				break;
			case '/test.v1.Users/List': {
				onMessages(stream, 'test.v1.ListRequest', () => {
					const all = Buffer.concat([message('test.v1.User', USERS['u1']), message('test.v1.User', USERS['u2']), message('test.v1.User', { id: 'u3', name: 'Cy' }), message('test.v1.User', {})]);
					// The first message in three pieces (its length prefix split too), the others in one.
					respond(stream, [all.subarray(0, 3), all.subarray(3, 9), all.subarray(9)], { 'grpc-status': '0' });
				});
				break;
			}
			case '/test.v1.Users/Create': {
				const names: string[] = [];
				onMessages(stream, 'test.v1.User', user => names.push(String(user['name'])));
				stream.on('end', () => respond(stream, [message('test.v1.Summary', { created: names.length, names })], { 'grpc-status': '0' }));
				break;
			}
			case '/test.v1.Users/Chat': {
				stream.respond(RESPONSE_HEADERS, { waitForTrailers: true });
				stream.on('wantTrailers', () => stream.sendTrailers({ 'grpc-status': '0' }));
				onMessages(stream, 'test.v1.ChatMessage', chat => stream.write(message('test.v1.ChatMessage', { text: `echo ${String(chat['text'])}` })));
				stream.on('end', () => stream.end());
				break;
			}
			case '/test.v1.Users/Fail':
				trailersOnly(stream, 7, 'not allowed \u2713');
				break;
			case '/test.v1.Users/Zip':
				respond(stream, [frame(zlib.gzipSync(registry.encode('test.v1.User', USERS['u1'])), true)], { 'grpc-status': '0' }, { 'grpc-encoding': 'gzip' });
				break;
			case '/test.v1.Users/Hang':
				stream.respond(RESPONSE_HEADERS);
				break;
			case '/test.v1.Users/Plain':
				stream.respond({ ':status': 404, 'content-type': 'text/plain' });
				stream.end('not found');
				break;
			case '/grpc.reflection.v1.ServerReflection/ServerReflectionInfo':
			case '/grpc.reflection.v1alpha.ServerReflection/ServerReflectionInfo': {
				if (reflection === 'none' || (reflection === 'v1alpha' && path.includes('.v1.'))) {
					trailersOnly(stream, 12, 'unknown service');
					break;
				}
				stream.respond(RESPONSE_HEADERS, { waitForTrailers: true });
				stream.on('wantTrailers', () => stream.sendTrailers({ 'grpc-status': '0' }));
				stream.on('end', () => stream.end());
				const reflect = ProtoRegistry.fromProtos({
					'r.proto': `syntax = "proto3"; package r;
						message Request { oneof q { string file_by_filename = 3; string file_containing_symbol = 4; string list_services = 7; } }
						message Response { oneof a { Files files = 4; Services services = 6; Error error = 7; } }
						message Files { repeated bytes file = 1; }
						message Services { repeated Service service = 1; }
						message Service { string name = 1; }
						message Error { int32 code = 1; string message = 2; }` });
				let pending = Buffer.alloc(0);
				stream.on('data', (chunk: Buffer) => {
					pending = Buffer.concat([pending, chunk]);
					while (pending.length >= 5 && pending.length >= 5 + pending.readUInt32BE(1)) {
						const length = pending.readUInt32BE(1);
						const request = reflect.decode('r.Request', pending.subarray(5, 5 + length)) as Record<string, string>;
						pending = pending.subarray(5 + length);
						let answer: unknown;
						if (request['listServices'] !== undefined) {
							answer = { services: { service: [{ name: 'test.v1.Users' }, { name: `grpc.reflection.${reflection}.ServerReflection` }] } };
						} else if (request['fileContainingSymbol'] === 'test.v1.Users' || request['fileByFilename'] === 'users.proto') {
							answer = { files: { file: [Buffer.from(fileDescriptor()).toString('base64')] } };
						} else {
							answer = { error: { code: 5, message: 'not found' } };
						}
						stream.write(frame(reflect.encode('r.Response', answer)));
					}
				});
				break;
			}
			default:
				trailersOnly(stream, 12, `unknown method ${path}`);
		}
	});
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
	const port = (server.address() as AddressInfo).port;
	return {
		url: `127.0.0.1:${port}`, port, calls, ended,
		close: () => new Promise<void>(resolve => {
			server.close(() => resolve());
			for (const session of sessions) {
				session.destroy();
			}
		}),
	};
}

type CallEvent = Omit<IVoltHttpStreamEvent, 'id' | 'at'>;

interface ICall {
	readonly events: CallEvent[];
	readonly connection: IVoltStreamConnection;
	/** Resolves with every event once `close` came. */
	readonly closed: Promise<CallEvent[]>;
	/** Resolves once `count` events of `type` came. */
	seen(type: CallEvent['type'], count: number): Promise<void>;
}

function call(spec: Omit<IVoltHttpStreamSpec, 'kind'>): ICall {
	const events: CallEvent[] = [];
	const waiting: (() => void)[] = [];
	let done: (events: CallEvent[]) => void = () => { };
	const closed = new Promise<CallEvent[]>(resolve => { done = resolve; });
	const connection = openGrpcCall({ kind: 'grpc', ...spec }, event => {
		events.push(event);
		for (const check of waiting.slice()) {
			check();
		}
		if (event.type === 'close') {
			done(events);
		}
	});
	return {
		events, connection, closed,
		seen: (type, count) => new Promise<void>(resolve => {
			const check = () => {
				if (events.filter(event => event.type === type).length >= count) {
					waiting.splice(waiting.indexOf(check), 1);
					resolve();
				}
			};
			waiting.push(check);
			check();
		}),
	};
}

function types(events: readonly CallEvent[]): string {
	return events.map(event => event.type).join(' ');
}

function only(events: readonly CallEvent[], type: CallEvent['type']): CallEvent[] {
	return events.filter(event => event.type === type);
}

suite('VoltGrpc', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	let server: ITestServer;
	const protos = { 'users.proto': PROTO };

	setup(async () => {
		server = await startServer('none');
	});

	teardown(async () => {
		await server.close();
	});

	test('unary: the message goes out, the answer comes back as JSON, trailers and OK follow', async () => {
		const events = await call({
			url: server.url,
			headers: { 'Authorization': 'Bearer t0ken', 'X-Tenant': 'acme', 'data-bin': 'AQIDBA==', 'Content-Type': 'text/plain', 'TE': 'gzip', ':path': '/evil', 'user-agent': 'me', 'grpc-timeout': '5S' },
			grpc: { service: 'test.v1.Users', method: 'Get', protos, message: '{"id":"u1"}' },
		}).closed;

		assert.strictEqual(types(events), 'info sent open message info close');
		assert.strictEqual(events[0].text, `Calling test.v1.Users/Get on ${server.url}`);
		assert.deepStrictEqual(events[1], { type: 'sent', target: 'Get', data: '{\n  "id": "u1"\n}', size: 4 });
		assert.strictEqual(events[2].status, 200);
		assert.strictEqual(events[2].text, 'test.v1.Users/Get (unary)');
		assert.strictEqual(events[2].headers?.['content-type'], 'application/grpc+proto');
		assert.strictEqual(events[2].headers?.['x-request-id'], 'r-1');
		assert.strictEqual(events[2].headers?.[':status'], undefined);
		assert.deepStrictEqual(events[3], { type: 'message', target: 'Get', data: '{\n  "id": "u1",\n  "name": "Ann",\n  "visits": "9007199254740993"\n}', size: 18 });
		assert.deepStrictEqual(events[4], { type: 'info', text: 'Trailers', headers: { 'x-served-by': 'test', 'x-trace-bin': 'AQID' } });
		assert.deepStrictEqual(events[5], { type: 'close', code: 0, text: 'OK' });

		// What the server saw: the call's own headers, the metadata in lower case, nothing reserved replaced.
		const headers = server.calls[0];
		assert.strictEqual(headers[':method'], 'POST');
		assert.strictEqual(headers[':path'], '/test.v1.Users/Get');
		assert.strictEqual(headers[':scheme'], 'http');
		assert.strictEqual(headers['content-type'], 'application/grpc+proto');
		assert.strictEqual(headers['te'], 'trailers');
		assert.strictEqual(headers['grpc-accept-encoding'], 'identity,gzip');
		assert.strictEqual(headers['user-agent'], 'volt-client');
		assert.strictEqual(headers['authorization'], 'Bearer t0ken');
		assert.strictEqual(headers['x-tenant'], 'acme');
		assert.strictEqual(headers['data-bin'], 'AQIDBA==');
		assert.strictEqual(headers['grpc-timeout'], '5S');
	});

	test('unary: no message means an empty one; a status that is not OK is an error with its message', async () => {
		const events = await call({ url: `http://${server.url}`, grpc: { service: 'test.v1.Users', method: 'Get', protos } }).closed;
		assert.strictEqual(types(events), 'info sent open error close');
		assert.deepStrictEqual(events[1], { type: 'sent', target: 'Get', data: '{}', size: 0 });
		assert.deepStrictEqual(events[3], { type: 'error', text: 'NOT_FOUND: no such user: ' });
		assert.deepStrictEqual(events[4], { type: 'close', code: 5, text: 'NOT_FOUND: no such user: ' });

		const named = await call({ url: `grpc://${server.url}`, grpc: { service: 'test.v1.Users', method: 'Get', protos, message: ' { "id": "who?" } ' } }).closed;
		assert.deepStrictEqual(named[named.length - 1], { type: 'close', code: 5, text: 'NOT_FOUND: no such user: who?' });
	});

	test('server streaming: several messages, split and merged across chunks', async () => {
		const events = await call({ url: server.url, grpc: { service: 'test.v1.Users', method: 'List', protos, message: '{"count":3}' } }).closed;
		assert.strictEqual(types(events), 'info sent open message message message message close');
		assert.strictEqual(events[2].text, 'test.v1.Users/List (server streaming)');
		assert.deepStrictEqual(only(events, 'message').map(event => JSON.parse(event.data!)), [
			{ id: 'u1', name: 'Ann', visits: '9007199254740993' },
			{ id: 'u2', name: 'Bob', visits: '0' },
			{ id: 'u3', name: 'Cy', visits: '0' },
			{ id: '', name: '', visits: '0' },
		]);
		assert.deepStrictEqual(only(events, 'message').map(event => `${event.target}:${event.size}`), ['List:18', 'List:9', 'List:8', 'List:0']);
		assert.deepStrictEqual(events[events.length - 1], { type: 'close', code: 0, text: 'OK' });
	});

	test('client streaming: messages sent one by one, then the half-close brings the answer', async () => {
		const running = call({ url: server.url, grpc: { service: 'test.v1.Users', method: 'Create', protos, message: '{"name":"first"}' } });
		// Before the call is up: kept and sent in order.
		running.connection.send({ data: '{"name":"second"}' });
		await running.seen('sent', 2);
		running.connection.send({ data: '{"name":"third","visits":"5"}' });
		await running.seen('sent', 3);
		assert.throws(() => running.connection.send({ data: '{"name":5}' }), /^ProtoError: name: expected a string$/);
		assert.throws(() => running.connection.send({ data: '{"name":' }), /The message is not valid JSON/);
		assert.strictEqual(only(running.events, 'close').length, 0);
		running.connection.send({ data: '{"name":"last"}', end: true });
		assert.throws(() => running.connection.send({ data: '{"name":"late"}' }), /The request side of this call is closed; no more messages can be sent\./);

		const events = await running.closed;
		assert.strictEqual(types(events), 'info sent sent sent sent open message close');
		assert.strictEqual(events[5].text, 'test.v1.Users/Create (client streaming)');
		assert.deepStrictEqual(JSON.parse(only(events, 'message')[0].data!), { created: 4, names: ['first', 'second', 'third', 'last'] });
		assert.deepStrictEqual(events[events.length - 1], { type: 'close', code: 0, text: 'OK' });
		assert.throws(() => running.connection.send({ data: '{}' }), /The call is over\./);
	});

	test('client streaming: no first message, and a half-close that carries none', async () => {
		const running = call({ url: server.url, grpc: { service: 'test.v1.Users', method: 'Create', protos } });
		await running.seen('info', 1);
		assert.strictEqual(types(running.events), 'info');
		running.connection.send({ data: '', end: true });
		const events = await running.closed;
		assert.strictEqual(types(events), 'info open message close');
		assert.deepStrictEqual(JSON.parse(only(events, 'message')[0].data!), { created: 0, names: [] });
	});

	test('bidirectional: each message is answered while the call stays open', async () => {
		const running = call({ url: server.url, grpc: { service: 'test.v1.Users', method: 'Chat', protos, message: '{"text":"one"}' } });
		await running.seen('message', 1);
		running.connection.send({ data: '{"text":"two"}' });
		await running.seen('message', 2);
		assert.strictEqual(only(running.events, 'close').length, 0);
		running.connection.send({ data: '', end: true });
		const events = await running.closed;
		assert.strictEqual(only(events, 'open')[0].text, 'test.v1.Users/Chat (bidirectional streaming)');
		assert.deepStrictEqual(only(events, 'message').map(event => JSON.parse(event.data!)), [{ text: 'echo one' }, { text: 'echo two' }]);
		assert.deepStrictEqual(events[events.length - 1], { type: 'close', code: 0, text: 'OK' });
	});

	test('a trailers-only answer: the status is in the headers', async () => {
		const events = await call({ url: server.url, grpc: { service: 'test.v1.Users', method: 'Fail', protos, message: '{}' } }).closed;
		assert.strictEqual(types(events), 'info sent open error close');
		assert.strictEqual(events[2].status, 200);
		assert.deepStrictEqual(events[3], { type: 'error', text: 'PERMISSION_DENIED: not allowed \u2713' });
		assert.deepStrictEqual(events[4], { type: 'close', code: 7, text: 'PERMISSION_DENIED: not allowed \u2713' });
	});

	test('a gzip-compressed message is inflated', async () => {
		const events = await call({ url: server.url, grpc: { service: 'test.v1.Users', method: 'Zip', protos } }).closed;
		assert.strictEqual(types(events), 'info sent open message close');
		assert.deepStrictEqual(JSON.parse(events[3].data!), { id: 'u1', name: 'Ann', visits: '9007199254740993' });
	});

	test('close cancels the call: one close, and the server sees the stream reset', async () => {
		const running = call({ url: server.url, grpc: { service: 'test.v1.Users', method: 'Hang', protos } });
		await running.seen('open', 1);
		running.connection.close();
		running.connection.close();
		const events = await running.closed;
		assert.strictEqual(types(events), 'info sent open close');
		assert.deepStrictEqual(events[3], { type: 'close', code: 1, text: 'CANCELLED' });
		for (let i = 0; i < 200 && server.ended.length === 0; i++) {
			await new Promise(resolve => setTimeout(resolve, 5));
		}
		assert.deepStrictEqual(server.ended, [`/test.v1.Users/Hang:${http2.constants.NGHTTP2_CANCEL}`]);
		assert.throws(() => running.connection.send({ data: '{}' }), /The call is over\./);
		assert.strictEqual(only(running.events, 'close').length, 1);
	});

	test('a first message that does not fit, an unknown method, a bad address: error, then close', async () => {
		const misfit = await call({ url: server.url, grpc: { service: 'test.v1.Users', method: 'Get', protos, message: '{"id":5}' } }).closed;
		assert.deepStrictEqual(misfit, [{ type: 'error', text: 'id: expected a string' }, { type: 'close' }]);
		assert.strictEqual(server.calls.length, 0);

		const notJson = await call({ url: server.url, grpc: { service: 'test.v1.Users', method: 'Get', protos, message: '{id}' } }).closed;
		assert.strictEqual(types(notJson), 'error close');
		assert.ok(notJson[0].text!.startsWith('The message is not valid JSON: '), notJson[0].text);

		const noMethod = await call({ url: server.url, grpc: { service: 'test.v1.Users', method: 'Nope', protos } }).closed;
		assert.strictEqual(types(noMethod), 'error close');
		assert.strictEqual(noMethod[0].text, 'test.v1.Users has no method Nope. It has: Get, List, Create, Chat, Fail, Zip, Hang, Plain.');

		const noService = await call({ url: server.url, grpc: { service: 'test.v1.Other', method: 'Get', protos } }).closed;
		assert.strictEqual(noService[0].text, 'There is no service test.v1.Other. The schema has: test.v1.Users.');

		const badProto = await call({ url: server.url, grpc: { service: 'test.v1.Users', method: 'Get', protos: { 'bad.proto': 'message {' } } }).closed;
		assert.strictEqual(types(badProto), 'error close');
		assert.ok(badProto[0].text!.startsWith('bad.proto:1: '), badProto[0].text);

		const badUrl = await call({ url: 'ftp://example.test', grpc: { service: 'test.v1.Users', method: 'Get', protos } }).closed;
		assert.deepStrictEqual(badUrl, [{ type: 'error', text: 'ftp:// is not a gRPC address. Use host:port, http://, grpc://, https:// or grpcs://.' }, { type: 'close' }]);

		const badHeader = await call({ url: server.url, headers: { 'bad name': 'x' }, grpc: { service: 'test.v1.Users', method: 'Get', protos } }).closed;
		assert.strictEqual(badHeader[0].text, '"bad name" cannot be a metadata name (letters, digits, "-", "_" and "." only).');
	});

	test('connection refused, a server that is not HTTP/2, an answer that is not gRPC', async () => {
		const gone = await startServer('none');
		await gone.close();
		const refused = await call({ url: gone.url, grpc: { service: 'test.v1.Users', method: 'Get', protos } }).closed;
		assert.deepStrictEqual(refused, [{ type: 'error', text: `Could not connect to ${gone.url}: the connection was refused. Is the server running?` }, { type: 'close' }]);

		const plain = http.createServer((_request, response) => response.end('hello'));
		await new Promise<void>(resolve => plain.listen(0, '127.0.0.1', resolve));
		try {
			const where = `127.0.0.1:${(plain.address() as AddressInfo).port}`;
			const events = await call({ url: where, grpc: { service: 'test.v1.Users', method: 'Get', protos } }).closed;
			assert.strictEqual(types(only(events, 'error').concat(only(events, 'close'))), 'error close');
			const text = only(events, 'error')[0].text!;
			assert.ok(text.startsWith(`${where} did not answer as an HTTP/2 server, which gRPC needs`) || text.startsWith(`${where} closed the connection.`), text);
			assert.strictEqual(events[events.length - 1].type, 'close');
		} finally {
			plain.closeAllConnections();
			await new Promise<void>(resolve => plain.close(() => resolve()));
		}

		const notGrpc = await call({ url: server.url, grpc: { service: 'test.v1.Users', method: 'Plain', protos } }).closed;
		assert.strictEqual(types(notGrpc), 'info sent open error close');
		assert.strictEqual(notGrpc[2].status, 404);
		assert.strictEqual(notGrpc[3].text, `${server.url} answered HTTP 404, not a gRPC response.`);
	});

	test('reflection: the schema comes from the server, v1 or else v1alpha', async () => {
		for (const version of ['v1', 'v1alpha'] as const) {
			const reflecting = await startServer(version);
			try {
				const events = await call({ url: reflecting.url, headers: { authorization: 'Bearer r' }, grpc: { service: 'test.v1.Users', method: 'Get', message: '{"id":"u2"}' } }).closed;
				assert.strictEqual(types(events), 'info sent open message info close', version);
				assert.deepStrictEqual(JSON.parse(only(events, 'message')[0].data!), { id: 'u2', name: 'Bob', visits: '0' });
				const paths = reflecting.calls.map(headers => headers[':path']);
				assert.deepStrictEqual(paths, version === 'v1'
					? ['/grpc.reflection.v1.ServerReflection/ServerReflectionInfo', '/test.v1.Users/Get']
					: ['/grpc.reflection.v1.ServerReflection/ServerReflectionInfo', '/grpc.reflection.v1alpha.ServerReflection/ServerReflectionInfo', '/test.v1.Users/Get']);
				// Metadata goes with the reflection call too (a server may ask for the same credentials).
				assert.ok(reflecting.calls.every(headers => headers['authorization'] === 'Bearer r'));

				const services = await describeGrpc(reflecting.url, undefined, undefined);
				assert.deepStrictEqual(services.map(service => service.name), ['test.v1.Users']);
				assert.deepStrictEqual(services[0].methods.map(method => `${method.name}:${method.clientStreaming}:${method.serverStreaming}`), [
					'Get:false:false', 'List:false:true', 'Create:true:false', 'Chat:true:true', 'Fail:false:false', 'Zip:false:false', 'Hang:false:false', 'Plain:false:false',
				]);
				assert.strictEqual(services[0].methods[0].template, '{\n  "id": ""\n}');
				assert.strictEqual(services[0].methods[2].template, '{\n  "id": "",\n  "name": "",\n  "visits": "0"\n}');

				const unknown = await call({ url: reflecting.url, grpc: { service: 'test.v1.Missing', method: 'Get' } }).closed;
				assert.deepStrictEqual(unknown, [{ type: 'error', text: 'The server\'s reflection does not know test.v1.Missing (not found).' }, { type: 'close' }]);
			} finally {
				await reflecting.close();
			}
		}
	});

	test('no reflection and no protos: says what to do', async () => {
		const events = await call({ url: server.url, grpc: { service: 'test.v1.Users', method: 'Get', message: '{"id":"u1"}' } }).closed;
		assert.deepStrictEqual(events, [{ type: 'error', text: 'This server does not offer reflection. Add the .proto file to the request.' }, { type: 'close' }]);
		await assert.rejects(describeGrpc(server.url, undefined, undefined), /^Error: This server does not offer reflection\. Add the \.proto file to the request\.$/);
		await assert.rejects(describeGrpc(server.url, undefined, {}), /does not offer reflection/);
	});

	test('describeGrpc from protos needs no server', async () => {
		const services = await describeGrpc('127.0.0.1:1', undefined, protos);
		assert.deepStrictEqual(services.map(service => service.name), ['test.v1.Users']);
		assert.strictEqual(services[0].methods.length, 8);
		assert.deepStrictEqual(services[0].methods[1], { name: 'List', clientStreaming: false, serverStreaming: true, template: '{\n  "count": 0\n}' });

		const gone = await startServer('none');
		await gone.close();
		await assert.rejects(describeGrpc(gone.url, undefined, undefined), /the connection was refused/);
	});
});
