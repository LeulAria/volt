/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { VSBuffer } from '../../../../../base/common/buffer.js';
import { joinPath } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
import { FileSystemProviderCapabilities, IFileService } from '../../../../../platform/files/common/files.js';
import { ILogService } from '../../../../../platform/log/common/log.js';

/** A beacon not refreshed within this long belongs to a workbench that is gone (or asleep). */
export const BEACON_TTL_MS = 60_000;
/** Beacons this old are deleted when seen. */
const BEACON_SWEEP_MS = 86_400_000;
const ATOMIC = { atomic: { postfix: '.tmp' } } as const;

/** Where a workbench can see processes (the agent server, in Node): its own pid, and whether another is alive. */
export interface IBeaconProcessProbe {
	readonly pid: number;
	alive(pid: number): boolean;
}

let processProbe: IBeaconProcessProbe | undefined;

/**
 * Set by the agent server. Its beacons then carry its pid, and a beacon whose process is gone
 * (the server was killed and started again) stops counting at once instead of after {@link BEACON_TTL_MS}.
 */
export function setBeaconProcessProbe(probe: IBeaconProcessProbe | undefined): void {
	processProbe = probe;
}

/**
 * Which chats another Volt workbench is responsible for right now. Each project runs its own
 * workbench and all of them load the same orchestration, so one that starts (or loads a chat tree
 * later) would otherwise settle another's running chats as interrupted and restart them: the same
 * work twice. Each workbench writes a beacon every watchdog tick naming the chats it has a turn in
 * or will restart; the others leave those chat trees alone while the beacon is fresh.
 *
 * Fails open: a beacon that cannot be read counts as no beacon, so a broken folder costs at worst
 * the old behavior, never a chat nobody restarts.
 */
export class WorkbenchBeacons {

	private readonly id = generateUuid();
	private written = false;

	constructor(
		private readonly home: URI,
		private readonly fileService: IFileService,
		private readonly logService: ILogService,
	) { }

	private get file(): URI {
		return joinPath(this.home, `${this.id}.json`);
	}

	/** Records the chats this workbench is responsible for now; none removes the beacon. */
	async beat(threadIds: readonly string[], now = Date.now()): Promise<void> {
		try {
			if (!threadIds.length) {
				if (this.written) {
					this.written = false;
					await this.fileService.del(this.file);
				}
				return;
			}
			const file = this.file;
			const atomic = this.fileService.hasCapability(file, FileSystemProviderCapabilities.FileAtomicWrite);
			await this.fileService.writeFile(file, VSBuffer.fromString(JSON.stringify({ at: now, threads: [...threadIds].sort(), ...(processProbe ? { pid: processProbe.pid } : {}) })), atomic ? ATOMIC : undefined);
			this.written = true;
		} catch (err) {
			this.logService.trace('[volt orchestrator] could not write the workbench beacon', err);
		}
	}

	/** Chats another workbench that is alive is responsible for. */
	async elsewhere(now = Date.now()): Promise<ReadonlySet<string>> {
		const live = new Set<string>();
		let children;
		try {
			children = (await this.fileService.resolve(this.home)).children ?? [];
		} catch {
			return live; // no beacons yet
		}
		const own = `${this.id}.json`;
		await Promise.all(children.map(async child => {
			if (child.isDirectory || child.name === own || !child.name.endsWith('.json')) {
				return;
			}
			try {
				const beacon = JSON.parse((await this.fileService.readFile(child.resource)).value.toString()) as { at?: unknown; threads?: unknown; pid?: unknown };
				const at = typeof beacon.at === 'number' ? beacon.at : 0;
				const dead = !!processProbe && typeof beacon.pid === 'number' && beacon.pid !== processProbe.pid && !processProbe.alive(beacon.pid);
				if (dead) {
					await this.fileService.del(child.resource).catch(() => undefined);
				} else if (now - at < BEACON_TTL_MS && Array.isArray(beacon.threads)) {
					for (const id of beacon.threads) {
						if (typeof id === 'string') {
							live.add(id);
						}
					}
				} else if (now - at > BEACON_SWEEP_MS) {
					await this.fileService.del(child.resource).catch(() => undefined);
				}
			} catch {
				// Torn or unreadable: no beacon.
			}
		}));
		return live;
	}

	/** Removes this workbench's beacon (shutdown). */
	async clear(): Promise<void> {
		await this.beat([]);
	}
}
