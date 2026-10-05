/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import * as http from 'http';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { NullLogService } from '../../../log/common/log.js';
import { IVoltHostMcpCall } from '../../common/voltHostMcp.js';
import { checkHostMcpRequest, VoltHostMcpMainService } from '../../electron-main/voltHostMcpMainService.js';

interface IReply {
	readonly status: number;
	readonly headers: http.IncomingHttpHeaders;
	readonly body: string;
}

function post(url: string, body: unknown, headers: Record<string, string> = {}, method = 'POST'): Promise<IReply> {
	const target = new URL(url);
	const payload = body === undefined ? '' : JSON.stringify(body);
	return new Promise((resolve, reject) => {
		const req = http.request({
			host: target.hostname,
			port: target.port,
			path: target.pathname + target.search,
			method,
			agent: false,
			headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), ...headers },
		}, res => {
			let data = '';
			res.setEncoding('utf8');
			res.on('data', chunk => data += chunk);
			res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: data }));
		});
		req.on('error', reject);
		req.end(payload);
	});
}

const INIT = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } };
const TOOLS = [
	{ name: 'ask_question', description: 'q', inputSchema: { type: 'object' }, group: 'core' },
	{ name: 'browser_snapshot', description: 's', inputSchema: { type: 'object' }, group: 'browser' },
];

suite('Volt host MCP server', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('request check: loopback Host, no browser headers, bearer token', () => {
		const ok = { host: '127.0.0.1:4000', authorization: 'Bearer secret' };
		assert.deepStrictEqual(checkHostMcpRequest('POST', '/mcp/s1', ok, 4000, 'secret'), { ok: true });
		assert.deepStrictEqual(checkHostMcpRequest('POST', '/mcp', { ...ok, host: 'localhost:4000' }, 4000, 'secret'), { ok: true });
		const status = (method: string, path: string, headers: http.IncomingHttpHeaders) => {
			const verdict = checkHostMcpRequest(method, path, headers, 4000, 'secret');
			return verdict.ok ? 200 : verdict.status;
		};
		assert.strictEqual(status('POST', '/mcp', { host: '127.0.0.1:4000' }), 401, 'no token');
		assert.strictEqual(status('POST', '/mcp', { ...ok, authorization: 'Bearer secreT' }), 401, 'wrong token');
		assert.strictEqual(status('POST', '/mcp', { ...ok, authorization: 'secret' }), 401, 'not a bearer token');
		assert.strictEqual(status('POST', '/mcp', { ...ok, host: 'evil.example:4000' }), 403, 'DNS rebinding host');
		assert.strictEqual(status('POST', '/mcp', { ...ok, host: '127.0.0.1:4001' }), 403, 'other port');
		assert.strictEqual(status('POST', '/mcp', { ...ok, origin: 'http://localhost:3000' }), 403, 'browser origin, even with the token');
		assert.strictEqual(status('POST', '/mcp', { ...ok, origin: 'null' }), 403, 'sandboxed page origin');
		assert.strictEqual(status('POST', '/mcp', { ...ok, 'sec-fetch-mode': 'no-cors' }), 403, 'browser fetch metadata');
		assert.strictEqual(status('OPTIONS', '/mcp', ok), 403, 'no CORS preflight');
		assert.strictEqual(status('POST', '/.well-known/oauth-protected-resource', ok), 404);
	});

	test('serves JSON-RPC only to callers with the token and never sends CORS headers', async () => {
		const service = store.add(new VoltHostMcpMainService(new NullLogService()));
		try {
			const endpoint = await service.start('w1', TOOLS);
			assert.match(endpoint.url, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
			assert.ok(endpoint.token.length >= 32);
			const auth = { Authorization: `Bearer ${endpoint.token}` };

			const good = await post(`${endpoint.url}/s1`, INIT, auth);
			assert.strictEqual(good.status, 200);
			assert.strictEqual(JSON.parse(good.body).result.serverInfo.name, 'volt');
			assert.strictEqual(good.headers['access-control-allow-origin'], undefined);

			assert.strictEqual((await post(`${endpoint.url}/s1`, INIT)).status, 401);
			assert.strictEqual((await post(`${endpoint.url}/s1`, INIT, { Authorization: 'Bearer nope' })).status, 401);
			const fromPage = await post(`${endpoint.url}/s1`, INIT, { ...auth, Origin: 'http://localhost:5173' });
			assert.strictEqual(fromPage.status, 403);
			assert.strictEqual(fromPage.headers['access-control-allow-origin'], undefined);
			const preflight = await post(`${endpoint.url}/s1`, undefined, { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'POST' }, 'OPTIONS');
			assert.strictEqual(preflight.status, 403);
			assert.strictEqual(preflight.headers['access-control-allow-origin'], undefined);
			assert.strictEqual((await post(`${endpoint.url}/s1`, INIT, { ...auth, Host: `evil.example:${new URL(endpoint.url).port}` })).status, 403);

			// A second start (tools changed) keeps the same endpoint and token.
			assert.deepStrictEqual(await service.start('w1', TOOLS), endpoint);
		} finally {
			await service.stop('w1');
		}
	});

	test('tools/list honours ?groups= and tools/call reaches the window with the session id', async () => {
		const service = store.add(new VoltHostMcpMainService(new NullLogService()));
		const calls: IVoltHostMcpCall[] = [];
		store.add(service.onDidCall(call => {
			calls.push(call);
			void service.respond(call.id, { content: [{ type: 'text', text: `ran ${call.name}` }] });
		}));
		try {
			const endpoint = await service.start('w2', TOOLS);
			const auth = { Authorization: `Bearer ${endpoint.token}` };
			const list = async (suffix: string) => (JSON.parse((await post(`${endpoint.url}/chat%201${suffix}`, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, auth)).body).result.tools as { name: string; group?: string }[]);
			assert.deepStrictEqual((await list('')).map(tool => tool.name), ['ask_question', 'browser_snapshot']);
			assert.deepStrictEqual((await list('?groups=core')).map(tool => tool.name), ['ask_question']);
			assert.ok((await list('')).every(tool => tool.group === undefined), 'groups stay internal');

			const called = await post(`${endpoint.url}/chat%201`, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'browser_snapshot', arguments: { interactive: true } } }, auth);
			assert.strictEqual(JSON.parse(called.body).result.content[0].text, 'ran browser_snapshot');
			assert.deepStrictEqual(calls.map(call => ({ sessionId: call.sessionId, name: call.name, args: call.args })), [{ sessionId: 'chat 1', name: 'browser_snapshot', args: { interactive: true } }]);

			const hidden = await post(`${endpoint.url}/chat%201?groups=core`, { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'browser_snapshot', arguments: {} } }, auth);
			assert.strictEqual(JSON.parse(hidden.body).result.isError, true, 'a tool outside the listed groups is not callable');
			assert.strictEqual(calls.length, 1);
		} finally {
			await service.stop('w2');
		}
	});

	test('rejects oversized bodies', async () => {
		const service = store.add(new VoltHostMcpMainService(new NullLogService()));
		try {
			const endpoint = await service.start('w3', TOOLS);
			const reply = await post(`${endpoint.url}/s`, { jsonrpc: '2.0', id: 1, method: 'ping', params: { pad: 'x'.repeat(5 * 1024 * 1024) } }, { Authorization: `Bearer ${endpoint.token}` });
			assert.strictEqual(reply.status, 413);
		} finally {
			await service.stop('w3');
		}
	});
});
