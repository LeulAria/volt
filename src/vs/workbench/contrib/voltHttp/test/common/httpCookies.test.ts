/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { httpCookieHeader, httpCookiesFor, httpSetCookieLines, IHttpCookie, parseHttpCookieDate, parseHttpCookieText, parseHttpSetCookie, serializeHttpCookie, splitHttpSetCookie, storeHttpCookies } from '../../common/httpCookies.js';

const NOW = Date.UTC(2026, 10, 18, 12, 0, 0);

suite('Volt HTTP client cookie jar', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('Set-Cookie lines: joined ones split where a new cookie starts, not inside Expires', () => {
		const joined = 'a=1; Path=/; Expires=Wed, 21 Oct 2037 07:28:00 GMT, b=2; HttpOnly, c=x=y';
		assert.deepStrictEqual(splitHttpSetCookie(joined), ['a=1; Path=/; Expires=Wed, 21 Oct 2037 07:28:00 GMT', 'b=2; HttpOnly', 'c=x=y']);
		assert.deepStrictEqual(httpSetCookieLines({ 'Set-Cookie': ['s=1', 't=2; Secure'], 'content-type': 'text/plain' }), ['s=1', 't=2; Secure']);
		assert.deepStrictEqual(httpSetCookieLines({ 'set-cookie': joined }).length, 3);
	});

	test('cookie dates in the forms servers send them', () => {
		assert.strictEqual(parseHttpCookieDate('Wed, 21 Oct 2037 07:28:00 GMT'), Date.UTC(2037, 9, 21, 7, 28, 0));
		assert.strictEqual(parseHttpCookieDate('Sunday, 06-Nov-94 08:49:37 GMT'), Date.UTC(1994, 10, 6, 8, 49, 37));
		assert.strictEqual(parseHttpCookieDate('Sun Nov  6 08:49:37 1994'), Date.UTC(1994, 10, 6, 8, 49, 37));
		assert.strictEqual(parseHttpCookieDate('not a date'), undefined);
	});

	test('a Set-Cookie line: host-only or domain, default path, attributes, Max-Age over Expires', () => {
		const hostOnly = parseHttpSetCookie('sid=abc; HttpOnly; SameSite=lax', 'https://api.example.com/v1/users/7', NOW)!;
		assert.deepStrictEqual({ ...hostOnly }, { name: 'sid', value: 'abc', domain: 'api.example.com', path: '/v1/users', hostOnly: true, secure: false, httpOnly: true, sameSite: 'Lax', created: NOW });
		const domain = parseHttpSetCookie('t="q"; Domain=.Example.com; Path=/; Secure; Max-Age=60; Expires=Wed, 21 Oct 2037 07:28:00 GMT', 'https://api.example.com/', NOW)!;
		assert.deepStrictEqual([domain.value, domain.domain, domain.hostOnly, domain.secure, domain.expires], ['q', 'example.com', false, true, NOW + 60_000]);
		// Another site's domain, a broken line and an unkept prefix promise are refused.
		assert.strictEqual(parseHttpSetCookie('x=1; Domain=evil.com', 'https://api.example.com/', NOW), undefined);
		assert.strictEqual(parseHttpSetCookie('no-equals-sign', 'https://api.example.com/', NOW), undefined);
		assert.strictEqual(parseHttpSetCookie('__Host-x=1; Secure; Path=/app', 'https://api.example.com/', NOW), undefined);
		assert.ok(parseHttpSetCookie('__Host-x=1; Secure; Path=/', 'https://api.example.com/', NOW));
	});

	test('which cookies a URL gets: domain, host-only, path, Secure, expiry; order and the user\'s own header', () => {
		let jar: IHttpCookie[] = [];
		jar = storeHttpCookies(jar, ['root=1; Domain=example.com; Path=/', 'api=2; Path=/v1', 'sec=3; Secure; Path=/'], 'https://api.example.com/v1/x', NOW);
		jar = storeHttpCookies(jar, ['short=4; Max-Age=1; Path=/'], 'https://api.example.com/', NOW);
		const names = (url: string, at = NOW) => httpCookiesFor(jar, url, at).map(cookie => cookie.name);
		assert.deepStrictEqual(names('https://api.example.com/v1/users'), ['api', 'root', 'sec', 'short'], 'the longest path first');
		assert.deepStrictEqual(names('http://api.example.com/v1/users'), ['api', 'root', 'short'], 'Secure only over https');
		assert.deepStrictEqual(names('https://www.example.com/v1'), ['root'], 'a host-only cookie stays on its host; a domain cookie goes to every subdomain');
		assert.deepStrictEqual(names('https://api.example.com/v10'), ['root', 'sec', 'short'], '/v1 does not match /v10');
		assert.deepStrictEqual(names('https://api.example.com/', NOW + 2000), ['root', 'sec'], 'expired after its Max-Age');
		assert.strictEqual(httpCookieHeader(jar, 'https://www.example.com/', NOW, 'root=mine; extra=1'), 'root=mine; extra=1', 'the user\'s value wins over the jar\'s');
		assert.strictEqual(httpCookieHeader(jar, 'https://other.test/', NOW), undefined);

		// The same name, domain and path replaces; an expired one deletes.
		jar = storeHttpCookies(jar, ['api=changed; Path=/v1'], 'https://api.example.com/v1/x', NOW + 10);
		assert.strictEqual(jar.find(cookie => cookie.name === 'api')?.value, 'changed');
		assert.strictEqual(jar.find(cookie => cookie.name === 'api')?.created, NOW, 'it keeps its age');
		jar = storeHttpCookies(jar, ['api=; Path=/v1; Max-Age=0'], 'https://api.example.com/v1/x', NOW + 20);
		assert.strictEqual(jar.some(cookie => cookie.name === 'api'), false);
	});

	test('a cookie as text and back, for the manager\'s editor', () => {
		const cookie = parseHttpCookieText('Cookie_1=value; Path=/; Expires=Wed, 21 Oct 2037 07:28:00 GMT;', 'https://Example.com/x', NOW)!;
		assert.deepStrictEqual([cookie.name, cookie.domain, cookie.path, cookie.hostOnly], ['Cookie_1', 'example.com', '/', true]);
		assert.strictEqual(serializeHttpCookie(cookie), 'Cookie_1=value; Path=/; Expires=Wed, 21 Oct 2037 07:28:00 GMT');
		assert.strictEqual(parseHttpCookieText('x=1; Domain=sub.example.com', 'example.com', NOW), undefined, 'a domain below the one it is written for');
	});
});
