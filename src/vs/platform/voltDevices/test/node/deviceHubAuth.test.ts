/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import * as http from 'http';
import { AddressInfo, connect } from 'net';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { NullLogService } from '../../../log/common/log.js';
import { DeviceHub } from '../../node/deviceHub.js';

/** Node's HTTP client: unlike a page's fetch, it sends exactly the Host and Origin given (or none). */
function call(url: string, init: { method?: string; headers?: Record<string, string> } = {}): Promise<{ status: number; text: string }> {
	return new Promise((resolve, reject) => {
		const req = http.request(url, { method: init.method ?? 'GET', headers: init.headers }, res => {
			let text = '';
			res.setEncoding('utf8');
			res.on('data', chunk => text += chunk);
			res.on('end', () => resolve({ status: res.statusCode ?? 0, text }));
		});
		req.on('error', reject);
		req.end();
	});
}

/** The status line a WebSocket upgrade gets. */
function upgrade(url: string, headers: Record<string, string>): Promise<string> {
	const target = new URL(url);
	return new Promise((resolve, reject) => {
		const socket = connect(Number(target.port), target.hostname, () => {
			const lines = [`GET ${target.pathname}${target.search} HTTP/1.1`, `Host: ${headers.Host ?? target.host}`, 'Upgrade: websocket', 'Connection: Upgrade', 'Sec-WebSocket-Version: 13', 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ=='];
			for (const [name, value] of Object.entries(headers)) {
				if (name !== 'Host') {
					lines.push(`${name}: ${value}`);
				}
			}
			socket.write(`${lines.join('\r\n')}\r\n\r\n`);
		});
		let text = '';
		socket.on('data', chunk => {
			text += chunk.toString('latin1');
			if (text.includes('\r\n')) {
				resolve(text.split('\r\n')[0]);
				socket.destroy();
			}
		});
		socket.on('end', () => resolve(text.split('\r\n')[0]));
		socket.on('error', reject);
	});
}

suite('LST-7: the device hub proxy authenticates every request', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('no secret, a forged secret, a forged Host, or a socket without Volt\'s Origin get 401/403', async () => {
		// Stands in for expo-device-hub: answers anything, and accepts sockets.
		const upstream = http.createServer((req, res) => res.end(`hub saw ${req.method} ${req.url}`));
		upstream.on('upgrade', (_req, socket) => socket.end('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n'));
		await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
		const hub = new DeviceHub('/nonexistent', async () => process.env, async () => undefined, new NullLogService());
		const internals = hub as unknown as { hubPort: number; startProxy(): Promise<string> };
		internals.hubPort = (upstream.address() as AddressInfo).port;
		try {
			const base = await internals.startProxy();
			const url = new URL(base);
			const secret = url.pathname.slice(1);
			assert.match(secret, /^[A-Za-z0-9_-]{43}$/, 'a 256-bit secret, not a guessable id');
			const origin = `http://${url.host}`;

			assert.strictEqual((await call(`${origin}/api/devices`)).status, 401, 'no secret');
			assert.strictEqual((await call(`${origin}/${'A'.repeat(43)}/api/devices`)).status, 401, 'forged secret');
			assert.strictEqual((await call(`${base}/api/devices`, { headers: { Host: `rebound.example:${url.port}` } })).status, 403, 'forged Host');
			assert.strictEqual((await call(`${base}/grid/api/start`, { method: 'POST' })).status, 403, 'a write without Volt\'s Origin');
			assert.strictEqual((await call(`${base}/grid/api/start`, { method: 'POST', headers: { Origin: 'http://evil.example' } })).status, 403, 'a write from another site');

			const read = await call(`${base}/api/devices`);
			assert.strictEqual(read.status, 200);
			assert.strictEqual(read.text, 'hub saw GET /api/devices', 'the secret is stripped before the hub');
			assert.strictEqual((await call(`${base}/grid/api/start`, { method: 'POST', headers: { Origin: 'vscode-file://vscode-app' } })).status, 200);

			assert.match(await upgrade(`${base}/ws`, {}), / 403 /, 'a socket without an Origin');
			assert.match(await upgrade(`${origin}/ws`, { Origin: 'vscode-file://vscode-app' }), / 401 /, 'a socket without the secret');
			assert.match(await upgrade(`${base}/ws`, { Origin: 'vscode-file://vscode-app', Host: `rebound.example:${url.port}` }), / 403 /, 'a socket with a forged Host');
			assert.match(await upgrade(`${base}/ws`, { Origin: 'vscode-file://vscode-app' }), / 101 /, 'Volt\'s window');
		} finally {
			hub.dispose();
			await new Promise(resolve => upstream.close(resolve));
		}
	});
});
