/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { browserCommand } from '../src/browser.mjs';

const URL = 'http://127.0.0.1:47321/';

test('each platform\'s opener', () => {
	assert.deepEqual(browserCommand(URL, { platform: 'darwin', env: {} }), { command: 'open', args: [URL] });
	assert.deepEqual(browserCommand(URL, { platform: 'linux', env: { DISPLAY: ':0' } }), { command: 'xdg-open', args: [URL] });
	const windows = browserCommand('http://x/?a=1&b=2', { platform: 'win32', env: {} });
	assert.equal(windows.command, 'cmd.exe');
	assert.match(windows.args.at(-1), /^start "" "http:\/\/x\/\?a=1\^&b=2"$/);
});

test('no desktop, no browser: the link is printed instead', () => {
	assert.equal(browserCommand(URL, { platform: 'linux', env: {} }), undefined);
	assert.equal(browserCommand(URL, { platform: 'darwin', env: { SSH_CONNECTION: '1 2 3 4' } }), undefined);
	assert.equal(browserCommand(URL, { platform: 'darwin', env: { BROWSER: 'none' } }), undefined);
});

test('$BROWSER wins', () => {
	assert.deepEqual(browserCommand(URL, { platform: 'linux', env: { BROWSER: 'firefox' } }), { command: 'firefox', args: [URL] });
});
