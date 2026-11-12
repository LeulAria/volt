/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { VSBuffer } from '../../../../../base/common/buffer.js';
import { joinPath } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { FileOperationError, FileOperationResult, FileSystemProviderCapabilities, IFileService } from '../../../../../platform/files/common/files.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IOrchIndex, IOrchRootSnapshot, isSafeId, parseIndex, parseRootSnapshot } from '../../common/orchestration/orchestratorCodec.js';
import { ORCHESTRATOR_STATE_VERSION } from '../../common/orchestration/orchestrator.js';

const ATOMIC = { atomic: { postfix: '.tmp' } } as const;
const INDEX_FILE = 'index.json';
const ROOTS_DIR = 'roots';

/**
 * Orchestration on disk: one JSON file per root chat and an index of the roots a restart has to
 * look at. Every write replaces a whole file atomically (the user data provider can lose offset
 * appends across a reload), and writes to one file never overlap. Writes resolve with whether they
 * landed, so the service can write a failed root again instead of trusting a stale file.
 */
export class OrchestratorStore {

	private readonly chains = new Map<string, Promise<boolean>>();
	/** The write of each file that waits for the one in flight; later saves join it (see `write`). */
	private readonly queued = new Map<string, { content: () => string | undefined; result: Promise<boolean> }>();
	private ensured: Promise<void> | undefined;

	constructor(
		private readonly home: URI,
		private readonly fileService: IFileService,
		private readonly logService: ILogService,
	) { }

	private rootFile(rootId: string): URI {
		return joinPath(this.home, ROOTS_DIR, `${rootId}.json`);
	}

	private get indexFile(): URI {
		return joinPath(this.home, INDEX_FILE);
	}

	/** The index, or undefined when it is missing or unreadable (the caller rebuilds it from the roots). */
	async loadIndex(): Promise<IOrchIndex | undefined> {
		const raw = await this.readJson(this.indexFile);
		return raw === undefined ? undefined : parseIndex(raw);
	}

	/** Every root with a file on disk, read from the folder (the index lost or never written). */
	async listRootIds(): Promise<string[]> {
		try {
			const stat = await this.fileService.resolve(joinPath(this.home, ROOTS_DIR));
			return (stat.children ?? [])
				.filter(child => child.isFile && child.name.endsWith('.json'))
				.map(child => child.name.slice(0, -'.json'.length))
				.filter(isSafeId);
		} catch (err) {
			if (!isNotFound(err)) {
				this.logService.warn('[volt orchestrator] could not list saved chat trees', err);
			}
			return [];
		}
	}

	async loadRoot(rootId: string): Promise<IOrchRootSnapshot | undefined> {
		if (!isSafeId(rootId)) {
			return undefined;
		}
		const raw = await this.readJson(this.rootFile(rootId));
		const snapshot = raw === undefined ? undefined : parseRootSnapshot(raw);
		if (raw !== undefined && !snapshot) {
			this.logService.warn(`[volt orchestrator] ignoring unreadable root ${rootId}`);
		}
		return snapshot;
	}

	hasRoot(rootId: string): Promise<boolean> {
		return isSafeId(rootId) ? this.fileService.exists(this.rootFile(rootId)) : Promise.resolve(false);
	}

	/**
	 * Writes the root as `snapshot` returns it when the write begins (undefined: nothing to write).
	 * Saves asked for while an earlier one of the same root is still on its way share one write of
	 * the newest state, which holds everything each of them asked to save.
	 */
	saveRoot(rootId: string, snapshot: () => IOrchRootSnapshot | undefined): Promise<boolean> {
		if (!isSafeId(rootId)) {
			return Promise.resolve(true);
		}
		return this.write(this.rootFile(rootId), () => {
			const value = snapshot();
			return value ? JSON.stringify(value) : undefined;
		});
	}

	deleteRoot(rootId: string): Promise<boolean> {
		if (!isSafeId(rootId)) {
			return Promise.resolve(true);
		}
		const file = this.rootFile(rootId);
		// A save asked for after this delete must not join a write queued before it.
		this.queued.delete(file.toString());
		return this.serialize(file, async () => {
			await this.fileService.del(file).catch(err => {
				if (!isNotFound(err)) {
					throw err;
				}
			});
		});
	}

	saveIndex(index: Omit<IOrchIndex, 'version'>): Promise<boolean> {
		const content = JSON.stringify({ version: ORCHESTRATOR_STATE_VERSION, ...index });
		return this.write(this.indexFile, () => content);
	}

	/** Resolves when every write accepted so far is on disk. */
	async flush(): Promise<void> {
		await Promise.all([...this.chains.values()]);
	}

	/**
	 * One write per file at a time, in order. A write asked for while another of the same file waits
	 * to start joins it: the waiting write takes the newest content and both callers get its result.
	 * A burst of N saves (a batch of subagents starting) is then two writes, not N growing ones.
	 */
	private write(file: URI, content: () => string | undefined): Promise<boolean> {
		const key = file.toString();
		const waiting = this.queued.get(key);
		if (waiting) {
			waiting.content = content;
			return waiting.result;
		}
		const entry: { content: () => string | undefined; result: Promise<boolean> } = { content, result: Promise.resolve(true) };
		this.queued.set(key, entry);
		entry.result = this.serialize(file, async () => {
			if (this.queued.get(key) === entry) {
				this.queued.delete(key);
			}
			const text = entry.content();
			if (text === undefined) {
				return;
			}
			await this.ensureDirectories();
			// Atomic where the provider can (the user data folder can); a plain write elsewhere.
			const atomic = this.fileService.hasCapability(file, FileSystemProviderCapabilities.FileAtomicWrite);
			await this.fileService.writeFile(file, VSBuffer.fromString(text), atomic ? ATOMIC : undefined);
		});
		return entry.result;
	}

	/** Writes to one file run one at a time, in order; a failure is logged, resolves false, and never blocks the next. */
	private serialize(file: URI, work: () => Promise<void>): Promise<boolean> {
		const key = file.toString();
		const previous = this.chains.get(key) ?? Promise.resolve(true);
		const next = previous.then(work, work).then(() => true, err => {
			this.logService.error(`[volt orchestrator] failed to write ${key}`, err);
			return false;
		});
		this.chains.set(key, next);
		void next.then(() => {
			if (this.chains.get(key) === next) {
				this.chains.delete(key);
			}
		});
		return next;
	}

	private ensureDirectories(): Promise<void> {
		// A failed attempt is not remembered: the next write tries again.
		this.ensured ??= this.fileService.createFolder(joinPath(this.home, ROOTS_DIR)).then(() => undefined, () => {
			this.ensured = undefined;
		});
		return this.ensured;
	}

	private async readJson(file: URI): Promise<unknown> {
		try {
			const content = await this.fileService.readFile(file);
			return JSON.parse(content.value.toString());
		} catch (err) {
			if (!isNotFound(err)) {
				this.logService.warn(`[volt orchestrator] could not read ${file.toString()}`, err);
			}
			return undefined;
		}
	}
}

function isNotFound(err: unknown): boolean {
	return err instanceof FileOperationError && err.fileOperationResult === FileOperationResult.FILE_NOT_FOUND;
}
