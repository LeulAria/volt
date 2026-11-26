/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { promises as fs } from 'fs';
import type * as http from 'http';
import { tmpdir } from 'os';
import { join } from '../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { NullLogService } from '../../../../platform/log/common/log.js';
import { IVoltGitService } from '../../../../platform/voltGit/common/voltGit.js';
import { isPhoneUserAgent, PHONE_CONFIGURATION_DEFAULTS, safeNext, ServerWorkbench, WORKBENCH_SESSION_PATH } from '../../../node/voltAgent/serverWorkbench.js';

const IPHONE_SAFARI = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const IPAD_SAFARI = 'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const ANDROID_PHONE = 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';
const ANDROID_TABLET = 'Mozilla/5.0 (Linux; Android 15; Pixel Tablet) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const VOLT_SHELL = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) VoltShell/1.0';
const DESKTOP_CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

interface IFakeResponse {
	status?: number;
	headers: Record<string, string | string[]>;
	body?: string;
}

function request(method: string, url: string, headers: http.IncomingHttpHeaders = {}): http.IncomingMessage {
	return { method, url, headers: { host: '127.0.0.1:9947', ...headers } } as http.IncomingMessage;
}

function response(): { res: http.ServerResponse; out: IFakeResponse } {
	const out: IFakeResponse = { headers: {} };
	const res = {
		headersSent: false,
		setHeader(name: string, value: string | string[]) {
			out.headers[name] = value;
			return res;
		},
		writeHead(status: number, headers?: Record<string, string | string[]>) {
			out.status = status;
			Object.assign(out.headers, headers);
			return res;
		},
		end(body?: string) {
			out.body = body;
			return res;
		},
	};
	return { res: res as unknown as http.ServerResponse, out };
}

suite('Agent server browser workbench', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();
	const DEVICE_TOKEN = 'paired-device-token';

	let root: string;

	setup(async () => {
		root = await fs.mkdtemp(join(tmpdir(), 'volt-server-workbench-'));
	});

	teardown(async () => {
		await fs.rm(root, { recursive: true, force: true });
	});

	function newWorkbench(): ServerWorkbench {
		const workbench = store.add(new ServerWorkbench({
			userDataDir: root,
			serverDir: join(root, 'agentServer'),
			label: 'Test Mac',
			environmentId: () => 'env-test',
			authorize: token => token === DEVICE_TOKEN ? { role: 'device', deviceId: 'device-1' } : undefined,
			resolveEnv: async () => process.env,
			git: {} as IVoltGitService,
			sendFile: async () => false,
		}, {} as IConfigurationService, new NullLogService()));
		// The real VS Code server is not started here (signing in warms it).
		Object.assign(workbench, { ensureServer: () => Promise.reject(new Error('not in tests')) });
		return workbench;
	}

	async function send(workbench: ServerWorkbench, req: http.IncomingMessage): Promise<IFakeResponse> {
		const { res, out } = response();
		assert.strictEqual(await workbench.handleHttp(req, res), true);
		return out;
	}

	test('a WebView signs in with the token as a bearer: cookies set, then a redirect to the page asked for', async () => {
		const workbench = newWorkbench();
		const out = await send(workbench, request('GET', `${WORKBENCH_SESSION_PATH}?next=${encodeURIComponent('/code/?folder=/Users/me/app')}`, { authorization: `Bearer ${DEVICE_TOKEN}` }));
		assert.strictEqual(out.status, 302);
		assert.strictEqual(out.headers['Location'], '/code/?folder=/Users/me/app');
		assert.strictEqual(out.headers['Cache-Control'], 'no-store');
		assert.strictEqual(out.headers['Set-Cookie'], `volt-session=${DEVICE_TOKEN}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`);
	});

	test('the GET sets the same cookie as the sign-in page\'s POST, Secure behind https', async () => {
		const workbench = newWorkbench();
		const headers = { authorization: `Bearer ${DEVICE_TOKEN}`, 'x-forwarded-proto': 'https' };
		const viaGet = await send(workbench, request('GET', WORKBENCH_SESSION_PATH, headers));
		const viaPost = await send(workbench, request('POST', WORKBENCH_SESSION_PATH, headers));
		assert.strictEqual(viaPost.status, 200);
		assert.deepStrictEqual(JSON.parse(viaPost.body ?? ''), { path: '/code/' });
		assert.strictEqual(viaGet.headers['Set-Cookie'], viaPost.headers['Set-Cookie']);
		assert.match(String(viaGet.headers['Set-Cookie']), /; Secure$/);
		assert.strictEqual(viaGet.headers['Location'], '/code/', 'no next: the workbench');
	});

	test('the GET needs no Origin check (a navigation), the POST keeps its same-origin rule', async () => {
		const workbench = newWorkbench();
		const crossSite = { authorization: `Bearer ${DEVICE_TOKEN}`, origin: 'https://elsewhere.example' };
		assert.strictEqual((await send(workbench, request('GET', WORKBENCH_SESSION_PATH, crossSite))).status, 302);
		assert.strictEqual((await send(workbench, request('POST', WORKBENCH_SESSION_PATH, crossSite))).status, 405);
		assert.strictEqual((await send(workbench, request('PUT', WORKBENCH_SESSION_PATH, { authorization: `Bearer ${DEVICE_TOKEN}` }))).status, 405);
	});

	test('a missing or wrong token gets a 401 with a JSON error, never the sign-in page or a cookie', async () => {
		const workbench = newWorkbench();
		for (const headers of [{}, { authorization: 'Bearer nope' }, { authorization: DEVICE_TOKEN }, { authorization: 'Bearer ' }]) {
			const out = await send(workbench, request('GET', `${WORKBENCH_SESSION_PATH}?next=%2Fcode%2F`, headers));
			assert.strictEqual(out.status, 401, JSON.stringify(headers));
			assert.strictEqual(out.headers['Content-Type'], 'application/json');
			assert.strictEqual(out.headers['Set-Cookie'], undefined);
			assert.strictEqual(out.headers['Location'], undefined);
			assert.strictEqual(JSON.parse(out.body ?? '').error, 'unauthorized');
		}
	});

	test('next only goes into the workbench', () => {
		assert.strictEqual(safeNext('/code/'), '/code/');
		assert.strictEqual(safeNext('/code'), '/code');
		assert.strictEqual(safeNext('/code?folder=/x'), '/code?folder=/x');
		assert.strictEqual(safeNext('/code/?folder=/x'), '/code/?folder=/x');
		for (const next of [null, undefined, '', '/', '/codex', 'https://evil.example/code/', '//evil.example/code/', '/code//evil.example', '/api/usage']) {
			assert.strictEqual(safeNext(next), '/code/', String(next));
		}
	});

	test('phones are told apart from tablets and desktops', () => {
		assert.strictEqual(isPhoneUserAgent(IPHONE_SAFARI), true);
		assert.strictEqual(isPhoneUserAgent(ANDROID_PHONE), true);
		assert.strictEqual(isPhoneUserAgent(VOLT_SHELL), true);
		assert.strictEqual(isPhoneUserAgent(IPAD_SAFARI), false);
		assert.strictEqual(isPhoneUserAgent(ANDROID_TABLET), false);
		assert.strictEqual(isPhoneUserAgent(DESKTOP_CHROME), false);
		assert.strictEqual(isPhoneUserAgent(undefined), false);
	});

	test('a phone\'s page gets the phone defaults over the desktop\'s settings; a desktop browser keeps them', async () => {
		await fs.mkdir(join(root, 'User'), { recursive: true });
		await fs.writeFile(join(root, 'User', 'settings.json'), JSON.stringify({ 'editor.minimap.enabled': true, 'editor.fontSize': 15, 'editor.tabSize': 2, 'window.zoomLevel': 1 }));
		const workbench = newWorkbench();
		const webConfiguration = (userAgent: string) => (workbench as unknown as { webConfiguration(req: http.IncomingMessage): Promise<{ configurationDefaults: Record<string, unknown> }> })
			.webConfiguration(request('GET', '/code/', { 'user-agent': userAgent, cookie: `volt-session=${DEVICE_TOKEN}` }));

		const phone = (await webConfiguration(IPHONE_SAFARI)).configurationDefaults;
		for (const [key, value] of Object.entries(PHONE_CONFIGURATION_DEFAULTS)) {
			assert.deepStrictEqual(phone[key], value, key);
		}
		assert.strictEqual(phone['editor.tabSize'], 2, 'the desktop\'s other settings stay');
		assert.strictEqual(phone['window.zoomLevel'], undefined);
		assert.strictEqual(phone['workbench.sideBar.location'], 'right');

		const desktop = (await webConfiguration(DESKTOP_CHROME)).configurationDefaults;
		assert.strictEqual(desktop['editor.minimap.enabled'], true);
		assert.strictEqual(desktop['editor.fontSize'], 15);
		assert.strictEqual(desktop['git.autofetch'], undefined);
	});
});
