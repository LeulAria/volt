/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import { homedir } from 'os';
import { getErrorMessage } from '../../../base/common/errors.js';
import { dirname, join } from '../../../base/common/path.js';
import { ILogService } from '../../log/common/log.js';
import { codeScanOptionsOf, ICodeScanFinding, ICodeScanReader, scanExtensionFolder } from '../../voltPlugins/common/extensionCodeScan.js';
import { canonicalManifest, compareWithLock, describeMismatch, IVoltDiskFile, IVoltExtensionLock, IVoltExtensionLockEntry, IVoltExtensionIntegrityService, IVoltIntegrityFailure, IVoltLockedFile, IVoltPublisherFacts, isUnlockedPath, VOLT_EXTENSION_LOCK_FILE, voltLockRootDigestInput, VoltLockSource } from '../common/voltExtensionLock.js';

/**
 * The integrity lock's store and check on disk (`common/voltExtensionLock.ts` says what and why).
 * One JSON file under `~/.volt/trust` (0600), read fresh and merged on every write, so the shared
 * process (installs) and the agent server (its own installs) don't drop each other's entries.
 *
 * The check stats every file of every checked extension (a parallel walk, no reads) and hashes only
 * the files whose size, modification or change time moved since they were last hashed.
 */

/** The lock under a home folder: `~/.volt/trust/extensions.lock.json`. */
export function extensionLockPath(home: string): string {
	return join(home, '.volt', 'trust', VOLT_EXTENSION_LOCK_FILE);
}

export const DEFAULT_EXTENSION_LOCK_PATH = extensionLockPath(homedir());

/** Files per extension past which the walk stops and reports the folder as unreadable: a bound for a hostile folder. */
const MAX_FILES = 60_000;

export interface IVoltRecordFacts extends IVoltPublisherFacts {
	readonly id: string;
	readonly version: string;
	readonly source: VoltLockSource;
	readonly highFindings?: readonly string[];
}

function sha256(bytes: Uint8Array | string): string {
	return createHash('sha256').update(bytes).digest('hex');
}

/** Every file under `root` (posix paths) with its stat; symbolic links are listed as files (their target is not followed). */
async function walk(root: string): Promise<Map<string, IVoltDiskFile>> {
	const files = new Map<string, IVoltDiskFile>();
	const visit = async (relative: string): Promise<void> => {
		const entries = await fs.readdir(relative ? join(root, relative) : root, { withFileTypes: true });
		await Promise.all(entries.map(async entry => {
			const path = relative ? `${relative}/${entry.name}` : entry.name;
			if (entry.isDirectory()) {
				return visit(path);
			}
			if (isUnlockedPath(path)) {
				return;
			}
			if (files.size >= MAX_FILES) {
				throw new Error(`it has more than ${MAX_FILES} files`);
			}
			const stat = await fs.lstat(join(root, path));
			files.set(path, { size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs });
		}));
	};
	await visit('');
	return files;
}

/** A file's hash as the lock records it (a symbolic link by its target text; `package.json` without `__metadata`). */
async function hashFile(root: string, path: string): Promise<string> {
	const full = join(root, path);
	const stat = await fs.lstat(full);
	if (stat.isSymbolicLink()) {
		return sha256(`symlink:${await fs.readlink(full)}`);
	}
	const bytes = await fs.readFile(full);
	if (path === 'package.json') {
		const canonical = canonicalManifest(bytes.toString('utf8'));
		if (canonical !== undefined) {
			return sha256(canonical);
		}
	}
	return sha256(bytes);
}

/** At most `limit` of `items` at a time. */
async function inParallel<T>(items: readonly T[], limit: number, run: (item: T) => Promise<void>): Promise<void> {
	let next = 0;
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
		while (next < items.length) {
			await run(items[next++]);
		}
	}));
}

export class VoltExtensionIntegrity implements IVoltExtensionIntegrityService {

	declare readonly _serviceBrand: undefined;

	/** Writes one at a time; each reads the file fresh and merges. */
	private writing: Promise<unknown> = Promise.resolve();

	constructor(
		readonly lockPath: string = DEFAULT_EXTENSION_LOCK_PATH,
		private readonly logService?: ILogService,
	) { }

	async read(): Promise<IVoltExtensionLock> {
		try {
			const lock = JSON.parse(await fs.readFile(this.lockPath, 'utf8'));
			if (lock?.version === 1 && lock.extensions && typeof lock.extensions === 'object') {
				return lock;
			}
			this.logService?.warn(`[volt integrity] ${this.lockPath} has an unknown format; starting a new one`);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
				this.logService?.warn(`[volt integrity] could not read ${this.lockPath}: ${getErrorMessage(error)}`);
			}
		}
		return { version: 1, extensions: {} };
	}

	/** Sets (or, with undefined, deletes) entries, merged into the file as it is now. */
	private update(changes: ReadonlyMap<string, IVoltExtensionLockEntry | undefined>): Promise<void> {
		const job = this.writing.then(() => this.exclusive(async () => {
			const lock = await this.read();
			const extensions = { ...lock.extensions };
			for (const [location, entry] of changes) {
				if (entry) {
					extensions[location] = entry;
				} else {
					delete extensions[location];
				}
			}
			const temp = `${this.lockPath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
			await fs.writeFile(temp, JSON.stringify({ version: 1, extensions }), { mode: 0o600 });
			await fs.rename(temp, this.lockPath);
		}));
		this.writing = job.catch(() => undefined);
		return job;
	}

	/**
	 * Runs `write` holding `<lock>.lock` (a folder: made atomically), so another process (the agent
	 * server, a second shared process) can't read-merge-write at the same time. A holder that died
	 * leaves it behind: one older than ten seconds is taken over.
	 */
	private async exclusive<T>(write: () => Promise<T>): Promise<T> {
		const mutex = `${this.lockPath}.lock`;
		await fs.mkdir(dirname(this.lockPath), { recursive: true, mode: 0o700 });
		for (let attempt = 0; ; attempt++) {
			try {
				await fs.mkdir(mutex);
				break;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
					throw error;
				}
				const stale = await fs.stat(mutex).then(stat => Date.now() - stat.mtimeMs > 10_000, () => false);
				if (stale || attempt > 250) {
					await fs.rm(mutex, { recursive: true, force: true });
					continue;
				}
				await new Promise(resolve => setTimeout(resolve, 20));
			}
		}
		try {
			return await write();
		} finally {
			await fs.rm(mutex, { recursive: true, force: true });
		}
	}

	async entry(location: string): Promise<IVoltExtensionLockEntry | undefined> {
		return (await this.read()).extensions[location];
	}

	/** Hashes every file of the folder and makes that its lock. */
	async record(location: string, facts: IVoltRecordFacts): Promise<IVoltExtensionLockEntry> {
		const disk = await walk(location);
		const files: Record<string, IVoltLockedFile> = {};
		await inParallel([...disk.keys()], 16, async path => {
			const stat = disk.get(path)!;
			files[path] = { sha256: await hashFile(location, path), size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs };
		});
		const entry: IVoltExtensionLockEntry = {
			id: facts.id.toLowerCase(),
			version: facts.version,
			publisher: facts.publisher,
			...(facts.publisherId ? { publisherId: facts.publisherId } : {}),
			...(facts.publisherDisplayName ? { publisherDisplayName: facts.publisherDisplayName } : {}),
			...(facts.verified !== undefined ? { verified: facts.verified } : {}),
			...(facts.signature !== undefined ? { signature: facts.signature } : {}),
			...(facts.highFindings ? { highFindings: facts.highFindings } : {}),
			source: facts.source,
			root: sha256(voltLockRootDigestInput(files)),
			files,
			recordedAt: Date.now(),
		};
		await this.update(new Map([[location, entry]]));
		this.logService?.info(`[volt integrity] recorded ${entry.id}@${entry.version} (${facts.source}): ${disk.size} files, root ${entry.root.slice(0, 12)}`);
		return entry;
	}

	async forget(location: string): Promise<void> {
		await this.update(new Map([[location, undefined]]));
	}

	async trust(location: string): Promise<void> {
		const previous = await this.entry(location);
		const manifest = JSON.parse(await fs.readFile(join(location, 'package.json'), 'utf8'));
		await this.record(location, {
			...(previous ?? {}),
			id: previous?.id ?? `${manifest.publisher}.${manifest.name}`,
			version: manifest.version,
			publisher: previous?.publisher ?? manifest.publisher,
			source: 'trusted',
		});
		this.logService?.warn(`[volt integrity] the user trusted the current files of ${location}`);
	}

	/**
	 * Checks each folder against its entry. A folder with no entry (installed before the lock) is
	 * recorded as it is now (`baseline`) and passes. Files whose stats moved but whose hash did not
	 * get their new stats saved, so the next check doesn't hash them again.
	 */
	async verify(locations: readonly string[]): Promise<IVoltIntegrityFailure[]> {
		const lock = await this.read();
		const failures: IVoltIntegrityFailure[] = [];
		const changes = new Map<string, IVoltExtensionLockEntry | undefined>();
		const baselines: string[] = [];
		await inParallel(locations, 8, async location => {
			const entry = lock.extensions[location];
			if (!entry) {
				baselines.push(location);
				return;
			}
			try {
				const disk = await walk(location);
				const { added, removed, toHash } = compareWithLock(entry, disk);
				const modified: string[] = [];
				const refreshed: Record<string, IVoltLockedFile> = {};
				await inParallel(toHash, 16, async path => {
					const hash = await hashFile(location, path);
					if (hash !== entry.files[path].sha256) {
						modified.push(path);
					} else {
						const stat = disk.get(path)!;
						refreshed[path] = { ...entry.files[path], size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs };
					}
				});
				const why = describeMismatch({ added, removed, modified: modified.sort() });
				if (why) {
					failures.push({ location, id: entry.id, version: entry.version, why, source: entry.source });
					this.logService?.error(`[volt integrity] ${entry.id}@${entry.version} is not started: ${why}`);
				} else if (Object.keys(refreshed).length) {
					changes.set(location, { ...entry, files: { ...entry.files, ...refreshed } });
				}
			} catch (error) {
				const why = (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'its folder is missing' : `its files could not be read (${getErrorMessage(error)})`;
				failures.push({ location, id: entry.id, version: entry.version, why, source: entry.source });
				this.logService?.error(`[volt integrity] ${entry.id}@${entry.version} is not started: ${why}`);
			}
		});
		// Entries of folders that are gone (an updated or uninstalled version VS Code deleted) are dropped.
		const checked = new Set(locations);
		await inParallel(Object.keys(lock.extensions).filter(location => !checked.has(location)), 8, async location => {
			if (!await fs.access(location).then(() => true, () => false)) {
				changes.set(location, undefined);
			}
		});
		if (changes.size) {
			await this.update(changes).catch(error => this.logService?.warn(`[volt integrity] could not save the lock: ${getErrorMessage(error)}`));
		}
		// Trust on first use for extensions installed before the lock: recorded in the background, they pass now.
		if (baselines.length) {
			this.baselining = Promise.all([this.baselining, ...baselines.map(location => this.recordBaseline(location))]).then(() => undefined);
		}
		return failures;
	}

	private baselining: Promise<void> = Promise.resolve();

	/** Resolves once the first-look records started by {@link verify} are written. */
	whenBaselined(): Promise<void> {
		return this.baselining;
	}

	private async recordBaseline(location: string): Promise<void> {
		try {
			const manifest = JSON.parse(await fs.readFile(join(location, 'package.json'), 'utf8'));
			await this.record(location, { id: `${manifest.publisher}.${manifest.name}`, version: manifest.version, publisher: manifest.publisher, source: 'baseline' });
		} catch (error) {
			this.logService?.warn(`[volt integrity] could not record ${location} on first look: ${getErrorMessage(error)}`);
		}
	}
}

/** The install-time code scan's `high` findings of a folder (`rule: evidence`), and the findings themselves for the sheet. */
export async function scanHighFindings(location: string, manifest: { readonly enabledApiProposals?: readonly string[]; readonly contributes?: unknown }): Promise<{ readonly keys: string[]; readonly findings: ICodeScanFinding[] }> {
	const reader: ICodeScanReader = {
		list: async path => (await fs.readdir(path, { withFileTypes: true }))
			.filter(entry => !entry.isSymbolicLink())
			.map(entry => ({ name: entry.name, directory: entry.isDirectory() })),
		read: path => fs.readFile(path, 'utf8'),
	};
	const result = await scanExtensionFolder(location, reader, codeScanOptionsOf(manifest), () => Promise.resolve());
	const findings = result.findings.filter(finding => finding.severity === 'high');
	return { keys: [...new Set(findings.map(finding => `${finding.rule}: ${finding.evidence}`))].sort(), findings };
}

/** One store per lock file in a process: the install path and the window's channel share it. */
const instances = new Map<string, VoltExtensionIntegrity>();

export function voltExtensionIntegrity(logService?: ILogService, lockPath: string = DEFAULT_EXTENSION_LOCK_PATH): VoltExtensionIntegrity {
	let instance = instances.get(lockPath);
	if (!instance) {
		instances.set(lockPath, instance = new VoltExtensionIntegrity(lockPath, logService));
	}
	return instance;
}
