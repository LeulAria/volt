/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { decideVoltUpdate, IVoltFeedEntry, resolveVoltReleaseChannel, voltFeedUrl, voltLinuxPlatform, voltReleaseTag } from '../../common/voltUpdateFeed.js';

suite('Volt update feed', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const entry: IVoltFeedEntry = {
		version: '0.0.2',
		productVersion: '0.0.2',
		commit: 'bbbbbbb',
		timestamp: Date.parse('2026-10-08T00:00:00Z'),
		url: 'https://github.com/LeulAria/VOLT/releases/download/v0.0.2/volt-stable-0.0.2-darwin-arm64.zip',
		sha256hash: 'abc',
		downloadUrl: 'https://github.com/LeulAria/VOLT/releases/download/v0.0.2/volt-stable-0.0.2-darwin-arm64.dmg',
		releaseUrl: 'https://github.com/LeulAria/VOLT/releases/tag/v0.0.2'
	};
	const current = { commit: 'aaaaaaa', date: '2026-10-06T00:00:00Z', quality: 'stable' };
	const page = 'https://volt.leularia.com/download';

	test('resolves the channel from the setting or the build', () => {
		assert.strictEqual(resolveVoltReleaseChannel('default', 'beta'), 'beta');
		assert.strictEqual(resolveVoltReleaseChannel(undefined, 'nightly'), 'nightly');
		assert.strictEqual(resolveVoltReleaseChannel('stable', 'nightly'), 'stable');
		assert.strictEqual(resolveVoltReleaseChannel('default', undefined), undefined);
		assert.strictEqual(resolveVoltReleaseChannel('none', 'insider'), undefined);
	});

	test('builds feed URLs', () => {
		assert.strictEqual(voltFeedUrl('https://raw.githubusercontent.com/LeulAria/VOLT/volt-update-feed/', 'beta', 'win32-x64-user'), 'https://raw.githubusercontent.com/LeulAria/VOLT/volt-update-feed/beta/win32-x64-user.json');
		assert.strictEqual(voltFeedUrl('https://x', 'stable', 'darwin-arm64', '.squirrel.json'), 'https://x/stable/darwin-arm64.squirrel.json');
		assert.strictEqual(voltLinuxPlatform('arm'), 'linux-armhf');
		assert.strictEqual(voltLinuxPlatform('x64'), 'linux-x64');
	});

	test('offers a newer build on the same channel', () => {
		const update = decideVoltUpdate(entry, current, 'stable', page);
		assert.deepStrictEqual(update, {
			version: 'bbbbbbb',
			productVersion: '0.0.2',
			timestamp: entry.timestamp,
			url: entry.url,
			sha256hash: 'abc',
			voltChannel: undefined,
			releaseUrl: entry.releaseUrl,
			downloadUrl: entry.downloadUrl
		});
	});

	test('ignores the running build and older builds', () => {
		assert.strictEqual(decideVoltUpdate({ ...entry, commit: 'aaaaaaa' }, current, 'stable', page), undefined);
		assert.strictEqual(decideVoltUpdate({ ...entry, timestamp: Date.parse('2026-10-05T00:00:00Z') }, current, 'stable', page), undefined);
		assert.strictEqual(decideVoltUpdate({ ...entry, timestamp: Date.parse(current.date) }, current, 'stable', page), undefined);
	});

	test('offers another channel as a download', () => {
		const update = decideVoltUpdate({ ...entry, timestamp: 1 }, current, 'nightly', page);
		assert.strictEqual(update?.voltChannel, 'nightly');
		assert.strictEqual(update?.url, 'https://volt.leularia.com/download?channel=nightly');
		assert.strictEqual(update?.sha256hash, undefined);
		assert.strictEqual(decideVoltUpdate(entry, current, 'beta', undefined)?.url, entry.downloadUrl);
	});

	test('rejects malformed entries', () => {
		assert.strictEqual(decideVoltUpdate(undefined, current, 'stable', page), undefined);
		assert.strictEqual(decideVoltUpdate('nope', current, 'stable', page), undefined);
		assert.strictEqual(decideVoltUpdate({ ...entry, url: 'http://insecure' }, current, 'stable', page), undefined);
		assert.strictEqual(decideVoltUpdate({ ...entry, commit: '' }, current, 'stable', page), undefined);
		assert.strictEqual(decideVoltUpdate({ ...entry, timestamp: 'today' }, current, 'stable', page), undefined);
	});

	test('maps versions to release tags', () => {
		assert.strictEqual(voltReleaseTag('0.0.1'), 'v0.0.1');
		assert.strictEqual(voltReleaseTag('0.0.1-beta.2'), 'v0.0.1-beta.2');
		assert.strictEqual(voltReleaseTag('0.0.1-nightly.202610060300'), 'nightly');
	});
});
