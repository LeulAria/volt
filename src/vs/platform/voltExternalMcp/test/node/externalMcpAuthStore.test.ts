/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { createHash } from 'crypto';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { ACCESS_TOKEN_TTL_MS, REFRESH_TOKEN_TTL_MS } from '../../common/externalMcpOAuth.js';
import { ExternalMcpAuthStore, IOAuthError, ITokenResponse, pkceMatches } from '../../node/externalMcpAuthStore.js';

const VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
const CHALLENGE = createHash('sha256').update(VERIFIER).digest('base64url');
const RESOURCE = 'http://127.0.0.1:47651/mcp';

function isTokens(value: ITokenResponse | IOAuthError): value is ITokenResponse {
	return !('error' in value);
}

suite('Volt external MCP: token store', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	let now: number;
	let store: ExternalMcpAuthStore;
	let changes: number;

	setup(() => {
		now = 1_000_000;
		changes = 0;
		store = new ExternalMcpAuthStore(() => changes++, () => now);
	});

	function connect(scopes: ('read' | 'send' | 'launch' | 'admin')[] = ['read', 'send']) {
		const client = store.registerClient({ name: 'Claude Code', redirectUris: ['http://localhost:4000/callback'] });
		const code = store.issueCode({ clientId: client.clientId, redirectUri: 'http://localhost:4000/callback', scopes, challenge: CHALLENGE, resource: RESOURCE });
		const tokens = store.exchangeCode({ code, clientId: client.clientId, redirectUri: 'http://localhost:4000/callback', verifier: VERIFIER, resource: RESOURCE });
		assert.ok(isTokens(tokens), JSON.stringify(tokens));
		return { client, tokens };
	}

	test('PKCE S256 (RFC 7636 appendix B)', () => {
		assert.ok(pkceMatches(VERIFIER, 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM'));
		assert.ok(!pkceMatches(VERIFIER.replace('d', 'e'), 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM'));
		assert.ok(!pkceMatches('short', CHALLENGE));
	});

	test('code → tokens; access token works for its resource only; nothing stored in clear', () => {
		const { tokens } = connect();
		assert.ok(tokens.access_token.startsWith('volt_at_'));
		assert.ok(tokens.refresh_token.startsWith('volt_rt_'));
		assert.strictEqual(tokens.expires_in, ACCESS_TOKEN_TTL_MS / 1000);
		assert.strictEqual(tokens.scope, 'read send');
		assert.deepStrictEqual(store.verifyAccess(tokens.access_token, 'http://localhost:47651/mcp')?.scopes, ['read', 'send']);
		assert.strictEqual(store.verifyAccess(tokens.access_token, 'https://tunnel.dev/mcp'), undefined, 'audience');
		assert.strictEqual(store.verifyAccess(tokens.refresh_token, RESOURCE), undefined, 'refresh token is not an access token');
		const saved = JSON.stringify(store.toJSON());
		assert.ok(!saved.includes(tokens.access_token) && !saved.includes(tokens.refresh_token), 'only hashes persist');
		assert.ok(changes > 0);
	});

	test('a code is single-use and checked against client, redirect, resource and verifier', () => {
		const client = store.registerClient({ name: 'x', redirectUris: ['http://localhost:4000/cb'] });
		const issue = () => store.issueCode({ clientId: client.clientId, redirectUri: 'http://localhost:4000/cb', scopes: ['read'], challenge: CHALLENGE, resource: RESOURCE });
		const good = { clientId: client.clientId, redirectUri: 'http://localhost:4000/cb', verifier: VERIFIER, resource: RESOURCE };
		const reuse = issue();
		assert.ok(isTokens(store.exchangeCode({ ...good, code: reuse })));
		assert.strictEqual((store.exchangeCode({ ...good, code: reuse }) as IOAuthError).error, 'invalid_grant', 'used');
		assert.strictEqual((store.exchangeCode({ ...good, code: issue(), verifier: VERIFIER.replace('d', 'x') }) as IOAuthError).error, 'invalid_grant', 'verifier');
		assert.strictEqual((store.exchangeCode({ ...good, code: issue(), clientId: 'other' }) as IOAuthError).error, 'invalid_grant', 'client');
		assert.strictEqual((store.exchangeCode({ ...good, code: issue(), redirectUri: 'http://localhost:4000/x' }) as IOAuthError).error, 'invalid_grant', 'redirect');
		assert.strictEqual((store.exchangeCode({ ...good, code: issue(), resource: 'https://x.dev/mcp' }) as IOAuthError).error, 'invalid_target', 'resource');
		const late = issue();
		now += 61_000;
		assert.strictEqual((store.exchangeCode({ ...good, code: late }) as IOAuthError).error, 'invalid_grant', 'expired');
	});

	test('access tokens expire after an hour; refresh rotates and narrows, never widens', () => {
		const { client, tokens } = connect(['read', 'send', 'launch']);
		now += ACCESS_TOKEN_TTL_MS + 1;
		assert.strictEqual(store.verifyAccess(tokens.access_token, RESOURCE), undefined);
		const wider = store.refresh({ refreshToken: tokens.refresh_token, clientId: client.clientId, scope: 'read admin' });
		assert.strictEqual((wider as IOAuthError).error, 'invalid_scope');
		const next = store.refresh({ refreshToken: tokens.refresh_token, clientId: client.clientId, scope: 'read' });
		assert.ok(isTokens(next));
		assert.notStrictEqual(next.refresh_token, tokens.refresh_token);
		assert.strictEqual(next.scope, 'read');
		assert.deepStrictEqual(store.verifyAccess(next.access_token, RESOURCE)?.scopes, ['read']);
		assert.strictEqual((store.refresh({ refreshToken: next.refresh_token, clientId: 'someone-else' }) as IOAuthError).error, 'invalid_grant');
	});

	test('reusing a rotated refresh token revokes the whole grant', () => {
		const { tokens } = connect();
		const next = store.refresh({ refreshToken: tokens.refresh_token });
		assert.ok(isTokens(next));
		const stolen = store.refresh({ refreshToken: tokens.refresh_token });
		assert.strictEqual((stolen as IOAuthError).error, 'invalid_grant');
		assert.strictEqual(store.verifyAccess(next.access_token, RESOURCE), undefined, 'live token died with the grant');
		assert.strictEqual((store.refresh({ refreshToken: next.refresh_token }) as IOAuthError).error, 'invalid_grant');
		assert.strictEqual(store.listGrants().length, 0);
	});

	test('revoke by grant or by token (RFC 7009); a refresh token lapses after 30 idle days', () => {
		const first = connect();
		const grant = store.listGrants()[0];
		store.touch(grant.id, 'thread_list');
		assert.strictEqual(store.listGrants()[0].lastTool, 'thread_list');
		assert.strictEqual(store.listGrants()[0].calls, 1);
		assert.ok(store.revokeGrant(grant.id));
		assert.strictEqual(store.verifyAccess(first.tokens.access_token, RESOURCE), undefined);

		const second = connect();
		assert.ok(store.revokeToken(second.tokens.access_token));
		assert.strictEqual((store.refresh({ refreshToken: second.tokens.refresh_token }) as IOAuthError).error, 'invalid_grant');
		assert.ok(!store.revokeToken('volt_at_unknown'));

		const third = connect();
		now += REFRESH_TOKEN_TTL_MS + 1;
		assert.strictEqual((store.refresh({ refreshToken: third.tokens.refresh_token }) as IOAuthError).error, 'invalid_grant');
	});

	test('signing in again replaces the earlier grant; grants survive a reload', () => {
		const client = store.registerClient({ name: 'Codex', redirectUris: ['http://127.0.0.1:1/cb'] });
		const exchange = () => store.exchangeCode({ code: store.issueCode({ clientId: client.clientId, redirectUri: 'http://127.0.0.1:1/cb', scopes: ['read'], challenge: CHALLENGE, resource: RESOURCE }), clientId: client.clientId, verifier: VERIFIER });
		const one = exchange() as ITokenResponse;
		const two = exchange() as ITokenResponse;
		assert.strictEqual(store.listGrants().length, 1);
		assert.strictEqual(store.verifyAccess(one.access_token, RESOURCE), undefined);

		const reloaded = new ExternalMcpAuthStore(() => { }, () => now);
		reloaded.load(JSON.parse(JSON.stringify(store.toJSON())));
		assert.strictEqual(reloaded.verifyAccess(two.access_token, RESOURCE)?.clientName, 'Codex');
		assert.ok(isTokens(reloaded.refresh({ refreshToken: two.refresh_token })));
		reloaded.load({ version: 99 });
	});
});
