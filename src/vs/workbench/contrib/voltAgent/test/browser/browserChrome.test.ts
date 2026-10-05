/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { InMemoryStorageService } from '../../../../../platform/storage/common/storage.js';
import { displayBrowserUrl, localServerHost, normalizeBrowserUrl } from '../../browser/preview/browserEditor.js';
import { BROWSER_DEVICES, deviceUserAgent } from '../../browser/preview/browserDevices.js';
import { browserHistoryKey, isRememberedUrl, shortBrowserUrl, VoltBrowserHistory } from '../../browser/preview/browserHistory.js';
import { createSurface } from '../../browser/workspace/agentWorkspace.js';

suite('Browser chrome', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('the address bar takes addresses, local servers and searches', () => {
		assert.strictEqual(normalizeBrowserUrl(''), '', 'an empty address is the start page');
		assert.strictEqual(normalizeBrowserUrl('localhost:3000'), 'http://localhost:3000');
		assert.strictEqual(normalizeBrowserUrl('127.0.0.1:8080/app'), 'http://127.0.0.1:8080/app');
		assert.strictEqual(normalizeBrowserUrl('example.com'), 'https://example.com');
		assert.strictEqual(normalizeBrowserUrl('https://example.com/a?b=1'), 'https://example.com/a?b=1');
		assert.strictEqual(normalizeBrowserUrl('react hooks'), 'https://www.google.com/search?q=react%20hooks');
		assert.strictEqual(normalizeBrowserUrl('typescript'), 'https://www.google.com/search?q=typescript');
	});

	test('only addresses on this machine are retried while their server starts', () => {
		assert.strictEqual(localServerHost('http://127.0.0.1:5178/'), '127.0.0.1:5178');
		assert.strictEqual(localServerHost('http://localhost:3000/app'), 'localhost:3000');
		assert.strictEqual(localServerHost('http://[::1]:8080/'), '[::1]:8080');
		assert.strictEqual(localServerHost('https://example.com/'), undefined);
		assert.strictEqual(localServerHost('http://127.0.0.1.example.com/'), undefined);
		assert.strictEqual(localServerHost('file:///tmp/index.html'), undefined);
	});

	test('a bare host shows without its trailing slash', () => {
		assert.strictEqual(displayBrowserUrl('https://leularia.com/'), 'https://leularia.com');
		assert.strictEqual(displayBrowserUrl('https://leularia.com/blog/'), 'https://leularia.com/blog/');
	});

	test('history keys drop fragments and the bare slash', () => {
		assert.strictEqual(browserHistoryKey('https://example.com/#top'), 'https://example.com');
		assert.strictEqual(browserHistoryKey('http://localhost:8765/hello-js.html'), 'http://localhost:8765/hello-js.html');
		assert.strictEqual(shortBrowserUrl('https://www.example.com/docs'), 'example.com/docs');
		assert.strictEqual(shortBrowserUrl('http://localhost:8765/hello-js.html'), 'localhost:8765/hello-js.html');
		assert.ok(isRememberedUrl('https://example.com'));
		assert.ok(!isRememberedUrl('about:blank'));
		assert.ok(!isRememberedUrl(''));
	});

	test('history lists recent pages first and finds them by address or title', () => {
		const history = store.add(new VoltBrowserHistory(store.add(new InMemoryStorageService())));
		history.visit('https://example.com/');
		history.visit('http://localhost:3000/', 'Dev server');
		history.describe('https://example.com', { title: 'Example Domain' });
		history.visit('https://example.com/#again');

		assert.deepStrictEqual(history.recents(5).map(entry => entry.url), ['https://example.com', 'http://localhost:3000']);
		assert.strictEqual(history.find('https://example.com/')?.visits, 2);
		assert.strictEqual(history.find('https://example.com')?.title, 'Example Domain');
		assert.deepStrictEqual(history.search('dev', 5).map(entry => entry.url), ['http://localhost:3000']);
		assert.deepStrictEqual(history.search('local', 5).map(entry => entry.url), ['http://localhost:3000']);

		history.clear();
		assert.deepStrictEqual(history.recents(5), []);
	});

	test('the star adds and removes a bookmark', () => {
		const history = store.add(new VoltBrowserHistory(store.add(new InMemoryStorageService())));
		assert.strictEqual(history.toggleBookmark('https://example.com/', 'Example'), true);
		assert.ok(history.isBookmarked('https://example.com'));
		assert.strictEqual(history.toggleBookmark('https://example.com', 'Example'), false);
		assert.deepStrictEqual(history.bookmarks, []);
	});

	test('device presets send a mobile user agent; responsive sizes and desktops keep the desktop one', () => {
		const iphone = BROWSER_DEVICES.find(device => device.id === 'iphone-17');
		const pixel = BROWSER_DEVICES.find(device => device.id === 'pixel-10');
		const laptop = BROWSER_DEVICES.find(device => device.id === 'laptop');
		assert.match(deviceUserAgent(iphone) ?? '', /iPhone/);
		assert.match(deviceUserAgent(pixel) ?? '', /Android/);
		assert.strictEqual(deviceUserAgent(laptop), undefined);
		assert.strictEqual(deviceUserAgent(undefined), undefined);
		assert.strictEqual(new Set(BROWSER_DEVICES.map(device => device.id)).size, BROWSER_DEVICES.length, 'device ids are unique');
	});

	test('only browser surfaces the agent opens are marked to float', () => {
		assert.deepStrictEqual(createSurface({ kind: 'browser', url: 'http://localhost:3000', floating: true }, 'b1'), { kind: 'browser', id: 'b1', url: 'http://localhost:3000', title: undefined, floating: true });
		assert.deepStrictEqual(createSurface({ kind: 'browser', url: 'http://localhost:3000' }, 'b2'), { kind: 'browser', id: 'b2', url: 'http://localhost:3000', title: undefined });
	});
});
