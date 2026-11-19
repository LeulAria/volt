/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import * as http from 'http';
import type { AddressInfo } from 'net';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { IVoltLoadResult, IVoltLoadSample, IVoltLoadSpec, IVoltLoadTarget, planVoltLoad, VoltLoadHistogram, voltLoadPercentiles } from '../../common/voltHttpLoad.js';
import { IVoltLoadHandle, startVoltLoad, voltLoadEngine, VoltLoadEvent, voltLoadInlineRequire, voltLoadWorkerSource } from '../../node/voltLoad.js';
import { delay, ITestWsServer, startWsTestServer } from './streamTestUtils.js';

interface IRun {
	readonly handle: IVoltLoadHandle;
	readonly samples: IVoltLoadSample[];
	readonly done: Promise<IVoltLoadResult>;
}

/** Runs the engine's function directly, on this thread. */
function start(spec: IVoltLoadSpec): IRun {
	const samples: IVoltLoadSample[] = [];
	let handle!: IVoltLoadHandle;
	const done = new Promise<IVoltLoadResult>(resolve => {
		handle = voltLoadEngine(planVoltLoad(spec), { onSample: sample => samples.push(sample), onDone: resolve }, voltLoadInlineRequire);
	});
	return { handle, samples, done };
}

function get(url: string, extra?: Partial<IVoltLoadTarget>): IVoltLoadTarget {
	return { name: url, method: 'GET', url, headers: [], ...extra };
}

suite('Volt Client load: the engine', function () {

	this.timeout(20_000);

	ensureNoDisposablesAreLeakedInTestSuite();

	const servers: http.Server[] = [];
	const wsServers: ITestWsServer[] = [];
	const runs: IVoltLoadHandle[] = [];

	teardown(async () => {
		for (const run of runs.splice(0)) {
			run.stop();
		}
		await Promise.all(wsServers.splice(0).map(server => server.close()));
		await Promise.all(servers.splice(0).map(server => {
			server.closeAllConnections();
			return new Promise(resolve => server.close(resolve));
		}));
	});

	interface ISeen { readonly method: string; readonly url: string; readonly headers: http.IncomingHttpHeaders; readonly body: string }

	/** A server with a few routes; `seen` holds every request it got. */
	async function serve(extra?: (request: http.IncomingMessage, response: http.ServerResponse) => boolean): Promise<{ readonly base: string; readonly seen: ISeen[]; readonly sockets: Set<unknown> }> {
		const seen: ISeen[] = [];
		const sockets = new Set<unknown>();
		const server = http.createServer((request, response) => {
			sockets.add(request.socket);
			const chunks: Buffer[] = [];
			request.on('data', chunk => chunks.push(chunk));
			request.on('end', () => {
				const path = (request.url ?? '/').split('?')[0];
				seen.push({ method: request.method ?? '', url: request.url ?? '', headers: request.headers, body: Buffer.concat(chunks).toString('utf8') });
				if (extra?.(request, response)) {
					return;
				}
				if (path === '/slow') {
					setTimeout(() => response.end('late'), 1500);
				} else if (path === '/reset') {
					request.socket.destroy();
				} else if (path === '/missing') {
					response.writeHead(404).end('no');
				} else if (path === '/fail') {
					response.writeHead(500).end('boom');
				} else if (path === '/delay') {
					setTimeout(() => response.end('ok'), 20);
				} else {
					response.writeHead(200, { 'Content-Type': 'text/plain' }).end('hello world');
				}
			});
		});
		servers.push(server);
		await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
		return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen, sockets };
	}

	async function closedPort(): Promise<number> {
		const server = http.createServer();
		await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
		const port = (server.address() as AddressInfo).port;
		await new Promise(resolve => server.close(resolve));
		return port;
	}

	test('a request count is met exactly, on keep-alive connections', async () => {
		const { base, seen, sockets } = await serve();
		const run = start({ mode: 'http', targets: [get(`${base}/ok`)], users: 3, requests: 200 });
		runs.push(run.handle);
		const result = await run.done;
		assert.strictEqual(result.ended, 'completed');
		assert.strictEqual(result.count, 200);
		assert.strictEqual(seen.length, 200);
		assert.strictEqual(result.errors, 0);
		assert.strictEqual(result.httpErrors, 0);
		assert.deepStrictEqual(result.statusCodes, { '200': 200 });
		assert.strictEqual(result.latency.n, 200);
		assert.strictEqual(result.targets[0].count, 200);
		assert.strictEqual(result.targets[0].latency.n, 200);
		assert.strictEqual(result.peakUsers, 3);
		assert.ok(sockets.size <= 3, `3 users keep 3 connections, the server saw ${sockets.size}`);
		assert.ok(result.bytesIn >= 200 * 'hello world'.length, `bytes in: ${result.bytesIn}`);
		assert.ok(result.bytesOut > 200 * 20, `bytes out: ${result.bytesOut}`);
		assert.ok(result.rate > 0);
		// The phases: three connections were made, every answer has a first byte.
		assert.strictEqual(result.tcp?.n, 3);
		assert.strictEqual(result.ttfb?.n, 200);
		assert.strictEqual(result.download?.n, 200);
		// The engine's own histogram reads back through the shared one.
		const percentiles = voltLoadPercentiles(result.latency);
		assert.ok(percentiles.min > 0 && percentiles.p50 >= percentiles.min && percentiles.p99 <= percentiles.max, JSON.stringify(percentiles));
		assert.ok(Math.abs(VoltLoadHistogram.from(result.latency).mean - result.latency.sum / 200) < 1e-9);
	});

	test('a duration ends the run and a requests-per-second cap holds', async () => {
		const { base, seen } = await serve();
		const run = start({ mode: 'http', targets: [get(`${base}/ok`)], users: 4, durationSec: 2, rps: 50 });
		runs.push(run.handle);
		const result = await run.done;
		assert.strictEqual(result.ended, 'completed');
		assert.ok(result.durationMs >= 1950 && result.durationMs < 2600, `ran ${result.durationMs} ms`);
		assert.ok(result.count >= 85 && result.count <= 104, `50 a second for 2 s, got ${result.count}`);
		assert.ok(seen.length <= 106);
		assert.ok(result.rate > 40 && result.rate < 53, `rate ${result.rate}`);
		assert.ok(run.samples.length >= 1 && run.samples.length <= 2, `${run.samples.length} samples`);
		assert.ok(run.samples[0].count >= 40 && run.samples[0].count <= 55, `first second: ${run.samples[0].count}`);
		assert.strictEqual(run.samples[0].users, 4);
		assert.strictEqual(run.samples[0].t, 1);
		assert.ok(run.samples[0].p50 > 0 && run.samples[0].p99 >= run.samples[0].p50);
		assert.deepStrictEqual(result.series, run.samples);
	});

	test('think time paces each user', async () => {
		const { base } = await serve();
		const run = start({ mode: 'http', targets: [get(`${base}/ok`)], users: 2, durationSec: 1, thinkMs: 100 });
		runs.push(run.handle);
		const result = await run.done;
		assert.ok(result.count >= 12 && result.count <= 22, `2 users, one request each 100 ms for 1 s: ${result.count}`);
	});

	test('a request that takes too long is a timeout', async () => {
		const { base } = await serve();
		const run = start({ mode: 'http', targets: [get(`${base}/slow`)], users: 3, requests: 6, timeoutMs: 100 });
		runs.push(run.handle);
		const result = await run.done;
		assert.strictEqual(result.count, 6);
		assert.strictEqual(result.errors, 6);
		assert.deepStrictEqual(result.errorKinds, { timeout: 6 });
		assert.strictEqual(result.latency.n, 0, 'a timeout has no latency');
		assert.deepStrictEqual(result.statusCodes, {});
		assert.ok(result.durationMs >= 190 && result.durationMs < 1400, `two rounds of 100 ms: ${result.durationMs}`);
	});

	test('errors are told apart: refused, reset, DNS', async () => {
		const { base } = await serve();
		const refused = start({ mode: 'http', targets: [get(`http://127.0.0.1:${await closedPort()}/`)], users: 2, requests: 4 });
		const reset = start({ mode: 'http', targets: [get(`${base}/reset`)], users: 2, requests: 4 });
		const dns = start({ mode: 'http', targets: [get('http://volt-load-test.invalid/')], users: 1, requests: 1, timeoutMs: 8000 });
		runs.push(refused.handle, reset.handle, dns.handle);
		assert.deepStrictEqual((await refused.done).errorKinds, { refused: 4 });
		const resetResult = await reset.done;
		assert.deepStrictEqual(resetResult.errorKinds, { reset: 4 });
		assert.strictEqual(resetResult.targets[0].errors, 4);
		const dnsResult = await dns.done;
		assert.strictEqual(dnsResult.errors, 1);
		// A resolver that is itself unreachable answers with a timeout instead.
		assert.ok(dnsResult.errorKinds.dns === 1 || dnsResult.errorKinds.timeout === 1, JSON.stringify(dnsResult.errorKinds));
	});

	test('a scenario of several requests: sequence, status codes, per-target numbers', async () => {
		const { base } = await serve();
		const run = start({ mode: 'http', order: 'sequence', targets: [get(`${base}/ok`, { name: 'ok' }), get(`${base}/missing`, { name: 'missing' }), get(`${base}/fail`, { name: 'fail' })], users: 1, requests: 30 });
		runs.push(run.handle);
		const result = await run.done;
		assert.deepStrictEqual(result.statusCodes, { '200': 10, '404': 10, '500': 10 });
		assert.strictEqual(result.errors, 0);
		assert.strictEqual(result.httpErrors, 20);
		assert.deepStrictEqual(result.targets.map(target => [target.name, target.count, target.errors, target.statusCodes]), [['ok', 10, 0, { '200': 10 }], ['missing', 10, 10, { '404': 10 }], ['fail', 10, 10, { '500': 10 }]]);
		assert.strictEqual(result.latency.n, 30, 'an answered request has a latency whatever its status');
	});

	test('weights share the requests', async () => {
		const { base } = await serve();
		const run = start({ mode: 'http', targets: [get(`${base}/ok`, { name: 'often', weight: 9 }), get(`${base}/delay`, { name: 'seldom', weight: 1 }), get(`${base}/fail`, { name: 'never', weight: 0 })], users: 4, requests: 400 });
		runs.push(run.handle);
		const result = await run.done;
		const [often, seldom, never] = result.targets;
		assert.strictEqual(often.count + seldom.count, 400);
		assert.strictEqual(never.count, 0);
		assert.ok(often.count > 320 && seldom.count > 10, `${often.count} to ${seldom.count}`);
		assert.ok(VoltLoadHistogram.from(seldom.latency).percentile(50) >= 19, 'the slow target keeps its own latency');
	});

	test('dynamic tokens are filled on every send', async () => {
		const { base, seen } = await serve();
		const run = start({
			mode: 'http', users: 2, requests: 20,
			targets: [{ name: 'create', method: 'POST', url: `${base}/ok?t={{$timestamp}}&vu={{ $vu }}`, headers: [['Content-Type', 'application/json'], ['X-At', '{{$isoTimestamp}}'], ['X-Static', 'same']], body: '{"id":"{{$guid}}","vu":{{$vu}},"iteration":{{$iteration}},"n":{{$randomInt 5 6}},"kept":"{{name}}"}' }],
		});
		runs.push(run.handle);
		await run.done;
		assert.strictEqual(seen.length, 20);
		const bodies = seen.map(request => JSON.parse(request.body) as { id: string; vu: number; iteration: number; n: number; kept: string });
		assert.strictEqual(new Set(bodies.map(body => body.id)).size, 20, 'a new guid each time');
		assert.ok(bodies.every(body => /^[0-9a-f]{8}-[0-9a-f]{4}-/.test(body.id)));
		assert.deepStrictEqual([...new Set(bodies.map(body => body.vu))].sort(), [1, 2]);
		assert.ok(bodies.every(body => body.n === 5));
		assert.ok(bodies.every(body => body.kept === '{{name}}'), 'what is not the engine\'s token stays as written');
		assert.ok(Math.max(...bodies.map(body => body.iteration)) >= 5);
		assert.ok(seen.every(request => /^\/ok\?t=\d{10}&vu=[12]$/.test(request.url)), seen[0].url);
		assert.ok(seen.every(request => /^\d{4}-\d\d-\d\dT/.test(String(request.headers['x-at'])) && request.headers['x-static'] === 'same' && request.method === 'POST'));
	});

	test('the warm-up is in the series but not in the statistics', async () => {
		const { base, seen } = await serve();
		const run = start({ mode: 'http', targets: [get(`${base}/delay`)], users: 2, durationSec: 1, warmupSec: 1 });
		runs.push(run.handle);
		const result = await run.done;
		assert.ok(result.durationMs >= 1950, `warm-up and run: ${result.durationMs}`);
		assert.ok(Math.abs(result.measuredSec - 1) < 0.3, `measured ${result.measuredSec} s`);
		// Loose bounds: a busy machine sends about twenty a second here, not forty.
		assert.ok(result.count > 8 && result.count < seen.length - 8, `${result.count} measured of ${seen.length} sent`);
		assert.strictEqual(result.series[0].warmup, true);
		assert.ok(result.series[0].count > 8);
	});

	test('users follow the load profile', async () => {
		const { base } = await serve();
		const run = start({ mode: 'http', targets: [get(`${base}/delay`)], users: 8, durationSec: 3, profile: { kind: 'rampUp', baseUsers: 1, rampUpSec: 2 } });
		runs.push(run.handle);
		const result = await run.done;
		assert.strictEqual(result.peakUsers, 8);
		assert.ok(result.series.length >= 2);
		assert.ok(result.series[0].users < 8, `after one second of a two second ramp: ${result.series[0].users}`);
		assert.strictEqual(result.series[result.series.length - 1].users, 8);
		assert.ok(result.series[0].count < result.series[result.series.length - 1].count, 'more users, more requests');
	});

	test('stop ends the run at once and still reports', async () => {
		const { base } = await serve();
		const run = start({ mode: 'http', targets: [get(`${base}/ok`)], users: 5, durationSec: 60 });
		await delay(400);
		const asked = Date.now();
		run.handle.stop();
		const result = await run.done;
		assert.ok(Date.now() - asked < 200, `stopping took ${Date.now() - asked} ms`);
		assert.strictEqual(result.ended, 'stopped');
		assert.ok(result.count > 0);
		assert.strictEqual(result.latency.n + result.errors, result.count);
		assert.ok(result.durationMs < 1000);
		run.handle.stop();
	});

	test('WebSocket: connections, messages, round trips', async () => {
		const server = await startWsTestServer({
			onPeer: peer => {
				peer.onFrame = frame => peer.sendText(`echo ${frame.payload.toString('utf8')}`);
			},
		});
		wsServers.push(server);
		const run = start({ mode: 'ws', targets: [get(`ws://127.0.0.1:${server.port}/socket`, { headers: [['X-Token', 'abc']] })], users: 5, durationSec: 2, ws: { message: 'ping {{$vu}} {{$iteration}}', intervalMs: 100, expectReply: true } });
		runs.push(run.handle);
		const result = await run.done;
		assert.strictEqual(result.connects, 5);
		assert.strictEqual(result.connect?.n, 5);
		assert.strictEqual(result.connectFailures, 0);
		assert.strictEqual(result.closes, 0);
		assert.strictEqual(result.peakUsers, 5);
		assert.deepStrictEqual(result.statusCodes, { '101': 5 });
		assert.ok(result.sent >= 80 && result.sent <= 105, `5 connections, 10 a second, 2 s: sent ${result.sent}`);
		assert.ok(result.count >= result.sent - 5 && result.count <= result.sent, `received ${result.count} of ${result.sent}`);
		assert.strictEqual(result.latency.n, result.count);
		assert.ok(voltLoadPercentiles(result.latency).p50 < 100);
		assert.ok(result.bytesIn > 0 && result.bytesOut > 0);
		assert.ok(result.series.length >= 1 && (result.series[0].sent ?? 0) > 30 && result.series[0].users === 5);
		assert.strictEqual(server.peers.length, 5);
		assert.strictEqual(server.peers[0].request.headers['x-token'], 'abc');
		const texts = server.peers.flatMap(peer => peer.texts());
		assert.ok(texts.includes('ping 1 1') && texts.includes('ping 5 2'), texts.slice(0, 6).join(', '));
		assert.ok(server.peers.every(peer => peer.frames.every(frame => frame.masked)), 'a client masks its frames');
	});

	test('WebSocket: refused handshakes and connections the server ends', async () => {
		const refusing = await startWsTestServer({
			refuse: (_request, socket) => {
				socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n');
				return true;
			},
		});
		const dropping = await startWsTestServer({
			onPeer: peer => {
				peer.onFrame = () => peer.socket.destroy();
			},
		});
		wsServers.push(refusing, dropping);
		const refused = start({ mode: 'ws', targets: [get(`ws://127.0.0.1:${refusing.port}/`)], users: 3, durationSec: 1 });
		const dropped = start({ mode: 'ws', targets: [get(`ws://127.0.0.1:${dropping.port}/`)], users: 2, durationSec: 2, ws: { message: 'hi', intervalMs: 5000 } });
		runs.push(refused.handle, dropped.handle);
		const refusedResult = await refused.done;
		assert.strictEqual(refusedResult.connects, 0);
		assert.strictEqual(refusedResult.connectFailures, 3);
		assert.deepStrictEqual(refusedResult.statusCodes, { '403': 3 });
		assert.strictEqual(refusedResult.peakUsers, 0);
		const droppedResult = await dropped.done;
		// Each connection is dropped, re-opened a second later and dropped again (a third round may just start as the run ends).
		assert.ok(droppedResult.closes >= 4 && droppedResult.closes <= 6, `closes: ${droppedResult.closes}`);
		assert.ok(droppedResult.reconnects >= 2 && droppedResult.reconnects <= 4, `reconnects: ${droppedResult.reconnects}`);
		assert.ok(droppedResult.connects >= 4 && droppedResult.connects <= 6, `connects: ${droppedResult.connects}`);
	});

	test('SSE: connections, time to the first event, events, reconnects', async () => {
		let streams = 0;
		let longEvents = 0;
		const { base } = await serve((request, response) => {
			if (!request.url?.startsWith('/events')) {
				return false;
			}
			streams++;
			response.writeHead(200, { 'Content-Type': 'text/event-stream' });
			let sent = 0;
			const timer = setInterval(() => {
				// A comment, an event of two data lines, and an event cut in two writes.
				response.write(': keep-alive\n\n');
				response.write(`event: tick\ndata: {"n":${sent}}\ndata: more\n\n`);
				response.write('data: sp');
				response.write('lit\r\n\r\n');
				sent++;
				longEvents += request.url === '/events' ? 2 : 0;
				if (request.url === '/events/short' && sent === 3) {
					clearInterval(timer);
					response.end();
				}
			}, 50);
			response.on('close', () => clearInterval(timer));
			return true;
		});
		const run = start({ mode: 'sse', targets: [get(`${base}/events`, { headers: [['X-Token', 'abc']] })], users: 4, durationSec: 2 });
		const short = start({ mode: 'sse', targets: [get(`${base}/events/short`)], users: 1, durationSec: 2 });
		const missing = start({ mode: 'sse', targets: [get(`${base}/missing`)], users: 2, durationSec: 1 });
		runs.push(run.handle, short.handle, missing.handle);
		const result = await run.done;
		assert.strictEqual(result.connects, 4);
		assert.strictEqual(result.connect?.n, 4);
		assert.strictEqual(result.latency.n, 4, 'one time to first event per connection');
		const first = voltLoadPercentiles(result.latency);
		assert.ok(first.min >= 30 && first.max < 400, `first event after ${first.min} to ${first.max} ms`);
		assert.ok(result.count >= 100 && result.count <= longEvents && result.count >= longEvents - 16, `4 streams, 2 events each 50 ms, 2 s: ${result.count} of the ${longEvents} sent`);
		assert.strictEqual(result.closes, 0);
		assert.ok(result.bytesIn > result.count * 10);
		assert.strictEqual(result.peakUsers, 4);
		assert.ok(result.series[0].count > 40 && result.series[0].users === 4);
		const shortResult = await short.done;
		assert.strictEqual(shortResult.closes, 2, 'the stream ends after 150 ms, is re-opened a second later and ends again');
		assert.strictEqual(shortResult.reconnects, 1);
		assert.strictEqual(shortResult.count, 12);
		const missingResult = await missing.done;
		assert.strictEqual(missingResult.connects, 0);
		assert.strictEqual(missingResult.connectFailures, 2);
		assert.deepStrictEqual(missingResult.statusCodes, { '404': 2 });
		assert.ok(streams >= 6);
	});

	test('startVoltLoad reports samples and one result, from a worker thread where there is one', async () => {
		const { base, seen } = await serve();
		const events: VoltLoadEvent[] = [];
		const result = await new Promise<IVoltLoadResult>((resolve, reject) => {
			const run = startVoltLoad({ mode: 'http', targets: [get(`${base}/delay`)], users: 2, durationSec: 1 }, event => {
				events.push(event);
				if (event.type === 'done' && event.result) {
					resolve(event.result);
				} else if (event.type === 'error') {
					reject(new Error(event.error));
				}
			});
			runs.push(run);
		});
		assert.ok(result.count > 20 && result.count <= seen.length, `${result.count} of ${seen.length}`);
		assert.strictEqual(events.filter(event => event.type === 'done').length, 1);
		assert.ok(events.some(event => event.type === 'sample'));
		assert.strictEqual(events[events.length - 1].type, 'done');

		// Stopped early, the worker still hands over what it measured.
		const stopped = await new Promise<IVoltLoadResult>((resolve, reject) => {
			const run = startVoltLoad({ mode: 'http', targets: [get(`${base}/ok`)], users: 2, durationSec: 60 }, event => event.type === 'done' && event.result ? resolve(event.result) : event.type === 'error' ? reject(new Error(event.error)) : undefined);
			runs.push(run);
			setTimeout(() => run.stop(), 500);
		});
		assert.strictEqual(stopped.ended, 'stopped');
		assert.ok(stopped.count > 0);
	});

	test('a spec that cannot run is refused before anything is sent', () => {
		assert.throws(() => startVoltLoad({ mode: 'http', targets: [], users: 1 }, () => { }), /at least one target/);
		assert.throws(() => startVoltLoad({ mode: 'sse', targets: [get('ws://x')], users: 1 }, () => { }), /no usable URL/);
	});

	test('the worker script is the engine alone', () => {
		const source = voltLoadWorkerSource();
		assert.ok(source.includes('workerData') && source.includes('parentPort.postMessage'));
		// Nothing of the module around the function may be named in it: the worker would not have it.
		for (const name of ['planVoltLoad', 'INLINE_MODULES', 'voltLoadInlineRequire', 'VoltLoadHistogram', 'startVoltLoad']) {
			assert.ok(!source.includes(name), `the worker script refers to ${name}`);
		}
	});
});
