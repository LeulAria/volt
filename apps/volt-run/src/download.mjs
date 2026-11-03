/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Downloads a Volt release archive, checks it and unpacks it, with the tools every system already
// has (ditto and hdiutil on macOS, tar on Linux and Windows): no dependencies to install first.

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createWriteStream, promises as fs } from 'node:fs';
import path from 'node:path';

export const MARKER = '.volt-run.json';

/**
 * Downloads `asset`, checks its size and SHA-256, and unpacks it into `dest`. Nothing lands in
 * `dest` unless the check passed: the work happens next to it and is moved in at the end.
 * @param {{ name: string, url: string, size: number, sha256: string, format: string }} asset
 * @param {string} dest
 * @param {{ onProgress?: (done: number, total: number) => void, signal?: AbortSignal, platform?: NodeJS.Platform, meta?: object }} [o]
 */
export async function installArchive(asset, dest, o = {}) {
	const platform = o.platform ?? process.platform;
	const work = `${dest}.partial-${process.pid}`;
	const unpacked = path.join(work, 'app');
	await fs.rm(work, { recursive: true, force: true });
	await fs.mkdir(unpacked, { recursive: true });
	try {
		let digest;
		if (asset.format === 'tar.gz' && platform !== 'win32') {
			// Unpacked as it arrives: the build is ready when the last byte is.
			const tar = spawn('tar', ['-xzf', '-', '-C', unpacked], { stdio: ['pipe', 'ignore', 'pipe'] });
			const done = exited(tar, 'tar');
			// Awaited below; when the download fails first, its error is the one to report.
			done.catch(() => undefined);
			try {
				digest = await download(asset, sink(tar.stdin), o);
			} catch (err) {
				tar.kill();
				throw err;
			}
			await done;
		} else {
			const file = path.join(work, asset.name);
			digest = await download(asset, sink(createWriteStream(file)), o);
			verify(asset, digest);
			await unpack(file, asset.format, unpacked, platform);
			await fs.rm(file, { force: true });
		}
		verify(asset, digest);
		await fs.writeFile(path.join(unpacked, MARKER), JSON.stringify({ ...o.meta, asset: asset.name, sha256: asset.sha256, installedAt: new Date().toISOString() }, undefined, '\t'));
		await fs.mkdir(path.dirname(dest), { recursive: true });
		try {
			await fs.rename(unpacked, dest);
		} catch (err) {
			// Another volt-run got there first: theirs is the same build.
			if (!await isInstalled(dest)) {
				throw err;
			}
		}
	} finally {
		await fs.rm(work, { recursive: true, force: true });
	}
}

/** Whether `dir` holds a build this tool finished unpacking. */
export async function isInstalled(dir) {
	try {
		await fs.access(path.join(dir, MARKER));
		return true;
	} catch {
		return false;
	}
}

/**
 * Streams the asset into `write`, hashing it on the way.
 * @returns {Promise<{ sha256: string, size: number }>}
 */
async function download(asset, write, o) {
	const response = await fetch(asset.url, { signal: o.signal, redirect: 'follow' }).catch(err => {
		throw new Error(`Could not download ${asset.name} (${err.cause?.code ?? err.message}).`);
	});
	if (!response.ok || !response.body) {
		throw new Error(`Could not download ${asset.name}: ${response.status} ${response.statusText}.`);
	}
	const total = Number(response.headers.get('content-length')) || asset.size;
	const hash = createHash('sha256');
	let size = 0;
	for await (const chunk of response.body) {
		hash.update(chunk);
		size += chunk.length;
		await write.write(chunk);
		o.onProgress?.(size, total);
	}
	await write.end();
	return { sha256: hash.digest('hex'), size };
}

function verify(asset, digest) {
	if (asset.size && digest.size !== asset.size) {
		throw new Error(`${asset.name} is ${digest.size} bytes, expected ${asset.size}. Nothing was installed; try again.`);
	}
	if (digest.sha256 !== asset.sha256) {
		throw new Error(`${asset.name} failed its checksum (expected ${asset.sha256}, got ${digest.sha256}). Nothing was installed.`);
	}
}

/** A writable stream as awaited writes that respect backpressure; the stream's first error rejects. */
function sink(stream) {
	let failure;
	stream.on('error', err => failure ??= err);
	return {
		async write(chunk) {
			if (failure) {
				throw failure;
			}
			if (!stream.write(chunk)) {
				await once(stream, 'drain');
			}
		},
		async end() {
			if (failure) {
				throw failure;
			}
			const finished = once(stream, 'finish');
			stream.end();
			await finished.catch(err => {
				throw failure ?? err;
			});
		},
	};
}

async function unpack(file, format, dest, platform) {
	if (format === 'dmg') {
		const mount = `${dest}.mount`;
		await fs.mkdir(mount, { recursive: true });
		// The image was checked above; hdiutil's own verify would read all of it again.
		await run('hdiutil', ['attach', file, '-nobrowse', '-readonly', '-noverify', '-noautoopen', '-mountpoint', mount]);
		try {
			const app = (await fs.readdir(mount)).find(name => name.endsWith('.app'));
			if (!app) {
				throw new Error('The disk image has no app in it.');
			}
			// ditto keeps the app's symlinks, extended attributes and code signature.
			await run('ditto', [path.join(mount, app), path.join(dest, app)]);
		} finally {
			await run('hdiutil', ['detach', mount, '-quiet']).catch(() => run('hdiutil', ['detach', mount, '-force', '-quiet']).catch(() => undefined));
			await fs.rm(mount, { recursive: true, force: true }).catch(() => undefined);
		}
	} else if (format === 'zip' && platform === 'darwin') {
		await run('ditto', ['-x', '-k', file, dest]);
	} else if (format === 'zip' && platform === 'win32') {
		// tar.exe has come with Windows since 10 (1803) and reads zips.
		await run('tar.exe', ['-xf', file, '-C', dest]).catch(() => run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Expand-Archive -LiteralPath '${file.replace(/'/g, '\'\'')}' -DestinationPath '${dest.replace(/'/g, '\'\'')}' -Force`]));
	} else if (format === 'zip') {
		await run('unzip', ['-q', file, '-d', dest]);
	} else {
		await run('tar', ['-xzf', file, '-C', dest]);
	}
}

/** Runs a tool; rejects with its error output when it fails. */
export function run(command, args) {
	const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
	return exited(child, command);
}

function exited(child, name) {
	let stderr = '';
	child.stderr?.setEncoding('utf8');
	child.stderr?.on('data', text => stderr = (stderr + text).slice(-2000));
	return new Promise((resolve, reject) => {
		child.once('error', err => reject(new Error(err.code === 'ENOENT' ? `'${name}' was not found; it is needed to unpack Volt.` : `${name} failed: ${err.message}`)));
		child.once('close', code => code === 0 ? resolve() : reject(new Error(`${name} failed (exit code ${code})${stderr.trim() ? `: ${stderr.trim()}` : ''}`)));
	});
}
