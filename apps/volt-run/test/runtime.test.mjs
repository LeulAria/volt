/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { targetId } from '../src/release.mjs';
import { cachedRuntimes, installLocations, locate, resolveRuntime } from '../src/runtime.mjs';
import { exists, fakeInstall, packRelease, serve, sha256, tempDir } from './helpers.mjs';

const target = targetId();

test('finds the runnable parts of an install folder, a macOS app and a checkout', async t => {
	const root = await tempDir(t);

	const install = await fakeInstall(path.join(root, 'Volt-linux-x64'));
	const found = locate(install, 'linux');
	assert.equal(found.appRoot, path.join(install, 'resources', 'app'));
	assert.equal(found.electron, path.join(install, 'volt'));
	assert.equal(found.version, '0.0.6');
	assert.equal(found.dev, false);
	// From the folder above (an unpacked tarball) and from the app folder itself.
	assert.equal(locate(root, 'linux')?.appRoot, found.appRoot);
	assert.equal(locate(found.appRoot, 'linux')?.appRoot, found.appRoot);

	const bundle = path.join(root, 'mac', 'Volt.app');
	await fs.mkdir(path.join(bundle, 'Contents', 'Resources', 'app', 'out'), { recursive: true });
	await fs.mkdir(path.join(bundle, 'Contents', 'MacOS'), { recursive: true });
	await fs.writeFile(path.join(bundle, 'Contents', 'Info.plist'), '<dict><key>CFBundleExecutable</key>\n\t<string>Electron</string></dict>');
	await fs.writeFile(path.join(bundle, 'Contents', 'MacOS', 'Electron'), '');
	await fs.writeFile(path.join(bundle, 'Contents', 'Resources', 'app', 'out', 'volt-agent-server-main.js'), '');
	await fs.writeFile(path.join(bundle, 'Contents', 'Resources', 'app', 'product.json'), JSON.stringify({ nameShort: 'Volt', voltVersion: '0.0.7', commit: 'abc' }));
	const mac = locate(path.join(root, 'mac'), 'darwin');
	assert.equal(mac.electron, path.join(bundle, 'Contents', 'MacOS', 'Electron'));
	assert.equal(mac.location, bundle);
	assert.equal(mac.version, '0.0.7');

	const checkout = path.join(root, 'checkout');
	await fs.mkdir(path.join(checkout, 'src', 'vs'), { recursive: true });
	await fs.mkdir(path.join(checkout, 'out'), { recursive: true });
	await fs.mkdir(path.join(checkout, '.build', 'electron'), { recursive: true });
	await fs.writeFile(path.join(checkout, 'out', 'volt-agent-server-main.js'), '');
	await fs.writeFile(path.join(checkout, '.build', 'electron', 'code-oss'), '');
	await fs.writeFile(path.join(checkout, 'product.json'), JSON.stringify({ nameShort: 'VOLT', nameLong: 'VOLT', applicationName: 'code-oss' }));
	await fs.writeFile(path.join(checkout, 'package.json'), JSON.stringify({ version: '0.0.5' }));
	const dev = locate(checkout, 'linux');
	assert.equal(dev.dev, true);
	assert.equal(dev.electron, path.join(checkout, '.build', 'electron', 'code-oss'));

	// A checkout that was never compiled has nothing to run.
	await fs.rm(path.join(checkout, 'out'), { recursive: true });
	assert.equal(locate(checkout, 'linux'), undefined);
	assert.equal(locate(path.join(root, 'nothing'), 'linux'), undefined);
});

test('install locations follow each channel\'s names', () => {
	assert.deepEqual(installLocations('stable', { platform: 'darwin', home: '/Users/me' }), ['/Applications/Volt.app', '/Users/me/Applications/Volt.app']);
	assert.ok(installLocations('beta', { platform: 'linux', home: '/home/me' }).includes('/home/me/.local/share/volt-beta'));
	assert.deepEqual(installLocations('stable', { platform: 'win32', env: { LOCALAPPDATA: 'L' }, home: 'H' }), [path.join('L', 'Programs', 'Volt')]);
});

/** A release of the fake install packed as `format`, served on loopback. */
async function fakeRelease(t, root, { version = '0.0.6', format = 'tar.gz', corrupt = false } = {}) {
	const { name, data } = await packRelease(root, target, { version, format });
	const base = await serve(t, { [`/${name}`]: data });
	return {
		channel: 'stable', version, commit: 'c0ffee',
		assets: { [target]: { name, url: `${base}/${name}`, size: data.length, sha256: corrupt ? sha256('something else') : sha256(data), format } },
	};
}

async function checkDownload(t, format) {
	const root = await tempDir(t);
	const cacheDir = path.join(root, 'cache');
	const embedded = await fakeRelease(t, root, { format });
	const progress = [];
	let downloads = 0;
	const options = { download: true, channel: 'stable', embedded, target, cacheDir, onDownload: () => downloads++, onProgress: (done, total) => progress.push([done, total]) };
	const first = await resolveRuntime(options);
	assert.equal(first.source, 'download');
	assert.equal(first.version, '0.0.6');
	assert.ok(first.appRoot.startsWith(path.join(cacheDir, `stable-0.0.6-${target}`)));
	assert.equal(downloads, 1);
	assert.equal(progress.at(-1)[0], embedded.assets[target].size);
	// The next start uses it as it is.
	const second = await resolveRuntime(options);
	assert.equal(second.appRoot, first.appRoot);
	assert.equal(downloads, 1);
	assert.deepEqual((await cachedRuntimes(cacheDir, 'stable', target)).map(build => build.version), ['0.0.6']);
}

test('downloads, checks and unpacks a tarball (as it arrives), then reuses it', t => checkDownload(t, 'tar.gz'));
test('downloads and unpacks a zip', { skip: process.platform !== 'darwin' && 'the zip test packs with ditto' }, t => checkDownload(t, 'zip'));
test('downloads and copies the app out of a disk image', { skip: process.platform !== 'darwin' && 'disk images are macOS only' }, t => checkDownload(t, 'dmg'));

test('a download that fails its checksum installs nothing', async t => {
	const root = await tempDir(t);
	const cacheDir = path.join(root, 'cache');
	for (const format of process.platform === 'darwin' ? ['tar.gz', 'zip'] : ['tar.gz']) {
		const embedded = await fakeRelease(t, path.join(root, format), { format, corrupt: true });
		await assert.rejects(resolveRuntime({ download: true, channel: 'stable', embedded, target, cacheDir }), /failed its checksum/);
		assert.deepEqual(await fs.readdir(cacheDir), []);
	}
});

test('a release older than browser sign-in is refused unless asked for', async t => {
	const root = await tempDir(t);
	const embedded = await fakeRelease(t, root, { version: '0.0.5' });
	await assert.rejects(resolveRuntime({ download: true, channel: 'stable', embedded, target, cacheDir: path.join(root, 'cache') }), /needs Volt 0\.0\.6/);
});

test('offline, the newest build downloaded before still runs', async t => {
	const root = await tempDir(t);
	const cacheDir = path.join(root, 'cache');
	const embedded = await fakeRelease(t, root);
	await resolveRuntime({ download: true, channel: 'stable', embedded, target, cacheDir });
	const notes = [];
	const offline = await resolveRuntime({ download: true, channel: 'stable', target, cacheDir, feedUrl: 'http://127.0.0.1:9', note: text => notes.push(text) });
	assert.equal(offline.version, '0.0.6');
	assert.match(notes[0], /Using Volt 0\.0\.6, downloaded before/);
	await fs.rm(cacheDir, { recursive: true });
	await assert.rejects(resolveRuntime({ download: true, channel: 'stable', target, cacheDir, feedUrl: 'http://127.0.0.1:9' }), /Could not reach/);
});

test('--app runs the given build and says so when there is none', async t => {
	const root = await tempDir(t);
	await fakeInstall(path.join(root, 'install'));
	assert.equal((await resolveRuntime({ app: path.join(root, 'install'), channel: 'stable', target, cacheDir: root })).version, '0.0.6');
	await assert.rejects(resolveRuntime({ app: path.join(root, 'missing'), channel: 'stable', target, cacheDir: root }), /No runnable Volt/);
	assert.equal(await exists(path.join(root, 'stable-0.0.6-' + target)), false);
});
