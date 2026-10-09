/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// node --test build/volt/release/releaseNaming.test.mjs

import assert from 'node:assert';
import { test } from 'node:test';
import { assetName, feedEntries, parseAssetName, resolveRelease } from './releaseNaming.mjs';

const now = new Date('2026-10-06T03:04:05Z');

test('nightly versions are stamped and use the rolling tag', () => {
	const r = resolveRelease({ channel: 'nightly', packageVersion: '0.0.1', now });
	assert.strictEqual(r.version, '0.0.1-nightly.202610060304');
	assert.strictEqual(r.tag, 'nightly');
	assert.strictEqual(r.prerelease, 'true');
	assert.deepStrictEqual(r.linux, ['x64', 'arm64', 'armhf']);
});

test('beta and stable take the version from the tag', () => {
	assert.strictEqual(resolveRelease({ channel: 'beta', packageVersion: '0.0.1', refType: 'tag', refName: 'v0.0.1-beta.3', now }).version, '0.0.1-beta.3');
	assert.strictEqual(resolveRelease({ channel: 'beta', packageVersion: '0.0.1', refType: 'branch', refName: 'main', runNumber: '7', now }).version, '0.0.1-beta.7');
	const stable = resolveRelease({ channel: 'stable', packageVersion: '0.0.1', refType: 'tag', refName: 'v0.0.1', now });
	assert.deepStrictEqual([stable.version, stable.tag, stable.prerelease], ['0.0.1', 'v0.0.1', 'false']);
	assert.throws(() => resolveRelease({ channel: 'stable', packageVersion: '0.0.1', version: '0.0.1-beta.1', now }));
	assert.throws(() => resolveRelease({ channel: 'beta', packageVersion: '0.0.1', version: '0.0.1', now }));
});

test('platform filters add both darwin arches for universal', () => {
	const r = resolveRelease({ channel: 'stable', packageVersion: '0.0.1', platforms: 'darwin-universal,win32-arm64', now });
	assert.deepStrictEqual([r.darwin, r.linux, r.win32, r.universal], [['x64', 'arm64'], [], ['arm64'], 'true']);
	assert.throws(() => resolveRelease({ channel: 'stable', packageVersion: '0.0.1', platforms: 'linux-riscv', now }));
});

test('asset names round-trip', () => {
	const name = assetName({ channel: 'nightly', version: '0.0.1-nightly.202610060304', os: 'win32', arch: 'x64', kind: 'user-setup', ext: 'exe' });
	assert.strictEqual(name, 'volt-nightly-0.0.1-nightly.202610060304-win32-x64-user-setup.exe');
	assert.deepStrictEqual(parseAssetName(name), { channel: 'nightly', version: '0.0.1-nightly.202610060304', os: 'win32', arch: 'x64', kind: 'user-setup', ext: 'exe' });
	assert.strictEqual(parseAssetName('volt-stable-0.0.1-linux-armhf.tar.gz')?.ext, 'tar.gz');
	assert.strictEqual(parseAssetName('Volt-0.1.0-arm64.dmg'), undefined);
});

test('feed entries map assets to updater platforms', () => {
	const asset = name => ({ name, url: `https://example.com/${name}`, sha256: name.length.toString(), size: 1 });
	const v = '0.0.1';
	const feed = feedEntries([
		asset(`volt-stable-${v}-darwin-arm64.zip`), asset(`volt-stable-${v}-darwin-arm64.dmg`),
		asset(`volt-stable-${v}-win32-x64-user-setup.exe`), asset(`volt-stable-${v}-win32-x64-system-setup.exe`), asset(`volt-stable-${v}-win32-x64.zip`),
		asset(`volt-stable-${v}-linux-armhf.tar.gz`), asset(`volt-stable-${v}-linux-armhf.deb`),
		asset(`volt-beta-${v}-beta.1-linux-x64.tar.gz`),
	], { channel: 'stable', version: v, commit: 'abc', timestamp: 5, releaseUrl: 'https://example.com/r' });
	assert.deepStrictEqual(Object.keys(feed).sort(), ['darwin-arm64', 'linux-armhf', 'win32-x64', 'win32-x64-archive', 'win32-x64-user']);
	assert.strictEqual(feed['darwin-arm64'].url, `https://example.com/volt-stable-${v}-darwin-arm64.zip`);
	assert.strictEqual(feed['darwin-arm64'].downloadUrl, `https://example.com/volt-stable-${v}-darwin-arm64.dmg`);
	assert.strictEqual(feed['win32-x64-user'].url, `https://example.com/volt-stable-${v}-win32-x64-user-setup.exe`);
	assert.strictEqual(feed['linux-armhf'].downloadUrl, `https://example.com/volt-stable-${v}-linux-armhf.deb`);
	assert.strictEqual(feed['win32-x64'].commit, 'abc');
});
