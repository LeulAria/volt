/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { promises as fs } from 'fs';
import * as http from 'http';
import { AddressInfo } from 'net';
import { tmpdir } from 'os';
import { join } from '../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../base/test/common/utils.js';
import { NullLogService } from '../../../platform/log/common/log.js';
import { VOLT_LOCAL_SESSION_PATH } from '../../../platform/voltAgentServer/common/protocol.js';
import { IPairingHttpContext, ServerPairing } from '../../node/voltAgent/serverPairing.js';
import { cloudflareQuickUrl, explainSshFailure, sshConfigHosts } from '../../node/voltAgent/serverTunnels.js';

suite('Agent server tunnels', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('reads the quick tunnel address out of cloudflared\'s log box', () => {
		assert.strictEqual(cloudflareQuickUrl('2026-11-01T10:00:00Z INF |  https://brave-otter-lamp-sea.trycloudflare.com                          |'), 'https://brave-otter-lamp-sea.trycloudflare.com');
		assert.strictEqual(cloudflareQuickUrl('INF Requesting new quick Tunnel on trycloudflare.com...'), undefined);
		assert.strictEqual(cloudflareQuickUrl('INF see https://www.cloudflare.com/website-terms/'), undefined);
	});

	test('lists plain hosts from ~/.ssh/config and skips patterns', () => {
		const config = [
			'Host *',
			'  ServerAliveInterval 30',
			'Host build-box  vps',
			'  HostName 203.0.113.9',
			'host !bastion jump?',
			'Host vps',
			'Match host foo',
		].join('\n');
		assert.deepStrictEqual(sshConfigHosts(config), ['build-box', 'vps']);
	});

	test('explains ssh failures in words', () => {
		assert.match(explainSshFailure(['debug1: Next authentication method: publickey', 'you@vps: Permission denied (publickey).'], 'you@vps'), /refused this computer's SSH key/);
		assert.match(explainSshFailure(['Error: remote port forwarding failed for listen port 8799'], 'vps'), /would not open that port/);
		assert.match(explainSshFailure(['ssh: Could not resolve hostname nope: nodename nor servname provided'], 'you@nope'), /^No server is called nope\./);
		assert.strictEqual(explainSshFailure(['debug1: only debug'], 'vps'), 'ssh stopped.');
	});

	test('the tunnel listener never hands out the local session, even from loopback', async () => {
		const dir = await fs.mkdtemp(join(tmpdir(), 'volt-tunnels-'));
		const pairing = await ServerPairing.load(dir, new NullLogService());
		const servers: http.Server[] = [];
		const post = async (viaTunnel: boolean): Promise<number> => {
			let ctx: IPairingHttpContext = { port: 0, network: false, serverVersion: 'test', viaTunnel };
			const server = http.createServer((req, res) => void pairing.handleHttp(req, res, ctx));
			servers.push(server);
			await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
			const port = (server.address() as AddressInfo).port;
			ctx = { ...ctx, port };
			// The page Volt opened, with the one-time nonce from its URL (B-01): the only way in.
			const body = JSON.stringify({ nonce: pairing.createLocalNonce().nonce });
			return new Promise<number>((resolve, reject) => {
				const req = http.request(`http://127.0.0.1:${port}${VOLT_LOCAL_SESSION_PATH}`, { method: 'POST', headers: { Origin: `http://127.0.0.1:${port}`, 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(body)) } }, res => {
					res.resume();
					res.on('end', () => resolve(res.statusCode ?? 0));
				});
				req.on('error', reject);
				req.end(body);
			});
		};
		try {
			assert.strictEqual(await post(false), 200, 'the browser on this computer signs in');
			assert.strictEqual(await post(true), 403, 'a request through a tunnel does not, even with a valid nonce');
		} finally {
			await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))));
			pairing.dispose();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
});
