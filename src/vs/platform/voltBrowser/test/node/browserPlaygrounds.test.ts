/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { existsSync } from 'fs';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { matchMockRoute, matchPlaygroundMock, parseEmulation, parseMockRoutes, parsePlaygroundFiles, parsePlaygroundMocks, portFromLog, safePlaygroundPath, urlPatternMatches } from '../../common/browserAgent.js';
import { BrowserPlaygrounds, parseLsofListen, PLAYGROUND_ROOT } from '../../node/browserPlaygrounds.js';
import { DevServers } from '../../node/devServers.js';

suite('Volt browser agent: mocks, emulation, playgrounds', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('url patterns: substrings and globs', () => {
		assert.ok(urlPatternMatches('/api/stats', 'http://localhost:4400/api/stats?x=1'));
		assert.ok(!urlPatternMatches('/api/stats', 'http://localhost:4400/api/users'));
		assert.ok(urlPatternMatches('*/api/*', 'http://localhost:4400/api/users/3'));
		assert.ok(urlPatternMatches('/api/users/*', 'http://localhost:4400/api/users/3'));
		assert.ok(urlPatternMatches('http://localhost:4400/*.png', 'http://localhost:4400/img/a.png'));
		assert.ok(!urlPatternMatches('http://localhost:4400/*.png', 'http://other/img/a.png'));
	});

	test('mock routes: parsing, method filter, times, first match wins', () => {
		const { routes, errors } = parseMockRoutes([
			{ url: '/api/stats', status: 500, json: { error: 'boom' }, times: 1 },
			{ url: '/api/stats', json: [] },
			{ url: '/api/todos', method: 'post', body: 'nope', status: 418 },
			{ url: '/slow', delay_ms: 99999, abort: true },
			{ status: 200 },
		]);
		assert.deepStrictEqual(errors, ['route 5: needs a `url` (substring or glob such as "*/api/stats*")']);
		assert.strictEqual(routes[0].contentType, 'application/json');
		assert.strictEqual(routes[0].body, '{"error":"boom"}');
		assert.strictEqual(routes[2].method, 'POST');
		assert.strictEqual(routes[2].contentType, 'text/plain; charset=utf-8');
		assert.strictEqual(routes[3].delayMs, 30000);
		assert.strictEqual(routes[3].abort, true);
		assert.strictEqual(matchMockRoute(routes, 'http://h/api/stats', 'GET', []), 0);
		assert.strictEqual(matchMockRoute(routes, 'http://h/api/stats', 'GET', [1]), 1, 'route 1 used up');
		assert.strictEqual(matchMockRoute(routes, 'http://h/api/todos', 'GET', []), -1, 'method filter');
		assert.strictEqual(matchMockRoute(routes, 'http://h/api/todos', 'POST', []), 2);
	});

	test('emulation input', () => {
		assert.deepStrictEqual(parseEmulation({ color_scheme: 'dark', network: 'slow-3g', cpu_slowdown: 100, reduced_motion: true, timezone: ' Asia/Tokyo ' }), {
			emulation: { colorScheme: 'dark', network: 'slow-3g', cpuSlowdown: 20, reducedMotion: true, timezone: 'Asia/Tokyo' },
			errors: [],
		});
		assert.deepStrictEqual(parseEmulation({ color_scheme: 'blue', network: '5g' }).errors.length, 2);
	});

	test('playground paths and inputs stay inside the playground', () => {
		assert.strictEqual(safePlaygroundPath('./css/app.css'), 'css/app.css');
		assert.strictEqual(safePlaygroundPath('/index.html'), 'index.html');
		assert.strictEqual(safePlaygroundPath('../etc/passwd'), undefined);
		assert.strictEqual(safePlaygroundPath('a/../../b'), undefined);
		assert.strictEqual(safePlaygroundPath('.git/config'), undefined);
		assert.strictEqual(safePlaygroundPath('C:/x'), undefined);
		const { files, errors } = parsePlaygroundFiles({ 'app.js': 'x', '../bad.js': 'y', 'data.json': { a: 1 } }, '<h1>hi</h1>');
		assert.deepStrictEqual(Object.keys(files).sort(), ['app.js', 'data.json', 'index.html']);
		assert.strictEqual(files['data.json'], '{\n  "a": 1\n}');
		assert.strictEqual(errors.length, 1);
		const mocks = parsePlaygroundMocks([{ path: '/api/stats', json: [1] }, { path: '/api/*', status: 404 }, { path: 'nope' }]);
		assert.strictEqual(mocks.errors.length, 1);
		assert.strictEqual(matchPlaygroundMock(mocks.mocks, '/api/stats?x=1', 'GET')?.body, '[1]');
		assert.strictEqual(matchPlaygroundMock(mocks.mocks, '/api/other', 'GET')?.status, 404);
		assert.strictEqual(matchPlaygroundMock(mocks.mocks, '/app.js', 'GET'), undefined);
	});

	test('lsof listener output', () => {
		const rows = parseLsofListen('p123\ncnode\nn*:4400\nn127.0.0.1:9229\np77\ncPython\nn[::1]:8000\n');
		assert.deepStrictEqual(rows, [
			{ pid: 123, command: 'node', address: '*', port: 4400 },
			{ pid: 123, command: 'node', address: '127.0.0.1', port: 9229 },
			{ pid: 77, command: 'Python', address: '::1', port: 8000 },
		]);
	});

	test('a playground serves its files and mocks on its own origin, and deleting it removes everything', async () => {
		const playgrounds = new BrowserPlaygrounds(() => { });
		const created = await playgrounds.create({
			sessionId: 'chat-1',
			title: 'Pricing',
			files: { 'index.html': '<script type="module" src="/app.js"></script>', 'app.js': 'export const x = 1;', 'nested/page.html': 'nested' },
			mocks: parsePlaygroundMocks([{ path: '/api/plans', json: [{ id: 'pro' }], delay_ms: 20 }]).mocks,
		});
		try {
			assert.match(created.url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
			assert.ok(created.dir.startsWith(PLAYGROUND_ROOT));
			const page = await fetch(created.url);
			assert.strictEqual(page.headers.get('content-type'), 'text/html; charset=utf-8');
			assert.match(await page.text(), /app\.js/);
			assert.strictEqual((await fetch(`${created.url}app.js`)).headers.get('content-type'), 'text/javascript; charset=utf-8');
			assert.deepStrictEqual(await (await fetch(`${created.url}api/plans`)).json(), [{ id: 'pro' }]);
			assert.strictEqual((await fetch(`${created.url}missing.css`)).status, 404);
			assert.strictEqual((await fetch(`${created.url}..%2F..%2Fetc%2Fpasswd`)).status, 404);
			const updated = await playgrounds.update({ id: created.id, files: { 'app.js': 'export const x = 2;' }, remove: ['nested/page.html'] });
			assert.deepStrictEqual(updated.files, ['app.js', 'index.html']);
			assert.strictEqual(await (await fetch(`${created.url}app.js`)).text(), 'export const x = 2;');
			assert.strictEqual(playgrounds.list('chat-1').length, 1);
			assert.strictEqual(playgrounds.list('chat-2').length, 0);
		} finally {
			const removed = await playgrounds.delete({ sessionId: 'chat-1' });
			assert.strictEqual(removed.length, 1);
		}
		assert.ok(!existsSync(created.dir));
		await assert.rejects(fetch(created.url));
		await playgrounds.dispose();
	});

	test('the port a dev server announces', () => {
		assert.strictEqual(portFromLog('\x1b[32m  ➜  Local:   http://localhost:5173/\x1b[0m'), 5173);
		assert.strictEqual(portFromLog('{"level":"info","message":"Shopfront on http://localhost:4500"}'), 4500);
		assert.strictEqual(portFromLog('Server listening on port 4400'), 4400);
		assert.strictEqual(portFromLog('ready in 300ms'), undefined);
		assert.strictEqual(portFromLog('http://localhost:80/'), undefined);
	});

	test('a dev server Volt starts is found by its port, reused, and stopped', async function () {
		this.timeout(20000);
		const servers = new DevServers(async () => process.env, () => { });
		try {
			const script = 'require("http").createServer((q, s) => s.end("ok")).listen(0, function () { console.log("listening on http://localhost:" + this.address().port); })';
			const started = await servers.start(process.cwd(), `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`, 10000);
			assert.ok(started.port && started.port > 1024, started.log);
			assert.strictEqual(await (await fetch(`http://127.0.0.1:${started.port}/`)).text(), 'ok');
			const again = await servers.start(process.cwd(), started.command, 1000);
			assert.strictEqual(again.pid, started.pid);
			assert.ok(servers.stop(started.pid));
			await new Promise(resolve => setTimeout(resolve, 300));
			await assert.rejects(fetch(`http://127.0.0.1:${started.port}/`));
		} finally {
			await servers.dispose();
		}
	});
});
