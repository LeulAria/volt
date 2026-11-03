/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The Volt build that runs the agent server. Fastest first: the Volt app already installed (no
// download, and Volt's windows then share the server instead of replacing it), a build downloaded
// before, and only then a download.

import { existsSync, readdirSync, readFileSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installArchive, isInstalled } from './download.mjs';
import { channelProduct } from './paths.mjs';
import { compareVersions, fetchManifest, MIN_RUNTIME_VERSION } from './release.mjs';
import { isAlive } from './server.mjs';

/**
 * @typedef {object} IRuntime
 * @property {string} appRoot    holds out/volt-agent-server-main.js and product.json
 * @property {string} electron   Volt's Electron, run in Node mode
 * @property {string | undefined} version Volt's version (product.json voltVersion)
 * @property {string | undefined} commit
 * @property {string | undefined} nameShort the product name its desktop profile is named after
 * @property {boolean} dev      a source checkout (runs with VSCODE_DEV)
 * @property {string} location   what to show: the app, install folder or checkout
 * @property {'app' | 'installed' | 'download'} source
 */

function readJson(file) {
	try {
		return JSON.parse(readFileSync(file, 'utf8'));
	} catch {
		return undefined;
	}
}

/** CFBundleExecutable from an app's Info.plist ("Electron" in Volt's builds). */
function bundleExecutable(app) {
	try {
		const plist = readFileSync(path.join(app, 'Contents', 'Info.plist'), 'utf8');
		return /<key>CFBundleExecutable<\/key>\s*<string>([^<]+)<\/string>/.exec(plist)?.[1] ?? 'Electron';
	} catch {
		return 'Electron';
	}
}

function fromAppRoot(appRoot, electron, location, dev) {
	if (!existsSync(path.join(appRoot, 'out', 'volt-agent-server-main.js')) || !existsSync(electron)) {
		return undefined;
	}
	const product = readJson(path.join(appRoot, 'product.json')) ?? {};
	const version = product.voltVersion ?? readJson(path.join(appRoot, 'package.json'))?.version;
	return { appRoot, electron, version, commit: product.commit, nameShort: product.nameShort, dev, location, source: 'app' };
}

/**
 * The runnable parts of a Volt build: a macOS app, a Linux or Windows install folder, a source
 * checkout with its compiled out/, or a folder holding one of those (an unpacked download).
 * @param {string} dir
 * @returns {IRuntime | undefined}
 */
export function locate(dir, platform = process.platform) {
	const bundleApp = path.join(dir, 'Contents', 'Resources', 'app');
	if (existsSync(path.join(bundleApp, 'product.json'))) {
		return fromAppRoot(bundleApp, path.join(dir, 'Contents', 'MacOS', bundleExecutable(dir)), dir, false);
	}
	const installApp = path.join(dir, 'resources', 'app');
	const installed = readJson(path.join(installApp, 'product.json'));
	if (installed) {
		const exe = platform === 'win32' ? `${installed.nameShort}.exe` : installed.applicationName;
		return fromAppRoot(installApp, path.join(dir, exe), dir, false);
	}
	const product = readJson(path.join(dir, 'product.json'));
	if (product && existsSync(path.join(dir, 'src', 'vs'))) {
		// A checkout runs with the Electron its build downloaded (scripts/code.sh does the same).
		const electron = platform === 'darwin'
			? path.join(dir, '.build', 'electron', `${product.nameLong}.app`, 'Contents', 'MacOS', bundleExecutable(path.join(dir, '.build', 'electron', `${product.nameLong}.app`)))
			: path.join(dir, '.build', 'electron', platform === 'win32' ? `${product.nameShort}.exe` : product.applicationName);
		return fromAppRoot(dir, electron, dir, !product.commit);
	}
	if (product && path.basename(dir) === 'app' && path.basename(path.dirname(dir)).toLowerCase() === 'resources') {
		// The app folder itself (.../Contents/Resources/app, .../resources/app): found from its container.
		const resources = path.dirname(dir);
		const container = path.basename(path.dirname(resources)) === 'Contents' ? path.dirname(path.dirname(resources)) : path.dirname(resources);
		return locate(container, platform);
	}
	let children = [];
	try {
		children = readdirSync(dir, { withFileTypes: true }).filter(entry => entry.isDirectory() && !entry.name.startsWith('.')).map(entry => entry.name).sort();
	} catch {
		return undefined;
	}
	// An unpacked download: Volt.app, or the tarball's one folder (Volt-linux-x64).
	for (const child of children.length === 1 ? children : children.filter(name => name.endsWith('.app'))) {
		const found = locate(path.join(dir, child), platform);
		if (found) {
			return found;
		}
	}
	return undefined;
}

/**
 * Where a channel's Volt is installed by its installers and install.sh.
 * @param {string} channel
 */
export function installLocations(channel, { platform = process.platform, env = process.env, home = os.homedir() } = {}) {
	const product = channelProduct(channel);
	switch (platform) {
		case 'darwin':
			return [path.join('/Applications', `${product.nameLong}.app`), path.join(home, 'Applications', `${product.nameLong}.app`)];
		case 'win32':
			return [
				env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Programs', product.win32DirName),
				env.ProgramFiles && path.join(env.ProgramFiles, product.win32DirName),
			].filter(Boolean);
		default:
			return [path.join(home, '.local', 'share', product.applicationName), path.join('/usr/share', product.applicationName), path.join('/opt', product.nameShort.replace(/ /g, '-'))];
	}
}

/**
 * @param {object} o
 * @param {string} [o.app]            `--app`: run this build
 * @param {boolean} [o.download]      skip installed apps
 * @param {string} o.channel
 * @param {string} [o.release]        `--release`: a version or `latest`
 * @param {object} [o.embedded]       the release manifest built into this package
 * @param {string} o.target           darwin-arm64, linux-x64...
 * @param {string} o.cacheDir
 * @param {string} [o.feedUrl]
 * @param {(message: string) => void} [o.note]
 * @param {(asset: object, manifest: object) => void} [o.onDownload]
 * @param {(done: number, total: number) => void} [o.onProgress]
 * @param {AbortSignal} [o.signal]
 * @returns {Promise<IRuntime>}
 */
export async function resolveRuntime(o) {
	const note = o.note ?? (() => undefined);
	if (o.app) {
		const dir = path.resolve(o.app);
		const found = locate(dir);
		if (!found) {
			throw new Error(`No runnable Volt at ${dir}. Point --app at Volt.app, an install folder, or a Volt checkout with out/ compiled.`);
		}
		return found;
	}
	if (!o.download && !o.release) {
		for (const location of installLocations(o.channel)) {
			const found = existsSync(location) ? locate(location) : undefined;
			if (!found) {
				continue;
			}
			if (compareVersions(found.version ?? '0.0.0', MIN_RUNTIME_VERSION) >= 0) {
				return { ...found, source: 'installed' };
			}
			note(`Your installed Volt ${found.version} can't open in a browser yet (that needs ${MIN_RUNTIME_VERSION}); update it to skip the download next time.`);
		}
	}

	let manifest;
	try {
		manifest = await releaseManifest(o);
	} catch (err) {
		// Offline: the newest build downloaded before still runs.
		const cached = await newestCached(o.cacheDir, o.channel, o.target);
		if (!cached) {
			throw err;
		}
		note(`${err.message} Using Volt ${cached.version}, downloaded before.`);
		return { ...cached.runtime, source: 'download' };
	}
	if (compareVersions(manifest.version, MIN_RUNTIME_VERSION) < 0) {
		const message = `Volt ${manifest.version} can't open in a browser: volt-run needs Volt ${MIN_RUNTIME_VERSION} or newer.`;
		if (!o.release) {
			throw new Error(message);
		}
		note(message);
	}
	const asset = manifest.assets[o.target];
	if (!asset) {
		throw new Error(`Volt ${manifest.version} has no ${o.target} build.`);
	}
	const dest = path.join(o.cacheDir, `${manifest.channel}-${manifest.version}-${o.target}`);
	if (!await isInstalled(dest)) {
		o.onDownload?.(asset, manifest);
		await installArchive(asset, dest, { onProgress: o.onProgress, signal: o.signal, meta: { channel: manifest.channel, version: manifest.version, commit: manifest.commit } });
		await pruneRuntimes(o.cacheDir, o.channel, o.target, dest);
	}
	const found = locate(dest);
	if (!found) {
		throw new Error(`The downloaded Volt in ${dest} is incomplete. Run "npx volt-run clean" and try again.`);
	}
	return { ...found, source: 'download' };
}

function releaseManifest(o) {
	if (!o.release && o.embedded && o.embedded.channel === o.channel && !o.feedUrl) {
		return Promise.resolve(o.embedded);
	}
	return fetchManifest({ channel: o.channel, version: o.release, feedUrl: o.feedUrl });
}

/** Downloaded builds for a channel and platform, newest first. */
export async function cachedRuntimes(cacheDir, channel, target) {
	let names = [];
	try {
		names = await fs.readdir(cacheDir);
	} catch {
		return [];
	}
	const prefix = `${channel}-`;
	const suffix = `-${target}`;
	const builds = [];
	for (const name of names) {
		if (name.startsWith(prefix) && name.endsWith(suffix) && !name.includes('.partial-') && await isInstalled(path.join(cacheDir, name))) {
			builds.push({ dir: path.join(cacheDir, name), version: name.slice(prefix.length, -suffix.length) });
		}
	}
	return builds.sort((a, b) => compareVersions(b.version, a.version) || b.version.localeCompare(a.version));
}

async function newestCached(cacheDir, channel, target) {
	for (const build of await cachedRuntimes(cacheDir, channel, target)) {
		const runtime = locate(build.dir);
		if (runtime) {
			return { version: build.version, runtime };
		}
	}
	return undefined;
}

/** Keeps the new build and the one before it (a server may still run from that); older ones go. */
export async function pruneRuntimes(cacheDir, channel, target, current) {
	const others = (await cachedRuntimes(cacheDir, channel, target)).filter(build => build.dir !== current);
	for (const build of others.slice(1)) {
		await fs.rm(build.dir, { recursive: true, force: true }).catch(() => undefined);
	}
	// Downloads a killed volt-run left half done.
	for (const name of await fs.readdir(cacheDir).catch(() => [])) {
		const pid = Number(/\.partial-(\d+)$/.exec(name)?.[1]);
		if (pid && pid !== process.pid && !isAlive(pid)) {
			await fs.rm(path.join(cacheDir, name), { recursive: true, force: true }).catch(() => undefined);
		}
	}
}
