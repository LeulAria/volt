/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { compactHttpSettings, encodeHttpUrl, httpSettingsWithDefaults, IHttpRequest, isHttpSettingDefault } from '../../common/httpCollection.js';
import { collectionToHttpFile, httpFileToCollection } from '../../common/httpDotHttp.js';
import { collectionToPostman, postmanToCollection } from '../../common/httpPostman.js';

suite('Volt HTTP client request settings', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('only what differs from the default is kept', () => {
		assert.strictEqual(compactHttpSettings({ strictSSL: true, followRedirects: true, maxRedirects: 10, httpVersion: 'auto', tlsCipherSuites: [], encodeUrl: true }), undefined);
		assert.deepStrictEqual(compactHttpSettings({ strictSSL: false, maxRedirects: 3, tlsDisabledProtocols: ['TLSv1_1', 'TLSv1'], tlsCipherSuites: [' ECDHE-RSA-AES128-GCM-SHA256 ', ''], timeoutMs: 1500.4 }), { strictSSL: false, maxRedirects: 3, tlsDisabledProtocols: ['TLSv1', 'TLSv1_1'], tlsCipherSuites: ['ECDHE-RSA-AES128-GCM-SHA256'], timeoutMs: 1500 });
		const all = httpSettingsWithDefaults({ disableCookies: true });
		assert.deepStrictEqual([all.strictSSL, all.followRedirects, all.followOriginalHttpMethod, all.followAuthorizationHeader, all.removeRefererHeaderOnRedirect, all.strictHttpParser, all.encodeUrl, all.disableCookies, all.maxRedirects, all.timeoutMs], [true, true, false, false, false, false, true, true, 10, undefined]);
		assert.strictEqual(isHttpSettingDefault({ maxRedirects: 10 }, 'maxRedirects'), true);
		assert.strictEqual(isHttpSettingDefault({ tlsDisabledProtocols: ['TLSv1'] }, 'tlsDisabledProtocols'), false);
	});

	test('URL encoding: what may not stand in a path or query, leaving %XX, the host and the fragment alone', () => {
		assert.strictEqual(encodeHttpUrl('https://api.example.com/a b/{id}?q=x y&r="1"&s=%20ok&t=100%#frag ment'), 'https://api.example.com/a%20b/%7Bid%7D?q=x%20y&r=%221%22&s=%20ok&t=100%25#frag ment');
		// allow-any-unicode-next-line
		assert.strictEqual(encodeHttpUrl('https://example.com/café?n=ü'), 'https://example.com/caf%C3%A9?n=%C3%BC');
		assert.strictEqual(encodeHttpUrl('https://example.com/already%2Fencoded?a=b'), 'https://example.com/already%2Fencoded?a=b');
		// The authentication fields: what may not stand in them (an @ in the name, a space, a colon in the password), %XX kept.
		assert.strictEqual(encodeHttpUrl('https://ada@example.com:p@ss w:rd%21@api.example.com:8443/x'), 'https://ada%40example.com:p%40ss%20w%3Ard%21@api.example.com:8443/x');
		assert.strictEqual(encodeHttpUrl('http://user@localhost:3000/'), 'http://user@localhost:3000/');
	});

	test('Postman\'s protocolProfileBehavior is the request\'s settings, and goes back as it came with keys the settings do not own', () => {
		const behavior = { strictSSL: false, followRedirects: false, disableUrlEncoding: true, insecureHTTPParser: false, maxRedirects: 3, tlsDisabledProtocols: ['TLSv1', 'nonsense'], tlsCipherSelection: ['ECDHE-RSA-AES128-GCM-SHA256'], protocolVersion: 'http2', disableBodyPruning: true };
		const collection = postmanToCollection({
			info: { name: 'S', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
			item: [{ name: 'r', request: { method: 'GET', url: 'https://api.example.com/x' }, protocolProfileBehavior: behavior }],
		});
		const request = collection.items[0] as IHttpRequest;
		assert.deepStrictEqual(request.settings, { httpVersion: 'http2', strictSSL: false, followRedirects: false, strictHttpParser: true, encodeUrl: false, maxRedirects: 3, tlsDisabledProtocols: ['TLSv1'], tlsCipherSuites: ['ECDHE-RSA-AES128-GCM-SHA256'] });
		request.settings = { ...request.settings, strictSSL: undefined, timeoutMs: 5000 };
		const written = (collectionToPostman(collection).item as { protocolProfileBehavior?: unknown }[])[0].protocolProfileBehavior;
		assert.deepStrictEqual(written, { disableBodyPruning: true, followRedirects: false, insecureHTTPParser: false, disableUrlEncoding: true, maxRedirects: 3, tlsDisabledProtocols: ['TLSv1'], tlsCipherSelection: ['ECDHE-RSA-AES128-GCM-SHA256'], protocolVersion: 'http2', voltTimeoutMs: 5000 });
	});

	test('.http settings directives read and written', () => {
		const text = [
			'### slow',
			'# @no-redirect',
			'# @no-cookie-jar',
			'# @insecure',
			'# @timeout 5000',
			'# @http-version 1.1',
			'# @setting removeRefererHeaderOnRedirect true',
			'# @setting maxRedirects 2',
			'GET https://api.example.com/slow',
		].join('\n');
		const collection = httpFileToCollection(text, 'f');
		const request = collection.items[0] as IHttpRequest;
		assert.deepStrictEqual(request.settings, { httpVersion: 'http1', strictSSL: false, followRedirects: false, removeRefererHeaderOnRedirect: true, disableCookies: true, maxRedirects: 2, timeoutMs: 5000 });
		const out = collectionToHttpFile(collection);
		for (const line of ['# @http-version 1.1', '# @insecure', '# @no-redirect', '# @no-cookie-jar', '# @timeout 5000', '# @setting removeRefererHeaderOnRedirect true', '# @setting maxRedirects 2']) {
			assert.ok(out.includes(line), `${line} in\n${out}`);
		}
		assert.deepStrictEqual((httpFileToCollection(out, 'f').items[0] as IHttpRequest).settings, request.settings, 'round trip');
	});
});
