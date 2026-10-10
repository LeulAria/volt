/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from 'fs';
import { homedir } from 'os';
import { join } from '../../../base/common/path.js';
import { formatKeyValues, parseKeyValues } from '../common/voltAwake.js';
import { AwakeExec } from './awakeExec.js';

/**
 * One registry per machine user, shared by every Volt process (release, dev builds, test profiles,
 * the agent server): the lid setting is global, so one instance must never undo another's hold.
 *
 * ```
 * ~/.volt/awake/            0700
 *   holders/<pid>           key=value: pid, started, boot, deadline (epoch s), lid (0|1), owner
 *   changes                 what Volt changed and must undo: darwinSleepDisabled=1, win32Lid=<scheme>,<ac>,<dc>
 *   lock.d/pid              mkdir lock, shared with recovery.sh / restore.ps1
 * ```
 *
 * Plain files on purpose: the macOS recovery agent reads them from `sh` (launchd may not run Volt's
 * own binary when it lives under ~/Desktop, where privacy rules block it), Windows from PowerShell.
 */
export function defaultAwakeDir(): string {
	return join(homedir(), '.volt', 'awake');
}

export interface IAwakeHolder {
	readonly pid: number;
	/** The process's start time as the platform prints it; a reused pid reads differently. */
	readonly started: string;
	readonly boot: string;
	/** Epoch seconds. Renewed while the hold lasts, so a hung Volt still lets go. */
	readonly deadline: number;
	readonly lid: boolean;
	readonly owner: string;
}

export interface IAwakeProcessProbe {
	/** The start time of `pid` as recorded in holder files, '' when unreadable. */
	startedOf(pid: number): Promise<string>;
	bootId(): Promise<string>;
	isAlive(pid: number): boolean;
}

export function createProcessProbe(exec: AwakeExec, platform: NodeJS.Platform = process.platform): IAwakeProcessProbe {
	let boot: Promise<string> | undefined;
	return {
		async startedOf(pid) {
			if (platform === 'win32') {
				const result = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`], { timeoutMs: 15_000 });
				return result.code === 0 ? result.stdout.trim() : '';
			}
			const result = await exec('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], { timeoutMs: 5_000 });
			return result.code === 0 ? result.stdout.trim().replace(/\s+/g, ' ') : '';
		},
		bootId() {
			boot ??= (async () => {
				if (platform === 'darwin') {
					const result = await exec('/usr/sbin/sysctl', ['-n', 'kern.bootsessionuuid'], { timeoutMs: 5_000 });
					return result.code === 0 ? result.stdout.trim() : '';
				}
				if (platform === 'linux') {
					return (await fs.readFile('/proc/sys/kernel/random/boot_id', 'utf8').catch(() => '')).trim();
				}
				return '';
			})();
			return boot;
		},
		isAlive(pid) {
			try {
				process.kill(pid, 0);
				return true;
			} catch (err) {
				return (err as NodeJS.ErrnoException).code === 'EPERM';
			}
		},
	};
}

const LOCK_WAIT_MS = 10_000;
const LOCK_STALE_MS = 60_000;

export class AwakeRegistry {

	constructor(
		readonly dir: string,
		private readonly probe: IAwakeProcessProbe,
		private readonly nowSeconds: () => number = () => Math.floor(Date.now() / 1000),
	) { }

	private get holdersDir(): string { return join(this.dir, 'holders'); }
	private get changesFile(): string { return join(this.dir, 'changes'); }
	private get lockDir(): string { return join(this.dir, 'lock.d'); }

	async ensureDir(): Promise<void> {
		await fs.mkdir(this.holdersDir, { recursive: true, mode: 0o700 });
		await fs.chmod(this.dir, 0o700).catch(() => undefined);
	}

	/** Serializes "read the holders, then change the OS setting" with every other Volt process and the recovery scripts. */
	async withLock<T>(fn: () => Promise<T>): Promise<T> {
		await this.ensureDir();
		const started = Date.now();
		for (; ;) {
			try {
				await fs.mkdir(this.lockDir);
				await fs.writeFile(join(this.lockDir, 'pid'), String(process.pid));
				break;
			} catch (err) {
				if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
					throw err;
				}
				if (await this.lockIsStale()) {
					await fs.rm(this.lockDir, { recursive: true, force: true });
					continue;
				}
				if (Date.now() - started > LOCK_WAIT_MS) {
					throw new Error(`[volt awake] ${this.lockDir} is held by another process`);
				}
				await new Promise(resolve => setTimeout(resolve, 50));
			}
		}
		try {
			return await fn();
		} finally {
			await fs.rm(this.lockDir, { recursive: true, force: true }).catch(() => undefined);
		}
	}

	private async lockIsStale(): Promise<boolean> {
		const owner = Number((await fs.readFile(join(this.lockDir, 'pid'), 'utf8').catch(() => '')).trim());
		if (owner > 0) {
			return owner !== process.pid && !this.probe.isAlive(owner);
		}
		// Taken but no pid yet: its owner died between the mkdir and the write, or is about to write.
		const stat = await fs.stat(this.lockDir).catch(() => undefined);
		return !stat || Date.now() - stat.mtimeMs > LOCK_STALE_MS;
	}

	async writeHolder(holder: IAwakeHolder): Promise<void> {
		await this.ensureDir();
		const map = new Map<string, string>([
			['pid', String(holder.pid)],
			['started', holder.started],
			['boot', holder.boot],
			['deadline', String(holder.deadline)],
			['lid', holder.lid ? '1' : '0'],
			['owner', holder.owner],
		]);
		await writeAtomic(join(this.holdersDir, String(holder.pid)), formatKeyValues(map));
	}

	async removeHolder(pid: number): Promise<void> {
		await fs.rm(join(this.holdersDir, String(pid)), { force: true });
	}

	async readHolders(): Promise<IAwakeHolder[]> {
		const names = await fs.readdir(this.holdersDir).catch(() => [] as string[]);
		const holders: IAwakeHolder[] = [];
		for (const name of names) {
			if (!/^\d+$/.test(name)) {
				continue;
			}
			const map = parseKeyValues(await fs.readFile(join(this.holdersDir, name), 'utf8').catch(() => ''));
			holders.push({
				pid: Number(map.get('pid') ?? name),
				started: map.get('started') ?? '',
				boot: map.get('boot') ?? '',
				deadline: Number(map.get('deadline') ?? 0),
				lid: map.get('lid') === '1',
				owner: map.get('owner') ?? '',
			});
		}
		return holders;
	}

	/** Holders whose process still runs (same start time, same boot) and whose deadline is ahead. Removes the rest. */
	async liveHolders(): Promise<IAwakeHolder[]> {
		const now = this.nowSeconds();
		const boot = await this.probe.bootId();
		const live: IAwakeHolder[] = [];
		for (const holder of await this.readHolders()) {
			if (await this.isLive(holder, now, boot)) {
				live.push(holder);
			} else {
				await this.removeHolder(holder.pid);
			}
		}
		return live;
	}

	private async isLive(holder: IAwakeHolder, now: number, boot: string): Promise<boolean> {
		if (!(holder.pid > 0) || !(holder.deadline > now)) {
			return false;
		}
		if (holder.boot && boot && holder.boot !== boot) {
			return false;
		}
		if (!this.probe.isAlive(holder.pid)) {
			return false;
		}
		if (holder.pid === process.pid) {
			return true;
		}
		return !holder.started || holder.started === await this.probe.startedOf(holder.pid);
	}

	async readChanges(): Promise<Map<string, string>> {
		return parseKeyValues(await fs.readFile(this.changesFile, 'utf8').catch(() => ''));
	}

	/** Journals (or with `undefined`, clears) one change. Written before the OS change, cleared after its undo. */
	async setChange(key: string, value: string | undefined): Promise<void> {
		const changes = await this.readChanges();
		if (value === undefined) {
			if (!changes.delete(key)) {
				return;
			}
		} else {
			changes.set(key, value);
		}
		await this.ensureDir();
		if (changes.size) {
			await writeAtomic(this.changesFile, formatKeyValues(changes));
		} else {
			await fs.rm(this.changesFile, { force: true });
		}
	}
}

async function writeAtomic(path: string, content: string): Promise<void> {
	const temp = `${path}.${process.pid}.tmp`;
	await fs.writeFile(temp, content, { mode: 0o600 });
	await fs.rename(temp, path);
}
