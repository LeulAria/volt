/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { guestPopupAction, isBrowserGuestPartition, isGuestPermissionAllowed, sanitizeGuestWebPreferences } from '../../common/browserGuestPolicy.js';
import { VOLT_BROWSER_PARTITION } from '../../common/voltBrowser.js';

suite('Volt in-app browser guests (B-37)', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('WEB-1: will-attach-webview strips preload scripts and Node options', () => {
		const prefs: Record<string, unknown> = {
			preload: 'file:///evil/preload.js',
			preloadURL: 'file:///evil/preload.js',
			nodeIntegration: true,
			nodeIntegrationInSubFrames: true,
			nodeIntegrationInWorker: true,
			contextIsolation: false,
			webSecurity: false,
			webviewTag: true,
			enableBlinkFeatures: 'Something',
			experimentalFeatures: true,
			additionalArguments: ['--inspect'],
			allowRunningInsecureContent: true,
			javascript: true,
		};
		sanitizeGuestWebPreferences(prefs);
		assert.deepStrictEqual(prefs, {
			nodeIntegration: false,
			nodeIntegrationInWorker: false,
			nodeIntegrationInSubFrames: false,
			contextIsolation: true,
			webSecurity: true,
			webviewTag: false,
			// What the in-app browser sets on purpose survives.
			allowRunningInsecureContent: true,
			javascript: true,
		});
	});

	test('WEB-1: only the in-app browser\'s partitions may host a <webview>', () => {
		assert.ok(isBrowserGuestPartition(VOLT_BROWSER_PARTITION));
		assert.ok(isBrowserGuestPartition('persist:volt-browser-chat_1'));
		assert.ok(!isBrowserGuestPartition(undefined));
		assert.ok(!isBrowserGuestPartition(''));
		assert.ok(!isBrowserGuestPartition('persist:vscode'));
		assert.ok(!isBrowserGuestPartition('persist:volt-browser-../x'));
	});

	test('WEB-2: popups open only http(s) outside Volt; custom schemes and about:blank are refused', () => {
		assert.strictEqual(guestPopupAction('https://example.com/a'), 'openExternal');
		assert.strictEqual(guestPopupAction('http://localhost:3000/'), 'openExternal');
		for (const url of ['zoommtg://zoom.us/join?confno=1', 'mailto:a@b.c', 'vscode://file/etc/passwd', 'volt://open', 'file:///etc/passwd', 'about:blank', 'javascript:alert(1)', 'ms-msdt:/id', 'smb://host/share', 'not a url', '']) {
			assert.strictEqual(guestPopupAction(url), 'deny', url);
		}
	});

	test('WEB-3: the partition permission handler refuses camera, microphone, notifications and protocol handlers', () => {
		for (const permission of ['media', 'display-capture', 'geolocation', 'notifications', 'openExternal', 'midi', 'midiSysex', 'hid', 'serial', 'usb', 'clipboard-read', 'idle-detection', 'window-management', 'storage-access', 'top-level-storage-access', 'fileSystem', 'speaker-selection', 'unknown']) {
			assert.ok(!isGuestPermissionAllowed(permission), permission);
		}
		for (const permission of ['clipboard-sanitized-write', 'fullscreen', 'pointerLock', 'keyboardLock', 'mediaKeySystem']) {
			assert.ok(isGuestPermissionAllowed(permission), permission);
		}
	});
});
