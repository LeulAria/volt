/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { EARLY_WINDOW_HINT_VERSION, isPlainLaunch, lastWindowBounds, matchEarlyWebPreferences, matchEarlyWindowOptions, parseEarlyWindowHint, toEarlyWindowHint } from '../../common/earlyWindow.js';

suite('Launch window (earlyWindow)', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const appRoot = '/Applications/Volt.app/Contents/Resources/app';
	const url = `vscode-file://vscode-app${appRoot}/out/vs/code/electron-browser/workbench/workbench.html`;
	const preload = `${appRoot}/out/vs/base/parts/sandbox/electron-browser/preload.js`;

	test('only a plain launch opens it', () => {
		assert.strictEqual(isPlainLaunch({ _: ['/Applications/Volt.app/Contents/MacOS/Electron'], sandbox: true }, []), true);
		assert.strictEqual(isPlainLaunch({ _: [], sandbox: true, 'user-data-dir': '/tmp/ud', 'remote-debugging-port': '9222' }, []), true);
		assert.strictEqual(isPlainLaunch({ _: [], sandbox: true }, ['-psn_0_12345']), true);
		assert.strictEqual(isPlainLaunch({ _: [], sandbox: true }, ['/Users/me/project']), false, 'a folder to open');
		assert.strictEqual(isPlainLaunch({ _: [], sandbox: true, 'new-window': true }, []), false);
		assert.strictEqual(isPlainLaunch({ _: [], sandbox: true, wait: true }, []), false);
		assert.strictEqual(isPlainLaunch({ _: [], sandbox: true, extensionDevelopmentPath: '/x' }, []), false);
		assert.strictEqual(isPlainLaunch({ _: [], sandbox: true, status: true }, []), false);
	});

	test('a hint is used only by the build and app that wrote it', () => {
		const hint = toEarlyWindowHint({ commit: 'abc', appRoot, url, options: { titleBarStyle: 'hidden' }, webPreferences: { preload, sandbox: true } });
		const raw = JSON.stringify(hint);
		assert.ok(parseEarlyWindowHint(raw, { commit: 'abc', appRoot }));
		assert.strictEqual(parseEarlyWindowHint(raw, { commit: 'def', appRoot }), undefined, 'another build');
		assert.strictEqual(parseEarlyWindowHint(raw, { commit: 'abc', appRoot: '/elsewhere/app' }), undefined, 'the app moved');
		assert.strictEqual(parseEarlyWindowHint('{', { commit: 'abc', appRoot }), undefined);
		assert.strictEqual(parseEarlyWindowHint(JSON.stringify({ ...hint, version: EARLY_WINDOW_HINT_VERSION + 1 }), { commit: 'abc', appRoot }), undefined);
		assert.strictEqual(parseEarlyWindowHint(JSON.stringify({ ...hint, webPreferences: { preload: '/tmp/evil.js' } }), { commit: 'abc', appRoot }), undefined, 'a preload outside the app');
		assert.strictEqual(parseEarlyWindowHint(JSON.stringify({ ...hint, webPreferences: { preload: `${appRoot}/../evil.js` } }), { commit: 'abc', appRoot }), undefined, 'a preload that climbs out');
		assert.strictEqual(parseEarlyWindowHint(JSON.stringify({ ...hint, url: 'https://example.com' }), { commit: 'abc', appRoot }), undefined, 'a page that is not the app');
		assert.strictEqual(parseEarlyWindowHint(JSON.stringify({ ...hint, commit: undefined }), { commit: null, appRoot }) !== undefined, true, 'no commit (a source build) matches no commit');
	});

	test('the hint keeps what the window is, not where it is or its per-window channel', () => {
		const hint = toEarlyWindowHint({
			commit: null,
			appRoot,
			url,
			options: { x: 1, y: 2, width: 3, height: 4, show: true, titleBarStyle: 'hidden', backgroundColor: '#1e1e1e', webPreferences: { preload }, fn: () => { } },
			webPreferences: { preload, sandbox: true, additionalArguments: ['--vscode-window-config=vscode:1234'] }
		});
		assert.deepStrictEqual(hint.options, { titleBarStyle: 'hidden', backgroundColor: '#1e1e1e' });
		assert.deepStrictEqual(hint.webPreferences, { preload, sandbox: true });
	});

	test('the last window is reopened only when it was left in the normal mode', () => {
		const storage = (uiState: unknown) => JSON.stringify({ windowsState: { lastActiveWindow: { uiState } } });
		assert.deepStrictEqual(lastWindowBounds(storage({ mode: 1, x: 10, y: 20, width: 1600, height: 1000 })), { x: 10, y: 20, width: 1600, height: 1000 });
		assert.strictEqual(lastWindowBounds(storage({ mode: 0, x: 10, y: 20, width: 1600, height: 1000 })), undefined, 'maximized');
		assert.strictEqual(lastWindowBounds(storage({ mode: 3, x: 10, y: 20, width: 1600, height: 1000 })), undefined, 'full screen');
		assert.strictEqual(lastWindowBounds(storage({ mode: 1, x: 10, y: 20, width: 0, height: 1000 })), undefined);
		assert.strictEqual(lastWindowBounds(storage({ mode: 1, x: 10 })), undefined);
		assert.strictEqual(lastWindowBounds('{}'), undefined);
		assert.strictEqual(lastWindowBounds('not json'), undefined);
	});

	test('a launch window is adopted when it differs only in what a window can still change', () => {
		const early = { titleBarStyle: 'hidden', backgroundColor: '#1e1e1e', minWidth: 400, title: 'Volt', x: 10, y: 20, width: 1600, height: 1000 };
		assert.deepStrictEqual(matchEarlyWindowOptions(early, { ...early, show: true, webPreferences: { preload } }), { compatible: true, changed: [], conflicts: [] });

		const moved = matchEarlyWindowOptions(early, { ...early, x: 50, backgroundColor: '#ffffff' });
		assert.strictEqual(moved.compatible, true);
		assert.deepStrictEqual([...moved.changed].sort(), ['backgroundColor', 'x']);

		const restyled = matchEarlyWindowOptions(early, { ...early, titleBarStyle: undefined });
		assert.strictEqual(restyled.compatible, false, 'a native title bar cannot be changed on a created window');
		assert.deepStrictEqual(restyled.conflicts, ['titleBarStyle']);

		assert.strictEqual(matchEarlyWindowOptions(early, { ...early, tabbingIdentifier: 'Volt' }).compatible, false, 'native tabs');
	});

	test('the page is kept when its preferences match, apart from the channel and the zoom', () => {
		const prefs = { preload, sandbox: true, v8CacheOptions: 'bypassHeatCheck', zoomFactor: 1 };
		assert.strictEqual(matchEarlyWebPreferences(prefs, { ...prefs, zoomFactor: 1.2, additionalArguments: ['--vscode-window-config=vscode:1'] }), true);
		assert.strictEqual(matchEarlyWebPreferences(prefs, { ...prefs, v8CacheOptions: 'none' }), false);
		assert.strictEqual(matchEarlyWebPreferences(prefs, { ...prefs, preload: `${appRoot}/other.js` }), false);
	});
});
