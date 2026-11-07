/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Which Volt build to download. A published volt-run carries its release's manifest (written in by
// scripts/build.mjs), so it starts without asking the network; `--release` and runs from source read
// the update feed or the GitHub release instead. Asset names follow build/volt/release/releaseNaming.mjs.

import { parseAssetName } from '../../../build/volt/release/releaseNaming.mjs';

export const REPOSITORY = 'LeulAria/volt';
export const FEED_URL = 'https://raw.githubusercontent.com/LeulAria/VOLT/volt-update-feed';

/** The first Volt whose agent server signs a browser in at `/` and makes pairing codes for this tool. */
export const MIN_RUNTIME_VERSION = '0.0.6';

/**
 * The release asset id for a platform: darwin-arm64, linux-x64, win32-arm64...
 * @param {NodeJS.Platform} platform
 * @param {string} arch
 */
export function targetId(platform = process.platform, arch = process.arch) {
	const os = platform === 'darwin' || platform === 'win32' || platform === 'linux' ? platform : undefined;
	const cpu = arch === 'arm64' ? 'arm64' : arch === 'x64' ? 'x64' : arch === 'arm' && os === 'linux' ? 'armhf' : undefined;
	if (!os || !cpu || (os !== 'linux' && cpu === 'armhf')) {
		throw new Error(`Volt has no build for ${platform} (${arch}). It runs on macOS, Windows and Linux, on x64 and arm64.`);
	}
	return `${os}-${cpu}`;
}

/**
 * What runs without an installer, smallest download first: the disk image on macOS (a quarter
 * smaller than the zip), the tarball on Linux (unpacked while it downloads), the zip on Windows.
 */
const FORMATS = { darwin: ['dmg', 'zip'], linux: ['tar.gz'], win32: ['zip'] };

/**
 * A release's assets, reduced to one runnable archive per platform.
 * @param {{ channel: string, version: string, commit?: string, publishedAt?: string, assets: { name: string, url: string, size: number, sha256?: string }[] }} release
 */
export function manifestFromRelease(release) {
	/** @type {Record<string, { name: string, url: string, size: number, sha256: string, format: string }>} */
	const assets = {};
	for (const [os, formats] of Object.entries(FORMATS)) {
		for (const asset of release.assets) {
			const parsed = parseAssetName(asset.name);
			if (!parsed || parsed.os !== os || parsed.kind || parsed.arch === 'universal' || !formats.includes(parsed.ext) || !/^[0-9a-f]{64}$/.test(asset.sha256 ?? '')) {
				continue;
			}
			const id = `${os}-${parsed.arch}`;
			const current = assets[id];
			if (!current || formats.indexOf(parsed.ext) < formats.indexOf(current.format)) {
				assets[id] = { name: asset.name, url: asset.url, size: asset.size, sha256: asset.sha256, format: parsed.ext };
			}
		}
	}
	return { channel: release.channel, version: release.version, commit: release.commit, publishedAt: release.publishedAt, assets };
}

/**
 * The manifest of a channel's latest release (from the update feed) or of one version (from GitHub).
 * @param {{ channel?: string, version?: string, feedUrl?: string, token?: string }} o
 */
export async function fetchManifest(o = {}) {
	const channel = o.channel ?? 'stable';
	if (!o.version || o.version === 'latest') {
		const url = `${(o.feedUrl ?? FEED_URL).replace(/\/+$/, '')}/${channel}/latest.json`;
		const latest = await getJson(url);
		return manifestFromRelease({ ...latest, channel: latest.channel ?? channel });
	}
	const tag = /-nightly(\.|$)/.test(o.version) ? 'nightly' : `v${o.version.replace(/^v/, '')}`;
	const headers = { Accept: 'application/vnd.github+json', ...(o.token ? { Authorization: `Bearer ${o.token}` } : {}) };
	const release = await getJson(`https://api.github.com/repos/${REPOSITORY}/releases/tags/${tag}`, headers);
	// The asset names carry the exact channel and version (the rolling nightly's tag does not).
	const named = release.assets.map(a => parseAssetName(a.name)).find(Boolean);
	return manifestFromRelease({
		channel: named?.channel ?? channel,
		version: named?.version ?? release.tag_name.replace(/^v/, ''),
		commit: release.target_commitish,
		publishedAt: release.published_at,
		assets: release.assets.map(a => ({ name: a.name, url: a.browser_download_url, size: a.size, sha256: String(a.digest ?? '').replace(/^sha256:/, '') })),
	});
}

/** @param {string} url */
async function getJson(url, headers = {}) {
	const response = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) }).catch(err => {
		throw new Error(`Could not reach ${new URL(url).host} (${err.cause?.code ?? err.message}).`);
	});
	if (!response.ok) {
		throw new Error(`${url} answered ${response.status}${response.status === 404 ? ': no such release' : ''}.`);
	}
	return response.json();
}

/**
 * -1, 0 or 1 by the x.y.z part; a prerelease of a version counts as that version.
 * @param {string} a
 * @param {string} b
 */
export function compareVersions(a, b) {
	const parts = v => String(v).replace(/^v/, '').split('-')[0].split('.').map(n => Number.parseInt(n, 10) || 0);
	const [x, y] = [parts(a), parts(b)];
	for (let i = 0; i < 3; i++) {
		if ((x[i] ?? 0) !== (y[i] ?? 0)) {
			return (x[i] ?? 0) < (y[i] ?? 0) ? -1 : 1;
		}
	}
	return 0;
}
