/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { bufferToStream, VSBuffer } from '../../../../../base/common/buffer.js';
import { Event } from '../../../../../base/common/event.js';
import { Schemas } from '../../../../../base/common/network.js';
import { URI } from '../../../../../base/common/uri.js';
import { IRequestContext } from '../../../../../base/parts/request/common/request.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { FileService } from '../../../../../platform/files/common/fileService.js';
import { InMemoryFileSystemProvider } from '../../../../../platform/files/common/inMemoryFilesystemProvider.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { InMemoryStorageService } from '../../../../../platform/storage/common/storage.js';
import { IVoltHttpRequestOptions, IVoltHttpTransport, VOLT_HTTP_VERSION_HEADER } from '../../../../../platform/voltHttp/common/voltHttpTransport.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { ISearchService } from '../../../../services/search/common/search.js';
import { IHttpRequestSpec } from '../../../../services/voltRuntime/common/ide/httpFile.js';
import { emptyHttpAuth, HttpAuthType, IHttpAuth } from '../../common/httpCollection.js';
import { HttpCookieJars, httpConfinedCookieJarKey, httpCookieJarKey } from '../../browser/voltHttpCookies.js';
import { httpRedirectHop, IHttpConfinement, IHttpSendOptions, VoltHttpService } from '../../browser/voltHttpService.js';

const NOW = Date.UTC(2026, 10, 18, 12, 0, 0);
const ROOT = URI.file('/tmp/wire-project');

interface IAnswer { readonly status: number; readonly headers?: Record<string, string | string[]>; readonly body?: string }

suite('Volt HTTP client: what goes on the wire', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	/** A service over a fake network: `routes` answers by URL (without the query), and every request that goes out is kept. */
	function setup(routes: Record<string, IAnswer | ((options: IVoltHttpRequestOptions) => IAnswer)>) {
		const fileService = store.add(new FileService(new NullLogService()));
		store.add(fileService.registerProvider(Schemas.file, store.add(new InMemoryFileSystemProvider())));
		const workspace = { getWorkspace: () => ({ folders: [] }), onDidChangeWorkspaceFolders: Event.None } as unknown as IWorkspaceContextService;
		const instantiation = { createInstance: () => ({ file: (folders: URI[]) => ({ folders }) }) } as unknown as IInstantiationService;
		const search = { fileSearch: async () => ({ results: [] }) } as unknown as ISearchService;
		const sent: IVoltHttpRequestOptions[] = [];
		const transport = {
			request: async (options: IVoltHttpRequestOptions): Promise<IRequestContext> => {
				sent.push(options);
				const route = routes[(options.url ?? '').replace(/\?.*$/, '')];
				const answer: IAnswer = typeof route === 'function' ? route(options) : route ?? { status: 404 };
				return { res: { headers: answer.headers ?? {}, statusCode: answer.status }, stream: bufferToStream(VSBuffer.fromString(answer.body ?? '')) };
			},
		} as unknown as IVoltHttpTransport;
		const storage = store.add(new InMemoryStorageService());
		const jars = store.add(new HttpCookieJars(storage, () => NOW));
		const http = store.add(new VoltHttpService(transport, fileService, search, workspace, storage, instantiation, jars));
		const send = (spec: Omit<IHttpRequestSpec, 'line'>, options: IHttpSendOptions = {}) => http.send({ ...spec, line: 1 }, { root: ROOT, ...options });
		return { http, jars, sent, send };
	}

	const header = (options: IVoltHttpRequestOptions, name: string): string | undefined => {
		const value = Object.entries(options.headers ?? {}).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
		return value === undefined ? undefined : String(value);
	};

	function auth(type: HttpAuthType, params: Record<string, string>): IHttpAuth {
		return { ...emptyHttpAuth(type), params };
	}

	const confinement: IHttpConfinement = { key: 'chat-1', urlRefusal: () => undefined, readable: async () => true };

	test('redirects are followed hop by hop: 302 turns into GET, Authorization stays on the host, Referer set, cookies stored and sent per hop, the chain recorded', async () => {
		const { sent, send, jars } = setup({
			'https://a.test/start': { status: 302, headers: { location: '/next', 'set-cookie': ['s=1; Path=/'] } },
			'https://a.test/next': { status: 301, headers: { location: 'https://b.test/final' } },
			'https://b.test/final': { status: 200, headers: { 'set-cookie': 'b=2; Path=/, c=3; Path=/' }, body: 'done' },
		});
		const exchange = await send({ method: 'POST', url: 'https://a.test/start', headers: [['Authorization', 'Bearer t'], ['Content-Type', 'application/json'], ['Cookie', 'mine=1']], body: '{"a":1}' });
		assert.strictEqual(exchange.error, undefined);
		assert.strictEqual(exchange.response?.status, 200);
		assert.strictEqual(exchange.response?.body, 'done');
		assert.deepStrictEqual(exchange.response?.redirects, [{ status: 302, url: 'https://a.test/start' }, { status: 301, url: 'https://a.test/next' }]);
		assert.deepStrictEqual(exchange.response?.setCookies, ['b=2; Path=/', 'c=3; Path=/']);
		assert.deepStrictEqual(sent.map(options => [options.type, options.url, options.data, options.manualRedirects, options.followRedirects]), [
			['POST', 'https://a.test/start', '{"a":1}', true, 5],
			['GET', 'https://a.test/next', undefined, true, 5],
			['GET', 'https://b.test/final', undefined, true, 5],
		]);
		assert.strictEqual(header(sent[1], 'authorization'), 'Bearer t', 'same host');
		assert.strictEqual(header(sent[1], 'content-type'), undefined, 'no body, no content type');
		assert.strictEqual(header(sent[1], 'cookie'), 'mine=1; s=1', 'the user\'s cookie, then the jar\'s');
		assert.strictEqual(header(sent[1], 'referer'), 'https://a.test/start');
		assert.strictEqual(header(sent[2], 'authorization'), undefined, 'another host does not get the Authorization header');
		assert.strictEqual(header(sent[2], 'cookie'), undefined, 'nor the a.test cookies');
		assert.strictEqual(header(sent[2], 'referer'), 'https://a.test/next');
		assert.deepStrictEqual(jars.domains(httpCookieJarKey(ROOT)), [{ domain: 'a.test', count: 1 }, { domain: 'b.test', count: 2 }]);
		assert.deepStrictEqual(jars.domains(httpCookieJarKey(undefined)), [], 'the project\'s jar, not the window\'s');

		// The next send gets the jar's cookies back.
		await send({ method: 'GET', url: 'https://b.test/final', headers: [] });
		assert.strictEqual(header(sent[3], 'cookie'), 'b=2; c=3');
	});

	test('the redirect settings: original method, Authorization across hosts, no Referer, a maximum, not following', async () => {
		const routes = {
			'https://a.test/one': { status: 302, headers: { location: 'https://b.test/two' } },
			'https://b.test/two': { status: 307, headers: { location: 'https://b.test/three' } },
			'https://b.test/three': { status: 201 },
		};
		const kept = setup(routes);
		const exchange = await kept.send({ method: 'PUT', url: 'https://a.test/one', headers: [['Authorization', 'Bearer t']], body: 'x' }, { settings: { followOriginalHttpMethod: true, followAuthorizationHeader: true, removeRefererHeaderOnRedirect: true } });
		assert.strictEqual(exchange.response?.status, 201);
		assert.deepStrictEqual(kept.sent.map(options => [options.type, options.data, header(options, 'authorization'), header(options, 'referer')]), [
			['PUT', 'x', 'Bearer t', undefined],
			['PUT', 'x', 'Bearer t', undefined],
			['PUT', 'x', 'Bearer t', undefined],
		]);

		// 307 keeps method and body whatever the settings say.
		const plain = setup(routes);
		await plain.send({ method: 'POST', url: 'https://b.test/two', headers: [], body: 'y' });
		assert.deepStrictEqual(plain.sent.map(options => [options.type, options.data]), [['POST', 'y'], ['POST', 'y']]);

		const capped = setup(routes);
		const stopped = await capped.send({ method: 'GET', url: 'https://a.test/one', headers: [] }, { settings: { maxRedirects: 1 } });
		assert.strictEqual(stopped.response?.status, 307, 'the redirect it stopped at is the answer');
		assert.deepStrictEqual(stopped.response?.redirects, [{ status: 302, url: 'https://a.test/one' }]);
		assert.match(stopped.logs?.[0]?.text ?? '', /^Stopped after 1 redirect: .* points to https:\/\/b\.test\/three\.$/);

		const off = setup(routes);
		const first = await off.send({ method: 'GET', url: 'https://a.test/one', headers: [] }, { settings: { followRedirects: false } });
		assert.strictEqual(first.response?.status, 302);
		assert.deepStrictEqual(off.sent.map(options => [options.followRedirects, options.manualRedirects]), [[0, undefined]]);
	});

	test('httpRedirectHop drops what must not travel on', () => {
		const hop = httpRedirectHop({ method: 'POST', url: 'https://user:pw@a.test/x#frag', headers: [['Host', 'a.test'], ['Content-Length', '3'], ['X-Keep', '1']], payload: { data: 'abc' } }, 303, 'https://a.test/y', { followOriginalHttpMethod: true, followAuthorizationHeader: false, removeRefererHeaderOnRedirect: false });
		// 303 is "see other": the setting keeps POST, as Postman's does.
		assert.deepStrictEqual(hop, { method: 'POST', url: 'https://a.test/y', headers: [['Content-Length', '3'], ['X-Keep', '1'], ['Referer', 'https://a.test/x']], payload: { data: 'abc' } });
	});

	test('the cookie jar: off in the settings or for the send, and a sandboxed chat\'s jar is its own', async () => {
		const routes = { 'https://a.test/': { status: 200, headers: { 'set-cookie': 'k=v; Path=/' } } };
		const { send, sent, jars } = setup(routes);
		await send({ method: 'GET', url: 'https://a.test/', headers: [] });
		await send({ method: 'GET', url: 'https://a.test/', headers: [] }, { settings: { disableCookies: true } });
		await send({ method: 'GET', url: 'https://a.test/', headers: [] }, { cookies: false });
		await send({ method: 'GET', url: 'https://a.test/', headers: [] });
		assert.deepStrictEqual(sent.map(options => header(options, 'cookie')), [undefined, undefined, undefined, 'k=v']);

		jars.clear(httpCookieJarKey(ROOT));
		const sandboxed = await send({ method: 'GET', url: 'https://a.test/', headers: [] }, { confined: confinement });
		assert.strictEqual(sandboxed.response?.status, 200);
		assert.deepStrictEqual(jars.domains(httpCookieJarKey(ROOT)), [], 'the user\'s jar is untouched');
		assert.deepStrictEqual(jars.domains(httpConfinedCookieJarKey('chat-1')), [{ domain: 'a.test', count: 1 }]);
	});

	test('TLS and protocol settings ask the transport for Node\'s stack; a sandboxed chat\'s send never relaxes TLS nor follows', async () => {
		const routes = {
			'https://a.test/': { status: 200, headers: { [VOLT_HTTP_VERSION_HEADER]: '2', 'content-type': 'text/plain' }, body: 'h2' },
			'https://a.test/moved': { status: 301, headers: { location: 'https://a.test/' } },
		};
		const { send, sent } = setup(routes);
		await send({ method: 'GET', url: 'https://a.test/', headers: [] });
		assert.strictEqual(sent[0].node, undefined, 'the defaults stay on Chromium\'s stack');

		const exchange = await send({ method: 'GET', url: 'https://a.test/', headers: [] }, { settings: { strictSSL: false, httpVersion: 'http2', tlsDisabledProtocols: ['TLSv1'], tlsCipherSuites: ['AES128-SHA'], tlsPreferServerCiphers: true, timeoutMs: 1234 } });
		assert.deepStrictEqual(sent[1].node, { rejectUnauthorized: false, httpVersion: 'http2', disabledProtocols: ['TLSv1'], ciphers: ['AES128-SHA'], honorCipherOrder: true, insecureHTTPParser: true });
		assert.strictEqual(sent[1].timeout, 1234);
		assert.strictEqual(exchange.response?.httpVersion, '2');
		assert.deepStrictEqual(Object.keys(exchange.response?.headers ?? {}), ['content-type'], 'the version is not shown as a header');

		await send({ method: 'GET', url: 'https://a.test/', headers: [] }, { settings: { strictHttpParser: true } });
		assert.deepStrictEqual(sent[2].node, {}, 'the strict parser alone goes through Node, whose parser is strict');

		const confined = await send({ method: 'GET', url: 'https://a.test/moved', headers: [] }, { confined: confinement, settings: { strictSSL: false, followRedirects: true } });
		assert.strictEqual(sent[3].node, undefined);
		assert.strictEqual(sent[3].followRedirects, 0);
		assert.strictEqual(sent.length, 4, 'the location was not requested');
		assert.strictEqual(confined.response?.status, 301);
		assert.match(confined.logs?.[0]?.text ?? '', /TLS and protocol settings were not applied/);
	});

	test('URL encoding as the settings say', async () => {
		const { send, sent } = setup({});
		await send({ method: 'GET', url: 'https://a.test/a b?q=x y&ok=%20', headers: [] });
		await send({ method: 'GET', url: 'https://a.test/a b?q=x y', headers: [] }, { settings: { encodeUrl: false } });
		assert.deepStrictEqual(sent.map(options => options.url), ['https://a.test/a%20b?q=x%20y&ok=%20', 'https://a.test/a b?q=x y']);
	});

	test('the authorization signer: Digest answers the 401 once, NTLM credentials go to the transport, a signer error is the exchange\'s error', async () => {
		const challenge = 'Digest realm="r", qop="auth", algorithm=MD5, nonce="n1", opaque="o"';
		const digest = setup({
			'https://a.test/secret': options => header(options, 'authorization')?.startsWith('Digest ') ? { status: 200, body: 'in' } : { status: 401, headers: { 'www-authenticate': challenge } },
		});
		const exchange = await digest.send({ method: 'GET', url: 'https://a.test/secret', headers: [] }, { auth: auth('digest', { username: '{{user}}', password: 'pw' }), environmentVariables: { user: 'ada' } });
		assert.strictEqual(exchange.response?.status, 200);
		assert.strictEqual(digest.sent.length, 2);
		assert.match(header(digest.sent[1], 'authorization') ?? '', /^Digest username="ada", realm="r", nonce="n1", uri="\/secret", algorithm=MD5, qop=auth/);

		// A server that refuses the answer too: the second 401 is the response, no third try.
		const refusing = setup({ 'https://a.test/secret': { status: 401, headers: { 'www-authenticate': challenge } } });
		assert.strictEqual((await refusing.send({ method: 'GET', url: 'https://a.test/secret', headers: [] }, { auth: auth('digest', { username: 'ada', password: 'pw' }) })).response?.status, 401);
		assert.strictEqual(refusing.sent.length, 2);

		const ntlm = setup({ 'https://a.test/': { status: 200 } });
		await ntlm.send({ method: 'GET', url: 'https://a.test/', headers: [] }, { auth: auth('ntlm', { username: 'ada', password: 'pw', domain: 'CORP' }) });
		assert.deepStrictEqual(ntlm.sent[0].credentials, { username: 'ada', password: 'pw', domain: 'CORP' });

		const broken = setup({});
		const failed = await broken.send({ method: 'GET', url: 'https://a.test/', headers: [] }, { auth: auth('digest', { username: 'ada', password: 'pw', realm: 'r', nonce: 'n', algorithm: 'SHA3-999' }) });
		assert.match(failed.error ?? '', /^Authorization: Digest algorithm "SHA3-999" is not supported/);
		assert.strictEqual(broken.sent.length, 0);

		const missing = await broken.send({ method: 'GET', url: 'https://a.test/', headers: [] }, { auth: auth('ntlm', { username: '{{nobody}}', password: 'pw' }) });
		assert.match(missing.error ?? '', /^Unresolved variable in the authorization: nobody/);
	});

	test('jars: one per key, stored with the workspace, sandboxed chats\' never stored; domains, remove, allowlist', () => {
		const storage = store.add(new InMemoryStorageService());
		const jars = store.add(new HttpCookieJars(storage, () => NOW));
		const changed: string[] = [];
		store.add(jars.onDidChange(key => changed.push(key)));
		jars.store('file:///p', 'https://api.example.com/', ['a=1', 'b=2; Domain=example.com']);
		jars.store('confined:chat', 'https://api.example.com/', ['secret=1']);
		assert.ok(jars.set('file:///p', 'other.test', 'Cookie_1=value; Path=/;'));
		assert.deepStrictEqual(jars.domains('file:///p'), [{ domain: 'api.example.com', count: 1 }, { domain: 'example.com', count: 1 }, { domain: 'other.test', count: 1 }]);
		assert.strictEqual(jars.header('file:///p', 'https://api.example.com/x'), 'a=1; b=2');
		assert.strictEqual(jars.header('', 'https://api.example.com/x'), undefined, 'another project\'s jar is its own');
		jars.setAllowlist('file:///p', ['https://Example.com/', 'example.com', ' api.test ']);
		assert.deepStrictEqual(jars.allowlist('file:///p'), ['api.test', 'example.com']);

		const reopened = store.add(new HttpCookieJars(storage, () => NOW));
		assert.strictEqual(reopened.header('file:///p', 'https://api.example.com/x'), 'a=1; b=2', 'kept across a restart');
		assert.strictEqual(reopened.header('confined:chat', 'https://api.example.com/'), undefined, 'a sandboxed chat\'s jar is not stored');
		assert.deepStrictEqual(reopened.allowlist('file:///p'), ['api.test', 'example.com']);

		jars.remove('file:///p', 'example.com', 'b');
		jars.remove('file:///p', 'other.test');
		assert.deepStrictEqual(jars.cookies('file:///p').map(cookie => cookie.name), ['a']);
		jars.clear('file:///p');
		assert.deepStrictEqual(jars.domains('file:///p'), []);
		assert.ok(changed.includes('file:///p') && changed.includes('confined:chat'));
	});
});
