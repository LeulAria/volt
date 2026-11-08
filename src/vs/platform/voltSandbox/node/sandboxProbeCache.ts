/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import { release, type, version } from 'os';

/**
 * Probe results are only as good as the system they were measured on (F.4, F.11): a backend's
 * trial is cached per (backend, OS build, binary digest), and a changed OS build or a replaced
 * sandbox binary (an OS update, `apt upgrade bubblewrap`) re-probes before the next launch.
 */

/** The running kernel's build: release plus version string (macOS: the xnu build; Linux: the build stamp). */
export function osBuild(): string {
	return `${type()} ${release()} ${version()}`;
}

const digests = new Map<string, { readonly stamp: string; readonly digest: Promise<string> }>();

/**
 * SHA-256 of a binary, recomputed only when its inode, size or times change, so asking before
 * every launch costs one `stat`. Missing: `missing`.
 */
export async function binaryDigest(path: string): Promise<string> {
	const stat = await fs.stat(path).catch(() => undefined);
	if (!stat) {
		digests.delete(path);
		return 'missing';
	}
	const stamp = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
	const known = digests.get(path);
	if (known?.stamp === stamp) {
		return known.digest;
	}
	const digest = fs.readFile(path).then(data => createHash('sha256').update(data).digest('hex'), () => 'unreadable');
	digests.set(path, { stamp, digest });
	return digest;
}

/** One cached probe, redone when its key changes. */
export class ProbeCache<T> {

	private key: string | undefined;
	private value: Promise<T> | undefined;

	get(key: string, probe: () => Promise<T>): Promise<T> {
		if (this.value === undefined || this.key !== key) {
			this.key = key;
			this.value = probe();
		}
		return this.value;
	}
}
