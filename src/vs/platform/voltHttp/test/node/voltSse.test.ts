/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import * as http from 'http';
import type { AddressInfo } from 'net';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { IVoltHttpStreamSpec } from '../../common/voltHttpStreams.js';
import { IVoltSseEvent, openSse, VoltSseParser } from '../../node/voltSse.js';
import { IVoltStreamConnection } from '../../node/voltStreamConnection.js';
import { delay, EventLog } from './streamTestUtils.js';

suite('Volt Client streams: server-sent events', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const servers: http.Server[] = [];
	const connections: IVoltStreamConnection[] = [];

	teardown(async () => {
		for (const connection of connections.splice(0)) {
			connection.close();
		}
		await Promise.all(servers.splice(0).map(server => {
			server.closeAllConnections();
			return new Promise(resolve => server.close(resolve));
		}));
	});

	async function serve(handler: (request: http.IncomingMessage, response: http.ServerResponse) => void): Promise<string> {
		const server = http.createServer(handler);
		servers.push(server);
		await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
		return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	}

	function connect(spec: Omit<IVoltHttpStreamSpec, 'kind'>): { log: EventLog; connection: IVoltStreamConnection } {
		const log = new EventLog();
		const connection = openSse({ kind: 'sse', ...spec }, log.emit);
		connections.push(connection);
		return { log, connection };
	}

	function parse(chunks: (string | Uint8Array)[]): { events: IVoltSseEvent[]; retries: number[] } {
		const events: IVoltSseEvent[] = [];
		const retries: number[] = [];
		const parser = new VoltSseParser(event => events.push(event), retry => retries.push(retry));
		for (const chunk of chunks) {
			parser.push(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk);
		}
		return { events, retries };
	}

	test('parser: multi-line data, names, ids, comments, retry and every line ending', () => {
		const { events, retries } = parse([
			'\uFEFF: a comment\n',
			'data: first\ndata: second\n\n',
			'event: tick\r\nid: 7\r\ndata:{"n":1}\r\n\r\n',
			'data: cr only\r\rretry: 2500\n',
			'event: ignored without data\n\n',
			'data\n\n',
			'id: 9\ndata:  two spaces\nunknown: field\n\n',
			'data: never dispatched'
		]);
		assert.deepStrictEqual(events, [
			{ event: '', data: 'first\nsecond', id: undefined },
			{ event: 'tick', data: '{"n":1}', id: '7' },
			{ event: '', data: 'cr only', id: undefined },
			{ event: '', data: '', id: undefined },
			{ event: '', data: ' two spaces', id: '9' }
		]);
		assert.deepStrictEqual(retries, [2500]);
	});

	test('parser: a multi-byte character and a CRLF split across chunks', () => {
		const bytes = Buffer.from('data: café \u{1F600}\r\n\r\ndata: next\r\n\r\n', 'utf8');
		for (let split = 1; split < bytes.length; split++) {
			const { events } = parse([bytes.subarray(0, split), bytes.subarray(split)]);
			assert.deepStrictEqual(events.map(event => event.data), ['café \u{1F600}', 'next'], `split at ${split}`);
		}
		const single = parse(Array.from(bytes, byte => Uint8Array.of(byte)));
		assert.deepStrictEqual(single.events.map(event => event.data), ['café \u{1F600}', 'next']);
	});

	test('an event stream: open with status and headers, each event a message, close when the server ends', async () => {
		let seen: http.IncomingHttpHeaders = {};
		const base = await serve(async (request, response) => {
			seen = request.headers;
			response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'x-stream': 'yes' });
			response.write(': hello\n\ndata: line one\ndata: line two\n\n');
			await delay(10);
			response.write('event: tick\nid: 42\ndata: {"n":1}\n\n');
			await delay(10);
			const euro = Buffer.from('data: price €5\n\n', 'utf8');
			response.write(euro.subarray(0, 13));
			await delay(20);
			response.write(euro.subarray(13));
			await delay(10);
			response.end('event: message\ndata: last\n\n');
		});
		const { log, connection } = connect({ url: `${base}/events`, headers: { 'Authorization': 'Bearer t' } });

		const open = await log.next('open');
		assert.strictEqual(open.status, 200);
		assert.strictEqual(open.headers?.['x-stream'], 'yes');
		assert.deepStrictEqual(await log.next('message'), { type: 'message', data: 'line one\nline two', size: 17 });
		assert.deepStrictEqual(await log.next('message'), { type: 'message', target: 'tick', data: '{"n":1}', text: '42', size: 7 });
		assert.strictEqual((await log.next('message')).data, 'price €5');
		const last = await log.next('message');
		assert.strictEqual(last.target, undefined, 'the default event name is left out');
		assert.strictEqual(last.data, 'last');
		await log.next('close');
		assert.deepStrictEqual(log.types(), ['open', 'message', 'message', 'message', 'message', 'close']);

		assert.strictEqual(seen['accept'], 'text/event-stream');
		assert.strictEqual(seen['authorization'], 'Bearer t');
		assert.throws(() => connection.send({ data: 'x' }), /one-way/);
	});

	test('an answer that is not an event stream is still shown: open, the body as one message, close', async () => {
		const base = await serve((request, response) => {
			if (request.url === '/missing') {
				response.writeHead(404, { 'content-type': 'application/json' });
				response.end('{"error":"no such stream"}');
			} else if (request.url === '/big') {
				response.writeHead(200, { 'content-type': 'text/plain' });
				response.end('x'.repeat(300 * 1024));
			} else {
				response.writeHead(204);
				response.end();
			}
		});

		const missing = connect({ url: `${base}/missing` });
		await missing.log.next('close');
		assert.deepStrictEqual(missing.log.types(), ['open', 'message', 'close']);
		assert.strictEqual(missing.log.events[0].status, 404);
		assert.strictEqual(missing.log.events[1].data, '{"error":"no such stream"}');

		const big = connect({ url: `${base}/big` });
		await big.log.next('close');
		assert.deepStrictEqual(big.log.types(), ['open', 'message', 'info', 'close']);
		assert.strictEqual(big.log.events[1].data?.length, 256 * 1024);

		const empty = connect({ url: `${base}/empty` });
		await empty.log.next('close');
		assert.deepStrictEqual(empty.log.types(), ['open', 'close']);
		assert.strictEqual(empty.log.events[0].status, 204);
	});

	test('follows redirects (at most five), sends the method, body and the caller\'s Accept', async () => {
		const requests: { url: string; method: string; accept: string; body: string }[] = [];
		const base = await serve((request, response) => {
			const parts: Buffer[] = [];
			request.on('data', (chunk: Buffer) => parts.push(chunk));
			request.on('end', () => {
				requests.push({ url: request.url ?? '', method: request.method ?? '', accept: String(request.headers['accept']), body: Buffer.concat(parts).toString() });
				if (request.url === '/loop') {
					response.writeHead(302, { location: '/loop' });
					response.end();
				} else if (request.url === '/start') {
					response.writeHead(307, { location: '/stream' });
					response.end();
				} else {
					response.writeHead(200, { 'content-type': 'text/event-stream' });
					response.end('data: arrived\n\n');
				}
			});
		});

		const followed = connect({ url: `${base}/start`, method: 'POST', body: '{"q":1}', headers: { 'Accept': 'application/x-custom', 'Content-Type': 'application/json' } });
		await followed.log.next('close');
		assert.deepStrictEqual(followed.log.types(), ['info', 'open', 'message', 'close']);
		assert.deepStrictEqual(requests, [
			{ url: '/start', method: 'POST', accept: 'application/x-custom', body: '{"q":1}' },
			{ url: '/stream', method: 'POST', accept: 'application/x-custom', body: '{"q":1}' }
		]);

		requests.length = 0;
		const loop = connect({ url: `${base}/loop` });
		const error = await loop.log.next('error');
		assert.ok(error.text?.includes('5 redirects'), error.text);
		await loop.log.next('close');
		assert.strictEqual(requests.length, 6, 'the first request and five redirects');
	});

	test('closing a live stream reports close once; a server that is gone is an error then close', async () => {
		const base = await serve((_request, response) => {
			response.writeHead(200, { 'content-type': 'text/event-stream' });
			response.write('data: one\n\n');
		});
		const { log, connection } = connect({ url: `${base}/forever` });
		await log.next('message');
		connection.close();
		connection.close();
		await delay(30);
		assert.deepStrictEqual(log.types(), ['open', 'message', 'close']);

		const gone = connect({ url: 'http://127.0.0.1:1/events' });
		await gone.log.next('error');
		await gone.log.next('close');
		assert.deepStrictEqual(gone.log.types(), ['error', 'close']);
	});
});
