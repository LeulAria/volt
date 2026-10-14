/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import { Emitter, Event } from '../../../base/common/event.js';
import { dirname, join, normalize, relative, sep } from '../../../base/common/path.js';
import { IVoltCodeIndexFilesRequest, IVoltCodeIndexFilesResult, IVoltCodeIndexFindFilesRequest, IVoltCodeIndexFindFilesResult, IVoltCodeIndexOptions, IVoltFffStatus, IVoltCodeIndexSearchRequest, IVoltCodeIndexSearchResult, IVoltCodeIndexStatus, IVoltCodeIndexSymbolsRequest, IVoltCodeIndexSymbolsResult } from '../common/voltCodeIndex.js';
import { FffEngine } from './fffEngine.js';
import { optionsKey, RootIndex } from './rootIndex.js';

/** Indexes kept on disk; the least recently used beyond this are deleted. */
const MAX_INDEXES_ON_DISK = 30;
/** A folder nobody searched for this long is unloaded (it stays on disk). */
const UNLOAD_AFTER_MS = 20 * 60_000;
const CHANGE_THROTTLE_MS = 250;

/** What the worker process serves over IPC. */
export interface ICodeIndexWorker {
	readonly onDidChangeStatus: Event<void>;
	warm(root: string, options?: IVoltCodeIndexOptions): Promise<void>;
	search(request: IVoltCodeIndexSearchRequest): Promise<IVoltCodeIndexSearchResult>;
	files(request: IVoltCodeIndexFilesRequest): Promise<IVoltCodeIndexFilesResult>;
	findFiles(request: IVoltCodeIndexFindFilesRequest): Promise<IVoltCodeIndexFindFilesResult>;
	symbols(request: IVoltCodeIndexSymbolsRequest): Promise<IVoltCodeIndexSymbolsResult>;
	fffStatus(fffPath?: string): Promise<IVoltFffStatus>;
	installFff(): Promise<IVoltFffStatus>;
	status(roots?: readonly string[]): Promise<readonly IVoltCodeIndexStatus[]>;
	rebuild(root: string, options?: IVoltCodeIndexOptions): Promise<void>;
	remove(root?: string): Promise<void>;
}

interface IManifestSummary {
	readonly root?: string;
	readonly updatedAt?: number;
	readonly lastUsedAt?: number;
	readonly stats?: { readonly files: number; readonly bytes: number; readonly symbols: number; readonly diskBytes: number };
}

function normalizeRoot(root: string): string {
	const path = normalize(root);
	return path.length > 1 && path.endsWith(sep) ? path.slice(0, -1) : path;
}

export class CodeIndexEngine implements ICodeIndexWorker {

	private readonly roots = new Map<string, RootIndex>();
	private readonly _onDidChangeStatus = new Emitter<void>();
	readonly onDidChangeStatus: Event<void> = this._onDidChangeStatus.event;
	private changeTimer: ReturnType<typeof setTimeout> | undefined;
	private readonly unloadTimer: ReturnType<typeof setInterval>;
	/** FFF, when installed: fuzzy file search ranked by typos, frecency and git status. */
	private readonly fff: FffEngine;

	constructor(
		private readonly dataDir: string,
		private readonly log: (message: string) => void,
	) {
		this.unloadTimer = setInterval(() => void this.unloadIdle(), 60_000);
		// Next to the indexes: `<userData>/volt-tools` for `<userData>/volt-index`.
		this.fff = new FffEngine(join(dirname(dataDir), 'volt-tools'), log);
	}

	private dirFor(root: string): string {
		return join(this.dataDir, createHash('sha1').update(root).digest('hex').slice(0, 24));
	}

	private fireChange(): void {
		if (!this.changeTimer) {
			this.changeTimer = setTimeout(() => {
				this.changeTimer = undefined;
				this._onDidChangeStatus.fire();
			}, CHANGE_THROTTLE_MS);
		}
	}

	private index(root: string, options: IVoltCodeIndexOptions | undefined): RootIndex {
		const key = normalizeRoot(root);
		let index = this.roots.get(key);
		if (!index) {
			index = new RootIndex(key, this.dirFor(key), options ?? {}, () => this.fireChange(), this.log);
			this.roots.set(key, index);
			void this.evictFromDisk().catch(err => this.log(`[code index] cleanup failed: ${err}`));
		} else if (options && optionsKey(options) !== index.key) {
			void index.start(options); // the ignore settings changed: rebuild with them
		}
		return index;
	}

	async warm(root: string, options?: IVoltCodeIndexOptions): Promise<void> {
		void this.index(root, options).start();
	}

	search(request: IVoltCodeIndexSearchRequest): Promise<IVoltCodeIndexSearchResult> {
		return this.index(request.root, request.options).search(request);
	}

	files(request: IVoltCodeIndexFilesRequest): Promise<IVoltCodeIndexFilesResult> {
		return this.index(request.root, request.options).files(request);
	}

	symbols(request: IVoltCodeIndexSymbolsRequest): Promise<IVoltCodeIndexSymbolsResult> {
		return this.index(request.root, request.options).symbols(request);
	}

	/**
	 * FFF first when it is installed and allowed (better ranking: typos, frecency, git status),
	 * kept to the files the index lists so both engines honor the same ignore files; the index's
	 * own fuzzy search when FFF is missing, slow, broken, or finds nothing the index would show.
	 */
	async findFiles(request: IVoltCodeIndexFindFilesRequest): Promise<IVoltCodeIndexFindFilesResult> {
		const index = this.index(request.root, request.options);
		const started = Date.now();
		let fffSkipped: string | undefined;
		if (request.fff !== 'off') {
			const root = normalizeRoot(request.root);
			const found = await this.fff.findFiles(root, request.query, request.limit, request.fffPath);
			if (found.kind === 'results') {
				const listed = index.listedFilter();
				const folder = request.folder ? relative(root, normalize(request.folder)).split(sep).join('/') : '';
				const inFolder = folder && !folder.startsWith('..') ? `${folder}/` : '';
				const paths = found.paths.filter(path => (!listed || listed(path)) && (!inFolder || path.startsWith(inFolder)));
				if (paths.length) {
					return {
						kind: 'results',
						paths: paths.slice(0, request.limit),
						limitHit: paths.length > request.limit || (found.total ?? 0) > found.paths.length,
						engine: 'fff',
						ms: Date.now() - started,
					};
				}
				fffSkipped = found.paths.length ? 'every FFF match is ignored by the index' : 'no FFF match';
			} else {
				fffSkipped = found.reason;
			}
		}
		const result = await index.findFiles(request);
		return result.kind === 'results' && fffSkipped && request.fff !== 'off' ? { ...result, fffSkipped } : result;
	}

	fffStatus(fffPath?: string): Promise<IVoltFffStatus> {
		return this.fff.status(fffPath);
	}

	installFff(): Promise<IVoltFffStatus> {
		return this.fff.install();
	}

	async status(roots?: readonly string[]): Promise<readonly IVoltCodeIndexStatus[]> {
		if (roots) {
			return Promise.all(roots.map(root => {
				const loaded = this.roots.get(normalizeRoot(root));
				return loaded ? loaded.status() : this.diskStatus(normalizeRoot(root), this.dirFor(normalizeRoot(root)));
			}));
		}
		const out = new Map<string, IVoltCodeIndexStatus>();
		for (const index of this.roots.values()) {
			out.set(index.root, index.status());
		}
		for (const name of await fs.readdir(this.dataDir).catch(() => [] as string[])) {
			const summary = await this.readSummary(join(this.dataDir, name));
			if (summary?.root && !out.has(summary.root)) {
				out.set(summary.root, await this.diskStatus(summary.root, join(this.dataDir, name)));
			}
		}
		return [...out.values()].sort((a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0));
	}

	private async readSummary(dir: string): Promise<IManifestSummary | undefined> {
		try {
			return JSON.parse(await fs.readFile(join(dir, 'manifest.json'), 'utf8')) as IManifestSummary;
		} catch {
			return undefined;
		}
	}

	private async diskStatus(root: string, dir: string): Promise<IVoltCodeIndexStatus> {
		const summary = await this.readSummary(dir);
		return {
			root,
			state: summary ? 'ready' : 'none',
			files: summary?.stats?.files ?? 0,
			bytes: summary?.stats?.bytes ?? 0,
			diskBytes: summary?.stats?.diskBytes ?? 0,
			symbols: summary?.stats?.symbols ?? 0,
			pending: 0,
			...(summary?.updatedAt ? { updatedAt: summary.updatedAt } : {}),
			...(summary?.lastUsedAt ? { lastUsedAt: summary.lastUsedAt } : {}),
		};
	}

	async rebuild(root: string, options?: IVoltCodeIndexOptions): Promise<void> {
		const index = this.index(root, options);
		void (options && optionsKey(options) !== index.key ? index.start(options) : index.rebuild());
	}

	async remove(root?: string): Promise<void> {
		const roots = root ? [normalizeRoot(root)] : [...this.roots.keys()];
		for (const key of roots) {
			await this.roots.get(key)?.dispose();
			this.roots.delete(key);
		}
		if (root) {
			await fs.rm(this.dirFor(normalizeRoot(root)), { recursive: true, force: true });
		} else {
			await fs.rm(this.dataDir, { recursive: true, force: true });
		}
		this.fireChange();
	}

	private async unloadIdle(): Promise<void> {
		const now = Date.now();
		for (const [key, index] of [...this.roots]) {
			if (now - index.lastUsedAt > UNLOAD_AFTER_MS) {
				this.roots.delete(key);
				await index.dispose();
				await this.fff.stop(key);
				this.log(`[code index] ${key}: unloaded (idle)`);
			}
		}
	}

	/** Deletes the least recently used indexes beyond the cap (never a loaded one). */
	private async evictFromDisk(): Promise<void> {
		const names = await fs.readdir(this.dataDir).catch(() => [] as string[]);
		if (names.length <= MAX_INDEXES_ON_DISK) {
			return;
		}
		const loaded = new Set([...this.roots.keys()].map(root => this.dirFor(root)));
		const entries: { dir: string; used: number }[] = [];
		for (const name of names) {
			const dir = join(this.dataDir, name);
			if (loaded.has(dir)) {
				continue;
			}
			const summary = await this.readSummary(dir);
			entries.push({ dir, used: summary?.lastUsedAt ?? summary?.updatedAt ?? 0 });
		}
		entries.sort((a, b) => a.used - b.used);
		for (const entry of entries.slice(0, names.length - MAX_INDEXES_ON_DISK)) {
			await fs.rm(entry.dir, { recursive: true, force: true });
		}
	}

	async dispose(): Promise<void> {
		clearInterval(this.unloadTimer);
		clearTimeout(this.changeTimer);
		this.fff.dispose();
		for (const index of this.roots.values()) {
			await index.dispose();
		}
		this.roots.clear();
		this._onDidChangeStatus.dispose();
	}
}
