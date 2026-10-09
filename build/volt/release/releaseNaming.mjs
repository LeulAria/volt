/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Shared release conventions: versions, tags, asset names and update feed entries.
// The docs download page (apps/docs/src/lib/releases.ts) parses the same asset names.

export const CHANNELS = ['stable', 'beta', 'nightly'];
export const TARGETS = ['darwin-x64', 'darwin-arm64', 'darwin-universal', 'linux-x64', 'linux-arm64', 'linux-armhf', 'win32-x64', 'win32-arm64'];

/**
 * @param {{ channel: string, version?: string, packageVersion: string, refType?: string, refName?: string, runNumber?: string, platforms?: string, now: Date }} o
 */
export function resolveRelease(o) {
	const { channel } = o;
	if (!CHANNELS.includes(channel)) {
		throw new Error(`Unknown channel "${channel}"`);
	}
	const base = o.packageVersion.replace(/-.*$/, '');
	const fromTag = o.refType === 'tag' && o.refName?.startsWith('v') ? o.refName.slice(1) : undefined;
	let version = o.version || '';
	if (!version) {
		if (channel === 'nightly') {
			const stamp = o.now.toISOString().replace(/[-:T]/g, '').slice(0, 12);
			version = `${base}-nightly.${stamp}`;
		} else if (channel === 'beta') {
			version = fromTag ?? `${base}-beta.${o.runNumber ?? '0'}`;
		} else {
			version = fromTag ?? base;
		}
	}
	if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/.test(version)) {
		throw new Error(`Invalid version "${version}"`);
	}
	if (channel === 'stable' && version.includes('-')) {
		throw new Error(`Stable versions can't have a prerelease tag: ${version}`);
	}
	if (channel === 'beta' && !/-beta(\.|$)/.test(version)) {
		throw new Error(`Beta versions look like 0.0.1-beta.1: ${version}`);
	}
	if (channel === 'nightly' && !/-nightly(\.|$)/.test(version)) {
		throw new Error(`Nightly versions look like 0.0.1-nightly.202610060600: ${version}`);
	}

	const wanted = new Set(!o.platforms || o.platforms.trim() === 'all' ? TARGETS : o.platforms.split(',').map(s => s.trim()).filter(Boolean));
	for (const target of wanted) {
		if (!TARGETS.includes(target)) {
			throw new Error(`Unknown target "${target}". Expected: ${TARGETS.join(', ')}`);
		}
	}
	// The universal app is stitched from both darwin builds.
	if (wanted.has('darwin-universal')) {
		wanted.add('darwin-x64');
		wanted.add('darwin-arm64');
	}
	const archesFor = os => TARGETS.filter(t => t.startsWith(`${os}-`) && t !== 'darwin-universal' && wanted.has(t)).map(t => t.slice(os.length + 1));

	return {
		version,
		tag: channel === 'nightly' ? 'nightly' : `v${version}`,
		prerelease: channel === 'stable' ? 'false' : 'true',
		darwin: archesFor('darwin'),
		linux: archesFor('linux'),
		win32: archesFor('win32'),
		universal: wanted.has('darwin-universal') ? 'true' : 'false',
	};
}

/**
 * volt-<channel>-<version>-<os>-<arch>[-user-setup|-system-setup].<ext>
 * @param {{ channel: string, version: string, os: string, arch: string, kind?: string, ext: string }} a
 */
export function assetName(a) {
	return `volt-${a.channel}-${a.version}-${a.os}-${a.arch}${a.kind ? `-${a.kind}` : ''}.${a.ext}`;
}

export const ASSET_PATTERN = /^volt-(stable|beta|nightly)-(.+)-(darwin|win32|linux)-(x64|arm64|armhf|universal)(?:-(user-setup|system-setup))?\.(dmg|zip|exe|deb|rpm|tar\.gz)$/;

/** @param {string} name */
export function parseAssetName(name) {
	const m = ASSET_PATTERN.exec(name);
	if (!m) {
		return undefined;
	}
	return { channel: m[1], version: m[2], os: m[3], arch: m[4], kind: m[5], ext: m[6] };
}

/**
 * Update feed entries, one per updater platform id (the ids VS Code's update services ask for).
 * `url` is what the in-app updater installs; `downloadUrl` is what a person should download.
 * @param {{ name: string, url: string, sha256: string, size: number }[]} assets
 * @param {{ channel: string, version: string, commit: string, timestamp: number, releaseUrl: string, notes?: string }} meta
 */
export function feedEntries(assets, meta) {
	const find = (os, arch, ext, kind) => assets.find(a => {
		const p = parseAssetName(a.name);
		return p && p.channel === meta.channel && p.os === os && p.arch === arch && p.ext === ext && (p.kind ?? undefined) === kind;
	});
	const entry = (update, download) => update && ({
		version: meta.version,
		productVersion: meta.version,
		commit: meta.commit,
		timestamp: meta.timestamp,
		url: update.url,
		sha256hash: update.sha256,
		size: update.size,
		downloadUrl: (download ?? update).url,
		releaseUrl: meta.releaseUrl,
		notes: meta.notes ?? '',
	});

	/** @type {Record<string, object>} */
	const feed = {};
	const put = (id, value) => { if (value) { feed[id] = value; } };
	put('darwin', entry(find('darwin', 'x64', 'zip'), find('darwin', 'x64', 'dmg')));
	put('darwin-arm64', entry(find('darwin', 'arm64', 'zip'), find('darwin', 'arm64', 'dmg')));
	put('darwin-universal', entry(find('darwin', 'universal', 'zip'), find('darwin', 'universal', 'dmg')));
	for (const arch of ['x64', 'arm64']) {
		put(`win32-${arch}`, entry(find('win32', arch, 'exe', 'system-setup')));
		put(`win32-${arch}-user`, entry(find('win32', arch, 'exe', 'user-setup')));
		put(`win32-${arch}-archive`, entry(find('win32', arch, 'zip')));
	}
	for (const arch of ['x64', 'arm64', 'armhf']) {
		put(`linux-${arch}`, entry(find('linux', arch, 'tar.gz'), find('linux', arch, 'deb')));
	}
	return feed;
}
