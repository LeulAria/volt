/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compareVersions, fetchManifest, manifestFromRelease, targetId } from '../src/release.mjs';
import { serve } from './helpers.mjs';

const SHA = 'a'.repeat(64);
const asset = (name, sha256 = SHA) => ({ name, url: `https://example.test/${name}`, size: 100, sha256 });
// Every asset of the 0.0.5 release.
const RELEASE = {
	channel: 'stable', version: '0.0.5', commit: '58a45b6', publishedAt: '2026-10-31T11:30:57Z',
	assets: [
		'darwin-arm64.dmg', 'darwin-arm64.zip', 'darwin-universal.dmg', 'darwin-universal.zip', 'darwin-x64.dmg', 'darwin-x64.zip',
		'linux-arm64.deb', 'linux-arm64.rpm', 'linux-arm64.tar.gz', 'linux-armhf.deb', 'linux-armhf.rpm', 'linux-armhf.tar.gz',
		'linux-x64.deb', 'linux-x64.rpm', 'linux-x64.tar.gz',
		'win32-arm64-system-setup.exe', 'win32-arm64-user-setup.exe', 'win32-arm64.zip', 'win32-x64-system-setup.exe', 'win32-x64-user-setup.exe', 'win32-x64.zip',
	].map(suffix => asset(`volt-stable-0.0.5-${suffix}`)),
};

test('one runnable archive per platform, smallest first', () => {
	const manifest = manifestFromRelease(RELEASE);
	assert.deepEqual(Object.keys(manifest.assets).sort(), ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-armhf', 'linux-x64', 'win32-arm64', 'win32-x64']);
	assert.equal(manifest.assets['darwin-arm64'].name, 'volt-stable-0.0.5-darwin-arm64.dmg');
	assert.equal(manifest.assets['linux-x64'].format, 'tar.gz');
	assert.equal(manifest.assets['win32-x64'].name, 'volt-stable-0.0.5-win32-x64.zip');
	assert.equal(manifest.version, '0.0.5');
});

test('an asset without a checksum is never offered', () => {
	const manifest = manifestFromRelease({ ...RELEASE, assets: [asset('volt-stable-0.0.5-darwin-arm64.dmg', ''), asset('volt-stable-0.0.5-darwin-arm64.zip')] });
	assert.equal(manifest.assets['darwin-arm64'].format, 'zip');
	assert.equal(manifestFromRelease({ ...RELEASE, assets: [asset('volt-stable-0.0.5-linux-x64.tar.gz', 'nope')] }).assets['linux-x64'], undefined);
});

test('platform ids', () => {
	assert.equal(targetId('darwin', 'arm64'), 'darwin-arm64');
	assert.equal(targetId('linux', 'arm'), 'linux-armhf');
	assert.equal(targetId('win32', 'x64'), 'win32-x64');
	assert.throws(() => targetId('freebsd', 'x64'), /no build for freebsd/);
	assert.throws(() => targetId('win32', 'arm'), /no build/);
	assert.throws(() => targetId('linux', 'ia32'), /no build/);
});

test('versions compare by x.y.z; a prerelease counts as its version', () => {
	assert.equal(compareVersions('0.0.6', '0.0.5'), 1);
	assert.equal(compareVersions('0.0.5', '0.0.6'), -1);
	assert.equal(compareVersions('0.1.0', '0.0.10'), 1);
	assert.equal(compareVersions('0.0.6-beta.2', '0.0.6'), 0);
	assert.equal(compareVersions('v0.0.6', '0.0.6'), 0);
});

test('the update feed\'s latest.json becomes a manifest', async t => {
	const base = await serve(t, { '/beta/latest.json': JSON.stringify({ ...RELEASE, channel: 'beta', version: '0.0.6-beta.1' }) });
	const manifest = await fetchManifest({ channel: 'beta', feedUrl: base });
	assert.equal(manifest.channel, 'beta');
	assert.equal(manifest.version, '0.0.6-beta.1');
	assert.ok(manifest.assets['linux-x64']);
	await assert.rejects(fetchManifest({ channel: 'nightly', feedUrl: base }), /answered 404/);
});
