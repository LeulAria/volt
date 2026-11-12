/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The sandbox proxy's minimal fixes before the network broker (B-31): a per-run route token,
 * tunnel idle and header timeouts, the local-use NAT64 prefix, and "Allow host" applying to the
 * next connection. No sandbox involved: the proxy is driven over loopback with a fake resolver
 * and connector, so nothing leaves the machine.
 */

import assert from 'assert';
import * as net from 'net';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { IResolvedAddress, isPublicAddress, ProxyRefusal, SandboxNetworkProxy } from '../../node/sandboxProxy.js';

const PUBLIC: IResolvedAddress = { address: '93.184.216.34', family: 4 };

/** A local server standing in for the internet: counts connections, echoes. */
async function upstream(): Promise<{ port: number; hits: () => number; close: () => Promise<void> }> {
	let hits = 0;
	const server = net.createServer(socket => {
		hits++;
		socket.on('error', () => undefined);
		socket.pipe(socket);
	});
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
	return { port: (server.address() as net.AddressInfo).port, hits: () => hits, close: () => new Promise(resolve => server.close(() => resolve())) };
}

/** Sends a raw request to the proxy and returns the first line of the answer (and the socket). */
async function request(port: number, text: string): Promise<{ line: string; socket: net.Socket }> {
	const socket = net.connect({ host: '127.0.0.1', port });
	socket.on('error', () => undefined);
	await new Promise<void>(resolve => socket.once('connect', () => resolve()));
	socket.write(text);
	const line = await new Promise<string>(resolve => {
		let buffer = '';
		const onData = (data: Buffer) => {
			buffer += data.toString('latin1');
			if (buffer.includes('\r\n')) {
				socket.off('data', onData);
				resolve(buffer.slice(0, buffer.indexOf('\r\n')));
			}
		};
		socket.on('data', onData);
		socket.once('close', () => resolve(buffer));
	});
	return { line, socket };
}

const basic = (token: string) => `Basic ${Buffer.from(`volt:${token}`).toString('base64')}`;

suite('Volt sandbox proxy (B-31)', function () {

	this.timeout(20_000);
	ensureNoDisposablesAreLeakedInTestSuite();

	let proxy: SandboxNetworkProxy | undefined;
	let server: Awaited<ReturnType<typeof upstream>> | undefined;
	const blocked: { host: string; reason: ProxyRefusal }[] = [];

	setup(async () => {
		blocked.length = 0;
		server = await upstream();
		const port = server.port;
		proxy = await SandboxNetworkProxy.start(['allowed.test'], (host, reason) => blocked.push({ host, reason }), {
			token: 'tok-1',
			lookup: async () => [PUBLIC],
			connect: () => net.connect({ host: '127.0.0.1', port }),
			tunnelIdleMs: 300,
		});
	});

	teardown(async () => {
		proxy?.dispose();
		await server?.close();
	});

	test('NET-AUTH: a request without this run\'s token gets 407, whoever sends it', async () => {
		const none = await request(proxy!.port, 'CONNECT allowed.test:443 HTTP/1.1\r\nHost: allowed.test:443\r\n\r\n');
		assert.match(none.line, /^HTTP\/1\.1 407/);
		none.socket.destroy();
		const other = await request(proxy!.port, `CONNECT allowed.test:443 HTTP/1.1\r\nHost: allowed.test:443\r\nProxy-Authorization: ${basic('another-run')}\r\n\r\n`);
		assert.match(other.line, /^HTTP\/1\.1 407/, 'another run\'s token');
		other.socket.destroy();
		const forward = await request(proxy!.port, 'GET http://allowed.test/ HTTP/1.1\r\nHost: allowed.test\r\n\r\n');
		assert.match(forward.line, /^HTTP\/1\.1 407/, 'plain HTTP too');
		forward.socket.destroy();
		assert.strictEqual(server!.hits(), 0, 'nothing went upstream');
		assert.ok(blocked.every(b => b.reason === 'auth'));
		const ok = await request(proxy!.port, `CONNECT allowed.test:443 HTTP/1.1\r\nHost: allowed.test:443\r\nProxy-Authorization: ${basic('tok-1')}\r\n\r\n`);
		assert.match(ok.line, /^HTTP\/1\.1 200/);
		ok.socket.destroy();
	});

	test('NET live grant: "Allow host" applies to the next connection of the same proxy', async () => {
		const before = await request(proxy!.port, `CONNECT later.test:443 HTTP/1.1\r\nHost: later.test:443\r\nProxy-Authorization: ${basic('tok-1')}\r\n\r\n`);
		assert.match(before.line, /^HTTP\/1\.1 403/);
		before.socket.destroy();
		proxy!.allow(['later.test']);
		const after = await request(proxy!.port, `CONNECT later.test:443 HTTP/1.1\r\nHost: later.test:443\r\nProxy-Authorization: ${basic('tok-1')}\r\n\r\n`);
		assert.match(after.line, /^HTTP\/1\.1 200/);
		after.socket.destroy();
	});

	test('a tunnel with no traffic is closed after the idle timeout', async () => {
		const { line, socket } = await request(proxy!.port, `CONNECT allowed.test:443 HTTP/1.1\r\nHost: allowed.test:443\r\nProxy-Authorization: ${basic('tok-1')}\r\n\r\n`);
		assert.match(line, /^HTTP\/1\.1 200/);
		const started = Date.now();
		await new Promise<void>(resolve => socket.once('close', () => resolve()));
		assert.ok(Date.now() - started < 5_000, 'closed by the idle timer, not the test timeout');
	});

	test('64:ff9b:1::/48 (local-use NAT64) is judged as IPv4 under every placement', () => {
		// 127.0.0.1 at /48 (bytes 6, 7, 9, 10), 10.0.0.1 at /64, 169.254.169.254 at /96.
		for (const address of ['64:ff9b:1:7f00:0:100::', '64:ff9b:1:0:a:0:100:0', '64:ff9b:1::a9fe:a9fe', '64:ff9b:1::7f00:1']) {
			assert.strictEqual(isPublicAddress(address), false, address);
		}
		assert.strictEqual(isPublicAddress('64:ff9b::7f00:1'), false, 'the well-known prefix still is');
		assert.strictEqual(isPublicAddress('64:ff9b::808:808'), true, '8.8.8.8 through the well-known prefix');
	});
});
