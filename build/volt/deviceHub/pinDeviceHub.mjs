/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Pins Expo's device hub (spec I.11): resolves `expo-device-hub@<version>` once into a lockfile
// (every package with its registry integrity hash), installs that lockfile for every platform Volt
// ships with `npm ci --ignore-scripts --os --cpu --libc`, and writes the lockfile and each install's
// tree digest into src/vs/platform/voltDevices/common/deviceHubPin.ts. Volt then installs exactly
// that tree at runtime and checks the digest before every launch.
//
//   node build/volt/deviceHub/pinDeviceHub.mjs [version]
//
// Keep treeDigest() and RUNTIME_FILE in step with treeDigest() in
// src/vs/platform/voltHelpers/node/helperIntegrity.ts and isDeviceHubRuntimeFile() in deviceHubPin.ts.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

const root = path.resolve(import.meta.dirname, '..', '..', '..');
const version = process.argv[2] ?? '0.19.1';
const PACKAGE = 'expo-device-hub';
const TARGETS = [
	{ key: 'darwin-arm64', os: 'darwin', cpu: 'arm64' },
	{ key: 'darwin-x64', os: 'darwin', cpu: 'x64' },
	{ key: 'linux-x64-gnu', os: 'linux', cpu: 'x64', libc: 'glibc' },
	{ key: 'linux-arm64-gnu', os: 'linux', cpu: 'arm64', libc: 'glibc' },
	{ key: 'linux-x64-musl', os: 'linux', cpu: 'x64', libc: 'musl' },
	{ key: 'linux-arm64-musl', os: 'linux', cpu: 'arm64', libc: 'musl' },
	{ key: 'win32-x64', os: 'win32', cpu: 'x64' },
	{ key: 'win32-arm64', os: 'win32', cpu: 'arm64' },
];
const RUNTIME_FILE = /^expo-device-hub\/vendor\/serve-emu\/vendor\/scrcpy-server-v[0-9.]+$/;
const NPM_FLAGS = ['--ignore-scripts', '--no-audit', '--no-fund', '--omit=dev', '--loglevel=error', '--userconfig', '/dev/null'];

/** A TypeScript literal in the repo's style: tabs, single quotes, keys quoted only when they must be. */
function tsLiteral(value, depth = 0) {
	const pad = '\t'.repeat(depth + 1);
	const end = '\t'.repeat(depth);
	if (typeof value === 'string') {
		return `'${value.replace(/\\/g, '\\\\').replace(/'/g, '\\\'')}'`;
	}
	if (Array.isArray(value)) {
		return value.length ? `[\n${value.map(item => `${pad}${tsLiteral(item, depth + 1)},`).join('\n')}\n${end}]` : '[]';
	}
	if (value && typeof value === 'object') {
		const entries = Object.entries(value);
		return entries.length ? `{\n${entries.map(([key, item]) => `${pad}${/^[A-Za-z_$][\w$]*$/.test(key) ? key : tsLiteral(key)}: ${tsLiteral(item, depth + 1)},`).join('\n')}\n${end}}` : '{}';
	}
	return String(value);
}

function sha256(bytes) {
	return createHash('sha256').update(bytes).digest('hex');
}

async function treeDigest(dir) {
	const entries = [];
	const walk = async current => {
		for (const dirent of await fs.readdir(current, { withFileTypes: true })) {
			const full = path.join(current, dirent.name);
			const rel = path.relative(dir, full).split(path.sep).join('/');
			if (dirent.isDirectory()) {
				await walk(full);
			} else if (RUNTIME_FILE.test(rel) || /^\.bin\//.test(rel) || rel === '.package-lock.json') {
				continue;
			} else if (dirent.isSymbolicLink()) {
				entries.push(`${rel}\0l\0${await fs.readlink(full)}\n`);
			} else if (dirent.isFile()) {
				entries.push(`${rel}\0f\0${sha256(await fs.readFile(full))}\n`);
			} else {
				entries.push(`${rel}\0o\0\n`);
			}
		}
	};
	await walk(dir);
	entries.sort();
	const hash = createHash('sha256');
	for (const entry of entries) {
		hash.update(entry);
	}
	return hash.digest('hex');
}

const work = await fs.mkdtemp(path.join(tmpdir(), 'volt-device-hub-pin-'));
try {
	const manifest = { name: 'volt-device-hub', private: true, dependencies: { [PACKAGE]: version } };
	const resolveDir = path.join(work, 'resolve');
	await fs.mkdir(resolveDir);
	await fs.writeFile(path.join(resolveDir, 'package.json'), JSON.stringify(manifest, null, '\t'));
	execFileSync('npm', ['install', '--package-lock-only', ...NPM_FLAGS], { cwd: resolveDir, stdio: 'inherit' });
	const lock = JSON.parse(await fs.readFile(path.join(resolveDir, 'package-lock.json'), 'utf8'));
	for (const [name, entry] of Object.entries(lock.packages)) {
		if (name && (!entry.integrity || entry.hasInstallScript)) {
			throw new Error(`${name} has ${entry.hasInstallScript ? 'an install script' : 'no integrity hash'}; Volt installs the hub with --ignore-scripts and integrity only`);
		}
	}
	const digests = {};
	for (const target of TARGETS) {
		const dir = path.join(work, target.key);
		await fs.mkdir(dir);
		await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify(manifest, null, '\t'));
		await fs.writeFile(path.join(dir, 'package-lock.json'), JSON.stringify(lock, null, '\t'));
		const platformFlags = [`--os=${target.os}`, `--cpu=${target.cpu}`, ...(target.libc ? [`--libc=${target.libc}`] : [])];
		if (target.libc && process.platform !== 'linux') {
			// npm checks libc only on Linux itself, so pin what a Linux machine gets: npm in a
			// container. (0.19.1's native packages name no libc, so both builds land either way.)
			const image = target.libc === 'musl' ? 'node:22-alpine' : 'node:22-bookworm';
			execFileSync('docker', ['run', '--rm', '-v', `${dir}:/hub`, '-w', '/hub', image, 'npm', 'ci', ...NPM_FLAGS, ...platformFlags], { stdio: 'inherit' });
		} else {
			execFileSync('npm', ['ci', ...NPM_FLAGS, ...platformFlags], { cwd: dir, stdio: 'inherit' });
		}
		digests[target.key] = await treeDigest(path.join(dir, 'node_modules'));
		console.log(`${target.key}: ${digests[target.key]}`);
	}
	const out = path.join(root, 'src', 'vs', 'platform', 'voltDevices', 'common', 'deviceHubPin.ts');
	const text = `/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Generated by build/volt/deviceHub/pinDeviceHub.mjs. Do not edit by hand: run it again to move the hub.

export const DEVICE_HUB_PACKAGE = '${PACKAGE}';
export const DEVICE_HUB_VERSION = '${version}';

/** \`package.json\` Volt installs the hub from. */
export const DEVICE_HUB_MANIFEST = ${tsLiteral(manifest)};

/** The resolved tree with each package's registry integrity: \`npm ci\` refuses a tarball that differs. */
export const DEVICE_HUB_LOCKFILE = ${tsLiteral(lock)};

/**
 * SHA-256 over the installed \`node_modules\` per \`<platform>-<arch>[-<libc>]\` (see \`treeDigest\` in
 * helperIntegrity.ts), checked before every launch of the hub.
 */
export const deviceHubTreeDigests: { readonly [target: string]: string } = ${tsLiteral(digests)};

/**
 * Files the hub writes into its own folder at runtime, or that npm adds beside the packages, left
 * out of the digest: the scrcpy server it downloads (pushed to Android devices, never run here),
 * \`.bin\` links and npm's hidden lockfile. Nothing Volt or the hub loads is in this list.
 */
export function isDeviceHubRuntimeFile(relativePath: string): boolean {
	return /^expo-device-hub\\/vendor\\/serve-emu\\/vendor\\/scrcpy-server-v[0-9.]+$/.test(relativePath) || /^\\.bin\\//.test(relativePath) || relativePath === '.package-lock.json';
}
`;
	await fs.writeFile(out, text);
	console.log(`wrote ${path.relative(root, out)}`);
} finally {
	await fs.rm(work, { recursive: true, force: true });
}
