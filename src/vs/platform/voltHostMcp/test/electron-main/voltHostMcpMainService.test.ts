/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { createHash, createHmac, randomBytes } from 'crypto';
import * as http from 'http';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { NullLogService } from '../../../log/common/log.js';
import { IVoltHostMcpCall } from '../../common/voltHostMcp.js';
import { HOST_MCP_TOKEN_TTL_MS, hmacSha256, hostMcpSessionMessage, hostMcpSessionToken, newHostMcpLease, parseHostMcpSessionToken, sha256 } from '../../common/voltHostMcpAuth.js';
import { checkHostMcpRequest, VoltHostMcpMainService } from '../../electron-main/voltHostMcpMainService.js';

interface IReply {
	readonly status: number;
	readonly headers: http.IncomingHttpHeaders;
	readonly body: string;
}

interface IRpcReply {
	readonly result: {
		readonly serverInfo: { readonly name: string };
		readonly tools: { name: string; group?: string }[];
		readonly content: readonly { readonly text: string }[];
		readonly isError?: boolean;
	};
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
		assert.deepStrictEqual(checkHostMcpRequest('POST', '/mcp/s1', { ...ok, authorization: `Bearer ${hostMcpSessionToken('secret', 's1')}` }, 4000, 'secret'), { ok: true, sessionId: 's1' });
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
		assert.strictEqual(status('POST', '/mcp', { ...ok, 'sec-fetch-mode': 'no-cors', 'sec-fetch-site': 'cross-site', 'sec-fetch-dest': 'empty' }), 403, 'browser fetch metadata');
		assert.strictEqual(status('POST', '/mcp', { ...ok, 'sec-fetch-site': 'same-origin' }), 403, 'a browser always sends Sec-Fetch-Site');
		assert.strictEqual(status('POST', '/mcp', { ...ok, 'sec-fetch-dest': 'document' }), 403, 'a form post from a page');
		assert.strictEqual(status('POST', '/mcp', { ...ok, 'sec-fetch-mode': 'cors', 'user-agent': 'Cursor/1.0.0', 'accept-language': '*' }), 200, 'Node fetch (cursor-agent) sends Sec-Fetch-Mode alone');
		assert.strictEqual(status('OPTIONS', '/mcp', ok), 403, 'no CORS preflight');
		assert.strictEqual(status('POST', '/.well-known/oauth-protected-resource', ok), 404);
	});

	test('session tokens: each chat\'s agent can act only as that chat, with the groups it was given', () => {
		const status = (path: string, token: string | undefined) => {
			const verdict = checkHostMcpRequest('POST', path, { host: '127.0.0.1:4000', ...(token !== undefined ? { authorization: `Bearer ${token}` } : {}) }, 4000, 'secret');
			return verdict.ok ? 200 : verdict.status;
		};
		const s1 = hostMcpSessionToken('secret', 's1');
		const s2 = hostMcpSessionToken('secret', 's2');
		assert.notStrictEqual(s1, s2);
		assert.strictEqual(status('/mcp/s1', s1), 200, 'its own session');
		assert.strictEqual(status('/mcp/s1?x=1#y', s1), 200, 'query and fragment do not matter');
		assert.strictEqual(status('/mcp/s2', s1), 401, 'another chat\'s session with this chat\'s token (a tampered path)');
		assert.strictEqual(status('/mcp/s1', s2), 401, 'another chat\'s token');
		assert.strictEqual(status('/mcp/s1', undefined), 401, 'no token');
		assert.strictEqual(status('/mcp/s1', ''), 401, 'empty token');
		assert.strictEqual(status('/mcp/s1', `${s1}0`), 401, 'a longer token');
		assert.strictEqual(status('/mcp/s1', s1.slice(0, -1)), 401, 'a shorter token');
		assert.strictEqual(status('/mcp/s1', 'secret'), 401, 'the server secret is not a session token');
		assert.strictEqual(status('/mcp/s1', hostMcpSessionToken('other secret', 's1')), 401, 'another server\'s token');
		assert.strictEqual(status('/mcp/%E0%A4%A', s1), 401, 'a session id that does not decode is not "no session"');

		// The token covers the groups: an agent handed `core` cannot list or call the rest.
		const core = hostMcpSessionToken('secret', 's1', ['core']);
		assert.strictEqual(status('/mcp/s1?groups=core', core), 200);
		assert.strictEqual(status('/mcp/s1?groups=core,browser', core), 401, 'widened groups');
		assert.strictEqual(status('/mcp/s1', core), 401, 'all groups');
		assert.strictEqual(status('/mcp/s1?groups=core', s1), 401, 'an all-groups token for a narrower URL');
		const both = hostMcpSessionToken('secret', 's1', ['image', 'core']);
		assert.strictEqual(status('/mcp/s1?groups=core,image', both), 200, 'group order and spacing do not matter');
		assert.strictEqual(status('/mcp/s1?groups=%20image,core', both), 200);
		const verdict = checkHostMcpRequest('POST', '/mcp/s1?groups=core', { host: '127.0.0.1:4000', authorization: `Bearer ${core}` }, 4000, 'secret');
		assert.ok(verdict.ok && verdict.sessionId === 's1' && [...verdict.groups ?? []].join() === 'core');

		// No session: only the server secret, which agents never get.
		assert.strictEqual(status('/mcp', 'secret'), 200);
		assert.strictEqual(status('/mcp', s1), 401);
		assert.strictEqual(status('/mcp/', s1), 401);
	});

	test('IPC-2: an expired token, a tampered lease or one from before the chat was revoked gets 401', () => {
		const now = 1_800_000_000_000;
		const revoked = new Map<string, number>();
		const status = (path: string, token: string, at = now) => {
			const verdict = checkHostMcpRequest('POST', path, { host: '127.0.0.1:4000', authorization: `Bearer ${token}` }, 4000, 'secret', { now: at, revokedThrough: id => revoked.get(id) });
			return verdict.ok ? 200 : verdict.status;
		};
		const lease = newHostMcpLease(now - 1000);
		const token = hostMcpSessionToken('secret', 's1', undefined, lease);
		assert.strictEqual(status('/mcp/s1', token), 200);

		// Expiry.
		assert.strictEqual(status('/mcp/s1', token, lease.expiry - 1), 200, 'just before expiry');
		assert.strictEqual(status('/mcp/s1', token, lease.expiry), 401, 'at expiry');
		assert.strictEqual(status('/mcp/s1', token, lease.expiry + HOST_MCP_TOKEN_TTL_MS), 401, 'long after');
		const tooLong = { epoch: now - 1000, expiry: now - 1000 + HOST_MCP_TOKEN_TTL_MS + 1 };
		assert.strictEqual(status('/mcp/s1', hostMcpSessionToken('secret', 's1', undefined, tooLong)), 401, 'a lifetime above the cap');

		// The lease is signed: moving the expiry or the epoch breaks the MAC.
		const mac = token.split('.')[2];
		assert.strictEqual(status('/mcp/s1', `${lease.epoch}.${lease.expiry + 60_000}.${mac}`), 401, 'a later expiry on the same MAC');
		assert.strictEqual(status('/mcp/s1', `${lease.epoch + 1}.${lease.expiry}.${mac}`), 401, 'a later epoch on the same MAC');
		assert.strictEqual(status('/mcp/s1', mac), 401, 'the bare MAC (version 1 form)');

		// Revocation: the chat's tokens at or below the revoked epoch die, later ones and other chats' live.
		const other = hostMcpSessionToken('secret', 's2', undefined, lease);
		revoked.set('s1', lease.epoch);
		assert.strictEqual(status('/mcp/s1', token), 401, 'old-epoch token after the chat was revoked');
		assert.strictEqual(status('/mcp/s2', other), 200, 'another chat is untouched');
		const renewed = hostMcpSessionToken('secret', 's1', undefined, newHostMcpLease(lease.epoch + 1));
		assert.strictEqual(status('/mcp/s1', renewed), 200, 'a token issued after the revocation');
		revoked.set('s1', lease.epoch + 1);
		assert.strictEqual(status('/mcp/s1', renewed), 401, 'revoked again');
	});

	test('IPC-1: chat A\'s token on chat B\'s path gets 401 from the live server', async () => {
		const service = store.add(new VoltHostMcpMainService(new NullLogService()));
		const calls: IVoltHostMcpCall[] = [];
		store.add(service.onDidCall(call => {
			calls.push(call);
			void service.respond(call.id, { content: [{ type: 'text', text: 'ran' }] });
		}));
		try {
			const endpoint = await service.start('ipc1', TOOLS);
			const tokenA = hostMcpSessionToken(endpoint.token, 'chat-a');
			const tokenB = hostMcpSessionToken(endpoint.token, 'chat-b');
			const call = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'ask_question', arguments: {} } };
			assert.strictEqual((await post(`${endpoint.url}/chat-b`, call, { Authorization: `Bearer ${tokenA}` })).status, 401, 'A\'s token on B\'s path');
			assert.strictEqual((await post(`${endpoint.url}/chat-a`, call, { Authorization: `Bearer ${tokenB}` })).status, 401, 'B\'s token on A\'s path');
			assert.strictEqual((await post(`${endpoint.url}/chat-b?groups=core`, call, { Authorization: `Bearer ${tokenA}` })).status, 401, 'with groups added');
			assert.strictEqual(calls.length, 0, 'nothing ran for the wrong chat');
			assert.strictEqual((await post(`${endpoint.url}/chat-a`, call, { Authorization: `Bearer ${tokenA}` })).status, 200);
			assert.deepStrictEqual(calls.map(c => c.sessionId), ['chat-a']);
		} finally {
			await service.stop('ipc1');
		}
	});

	test('IPC-2: revokeSession kills a chat\'s live token on the server; a later epoch works', async () => {
		const service = store.add(new VoltHostMcpMainService(new NullLogService()));
		try {
			const endpoint = await service.start('ipc2', TOOLS);
			const lease = newHostMcpLease(Date.now() - 10);
			const old = hostMcpSessionToken(endpoint.token, 'chat-a', undefined, lease);
			const otherChat = hostMcpSessionToken(endpoint.token, 'chat-b', undefined, lease);
			assert.strictEqual((await post(`${endpoint.url}/chat-a`, INIT, { Authorization: `Bearer ${old}` })).status, 200);
			await service.revokeSession('ipc2', 'chat-a', lease.epoch);
			const refused = await post(`${endpoint.url}/chat-a`, INIT, { Authorization: `Bearer ${old}` });
			assert.strictEqual(refused.status, 401, 'old-epoch token after revocation');
			assert.match(refused.body, /expired or revoked/i);
			assert.strictEqual((await post(`${endpoint.url}/chat-b`, INIT, { Authorization: `Bearer ${otherChat}` })).status, 200, 'other chats keep working');
			// A revocation never lowers the floor.
			await service.revokeSession('ipc2', 'chat-a', lease.epoch - 5);
			const renewed = hostMcpSessionToken(endpoint.token, 'chat-a', undefined, newHostMcpLease(lease.epoch + 1));
			assert.strictEqual((await post(`${endpoint.url}/chat-a`, INIT, { Authorization: `Bearer ${renewed}` })).status, 200, 'a token issued after');
			const expired = hostMcpSessionToken(endpoint.token, 'chat-c', undefined, { epoch: Date.now() - HOST_MCP_TOKEN_TTL_MS - 10, expiry: Date.now() - 10 });
			assert.strictEqual((await post(`${endpoint.url}/chat-c`, INIT, { Authorization: `Bearer ${expired}` })).status, 401, 'an expired token');
		} finally {
			await service.stop('ipc2');
		}
	});

	test('session tokens: the window\'s HMAC matches Node\'s, and SHA-256/HMAC match the published vectors', () => {
		const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');
		const utf8 = (value: string) => new TextEncoder().encode(value);
		assert.strictEqual(hex(sha256(utf8(''))), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
		assert.strictEqual(hex(sha256(utf8('abc'))), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
		assert.strictEqual(hex(sha256(utf8('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'))), '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1');
		// RFC 4231 test cases 2 and 6 (a key longer than a block).
		assert.strictEqual(hex(hmacSha256(utf8('Jefe'), utf8('what do ya want for nothing?'))), '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843');
		assert.strictEqual(hex(hmacSha256(new Uint8Array(131).fill(0xaa), utf8('Test Using Larger Than Block-Size Key - Hash Key First'))), '60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54');
		for (const [secret, session, groups, lease] of [
			['s', 'chat', undefined, newHostMcpLease(1)],
			[randomBytes(32).toString('base64url'), 'agent-1d2c', ['core', 'image'], newHostMcpLease()],
			[randomBytes(32).toString('base64url'), 'chat 1/ü?#', [], { epoch: 1_700_000_000_123, expiry: 1_700_000_100_000 }],
			['k'.repeat(200), 'x'.repeat(1000), ['browser'], { epoch: Number.MAX_SAFE_INTEGER - 1, expiry: Number.MAX_SAFE_INTEGER }],
		] as const) {
			// The key epoch and expiry are signed and carried in the token, the same in the window and in Node.
			const expected = `${lease.epoch}.${lease.expiry}.${createHmac('sha256', secret).update(hostMcpSessionMessage(session, groups, lease)).digest('hex')}`;
			assert.strictEqual(hostMcpSessionToken(secret, session, groups, lease), expected, `${session}`);
			assert.deepStrictEqual(parseHostMcpSessionToken(expected), { epoch: lease.epoch, expiry: lease.expiry, mac: expected.split('.')[2] });
			assert.ok(hostMcpSessionMessage(session, groups, lease).endsWith(`\n${lease.epoch}\n${lease.expiry}`));
		}
		assert.strictEqual(parseHostMcpSessionToken('a'.repeat(64)), undefined, 'a version 1 token (a bare MAC) is not a session token');
		for (let length = 0; length < 140; length++) {
			const data = randomBytes(length);
			assert.strictEqual(hex(sha256(data)), createHash('sha256').update(data).digest('hex'), `length ${length}`);
		}
	});

	test('serves JSON-RPC only to callers with the token and never sends CORS headers', async () => {
		const service = store.add(new VoltHostMcpMainService(new NullLogService()));
		try {
			const endpoint = await service.start('w1', TOOLS);
			assert.match(endpoint.url, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
			assert.ok(endpoint.token.length >= 32);
			const auth = { Authorization: `Bearer ${hostMcpSessionToken(endpoint.token, 's1')}` };

			const good = await post(`${endpoint.url}/s1`, INIT, auth);
			assert.strictEqual(good.status, 200);
			assert.strictEqual((JSON.parse(good.body) as IRpcReply).result.serverInfo.name, 'volt');
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
			const auth = (groups?: string[]) => ({ Authorization: `Bearer ${hostMcpSessionToken(endpoint.token, 'chat 1', groups)}` });
			const list = async (suffix: string, groups?: string[]) => (JSON.parse((await post(`${endpoint.url}/chat%201${suffix}`, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, auth(groups))).body) as IRpcReply).result.tools;
			assert.deepStrictEqual((await list('')).map(tool => tool.name), ['ask_question', 'browser_snapshot']);
			assert.deepStrictEqual((await list('?groups=core', ['core'])).map(tool => tool.name), ['ask_question']);
			assert.ok((await list('')).every(tool => tool.group === undefined), 'groups stay internal');

			const called = await post(`${endpoint.url}/chat%201`, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'browser_snapshot', arguments: { interactive: true } } }, auth());
			assert.strictEqual((JSON.parse(called.body) as IRpcReply).result.content[0].text, 'ran browser_snapshot');
			assert.deepStrictEqual(calls.map(call => ({ sessionId: call.sessionId, name: call.name, args: call.args })), [{ sessionId: 'chat 1', name: 'browser_snapshot', args: { interactive: true } }]);

			const hidden = await post(`${endpoint.url}/chat%201?groups=core`, { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'browser_snapshot', arguments: {} } }, auth(['core']));
			assert.strictEqual((JSON.parse(hidden.body) as IRpcReply).result.isError, true, 'a tool outside the listed groups is not callable');
			assert.strictEqual(calls.length, 1);

			// An agent that drops its groups, or names another chat, is turned away before anything runs.
			const widened = await post(`${endpoint.url}/chat%201`, { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'browser_snapshot', arguments: {} } }, auth(['core']));
			assert.strictEqual(widened.status, 401);
			const impersonated = await post(`${endpoint.url}/chat%202`, { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'ask_question', arguments: {} } }, auth());
			assert.strictEqual(impersonated.status, 401);
			assert.strictEqual(calls.length, 1);
		} finally {
			await service.stop('w2');
		}
	});

	test('rejects oversized bodies', async () => {
		const service = store.add(new VoltHostMcpMainService(new NullLogService()));
		try {
			const endpoint = await service.start('w3', TOOLS);
			const reply = await post(`${endpoint.url}/s`, { jsonrpc: '2.0', id: 1, method: 'ping', params: { pad: 'x'.repeat(5 * 1024 * 1024) } }, { Authorization: `Bearer ${hostMcpSessionToken(endpoint.token, 's')}` });
			assert.strictEqual(reply.status, 413);
		} finally {
			await service.stop('w3');
		}
	});
});
