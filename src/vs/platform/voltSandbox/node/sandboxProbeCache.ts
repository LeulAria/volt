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

/** How long a failed probe stands before the next launch tries again. */
export const PROBE_RETRY_MS = 30_000;

/**
 * One cached probe, redone when its key changes. A failed one (`failed`) is redone too once it is
 * {@link PROBE_RETRY_MS} old: a trial that timed out under load, or a full temp folder, must not
 * refuse every chat until Volt restarts. A working one stands until the key changes.
 */
export class ProbeCache<T> {

	private key: string | undefined;
	private value: Promise<T> | undefined;
	private failedAt: number | undefined;

	constructor(
		private readonly failed: (value: T) => boolean = () => false,
		private readonly retryMs = PROBE_RETRY_MS,
		private readonly now: () => number = Date.now,
	) { }

	get(key: string, probe: () => Promise<T>): Promise<T> {
		const stale = this.failedAt !== undefined && this.now() - this.failedAt >= this.retryMs;
		if (this.value === undefined || this.key !== key || stale) {
			this.key = key;
			this.failedAt = undefined;
			const value = probe();
			this.value = value;
			void value.then(result => {
				if (this.value === value && this.failed(result)) {
					this.failedAt = this.now();
				}
			}, () => {
				if (this.value === value) {
					this.failedAt = this.now();
				}
			});
		}
		return this.value;
	}
}
