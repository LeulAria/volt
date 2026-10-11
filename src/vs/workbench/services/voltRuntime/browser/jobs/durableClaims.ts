/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { joinPath } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { FileSystemProviderErrorCode, IFileService, toFileSystemProviderErrorCode } from '../../../../../platform/files/common/files.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { unitHash } from '../../common/jobs/retryPolicy.js';

/** Claims older than this are swept; a retry of anything that old is not a retry any more. */
const CLAIM_TTL_MS = 7 * 86_400_000;
/** At most this many claims are looked at per sweep. */
const SWEEP_BATCH = 400;

/**
 * Exactly-once gates shared by every Volt workbench. Each project runs its own workbench (parked
 * in the background, not unloaded), and all of them load the same orchestration and automations
 * from the user data folder, so two of them can decide the same thing at once: resume this parked
 * chat, run this automation's 9:00 slot.
 *
 * A claim is a directory made with `mkdir`, which the file system either creates or refuses with
 * EEXIST, atomically, across processes: of the workbenches that claim one key, exactly one gets
 * `true`. Keys are deterministic (a turn id, an automation slot), so a retried decision claims
 * nothing new and a crash between claiming and acting never runs the work twice. When the claim
 * store itself fails (a read-only folder, a provider without directories) a claim succeeds: one
 * workbench doing the work beats none doing it.
 */
export class DurableClaims {

	private ensured: Promise<boolean> | undefined;
	private swept = false;
	/** Keys this workbench holds: claiming one again (a retried effect) is still ours. */
	private readonly mine = new Set<string>();

	constructor(
		private readonly home: URI,
		private readonly fileService: IFileService,
		private readonly logService: ILogService,
	) { }

	/** True for the one caller that claims `key` first, across every workbench. */
	async claim(key: string): Promise<boolean> {
		if (this.mine.has(key)) {
			return true;
		}
		const dir = joinPath(this.home, claimName(key));
		const provider = this.fileService.getProvider(dir.scheme);
		if (!provider || !await this.ensureHome()) {
			return true;
		}
		try {
			await provider.mkdir(dir);
			this.mine.add(key);
			this.sweepSoon();
			return true;
		} catch (err) {
			if (toFileSystemProviderErrorCode(err instanceof Error ? err : undefined) === FileSystemProviderErrorCode.FileExists) {
				return false;
			}
			this.logService.warn(`[volt jobs] could not record claim ${key}; going ahead`, err);
			return true;
		}
	}

	/** Whether some workbench claimed `key` (it may since have finished the work). */
	async isClaimed(key: string): Promise<boolean> {
		try {
			return await this.fileService.exists(joinPath(this.home, claimName(key)));
		} catch {
			return false;
		}
	}

	private ensureHome(): Promise<boolean> {
		this.ensured ??= this.fileService.createFolder(this.home).then(() => true, err => {
			this.logService.warn('[volt jobs] could not create the claims folder', err);
			// Not remembered: the next claim tries again.
			this.ensured = undefined;
			return false;
		});
		return this.ensured;
	}

	/** Once per workbench, a little after the first claim: old claims go. */
	private sweepSoon(): void {
		if (this.swept) {
			return;
		}
		this.swept = true;
		setTimeout(() => void this.sweep(), 60_000);
	}

	private async sweep(): Promise<void> {
		try {
			const stat = await this.fileService.resolve(this.home, { resolveMetadata: true });
			const cutoff = Date.now() - CLAIM_TTL_MS;
			const old = (stat.children ?? []).filter(child => child.isDirectory && child.mtime !== undefined && child.mtime < cutoff).slice(0, SWEEP_BATCH);
			for (const child of old) {
				await this.fileService.del(child.resource, { recursive: true }).catch(() => undefined);
			}
		} catch {
			// Nothing to sweep.
		}
	}
}

/** A file name for any key: readable when it is plain, hashed when it is long or odd. */
export function claimName(key: string): string {
	const plain = key.replace(/[^A-Za-z0-9._~-]/g, '_');
	if (plain.length <= 120 && plain === key) {
		return plain;
	}
	const hash = Math.floor(unitHash(key) * 0x1_0000_0000).toString(36) + Math.floor(unitHash(`${key}\0`) * 0x1_0000_0000).toString(36);
	return `${plain.slice(0, 100)}-${hash}`;
}
