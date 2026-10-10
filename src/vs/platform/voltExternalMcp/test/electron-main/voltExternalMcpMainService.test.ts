/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { createHash } from 'crypto';
import * as http from 'http';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { NullLogService } from '../../../log/common/log.js';
import { IExternalMcpConsentRequest } from '../../common/voltExternalMcp.js';
import { VoltExternalMcpMainService } from '../../electron-main/voltExternalMcpMainService.js';

interface IReply {
	readonly status: number;
	readonly headers: http.IncomingHttpHeaders;
	readonly body: string;
}

interface IServerMetadata {
	readonly issuer: string;
	readonly registration_endpoint: string;
	readonly authorization_endpoint: string;
	readonly token_endpoint: string;
}

interface ITokens {
	readonly scope?: string;
	readonly access_token: string;
	readonly refresh_token: string;
}

interface IRpcReply {
	readonly result: { readonly protocolVersion?: string; readonly tools: readonly { name: string }[]; readonly content?: unknown };
}

function request(url: string, options: { method?: string; body?: string; headers?: Record<string, string> } = {}): Promise<IReply> {
	const target = new URL(url);
	return new Promise((resolve, reject) => {
		const req = http.request({
			host: target.hostname,
			port: target.port,
			path: target.pathname + target.search,
			method: options.method ?? 'GET',
			agent: false,
			headers: { ...(options.body !== undefined ? { 'Content-Length': String(Buffer.byteLength(options.body)) } : {}), ...options.headers },
		}, res => {
			let data = '';
			res.setEncoding('utf8');
			res.on('data', chunk => data += chunk);
			res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: data }));
		});
		req.on('error', reject);
		req.end(options.body);
	});
}

const json = (url: string, body: unknown, headers: Record<string, string> = {}) => request(url, { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json', ...headers } });
const form = (url: string, body: Record<string, string>) => request(url, { method: 'POST', body: new URLSearchParams(body).toString(), headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });

const VERIFIER = 'q'.repeat(20) + 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_w';
const CHALLENGE = createHash('sha256').update(VERIFIER).digest('base64url');

suite('Volt external MCP server (OAuth + Streamable HTTP)', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('an outside agent registers, is approved in Volt, calls tools within its scopes, refreshes, and gets 401 after revoke', async function () {
		this.timeout(20_000);
		const port = 40000 + Math.floor(Math.random() * 20000);
		const service = store.add(new VoltExternalMcpMainService(new NullLogService(), undefined, { file: null }));
		const status = await service.configure({ enabled: true, port, publicUrl: '' });
		assert.ok(status.listening, status.error);
		const base = `http://127.0.0.1:${port}`;

		// The window serves read and send tools and answers calls.
		await service.attach('w1', [
			{ name: 'thread_list', description: 'list', inputSchema: { type: 'object' }, scope: 'read' },
			{ name: 'thread_send', description: 'send', inputSchema: { type: 'object' }, scope: 'send' },
			{ name: 'thread_launch', description: 'launch', inputSchema: { type: 'object' }, scope: 'launch' },
		]);
		const calls: string[] = [];
		store.add(service.onDidCall(call => {
			calls.push(`${call.clientName}:${call.name}`);
			void service.respond(call.id, { content: [{ type: 'text', text: `ran ${call.name}` }] });
		}));
		const consents: IExternalMcpConsentRequest[] = [];
		store.add(service.onDidRequestConsent(request => consents.push(request)));

		// 1. Unauthenticated: 401 pointing at the resource metadata.
		const anonymous = await json(`${base}/mcp`, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
		assert.strictEqual(anonymous.status, 401);
		assert.match(String(anonymous.headers['www-authenticate']), /resource_metadata="http:\/\/127\.0\.0\.1:\d+\/\.well-known\/oauth-protected-resource\/mcp"/);
		assert.strictEqual((await json(`${base}/mcp`, {}, { Host: 'evil.com' })).status, 403, 'DNS rebinding');

		// 2. Discovery.
		const prm = JSON.parse((await request(`${base}/.well-known/oauth-protected-resource/mcp`)).body) as { resource: string };
		assert.strictEqual(prm.resource, `${base}/mcp`);
		const meta = JSON.parse((await request(`${base}/.well-known/oauth-authorization-server`)).body) as IServerMetadata;
		assert.strictEqual(meta.issuer, base);

		// 3. Dynamic client registration.
		const registered = await json(meta.registration_endpoint, { client_name: 'Claude Code', redirect_uris: ['http://localhost:5555/callback'], token_endpoint_auth_method: 'none' });
		assert.strictEqual(registered.status, 201, registered.body);
		const clientId = (JSON.parse(registered.body) as { client_id: string }).client_id;
		assert.strictEqual((await json(meta.registration_endpoint, { client_name: 'x', redirect_uris: ['http://evil.com/cb'] })).status, 400);

		// 4. Authorize: no PKCE goes back to the client with an error; a bad redirect never redirects.
		const authorize = (extra: Record<string, string>) => request(`${meta.authorization_endpoint}?${new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: 'http://localhost:61000/callback', state: 'st8', ...extra })}`);
		const noPkce = await authorize({});
		assert.strictEqual(noPkce.status, 302);
		assert.match(String(noPkce.headers.location), /^http:\/\/localhost:61000\/callback\?error=invalid_request/);
		assert.strictEqual((await authorize({ redirect_uri: 'http://localhost:1/elsewhere', code_challenge: CHALLENGE, code_challenge_method: 'S256' })).status, 400);

		const started = await authorize({ code_challenge: CHALLENGE, code_challenge_method: 'S256', scope: 'read launch' });
		assert.strictEqual(started.status, 302);
		const waitUrl = String(started.headers.location);
		assert.ok(waitUrl.startsWith(`${base}/oauth/authorize/wait?request=`));
		assert.strictEqual(consents.length, 1);
		assert.deepStrictEqual(consents[0].scopes, ['read', 'launch']);
		assert.strictEqual(consents[0].windowId, 'w1');
		assert.strictEqual(consents[0].clientName, 'Claude Code');

		// The browser tab waits (it reloads itself) until the user answers in Volt.
		const waiting = await request(waitUrl);
		assert.strictEqual(waiting.status, 200);
		assert.strictEqual(waiting.headers.refresh, '1');
		assert.match(waiting.body, /Switch to <b>Volt<\/b>/);

		// The user unticks launch and allows read.
		await service.answerConsent(consents[0].id, { approve: true, scopes: ['read'] });
		const back = await request(waitUrl);
		assert.strictEqual(back.status, 302);
		const callback = new URL(String(back.headers.location));
		assert.strictEqual(callback.origin + callback.pathname, 'http://localhost:61000/callback');
		assert.strictEqual(callback.searchParams.get('state'), 'st8');
		assert.strictEqual(callback.searchParams.get('iss'), base);
		const code = callback.searchParams.get('code')!;

		// 5. Token exchange (form encoded, like most clients).
		const tokenReply = await form(meta.token_endpoint, { grant_type: 'authorization_code', code, client_id: clientId, redirect_uri: 'http://localhost:61000/callback', code_verifier: VERIFIER, resource: `${base}/mcp` });
		assert.strictEqual(tokenReply.status, 200, tokenReply.body);
		assert.strictEqual(tokenReply.headers['cache-control'], 'no-store');
		const tokens = JSON.parse(tokenReply.body) as ITokens;
		assert.strictEqual(tokens.scope, 'read');
		const auth = { Authorization: `Bearer ${tokens.access_token}`, Accept: 'application/json, text/event-stream' };

		// 6. MCP: initialize gives a session; tools/list only shows the granted scope; calls reach the window.
		const init = await json(`${base}/mcp`, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }, auth);
		assert.strictEqual(init.status, 200, init.body);
		assert.ok(init.headers['mcp-session-id']);
		assert.strictEqual((JSON.parse(init.body) as IRpcReply).result.protocolVersion, '2025-06-18');
		const session = { ...auth, 'Mcp-Session-Id': String(init.headers['mcp-session-id']) };
		assert.strictEqual((await json(`${base}/mcp`, { jsonrpc: '2.0', method: 'notifications/initialized' }, session)).status, 202);
		const listed = JSON.parse((await json(`${base}/mcp`, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, session)).body) as IRpcReply;
		assert.deepStrictEqual(listed.result.tools.map((tool: { name: string }) => tool.name), ['thread_list']);
		const called = JSON.parse((await json(`${base}/mcp`, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'thread_list', arguments: {} } }, session)).body) as IRpcReply;
		assert.deepStrictEqual(called.result.content, [{ type: 'text', text: 'ran thread_list' }]);
		assert.deepStrictEqual(calls, ['Claude Code:thread_list']);
		const outOfScope = await json(`${base}/mcp`, { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'thread_launch', arguments: {} } }, session);
		assert.strictEqual(outOfScope.status, 403);
		assert.match(String(outOfScope.headers['www-authenticate']), /error="insufficient_scope", scope="read launch"/);
		assert.strictEqual((await json(`${base}/mcp`, {}, { ...auth, Origin: 'https://evil.com' })).status, 403, 'foreign origin');

		// 7. Refresh rotates; the grant shows on Connected agents with its last call.
		const refreshed = JSON.parse((await form(meta.token_endpoint, { grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: clientId })).body) as ITokens;
		assert.ok(refreshed.access_token && refreshed.refresh_token !== tokens.refresh_token);
		const grants = await service.listGrants();
		assert.strictEqual(grants.length, 1);
		assert.strictEqual(grants[0].clientName, 'Claude Code');
		assert.strictEqual(grants[0].lastTool, 'thread_list');

		// 8. Revoke in Volt: the next call is 401 with invalid_token.
		await service.revoke(grants[0].id);
		const after = await json(`${base}/mcp`, { jsonrpc: '2.0', id: 5, method: 'tools/list' }, { Authorization: `Bearer ${refreshed.access_token}` });
		assert.strictEqual(after.status, 401);
		assert.match(String(after.headers['www-authenticate']), /error="invalid_token"/);

		// A denied request sends the browser back with access_denied.
		const again = await authorize({ code_challenge: CHALLENGE, code_challenge_method: 'S256' });
		await service.answerConsent(consents[1].id, { approve: false });
		const denied = await request(String(again.headers.location));
		assert.match(String(denied.headers.location), /error=access_denied/);

		await service.configure({ enabled: false, port, publicUrl: '' });
		assert.strictEqual((await service.getStatus()).listening, false);
	});
});
