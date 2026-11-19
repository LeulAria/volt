/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { httpOAuth1BaseString, httpSignJwt, IHttpSignable, parseHttpChallenges, signHttpRequest } from '../../common/httpAuth.js';
import { emptyHttpAuth, emptyHttpRequest, HTTP_AUTH_COMPUTED, HttpAuthType, httpAutoHeaders, httpWireRequest, IHttpAuth } from '../../common/httpCollection.js';
import { httpBase64, httpFromBase64, httpHex, httpMd5, httpSha512_256, httpUtf8 } from '../../common/httpCrypto.js';
import { httpOAuth2AuthorizeUrl, httpOAuth2CodeFrom, httpOAuth2TokenRequest, httpPkceChallenge, httpPkceVerifier, parseHttpOAuth2Token } from '../../common/httpOAuth2.js';

function auth(type: HttpAuthType, params: Record<string, string>): IHttpAuth {
	return { ...emptyHttpAuth(type), params };
}

function get(url: string, headers: [string, string][] = []): IHttpSignable {
	return { method: 'GET', url, headers };
}

const same = (text: string) => text;

function authorization(signed: { readonly headers: readonly (readonly [string, string])[] }): string {
	return signed.headers.find(([key]) => key.toLowerCase() === 'authorization')?.[1] ?? '';
}

function pem(label: string, bytes: ArrayBuffer): string {
	const lines = httpBase64(new Uint8Array(bytes)).match(/.{1,64}/g) ?? [];
	return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----\n`;
}

function fromBase64Url(text: string): ArrayBuffer {
	const bytes = httpFromBase64(text.replace(/-/g, '+').replace(/_/g, '/'));
	const copy = new Uint8Array(bytes.byteLength);
	copy.set(bytes);
	return copy.buffer;
}

function bufferOf(text: string): ArrayBuffer {
	const bytes = httpUtf8(text);
	const copy = new Uint8Array(bytes.byteLength);
	copy.set(bytes);
	return copy.buffer;
}

async function rsaKey(name: 'RSASSA-PKCS1-v1_5' | 'RSA-PSS', hash: string): Promise<{ pem: string; publicKey: CryptoKey }> {
	const pair = await crypto.subtle.generateKey({ name, modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash }, true, ['sign', 'verify']);
	return { pem: pem('PRIVATE KEY', await crypto.subtle.exportKey('pkcs8', pair.privateKey)), publicKey: pair.publicKey };
}

suite('HTTP client: authorization signing', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('MD5 and SHA-512/256 match their published values', () => {
		assert.strictEqual(httpHex(httpMd5(httpUtf8(''))), 'd41d8cd98f00b204e9800998ecf8427e');
		assert.strictEqual(httpHex(httpMd5(httpUtf8('abc'))), '900150983cd24fb0d6963f7d28e17f72');
		assert.strictEqual(httpHex(httpMd5(httpUtf8('1234567890'.repeat(8)))), '57edf4a22be3c955ac49da2e2107b67a', 'more than one block');
		assert.strictEqual(httpHex(httpSha512_256(httpUtf8('abc'))), '53048e2681941ef99b2e29b76b4c7dabe4c2d0c634fc6d46e0e2f13107e7af23');
		assert.strictEqual(httpHex(httpSha512_256(httpUtf8(''))), 'c672b8d1ef56ed28ab87c3622c5114069bdd3ad7b8f9737498d0c01ecef0967a');
		assert.strictEqual(httpHex(httpSha512_256(httpUtf8('abcdefghbcdefghicdefghijdefghijkefghijklfghijklmghijklmnhijklmnoijklmnopjklmnopqklmnopqrlmnopqrsmnopqrstnopqrstu'))), '3928e184fb8690f840da3988121d31be65cb9d3ef83ee6146feac861e19b563a', 'two blocks');
	});

	test('JWT: the well-known HS256 token, in the header with its prefix or as a query param', async () => {
		const jwt = auth('jwt', { algorithm: 'HS256', secret: '{{secret}}', payload: '{\n  "sub": "1234567890",\n  "name": "{{who}}",\n  "iat": 1516239022\n}' });
		const resolve = (text: string) => text.replace('{{secret}}', 'your-256-bit-secret').replace('{{who}}', 'John Doe');
		const token = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
		const signed = await signHttpRequest(jwt, get('https://api.test/me'), resolve);
		assert.strictEqual(authorization(signed), `Bearer ${token}`, 'no iat or exp is added: the payload is sent as written');
		assert.strictEqual(signed.url, 'https://api.test/me');

		const inQuery = await signHttpRequest({ ...jwt, params: { ...jwt.params, addTokenTo: 'queryParam', queryParamKey: 'jwt' } }, get('https://api.test/me?a=1#top'), resolve);
		assert.strictEqual(inQuery.url, `https://api.test/me?a=1&jwt=${token}#top`);
		assert.strictEqual(authorization(inQuery), '');

		const prefixed = await signHttpRequest({ ...jwt, params: { ...jwt.params, headerPrefix: 'JWT' } }, get('https://api.test/me'), resolve);
		assert.strictEqual(authorization(prefixed), `JWT ${token}`);

		// The same secret given as base64.
		const encoded = await signHttpRequest({ ...jwt, params: { ...jwt.params, secret: httpBase64(httpUtf8('your-256-bit-secret')), isSecretBase64Encoded: 'true' } }, get('https://api.test/me'), resolve);
		assert.strictEqual(authorization(encoded), `Bearer ${token}`);

		const custom = await signHttpRequest({ ...jwt, params: { ...jwt.params, header: '{"kid":"k1"}' } }, get('https://api.test/me'), resolve);
		assert.deepStrictEqual(JSON.parse(new TextDecoder().decode(fromBase64Url(authorization(custom).split(' ')[1].split('.')[0]))), { alg: 'HS256', typ: 'JWT', kid: 'k1' });

		await assert.rejects(signHttpRequest({ ...jwt, params: { ...jwt.params, payload: '{nope' } }, get('https://api.test/me'), resolve), /payload is not valid JSON/);
		await assert.rejects(signHttpRequest({ ...jwt, params: { ...jwt.params, algorithm: 'none' } }, get('https://api.test/me'), resolve), /not a JWT algorithm/);
	});

	test('JWT: HS384 and HS512 against values from an independent implementation', async () => {
		// node -e "crypto.createHmac('sha384', 'k').update(input).digest('base64url')" over the same header and payload.
		const h384 = await httpSignJwt('HS384', {}, { a: 1 }, 'k');
		const h512 = await httpSignJwt('HS512', {}, { a: 1 }, 'k');
		assert.strictEqual(h384.split('.').slice(0, 2).join('.'), 'eyJhbGciOiJIUzM4NCIsInR5cCI6IkpXVCJ9.eyJhIjoxfQ');
		assert.strictEqual(h384.split('.')[2], HS384_SIGNATURE);
		assert.strictEqual(h512.split('.')[2], HS512_SIGNATURE);
	});

	test('JWT: RS256, PS256 and ES256/ES384 tokens verify with the public key', async () => {
		for (const [algorithm, name, hash] of [['RS256', 'RSASSA-PKCS1-v1_5', 'SHA-256'], ['RS512', 'RSASSA-PKCS1-v1_5', 'SHA-512'], ['PS256', 'RSA-PSS', 'SHA-256'], ['PS384', 'RSA-PSS', 'SHA-384']] as const) {
			const key = await rsaKey(name, hash);
			const token = authorization(await signHttpRequest(auth('jwt', { algorithm, privateKey: key.pem, payload: '{"sub":"ada"}' }), get('https://api.test/'), same)).replace(/^Bearer /, '');
			const [head, body, signature] = token.split('.');
			assert.deepStrictEqual(JSON.parse(new TextDecoder().decode(fromBase64Url(head))), { alg: algorithm, typ: 'JWT' });
			const verified = await crypto.subtle.verify(name === 'RSA-PSS' ? { name, saltLength: Number(hash.slice(4)) / 8 } : name, key.publicKey, fromBase64Url(signature), bufferOf(`${head}.${body}`));
			assert.strictEqual(verified, true, algorithm);
		}
		for (const [algorithm, namedCurve, hash] of [['ES256', 'P-256', 'SHA-256'], ['ES384', 'P-384', 'SHA-384']] as const) {
			const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve }, true, ['sign', 'verify']);
			const privateKey = pem('PRIVATE KEY', await crypto.subtle.exportKey('pkcs8', pair.privateKey));
			const token = await httpSignJwt(algorithm, {}, { sub: 'ada' }, privateKey);
			const [head, body, signature] = token.split('.');
			assert.strictEqual(fromBase64Url(signature).byteLength, namedCurve === 'P-256' ? 64 : 96, 'r || s, not DER');
			assert.strictEqual(await crypto.subtle.verify({ name: 'ECDSA', hash }, pair.publicKey, fromBase64Url(signature), bufferOf(`${head}.${body}`)), true, algorithm);
		}
		await assert.rejects(httpSignJwt('RS256', {}, {}, 'not a key'), /private key/i);
	});

	test('JWT: a PKCS#1 "RSA PRIVATE KEY" is read too', async () => {
		const pair = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
		const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
		// PKCS#8 of an RSA key is a fixed 26-byte wrapper around the PKCS#1 key.
		const pkcs1 = pkcs8.slice(26);
		const token = await httpSignJwt('RS256', {}, { a: 1 }, pem('RSA PRIVATE KEY', pkcs1.buffer));
		const [head, body, signature] = token.split('.');
		assert.strictEqual(await crypto.subtle.verify('RSASSA-PKCS1-v1_5', pair.publicKey, fromBase64Url(signature), bufferOf(`${head}.${body}`)), true);
	});

	test('ASAP: an RS256 token with kid and the standard claims as Bearer', async () => {
		const key = await rsaKey('RSASSA-PKCS1-v1_5', 'SHA-256');
		const signed = await signHttpRequest(auth('asap', { alg: 'RS256', iss: 'micros/my-service', aud: 'other-service', kid: 'micros/my-service/key1', exp: '10m', claims: '{"scope":"read"}', privateKey: key.pem }), get('https://api.test/'), same, { now: () => 1700000000000, nonce: () => 'jti-1' });
		const [scheme, token] = authorization(signed).split(' ');
		const [head, body, signature] = token.split('.');
		assert.strictEqual(scheme, 'Bearer');
		assert.deepStrictEqual(JSON.parse(new TextDecoder().decode(fromBase64Url(head))), { alg: 'RS256', typ: 'JWT', kid: 'micros/my-service/key1' });
		assert.deepStrictEqual(JSON.parse(new TextDecoder().decode(fromBase64Url(body))), { iss: 'micros/my-service', sub: 'micros/my-service', aud: 'other-service', iat: 1700000000, exp: 1700000600, jti: 'jti-1', scope: 'read' });
		assert.strictEqual(await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key.publicKey, fromBase64Url(signature), bufferOf(`${head}.${body}`)), true);
	});

	test('Digest: RFC 2617 example sent with the first request when realm and nonce are known', async () => {
		const digest = auth('digest', { username: 'Mufasa', password: 'Circle Of Life', realm: 'testrealm@host.com', nonce: 'dcd98b7102dd2f0e8b11d0f600bfb0c093', algorithm: 'MD5', qop: 'auth', nonceCount: '00000001', clientNonce: '0a4f113b', opaque: '5ccc069c403ebaf9f0171e9517f40e41' });
		const signed = await signHttpRequest(digest, get('http://www.nowhere.org/dir/index.html'), same);
		assert.strictEqual(authorization(signed), 'Digest username="Mufasa", realm="testrealm@host.com", nonce="dcd98b7102dd2f0e8b11d0f600bfb0c093", uri="/dir/index.html", algorithm=MD5, qop=auth, nc=00000001, cnonce="0a4f113b", response="6629fae49393a05397450978507c4ef1", opaque="5ccc069c403ebaf9f0171e9517f40e41"');
		assert.ok(signed.challenge, 'a 401 is still answered');
		assert.strictEqual((await signHttpRequest({ ...digest, params: { ...digest.params, disableRetryRequest: 'true' } }, get('http://www.nowhere.org/dir/index.html'), same)).challenge, undefined);
	});

	test('Digest: RFC 7616 example answered from the challenge, SHA-256 first, MD5 when that is all', async () => {
		const digest = auth('digest', { username: 'Mufasa', password: 'Circle of Life' });
		const cnonce = 'f2/wE4q74E6zIJEtWaHKaf5wv/H5QzzpXusqGemxURZJ';
		const signed = await signHttpRequest(digest, get('http://www.example.org/dir/index.html'), same, { nonce: () => cnonce });
		assert.strictEqual(authorization(signed), '', 'nothing to answer yet');
		const sha = 'Digest realm="http-auth@example.org", qop="auth, auth-int", algorithm=SHA-256, nonce="7ypf/xlj9XXwfDPEoM4URrv/xwf94BcCAzFZH4GiTo0v", opaque="FQhe/qaU925kfnzjCev0ciny7QMkPqMAFRtzCUYo5tdS"';
		const md5 = 'Digest realm="http-auth@example.org", qop="auth, auth-int", algorithm=MD5, nonce="7ypf/xlj9XXwfDPEoM4URrv/xwf94BcCAzFZH4GiTo0v", opaque="FQhe/qaU925kfnzjCev0ciny7QMkPqMAFRtzCUYo5tdS"';
		const answer = await signed.challenge!(401, { 'WWW-Authenticate': `Basic realm="simple, really", ${sha}, ${md5}` });
		assert.strictEqual(authorization(answer!), `Digest username="Mufasa", realm="http-auth@example.org", nonce="7ypf/xlj9XXwfDPEoM4URrv/xwf94BcCAzFZH4GiTo0v", uri="/dir/index.html", algorithm=SHA-256, qop=auth, nc=00000001, cnonce="${cnonce}", response="753927fa0e85d155564e2e272a28d1802ca10daf4496794697cf8db5856cb6c1", opaque="FQhe/qaU925kfnzjCev0ciny7QMkPqMAFRtzCUYo5tdS"`);
		const older = await signed.challenge!(401, { 'www-authenticate': `Digest realm="x", algorithm=SHA3-999, nonce="n"\n${md5}` });
		assert.ok(authorization(older!).includes('algorithm=MD5') && authorization(older!).includes('response="8ca523f5e9506fed4657c9700eebdbec"'), authorization(older!));
		assert.strictEqual(await signed.challenge!(200, { 'www-authenticate': md5 }), undefined);
		assert.strictEqual(await signed.challenge!(401, { 'www-authenticate': 'Basic realm="x"' }), undefined);
		assert.strictEqual(await signed.challenge!(401, {}), undefined);
	});

	test('Digest: -sess, auth-int, SHA-512-256 and no qop against values from an independent implementation', async () => {
		const base = { username: 'ada', password: 'pw', realm: 'r', nonce: 'n1', clientNonce: 'c1' };
		const post: IHttpSignable = { method: 'POST', url: 'http://h.test/a?b=1', headers: [], body: '{"x":1}' };
		const response = async (params: Record<string, string>) => /response="([0-9a-f]+)"/.exec(authorization(await signHttpRequest(auth('digest', { ...base, ...params }), post, same)))?.[1];
		assert.strictEqual(await response({ algorithm: 'MD5-sess', qop: 'auth' }), DIGEST_VALUES.md5Sess);
		assert.strictEqual(await response({ algorithm: 'MD5', qop: 'auth-int' }), DIGEST_VALUES.md5AuthInt);
		assert.strictEqual(await response({ algorithm: 'SHA-256-sess', qop: 'auth-int' }), DIGEST_VALUES.sha256SessAuthInt);
		assert.strictEqual(await response({ algorithm: 'SHA-512-256', qop: 'auth' }), DIGEST_VALUES.sha512);
		assert.strictEqual(await response({ algorithm: 'SHA-512-256-sess', qop: 'auth' }), DIGEST_VALUES.sha512Sess);
		assert.strictEqual(await response({ algorithm: 'MD5' }), DIGEST_VALUES.md5NoQop);
		const noQop = authorization(await signHttpRequest(auth('digest', { ...base, algorithm: 'MD5' }), post, same));
		assert.ok(!/qop=|nc=|cnonce=/.test(noQop), noQop);
	});

	test('challenges: several in one value, quoted commas, a scheme alone, a token68', () => {
		assert.deepStrictEqual(parseHttpChallenges('Negotiate, Basic realm="a, \\"b\\"", charset="UTF-8", Digest realm="r", nonce="n=1", qop="auth,auth-int", stale=FALSE, NTLM TlRMTVNTUAAC=='), [
			{ scheme: 'negotiate', params: {} },
			{ scheme: 'basic', params: { realm: 'a, "b"', charset: 'UTF-8' } },
			{ scheme: 'digest', params: { realm: 'r', nonce: 'n=1', qop: 'auth,auth-int', stale: 'FALSE' } },
			{ scheme: 'ntlm', params: {} },
		]);
	});

	test('OAuth 1.0: RFC 5849 base string (3.4.1) and signed request (1.2)', async () => {
		assert.strictEqual(
			httpOAuth1BaseString('post', 'http://EXAMPLE.COM:80/request?b5=%3D%253D&a3=a&c%40=&a2=r%20b', [
				['b5', '=%3D'], ['a3', 'a'], ['c@', ''], ['a2', 'r b'],
				['oauth_consumer_key', '9djdj82h48djs9d2'], ['oauth_token', 'kkk9d7dh3k39sjv7'], ['oauth_signature_method', 'HMAC-SHA1'], ['oauth_timestamp', '137131201'], ['oauth_nonce', '7d8f3e4a'],
				['c2', ''], ['a3', '2 q'],
			]),
			'POST&http%3A%2F%2Fexample.com%2Frequest&a2%3Dr%2520b%26a3%3D2%2520q%26a3%3Da%26b5%3D%253D%25253D%26c%2540%3D%26c2%3D%26oauth_consumer_key%3D9djdj82h48djs9d2%26oauth_nonce%3D7d8f3e4a%26oauth_signature_method%3DHMAC-SHA1%26oauth_timestamp%3D137131201%26oauth_token%3Dkkk9d7dh3k39sjv7');

		const photos = auth('oauth1', { consumerKey: 'dpf43f3p2l4k3l03', consumerSecret: 'kd94hf93k423kf44', token: 'nnch734d00sl2jdk', tokenSecret: 'pfkkdhi9sl3r4s00', signatureMethod: 'HMAC-SHA1', timestamp: '137131202', nonce: 'chapoH', version: '', realm: 'Photos', addParamsToHeader: 'true' });
		const signed = await signHttpRequest(photos, get('http://photos.example.net/photos?file=vacation.jpg&size=original'), same);
		assert.strictEqual(authorization(signed), 'OAuth realm="Photos",oauth_consumer_key="dpf43f3p2l4k3l03",oauth_token="nnch734d00sl2jdk",oauth_signature_method="HMAC-SHA1",oauth_timestamp="137131202",oauth_nonce="chapoH",oauth_signature="MdpQcU8iPSUjWoN%2FUDMsK2sui9I%3D"');

		// In the URL when not in the header; the clock and the nonce are the environment's when the fields are empty.
		const inQuery = await signHttpRequest({ ...photos, params: { ...photos.params, addParamsToHeader: 'false', timestamp: '', nonce: '' } }, get('http://photos.example.net/photos?file=vacation.jpg&size=original'), same, { now: () => 137131202000, nonce: () => 'chapoH' });
		assert.strictEqual(inQuery.url, 'http://photos.example.net/photos?file=vacation.jpg&size=original&oauth_consumer_key=dpf43f3p2l4k3l03&oauth_token=nnch734d00sl2jdk&oauth_signature_method=HMAC-SHA1&oauth_timestamp=137131202&oauth_nonce=chapoH&oauth_signature=MdpQcU8iPSUjWoN%2FUDMsK2sui9I%3D');
		assert.strictEqual(authorization(inQuery), '');
	});

	test('OAuth 1.0: a form body is part of the signature (the Twitter documentation example)', async () => {
		const twitter = auth('oauth1', { consumerKey: 'xvz1evFS4wEEPTGEFPHBog', consumerSecret: 'kAcSOqF21Fu85e7zjz7ZN2U4ZRhfV3WpwPAoE3Z7kBw', token: '370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb', tokenSecret: 'LswwdoUaIvS8ltyTt5jkRh4J50vUPVVHtR2YPi5kE', timestamp: '1318622958', nonce: 'kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg', addParamsToHeader: 'true' });
		const signed = await signHttpRequest(twitter, { method: 'POST', url: 'https://api.twitter.com/1.1/statuses/update.json?include_entities=true', headers: [['Content-Type', 'application/x-www-form-urlencoded; charset=utf-8']], body: 'status=Hello%20Ladies%20%2B%20Gentlemen%2C%20a%20signed%20OAuth%20request%21' }, same);
		assert.ok(authorization(signed).endsWith('oauth_version="1.0",oauth_signature="hCtSmYh%2BiHYCEqBWrE7C7hYmtUk%3D"'), authorization(signed));
	});

	test('OAuth 1.0: PLAINTEXT, HMAC-SHA256, RSA-SHA256, body hash, empty params', async () => {
		const base = { consumerKey: 'ck', consumerSecret: 'c s', token: 'tk', tokenSecret: 't&s', timestamp: '1', nonce: 'n', addParamsToHeader: 'true' };
		const request: IHttpSignable = { method: 'POST', url: 'https://h.test/p?x=1', headers: [['Content-Type', 'application/json']], body: '{"a":1}' };
		const plaintext = authorization(await signHttpRequest(auth('oauth1', { ...base, signatureMethod: 'PLAINTEXT' }), request, same));
		assert.ok(plaintext.endsWith('oauth_signature="c%2520s%26t%2526s"'), plaintext);

		const hmac = authorization(await signHttpRequest(auth('oauth1', { ...base, signatureMethod: 'HMAC-SHA256', includeBodyHash: 'true', addEmptyParamsToSign: 'true' }), request, same));
		assert.ok(hmac.includes('oauth_callback="",oauth_verifier="",oauth_body_hash="AVq9f1zFei3ZS3WQ8ErYCEJzkF7jPsXOvq5iJ2qX%2BGI%3D"'), hmac);
		assert.ok(hmac.endsWith(`oauth_signature="${OAUTH1_SHA256_SIGNATURE}"`), hmac);

		const key = await rsaKey('RSASSA-PKCS1-v1_5', 'SHA-256');
		const rsa = authorization(await signHttpRequest(auth('oauth1', { ...base, signatureMethod: 'RSA-SHA256', privateKey: key.pem, disableHeaderEncoding: 'true' }), request, same));
		const signature = /oauth_signature="([^"]+)"/.exec(rsa)![1];
		const baseString = httpOAuth1BaseString('POST', request.url, [['x', '1'], ['oauth_consumer_key', 'ck'], ['oauth_token', 'tk'], ['oauth_signature_method', 'RSA-SHA256'], ['oauth_timestamp', '1'], ['oauth_nonce', 'n'], ['oauth_version', '1.0']]);
		const raw = httpFromBase64(signature);
		const copy = new Uint8Array(raw.byteLength);
		copy.set(raw);
		assert.strictEqual(await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key.publicKey, copy.buffer, bufferOf(baseString)), true);
	});

	test('Hawk: the README example, with and without a payload hash, and app/dlg', async () => {
		const hawk = auth('hawk', { authId: 'dh37fgj492je', authKey: 'werxhqb98rpaxn39848xrunpaw3489ruxnpa98w4rxn', algorithm: 'sha256', timestamp: '1353832234', nonce: 'j4h3g2', extraData: 'some-app-ext-data' });
		const signed = await signHttpRequest(hawk, get('http://example.com:8000/resource/1?b=1&a=2'), same);
		assert.strictEqual(authorization(signed), 'Hawk id="dh37fgj492je", ts="1353832234", nonce="j4h3g2", ext="some-app-ext-data", mac="6R4rV5iE+NPoym+WwjeHzjAGXUtLNIxmo1vpMofpLAE="');

		const withPayload = await signHttpRequest({ ...hawk, params: { ...hawk.params, includePayloadHash: 'true' } }, { method: 'POST', url: 'http://example.com:8000/resource/1?b=1&a=2', headers: [['Content-Type', 'text/plain; charset=utf-8']], body: 'Thank you for flying Hawk' }, same);
		assert.strictEqual(authorization(withPayload), 'Hawk id="dh37fgj492je", ts="1353832234", nonce="j4h3g2", hash="Yi9LfIIFRtBEPt74PVmbTF/xVAwPn7ub15ePICfgnuY=", ext="some-app-ext-data", mac="aSe1DERmZuRl3pI36/9BdZmnErTw3sNzOOAUlfeKjVw="');

		const delegated = authorization(await signHttpRequest({ ...hawk, params: { ...hawk.params, algorithm: 'sha1', app: 'app1', delegation: 'dlg1', timestamp: '', nonce: '' } }, get('https://example.com/resource'), same, { now: () => 1353832234999, nonce: () => 'abcdef0123' }));
		assert.strictEqual(delegated, `Hawk id="dh37fgj492je", ts="1353832234", nonce="abcdef", ext="some-app-ext-data", mac="${HAWK_SHA1_MAC}", app="app1", dlg="dlg1"`);
	});

	test('AWS Signature v4: the get-vanilla and post-vanilla suite examples', async () => {
		const aws = auth('awsv4', { accessKey: 'AKIDEXAMPLE', secretKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY', region: 'us-east-1', service: 'service' });
		const now = () => Date.UTC(2015, 7, 30, 12, 36, 0);
		const signed = await signHttpRequest(aws, get('https://example.amazonaws.com/'), same, { now });
		assert.deepStrictEqual(signed.headers, [
			['X-Amz-Date', '20150830T123600Z'],
			['Authorization', 'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31'],
		]);
		const post = await signHttpRequest(aws, { method: 'POST', url: 'https://example.amazonaws.com/', headers: [] }, same, { now });
		assert.ok(authorization(post).endsWith('Signature=5da7c1a2acd57cee7505fc6676e4e544621c30862966e37dddb68e92efbe5d6b'), authorization(post));
		// get-vanilla-query-order-key-case: the query is sorted for the signature, not in the URL.
		const ordered = await signHttpRequest(aws, get('https://example.amazonaws.com/?Param2=value2&Param1=value1'), same, { now });
		assert.ok(authorization(ordered).endsWith('Signature=b97d918cfa904a5beff61c982a1b6f458b799221646efd99d3219ec94cdf2500'), authorization(ordered));
		assert.strictEqual(ordered.url, 'https://example.amazonaws.com/?Param2=value2&Param1=value1');

		const session = await signHttpRequest({ ...aws, params: { ...aws.params, sessionToken: 'tok/en' } }, { method: 'PUT', url: 'https://example.amazonaws.com/a%20b/c', headers: [['Content-Type', 'application/json'], ['X-Other', '1']], body: '{}' }, same, { now });
		assert.deepStrictEqual(signed.headers.length, 2);
		assert.ok(session.headers.some(([key, value]) => key === 'X-Amz-Security-Token' && value === 'tok/en'));
		assert.ok(authorization(session).includes('SignedHeaders=content-type;host;x-amz-date;x-amz-security-token, Signature='), authorization(session));
	});

	test('AWS Signature v4: in the query string (the S3 presigned URL example)', async () => {
		const aws = auth('awsv4', { accessKey: 'AKIAIOSFODNN7EXAMPLE', secretKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', region: 'us-east-1', service: 's3', addAuthDataToQuery: 'true' });
		const signed = await signHttpRequest(aws, get('https://examplebucket.s3.amazonaws.com/test.txt'), same, { now: () => Date.UTC(2013, 4, 24, 0, 0, 0) });
		assert.strictEqual(signed.url, 'https://examplebucket.s3.amazonaws.com/test.txt?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20130524T000000Z&X-Amz-Expires=86400&X-Amz-SignedHeaders=host&X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404');
		assert.deepStrictEqual(signed.headers, []);
	});

	test('Akamai EdgeGrid: the library test data (simple GET, query, POST body, headers to sign)', async () => {
		const edge = auth('edgegrid', { accessToken: 'akab-access-token-xxx-xxxxxxxxxxxxxxxx', clientToken: 'akab-client-token-xxx-xxxxxxxxxxxxxxxx', clientSecret: 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx=', nonce: 'nonce-xx-xxxx-xxxx-xxxx-xxxxxxxxxxxx', timestamp: '20140321T19:34:21+0000', maxBodySize: '2048', headersToSign: 'X-Test1,X-Test2,X-Test3' });
		const host = 'https://akaa-baseurl-xxxxxxxxxxx-xxxxxxxxxxxxx.luna.akamaiapis.net';
		const prefix = 'EG1-HMAC-SHA256 client_token=akab-client-token-xxx-xxxxxxxxxxxxxxxx;access_token=akab-access-token-xxx-xxxxxxxxxxxxxxxx;timestamp=20140321T19:34:21+0000;nonce=nonce-xx-xxxx-xxxx-xxxx-xxxxxxxxxxxx;signature=';
		assert.strictEqual(authorization(await signHttpRequest(edge, get(`${host}/`), same)), `${prefix}tL+y4hxyHxgWVD30X3pWnGKHcPzmrIF+LThiAOhMxYU=`);
		assert.strictEqual(authorization(await signHttpRequest(edge, get(`${host}/testapi/v1/t1?p1=1&p2=2`), same)), `${prefix}hKDH1UlnQySSHjvIcZpDMbQHihTQ0XyVAKZaApabdeA=`);
		assert.strictEqual(authorization(await signHttpRequest(edge, { method: 'POST', url: `${host}/testapi/v1/t3`, headers: [], body: 'datadatadatadatadatadatadatadata' }, same)), `${prefix}hXm4iCxtpN22m4cbZb4lVLW5rhX8Ca82vCFqXzSTPe4=`);
		assert.strictEqual(authorization(await signHttpRequest(edge, { method: 'POST', url: `${host}/testapi/v1/t6`, headers: [], body: '' }, same)), `${prefix}1gEDxeQGD5GovIkJJGcBaKnZ+VaPtrc4qBUHixjsPCQ=`);
		assert.strictEqual(authorization(await signHttpRequest(edge, get(`${host}/testapi/v1/t4`, [['X-Test1', 'test-simple-header']]), same)), `${prefix}8F9AybcRw+PLxnvT+H0JRkjROrrUgsxJTnRXMzqvcwY=`);

		const timed = authorization(await signHttpRequest({ ...edge, params: { ...edge.params, timestamp: '', nonce: '' } }, get(`${host}/`), same, { now: () => Date.UTC(2014, 2, 21, 19, 34, 21), nonce: () => 'nonce-xx-xxxx-xxxx-xxxx-xxxxxxxxxxxx' }));
		assert.strictEqual(timed, `${prefix}tL+y4hxyHxgWVD30X3pWnGKHcPzmrIF+LThiAOhMxYU=`);
	});

	test('NTLM hands the name and password to the network stack; a request\'s own Authorization is kept', async () => {
		const resolve = (text: string) => text.replace('{{pw}}', 's3cret');
		assert.deepStrictEqual(await signHttpRequest(auth('ntlm', { username: 'ada', password: '{{pw}}', domain: 'CORP' }), get('http://h.test/'), resolve), { url: 'http://h.test/', headers: [], credentials: { username: 'ada', password: 's3cret', domain: 'CORP' } });
		assert.deepStrictEqual((await signHttpRequest(auth('ntlm', { username: 'CORP\\ada', password: 'p' }), get('http://h.test/'), resolve)).credentials, { username: 'ada', password: 'p', domain: 'CORP' });
		assert.strictEqual((await signHttpRequest(auth('ntlm', {}), get('http://h.test/'), resolve)).credentials, undefined);

		const own = get('http://example.com:8000/resource/1', [['authorization', 'Custom mine']]);
		const hawk = await signHttpRequest(auth('hawk', { authId: 'a', authKey: 'b' }), own, same);
		assert.deepStrictEqual(hawk.headers, [['authorization', 'Custom mine']]);
		const bearer = await signHttpRequest({ ...emptyHttpAuth('bearer'), token: 't' }, get('http://h.test/'), same);
		assert.deepStrictEqual(bearer, { url: 'http://h.test/', headers: [] }, 'Bearer is the wire request\'s to write');
	});

	test('what goes out before signing: OAuth 2.0 prefix and query param; a computed header is shown, never sent', () => {
		const request = emptyHttpRequest('r', 'oauth2');
		request.url = 'https://api.test/me?a=1#f';
		request.auth.token = '{{token}}';
		assert.deepStrictEqual(httpWireRequest(request).spec.headers, [['Authorization', 'Bearer {{token}}']]);
		request.auth.params = { headerPrefix: 'Token' };
		assert.deepStrictEqual(httpAutoHeaders(request, request.auth), [['Authorization', 'Token {{token}}']]);
		request.auth.params = { headerPrefix: '' };
		assert.deepStrictEqual(httpWireRequest(request).spec.headers, [['Authorization', '{{token}}']]);
		request.auth.params = { addTokenTo: 'queryParams' };
		const wire = httpWireRequest(request);
		assert.deepStrictEqual([wire.spec.url, wire.spec.headers], ['https://api.test/me?a=1&access_token={{token}}#f', []]);

		for (const [type, params, shown] of [['hawk', {}, true], ['digest', {}, true], ['edgegrid', {}, true], ['asap', {}, true], ['jwt', {}, true], ['jwt', { addTokenTo: 'queryParam' }, false], ['awsv4', {}, true], ['awsv4', { addAuthDataToQuery: 'true' }, false], ['oauth1', {}, false], ['oauth1', { addParamsToHeader: 'true' }, true], ['ntlm', {}, false]] as const) {
			const signedRequest = emptyHttpRequest('r', type);
			signedRequest.url = 'https://api.test/';
			signedRequest.auth.params = { ...params };
			assert.deepStrictEqual(httpAutoHeaders(signedRequest, signedRequest.auth), shown ? [['Authorization', HTTP_AUTH_COMPUTED]] : [], `${type} ${JSON.stringify(params)}`);
			assert.deepStrictEqual(httpWireRequest(signedRequest).spec.headers, [], `${type} sends no placeholder`);
		}
	});

	test('OAuth 2.0: the token request of each grant, client authentication in the header or the body', () => {
		const fields: Record<string, string> = { accessTokenUrl: 'https://id.test/token', clientId: 'id', clientSecret: 's3cret', scope: 'read write', audience: 'api://x' };
		const get = (key: string) => fields[key] ?? '';
		assert.deepStrictEqual(httpOAuth2TokenRequest(get, 'client_credentials'), {
			url: 'https://id.test/token',
			headers: [['Content-Type', 'application/x-www-form-urlencoded'], ['Accept', 'application/json'], ['Authorization', 'Basic aWQ6czNjcmV0']],
			body: 'grant_type=client_credentials&scope=read+write&audience=api%3A%2F%2Fx',
		});
		fields.client_authentication = 'body';
		fields.username = 'ada';
		fields.password = 'p&ss';
		const password = httpOAuth2TokenRequest(get, 'password_credentials');
		assert.ok(!('error' in password));
		assert.strictEqual(password.body, 'grant_type=password&username=ada&password=p%26ss&scope=read+write&audience=api%3A%2F%2Fx&client_id=id&client_secret=s3cret');
		assert.strictEqual(password.headers.length, 2, 'no Basic header when the client is in the body');

		assert.deepStrictEqual(httpOAuth2TokenRequest(get, 'refresh_token'), { error: 'There is no refresh token to use yet.' });
		fields.refreshToken = 'r1';
		const refresh = httpOAuth2TokenRequest(get, 'refresh_token');
		assert.ok(!('error' in refresh));
		assert.deepStrictEqual([refresh.url, refresh.body.split('&').slice(0, 2)], ['https://id.test/token', ['grant_type=refresh_token', 'refresh_token=r1']], 'the access token URL when there is no refresh URL');
		fields.refreshTokenUrl = 'https://id.test/refresh';
		assert.strictEqual((httpOAuth2TokenRequest(get, 'refresh_token') as { url: string }).url, 'https://id.test/refresh');

		assert.ok('error' in httpOAuth2TokenRequest(get, 'authorization_code'), 'no code yet');
		fields.redirect_uri = 'https://localhost/cb';
		const code = httpOAuth2TokenRequest(get, 'authorization_code_with_pkce', { code: 'c0de', codeVerifier: 'v' });
		assert.ok(!('error' in code));
		assert.strictEqual(code.body, 'grant_type=authorization_code&code=c0de&redirect_uri=https%3A%2F%2Flocalhost%2Fcb&code_verifier=v&audience=api%3A%2F%2Fx&client_id=id&client_secret=s3cret', 'the scope went with the sign-in, not here');

		delete fields.accessTokenUrl;
		assert.ok('error' in httpOAuth2TokenRequest(get, 'client_credentials'));
	});

	test('OAuth 2.0: the sign-in address with PKCE, and what the user pastes back', async () => {
		const verifier = 'volt-verifier-0123456789-abcdefghijklmnopqrstuvwxyz';
		// node: crypto.createHash('sha256').update(verifier).digest('base64url')
		assert.strictEqual(await httpPkceChallenge(verifier, 'S256'), 'Qo6ofxWPfHUL-pkr7MM9gOfiM9MOtaR52rnhCTW2TyI');
		assert.strictEqual(await httpPkceChallenge(verifier, 'plain'), verifier);
		assert.match(httpPkceVerifier(), /^[0-9a-f]{64}$/);

		const fields: Record<string, string> = { authUrl: 'https://id.test/authorize?prompt=login#x', clientId: 'id', redirect_uri: 'https://localhost/cb', scope: 'openid email' };
		assert.strictEqual(httpOAuth2AuthorizeUrl(key => fields[key] ?? '', 'st', { challenge: 'ch', method: 'S256' }), 'https://id.test/authorize?prompt=login&response_type=code&client_id=id&redirect_uri=https%3A%2F%2Flocalhost%2Fcb&scope=openid%20email&state=st&code_challenge=ch&code_challenge_method=S256#x');
		assert.deepStrictEqual(httpOAuth2AuthorizeUrl(() => '', 'st'), { error: 'Fill in the Auth URL first.' });

		assert.deepStrictEqual(httpOAuth2CodeFrom('https://localhost/cb?code=a%2Fb&state=st'), { code: 'a/b', state: 'st' });
		assert.deepStrictEqual(httpOAuth2CodeFrom('  just-the-code '), { code: 'just-the-code' });
		assert.deepStrictEqual(httpOAuth2CodeFrom('https://localhost/cb#code=h&state=s2'), { code: 'h', state: 's2' });
		assert.deepStrictEqual(httpOAuth2CodeFrom('https://localhost/cb?error=access_denied&error_description=User+said+no'), { error: 'User said no' });
		assert.deepStrictEqual(httpOAuth2CodeFrom(''), {});
	});

	test('OAuth 2.0: the token endpoint\'s answer, JSON or form, and its refusals', () => {
		assert.deepStrictEqual(parseHttpOAuth2Token(200, '{"access_token":"at","token_type":"Bearer","expires_in":3600,"refresh_token":"rt","scope":"read"}'), { accessToken: 'at', refreshToken: 'rt', tokenType: 'Bearer', expiresIn: 3600, scope: 'read' });
		assert.deepStrictEqual(parseHttpOAuth2Token(200, 'access_token=at&token_type=bearer'), { accessToken: 'at', tokenType: 'bearer' });
		assert.deepStrictEqual(parseHttpOAuth2Token(400, '{"error":"invalid_client","error_description":"Bad secret"}'), { error: 'The token request was answered with 400: Bad secret' });
		assert.deepStrictEqual(parseHttpOAuth2Token(500, '<html>oops</html>'), { error: 'The token request was answered with 500.' });
		assert.deepStrictEqual(parseHttpOAuth2Token(200, '{"token_type":"Bearer"}'), { error: 'The answer (200) has no access_token.' });
	});
});

// Computed with node's crypto (see the test names), not with the code under test.
const HS384_SIGNATURE = 'Fyka5PxPY7xMWBR3Pf6rsmiKYFHDxravt4BcX3hDWV92dsV4uD0K4GrJoQu_I_ei';
const HS512_SIGNATURE = '-n3PwVqpG1R1RM-MY6sjfZvyEUiBqEm9I8bHrn-E8juR-CTbah1vcBY08ahuc-Bri_fILL8eYBI4sX6q9JMAzg';
const OAUTH1_SHA256_SIGNATURE = '%2BWRlgKe%2B4VzRBCLSqzlxVgIUVluXOPQQG6%2FL%2FLwUAm0%3D';
const HAWK_SHA1_MAC = 'tZOgpcBja+xUeUJ1lIW5RbV9Ueo=';
const DIGEST_VALUES = { md5Sess: 'b939ab304dcdcfc9d7cd41e10d2286d9', md5AuthInt: '96da2ca00065f3737d87ceeb5c5f531e', sha256SessAuthInt: '8b1c35a8d1b65d45f1c99a74dafdb280d9d9e90b171eac2bdcbf09e73c14b313', sha512: '53f1cb70c22057b620d1d855b47f950624d65c8d017b5dd6d1a01ad35baee3b2', sha512Sess: '1bcd00efff582acf15882b307857673bf095c4461b60bcebca8f48c73a6aac21', md5NoQop: '71de071e3efaf0beb747a79d70dc5ab7' };
