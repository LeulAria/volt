/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { connectSnippets } from '../../common/externalMcpConnect.js';
import {
	authorizationServerMetadata, baseUrlFor, checkClientMetadata, checkRedirectUri, describeRedirect, externalToolScope, isAllowedOrigin, isPkceChallenge, isPkceVerifier,
	narrowScopes, negotiateProtocolVersion, normalizePublicUrl, parseScopes, protectedResourceMetadata, redirectMatches, sameResource, wwwAuthenticate,
} from '../../common/externalMcpOAuth.js';

suite('Volt external MCP: OAuth rules', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('scopes: defaults, namespaced, unknown, canonical order, narrowing', () => {
		assert.deepStrictEqual(parseScopes(undefined).scopes, ['read', 'send', 'launch']);
		assert.deepStrictEqual(parseScopes('').scopes, ['read', 'send', 'launch']);
		assert.deepStrictEqual(parseScopes('admin read'), { scopes: ['read', 'admin'], unknown: [] });
		assert.deepStrictEqual(parseScopes('volt:send mcp:read offline_access'), { scopes: ['read', 'send'], unknown: ['offline_access'] });
		assert.deepStrictEqual(parseScopes('openid', []).scopes, []);
		assert.deepStrictEqual(narrowScopes(['admin', 'read'], ['read', 'send']), ['read']);
	});

	test('every orchestrator tool has a scope; tools that need a chat or the screen have none', () => {
		assert.strictEqual(externalToolScope('thread_list'), 'read');
		assert.strictEqual(externalToolScope('thread_wait'), 'read');
		assert.strictEqual(externalToolScope('thread_send'), 'send');
		assert.strictEqual(externalToolScope('thread_launch'), 'launch');
		assert.strictEqual(externalToolScope('thread_fork'), 'launch');
		assert.strictEqual(externalToolScope('thread_configure'), 'admin');
		for (const name of ['delegate_task', 'browser_click', 'ask_question', 'html_render', 'toString', '__proto__']) {
			assert.strictEqual(externalToolScope(name), undefined, name);
		}
	});

	test('redirect URIs: loopback http, https, app schemes; no fragments, credentials or script', () => {
		for (const ok of ['http://localhost:53682/callback', 'http://127.0.0.1/cb', 'http://[::1]:9000/cb', 'https://chatgpt.com/connector_platform_oauth_redirect', 'cursor://anysphere.cursor-retrieval/oauth/callback', 'com.example.app:/cb']) {
			assert.strictEqual(checkRedirectUri(ok), undefined, ok);
		}
		for (const bad of ['http://example.com/cb', 'http://192.168.1.2/cb', 'https://a.com/cb#x', 'https://user:pw@a.com/cb', 'javascript:alert(1)', 'data:text/html,hi', 'file:///etc/passwd', 'not a uri', 42]) {
			assert.ok(checkRedirectUri(bad), String(bad));
		}
	});

	test('redirect match: exact, or loopback with any port (RFC 8252)', () => {
		const registered = ['http://localhost:4000/callback', 'https://a.com/cb'];
		assert.ok(redirectMatches(registered, 'http://localhost:4000/callback'));
		assert.ok(redirectMatches(registered, 'http://localhost:61234/callback'));
		assert.ok(!redirectMatches(registered, 'http://127.0.0.1:4000/callback'), 'host must match');
		assert.ok(!redirectMatches(registered, 'http://localhost:4000/other'), 'path must match');
		assert.ok(!redirectMatches(registered, 'https://a.com/cb2'));
		assert.ok(!redirectMatches(registered, 'https://a.com:444/cb'), 'https is exact');
	});

	test('client metadata: names cleaned, bad redirects refused', () => {
		const ok = checkClientMetadata({ client_name: 'Claude‮ Code\n', redirect_uris: ['http://localhost:1/cb'], client_uri: 'http://x.com', software_id: 'claude-code' });
		assert.ok(!('error' in ok));
		assert.strictEqual(ok.name, 'Claude Code');
		assert.strictEqual(ok.clientUri, undefined, 'only https client_uri');
		assert.strictEqual(ok.softwareId, 'claude-code');
		assert.strictEqual((checkClientMetadata({ redirect_uris: ['http://localhost:1/cb'] }) as { name: string }).name, 'Unnamed agent');
		assert.deepStrictEqual(Object.keys(checkClientMetadata({ client_name: 'x', redirect_uris: [] })), ['error', 'description']);
		assert.strictEqual((checkClientMetadata({ client_name: 'x', redirect_uris: ['http://evil.com/cb'] }) as { error: string }).error, 'invalid_redirect_uri');
	});

	test('PKCE shapes', () => {
		assert.ok(isPkceChallenge('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM'));
		assert.ok(!isPkceChallenge('short'));
		assert.ok(isPkceVerifier('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'));
		assert.ok(!isPkceVerifier('a'.repeat(42)));
		assert.ok(!isPkceVerifier('a'.repeat(129)));
	});

	test('hosts: loopback names on the port, the public tunnel host, nothing else', () => {
		const origins = { port: 47651, publicUrl: 'https://volt.example.dev' };
		assert.strictEqual(baseUrlFor('127.0.0.1:47651', origins), 'http://127.0.0.1:47651');
		assert.strictEqual(baseUrlFor('LOCALHOST:47651', origins), 'http://localhost:47651');
		assert.strictEqual(baseUrlFor('[::1]:47651', origins), 'http://[::1]:47651');
		assert.strictEqual(baseUrlFor('volt.example.dev', origins), 'https://volt.example.dev');
		assert.strictEqual(baseUrlFor('127.0.0.1:1', origins), undefined);
		assert.strictEqual(baseUrlFor('evil.com', origins), undefined, 'DNS rebinding');
		assert.strictEqual(baseUrlFor(undefined, origins), undefined);
		assert.strictEqual(normalizePublicUrl('https://abc.trycloudflare.com/'), 'https://abc.trycloudflare.com');
		assert.strictEqual(normalizePublicUrl('http://abc.com'), '', 'https only');
	});

	test('resource binding treats loopback names as one; origins only from Volt itself', () => {
		assert.ok(sameResource('http://127.0.0.1:47651/mcp', 'http://localhost:47651/mcp/'));
		assert.ok(!sameResource('http://127.0.0.1:47651/mcp', 'https://volt.example.dev/mcp'));
		assert.ok(!sameResource('http://127.0.0.1:47651/mcp', 'http://127.0.0.1:47652/mcp'));
		assert.ok(isAllowedOrigin(undefined, 'http://127.0.0.1:1'));
		assert.ok(isAllowedOrigin('http://127.0.0.1:1', 'http://127.0.0.1:1'));
		assert.ok(!isAllowedOrigin('https://evil.com', 'http://127.0.0.1:1'));
	});

	test('metadata documents and the 401/403 challenge', () => {
		const base = 'http://127.0.0.1:47651';
		const prm = protectedResourceMetadata(base) as { resource: string; authorization_servers: string[] };
		assert.strictEqual(prm.resource, `${base}/mcp`);
		assert.deepStrictEqual(prm.authorization_servers, [base]);
		const as = authorizationServerMetadata(base) as Record<string, unknown>;
		assert.strictEqual(as.issuer, base);
		assert.deepStrictEqual(as.code_challenge_methods_supported, ['S256']);
		assert.deepStrictEqual(as.grant_types_supported, ['authorization_code', 'refresh_token']);
		assert.strictEqual(as.registration_endpoint, `${base}/oauth/register`);
		assert.strictEqual(wwwAuthenticate(base), `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`);
		assert.strictEqual(wwwAuthenticate(base, { error: 'insufficient_scope', scope: ['launch', 'read'] }), `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp", error="insufficient_scope", scope="read launch"`);
		assert.strictEqual(negotiateProtocolVersion('2025-06-18'), '2025-06-18');
		assert.strictEqual(negotiateProtocolVersion('1999-01-01'), '2025-11-25');
	});

	test('redirect labels and connect snippets', () => {
		assert.deepStrictEqual(describeRedirect('http://localhost:5000/cb'), { local: true, label: 'an app on this computer (port 5000)' });
		assert.deepStrictEqual(describeRedirect('https://chatgpt.com/cb'), { local: false, label: 'chatgpt.com' });
		const snippets = connectSnippets('http://127.0.0.1:47651/mcp', { port: 47651 });
		assert.deepStrictEqual(snippets.map(snippet => snippet.id), ['claude', 'codex', 'cursor', 'tunnel']);
		assert.ok(snippets[0].code.startsWith('claude mcp add --transport http --scope user volt http://127.0.0.1:47651/mcp'));
		assert.deepStrictEqual(JSON.parse(snippets[2].code), { mcpServers: { volt: { url: 'http://127.0.0.1:47651/mcp' } } });
		assert.strictEqual(connectSnippets('u', { port: 1, publicMcpUrl: 'https://t.dev/mcp' })[3].code, 'https://t.dev/mcp');
	});
});
