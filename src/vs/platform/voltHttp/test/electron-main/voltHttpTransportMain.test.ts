/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import * as http from 'http';
import type { AddressInfo } from 'net';
import { streamToBuffer } from '../../../../base/common/buffer.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { IChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { TestConfigurationService } from '../../../configuration/test/common/testConfigurationService.js';
import { INativeEnvironmentService } from '../../../environment/common/environment.js';
import { NullLogService } from '../../../log/common/log.js';
import { RequestChannel, RequestChannelClient } from '../../../request/common/requestIpc.js';
import { INetClientRequest, NetRequestFunction, VoltHttpTransportMainService } from '../../electron-main/voltHttpTransportMain.js';

/**
 * Electron's `net.request` as far as the transport relies on it, on Node's `http`: with `redirect:
 * 'manual'` a redirect is a `redirect` event (the request is cancelled unless it is followed), never
 * a response; otherwise the response goes to the callback.
 */
const electronLikeNet: NetRequestFunction = (options, callback) => {
	const { redirect, ...rest } = options;
	const request = http.request(rest);
	request.on('response', res => {
		if (redirect === 'manual' && res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
			res.resume();
			const headers: Record<string, string[]> = {};
			for (const [key, value] of Object.entries(res.headers)) {
				if (value !== undefined) {
					headers[key] = Array.isArray(value) ? value : [String(value)];
				}
			}
			request.emit('redirect', res.statusCode, rest.method ?? 'GET', res.headers.location, headers);
			return;
		}
		callback?.(res);
	});
	return request as unknown as INetClientRequest;
};

class TestTransport extends VoltHttpTransportMainService {
	protected override netRequest(): NetRequestFunction {
		return electronLikeNet;
	}
}

interface IServed { readonly method: string; readonly url: string; readonly origin?: string }

async function listen(handler: (req: http.IncomingMessage, res: http.ServerResponse) => void): Promise<{ server: http.Server; base: string; served: IServed[] }> {
	const served: IServed[] = [];
	const server = http.createServer((req, res) => {
		served.push({ method: req.method ?? '', url: req.url ?? '', ...(req.headers.origin ? { origin: req.headers.origin } : {}) });
		handler(req, res);
	});
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
	return { server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, served };
}

suite('Volt HTTP client transport (main process)', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();
	const servers: http.Server[] = [];

	teardown(async () => {
		await Promise.all(servers.splice(0).map(server => new Promise(resolve => server.close(resolve))));
	});

	/** The window's side of the channel, talking to the main process's transport. */
	function windowClient(): RequestChannelClient {
		const environment = { args: { 'force-disable-user-env': true } } as unknown as INativeEnvironmentService;
		const transport = store.add(new TestTransport(new TestConfigurationService(), environment, new NullLogService()));
		const channel = new RequestChannel(transport);
		return new RequestChannelClient({ call: (command: string, args?: unknown, token?: CancellationToken) => channel.call(undefined, command, args, token), listen: () => { throw new Error('unused'); } } as IChannel);
	}

	test('DEV-LIVE-3: a server without CORS headers answers, with every response header (Set-Cookie, custom) and no Origin added', async () => {
		const api = await listen((_req, res) => {
			res.writeHead(201, { 'content-type': 'application/json', 'set-cookie': ['session=abc; HttpOnly', 'theme=dark'], 'x-request-id': 'r-42' });
			res.end('{"ok":true}');
		});
		servers.push(api.server);
		const client = windowClient();

		const context = await client.request({ type: 'POST', url: `${api.base}/items`, headers: { 'content-type': 'application/json' }, data: '{"name":"x"}', followRedirects: 5, disableCache: true }, CancellationToken.None);
		assert.strictEqual(context.res.statusCode, 201);
		assert.strictEqual((await streamToBuffer(context.stream)).toString(), '{"ok":true}');
		assert.deepStrictEqual(context.res.headers['set-cookie'], ['session=abc; HttpOnly', 'theme=dark']);
		assert.strictEqual(context.res.headers['x-request-id'], 'r-42');
		assert.deepStrictEqual(api.served, [{ method: 'POST', url: '/items' }], 'sent once, without an Origin header');
	});

	test('DEV-SBX-19: from the main process, a send that may not follow redirects (a sandboxed chat\'s) gets the redirect and the location is never requested', async () => {
		const elsewhere = await listen((_req, res) => res.end('should not be reached'));
		servers.push(elsewhere.server);
		const api = await listen((_req, res) => {
			res.writeHead(302, { location: `${elsewhere.base}/internal` });
			res.end();
		});
		servers.push(api.server);
		const client = windowClient();

		const context = await client.request({ type: 'GET', url: `${api.base}/old`, followRedirects: 0, disableCache: true }, CancellationToken.None);
		assert.strictEqual(context.res.statusCode, 302);
		assert.strictEqual(context.res.headers['location'], `${elsewhere.base}/internal`);
		assert.strictEqual((await streamToBuffer(context.stream)).byteLength, 0);
		assert.deepStrictEqual(api.served.map(item => item.url), ['/old']);
		assert.strictEqual(elsewhere.served.length, 0, 'the location was not requested');

		// The user's own send (followRedirects > 0) still follows.
		const followed = await client.request({ type: 'GET', url: `${api.base}/old`, followRedirects: 5, disableCache: true }, CancellationToken.None);
		assert.strictEqual((await streamToBuffer(followed.stream)).toString(), 'should not be reached');
		assert.deepStrictEqual(elsewhere.served.map(item => item.url), ['/internal']);
	});
});
