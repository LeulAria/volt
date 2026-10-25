/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { RunOnceScheduler, Sequencer, timeout } from '../../../../../base/common/async.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable, IReference, toDisposable } from '../../../../../base/common/lifecycle.js';
import { joinPath } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { localize } from '../../../../../nls.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IEnvironmentService } from '../../../../../platform/environment/common/environment.js';
import { FileOperationError, FileOperationResult, FileSystemProviderCapabilities, IFileService } from '../../../../../platform/files/common/files.js';
import { InstantiationType, registerSingleton } from '../../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { INotificationService, Severity } from '../../../../../platform/notification/common/notification.js';
import { ILifecycleService } from '../../../../services/lifecycle/common/lifecycle.js';
import { readNewBoardSettings, readSnapshotMinutes, readTrashDays, SCRATCH_SNAPSHOT_MINUTES_SETTING, SCRATCH_TRASH_DAYS_SETTING } from '../../common/canvasScratchSettings.js';
import { documentCovers, emptyBoardDocument, emptyIndex, mergeBoardDocuments, mergeIndexes, parseBoardDocument, parseIndex, serializeBoardDocument } from '../../common/scratchBoard/scratchDocument.js';
import { newElementId } from '../../common/scratchBoard/scratchFactory.js';
import { richTextExcerpt } from '../../common/scratchBoard/scratchHtml.js';
import { deleteFolder, nextUntitledName, updateBoard, updateFolder } from '../../common/scratchBoard/scratchIndex.js';
import { ScratchScene } from '../../common/scratchBoard/scratchScene.js';
import { IScratchBoardDocument, IScratchBoardMeta, IScratchCamera, IScratchFolder, IScratchIndex, isRichText, ScratchElement } from '../../common/scratchBoard/scratchTypes.js';

export const IScratchBoardService = createDecorator<IScratchBoardService>('voltScratchBoardService');

export interface IScratchSnapshot {
	readonly name: string;
	readonly time: number;
}

/**
 * Scratch boards on disk, under the user data folder:
 *
 *   voltScratchBoards/index.json          the board list (folders, pins, archive)
 *   voltScratchBoards/boards/<id>.json    one board
 *   voltScratchBoards/assets/<hash>.<ext> pasted images, shared by content
 *   voltScratchBoards/snapshots/<id>/     a copy every few minutes of editing (volt.scratch.snapshotMinutes), newest 40 kept
 *   voltScratchBoards/trash/              deleted boards, kept 30 days (volt.scratch.trashDays)
 *   voltScratchBoards/broken/             files that could not be read, never overwritten in place
 *
 * Every write is atomic and merges what another window wrote first, so two windows on one
 * board both keep their edits.
 */
export interface IScratchBoardService {
	readonly _serviceBrand: undefined;
	readonly whenReady: Promise<void>;
	readonly onDidChangeIndex: Event<void>;
	readonly index: IScratchIndex;
	getBoard(id: string): IScratchBoardMeta | undefined;
	getFolder(id: string): IScratchFolder | undefined;
	createBoard(options?: { readonly folderId?: string | null; readonly projectId?: string; readonly title?: string; readonly document?: Partial<Pick<IScratchBoardDocument, 'elements' | 'settings' | 'camera'>> }): Promise<string>;
	renameBoard(id: string, title: string): void;
	setBoardPinned(id: string, pinned: boolean): void;
	setBoardArchived(id: string, archived: boolean): void;
	moveBoard(id: string, folderId: string | null): void;
	duplicateBoard(id: string): Promise<string | undefined>;
	/** Moves the board to the trash; resolves with a function that brings it back (false when it could not). */
	deleteBoard(id: string): Promise<(() => Promise<boolean>) | undefined>;
	createFolder(name: string): string;
	renameFolder(id: string, name: string): void;
	deleteFolder(id: string): void;
	setFolderCollapsed(id: string, collapsed: boolean): void;
	setLastOpened(id: string): void;
	acquireModel(id: string): Promise<IReference<ScratchBoardModel>>;
	putAsset(bytes: Uint8Array, mime: string): Promise<string>;
	readAsset(assetId: string): Promise<VSBuffer | undefined>;
	/** A blob: URL for an image element, cached for the window's life. */
	assetUrl(assetId: string, mime: string): Promise<string | undefined>;
	readBoardDocument(id: string): Promise<IScratchBoardDocument | undefined>;
	/** The board a chat was started from (its run outline is on it), if any. */
	findBoardForSession(sessionId: string): Promise<string | undefined>;
	listSnapshots(id: string): Promise<IScratchSnapshot[]>;
	restoreSnapshot(id: string, name: string): Promise<boolean>;
	flush(): Promise<void>;
}

const ROOT = 'voltScratchBoards';
const INDEX_FILE = 'index.json';
const SAVE_DELAY_MS = 350;
const CAMERA_SAVE_DELAY_MS = 1500;
const INDEX_SAVE_DELAY_MS = 300;
const SNAPSHOTS_KEPT = 40;
const DAY_MS = 86_400_000;
const MAX_SAVE_RETRY_MS = 30_000;
const MISSING_FILE_GRACE_MS = 2500;

function isNotFound(err: unknown): boolean {
	return err instanceof FileOperationError && err.fileOperationResult === FileOperationResult.FILE_NOT_FOUND;
}

function extensionForMime(mime: string): string {
	switch (mime) {
		case 'image/png': return 'png';
		case 'image/jpeg': return 'jpg';
		case 'image/gif': return 'gif';
		case 'image/webp': return 'webp';
		case 'image/svg+xml': return 'svg';
		case 'image/avif': return 'avif';
		case 'image/bmp': return 'bmp';
		default: return 'bin';
	}
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>);
	return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
}

/** What the store needs from its service. */
interface IBoardStore {
	readonly fileService: IFileService;
	readonly logService: ILogService;
	readonly root: URI;
	boardFile(id: string): URI;
	writeAtomic(file: URI, content: string): Promise<void>;
	backupBroken(file: URI, content: string, reason: string): Promise<URI | undefined>;
	noteEdited(id: string, elements: readonly ScratchElement[]): void;
	notifyUnreadable(id: string, backup: URI | undefined): void;
	/** Time between saved versions while editing (0: none); ten minutes when unset. */
	snapshotEveryMs?(): number;
}

/**
 * One open board: its scene plus the saving. Saves follow edits by a third of a second, merge
 * another window's copy first, keep a snapshot every few minutes, and retry until they land.
 */
export class ScratchBoardModel extends Disposable {

	readonly scene: ScratchScene;
	private _camera: IScratchCamera | undefined;
	private lastWritten: string | undefined;
	private savedDirty = 0;
	private revision = 0;
	private updated = 0;
	private loaded = false;
	/** A file we could not read stays untouched until the user edits; then a copy is kept first. */
	private unreadableText: string | undefined;
	private readonly sequencer = new Sequencer();
	private readonly saveScheduler: RunOnceScheduler;
	private readonly cameraScheduler: RunOnceScheduler;
	private readonly reloadScheduler: RunOnceScheduler;
	private retryHandle: ReturnType<typeof setTimeout> | undefined;
	private failures = 0;
	private lastSnapshotAt = 0;
	private cameraDirty = false;
	/** In the trash: nothing is written (or merged) until the board comes back. */
	private retired = false;
	/** Never written: rewriting would drop what this version could not read, and no copy could be kept. */
	private readOnly = false;
	/** The file we saved before went missing (moved to the trash by another window?): since when. */
	private missingSince: number | undefined;
	/** The board as it was opened, kept as the first version-history entry once it is edited. */
	private sessionStartText: string | undefined;
	readonly whenLoaded: Promise<void>;

	private readonly _onDidReloadFromDisk = this._register(new Emitter<void>());
	/** Another window changed this board and its edits were merged in. */
	readonly onDidReloadFromDisk = this._onDidReloadFromDisk.event;

	constructor(readonly id: string, private readonly store: IBoardStore) {
		super();
		this.scene = this._register(new ScratchScene());
		this.saveScheduler = this._register(new RunOnceScheduler(() => void this.save(), SAVE_DELAY_MS));
		this.cameraScheduler = this._register(new RunOnceScheduler(() => void this.save(), CAMERA_SAVE_DELAY_MS));
		this.reloadScheduler = this._register(new RunOnceScheduler(() => void this.reload(), 120));
		this._register(this.scene.onDidBecomeDirty(() => this.saveScheduler.schedule()));
		this._register(toDisposable(() => {
			if (this.retryHandle !== undefined) {
				clearTimeout(this.retryHandle);
			}
		}));
		this.whenLoaded = this.load();
	}

	get camera(): IScratchCamera | undefined {
		return this._camera;
	}

	get isDirty(): boolean {
		return this.scene.dirtyVersion !== this.savedDirty || this.cameraDirty;
	}

	/** Content edits not on disk (the view position does not count), unless the board is in the trash. */
	get hasUnsavedEdits(): boolean {
		return !this.retired && this.scene.dirtyVersion !== this.savedDirty;
	}

	setRetired(retired: boolean): void {
		if (this.retired === retired) {
			return;
		}
		this.retired = retired;
		if (!retired && this.isDirty) {
			this.saveScheduler.schedule();
		}
	}

	/** The view's camera; saved lazily and never part of undo. */
	setCamera(camera: IScratchCamera): void {
		const c = this._camera;
		if (c && c.x === camera.x && c.y === camera.y && c.zoom === camera.zoom) {
			return;
		}
		this._camera = camera;
		if (this.loaded) {
			this.cameraDirty = true;
			this.cameraScheduler.schedule();
		}
	}

	private async load(): Promise<void> {
		const file = this.store.boardFile(this.id);
		let text: string | undefined;
		let readFailed = false;
		for (let attempt = 0; ; attempt++) {
			try {
				text = (await this.store.fileService.readFile(file)).value.toString();
				break;
			} catch (err) {
				if (isNotFound(err)) {
					break;
				}
				if (attempt >= 2) {
					// What is on disk is unknown: saves read it again first and write nothing until that works.
					this.store.logService.error(`[volt scratch] could not read board ${this.id}`, err);
					readFailed = true;
					break;
				}
				await timeout(150 * (attempt + 1));
			}
		}
		let doc = emptyBoardDocument(this.id, 0);
		if (text !== undefined) {
			let raw: unknown;
			let parsedOk = true;
			try {
				raw = JSON.parse(text);
			} catch (err) {
				parsedOk = false;
				this.store.logService.error(`[volt scratch] board ${this.id} is not valid JSON`, err);
			}
			if (parsedOk) {
				const parsed = parseBoardDocument(raw, this.id);
				doc = parsed.document;
				if (parsed.dropped > 0 || parsed.newerSchema) {
					// Keep the original before the first save writes the cleaned-up copy over it.
					if (!await this.store.backupBroken(file, text, parsed.newerSchema ? 'newer' : 'partial')) {
						this.readOnly = true;
						this.store.notifyUnreadable(this.id, undefined);
					}
				}
				this.lastWritten = text;
				this.sessionStartText = doc.elements.length ? text : undefined;
			} else {
				this.unreadableText = text;
				const backup = await this.store.backupBroken(file, text, 'unreadable');
				this.unreadableText = backup ? undefined : text;
				this.store.notifyUnreadable(this.id, backup);
			}
		}
		this.revision = doc.revision;
		this.updated = doc.updated;
		this._camera = doc.camera;
		this.scene.load(doc.elements, doc.settings, doc.runs, doc.deleted);
		this.savedDirty = this.scene.dirtyVersion;
		this.loaded = true;
		if (readFailed) {
			// Show what is on disk as soon as it can be read.
			this.reloadScheduler.schedule(1000);
		}
	}

	/** The board as it would be saved now. */
	toDocument(): IScratchBoardDocument {
		// What was last committed: a drag or draft in progress never reaches the disk.
		const view = this.scene.committedView();
		const deleted: Record<string, number> = {};
		for (const [id, at] of view.deleted) {
			deleted[id] = at;
		}
		return {
			schema: 1,
			id: this.id,
			elements: view.elements,
			deleted,
			settings: view.settings,
			camera: this._camera,
			runs: view.runs,
			revision: this.revision,
			updated: this.updated,
		};
	}

	/** Another window wrote the file: merge it in unless it is our own write. */
	scheduleReload(): void {
		if (this.loaded && !this.retired) {
			this.reloadScheduler.schedule();
		}
	}

	private async reload(): Promise<void> {
		await this.sequencer.queue(async () => {
			let text: string;
			try {
				text = (await this.store.fileService.readFile(this.store.boardFile(this.id))).value.toString();
			} catch {
				return;
			}
			if (text === this.lastWritten) {
				return;
			}
			let raw: unknown;
			try {
				raw = JSON.parse(text);
			} catch {
				return; // Half-written by another process; its rename will fire again.
			}
			const theirs = parseBoardDocument(raw, this.id).document;
			if (theirs.revision < this.revision && theirs.updated <= this.updated) {
				return;
			}
			if (this.scene.inTransaction) {
				// The user is mid-drag; try again once they let go (this text is not taken in yet).
				this.reloadScheduler.schedule(400);
				return;
			}
			const changed = this.scene.applyRemote(theirs.elements, theirs.deleted, theirs.updated > this.updated ? theirs.settings : undefined, theirs.runs);
			this.lastWritten = text;
			this.revision = Math.max(this.revision, theirs.revision);
			this.updated = Math.max(this.updated, theirs.updated);
			if (!this.readOnly && !documentCovers(theirs, this.scene.committedView())) {
				// Their copy lacks part of ours (two windows saved at once): write the union back.
				this.scene._markDirty();
			}
			if (changed) {
				this._onDidReloadFromDisk.fire();
			}
		});
	}

	/** Writes pending edits now; resolves false when edits are still not on disk. */
	async flush(): Promise<boolean> {
		await this.whenLoaded;
		this.saveScheduler.cancel();
		this.cameraScheduler.cancel();
		if (this.isDirty) {
			await this.save();
		} else {
			await this.sequencer.queue(() => Promise.resolve());
		}
		return !this.hasUnsavedEdits;
	}

	private save(): Promise<boolean> {
		return this.sequencer.queue(() => this.doSave());
	}

	/** One save: read the disk, merge another window's copy, write. Never writes over what it could not read. */
	private async doSave(): Promise<boolean> {
		if (!this.loaded || this.retired) {
			return true;
		}
		if (!this.isDirty) {
			return true;
		}
		if (this.readOnly) {
			return false;
		}
		const file = this.store.boardFile(this.id);
		const dirtyAtStart = this.scene.dirtyVersion;
		const contentEdit = dirtyAtStart !== this.savedDirty;
		const now = Date.now();
		let ours = this.toDocument();
		if (contentEdit) {
			ours = { ...ours, updated: now };
		}
		let diskText: string | undefined;
		try {
			diskText = (await this.store.fileService.readFile(file)).value.toString();
			this.missingSince = undefined;
		} catch (err) {
			if (!isNotFound(err)) {
				this.store.logService.warn(`[volt scratch] could not read board ${this.id} before saving; retrying`, err);
				this.scheduleRetry();
				return false;
			}
			if (this.lastWritten !== undefined) {
				// It was there: another window may have just moved it to the trash. Its list says so in a moment.
				this.missingSince ??= Date.now();
				if (Date.now() - this.missingSince < MISSING_FILE_GRACE_MS) {
					this.scheduleRetry();
					return false;
				}
			}
		}
		if (this.retired) {
			return true;
		}
		let remoteRefused = false;
		if (diskText !== undefined && diskText !== this.lastWritten) {
			let theirs: IScratchBoardDocument | undefined;
			try {
				theirs = parseBoardDocument(JSON.parse(diskText), this.id).document;
			} catch {
				if (!contentEdit) {
					// Only the view moved: not worth replacing a file we cannot read.
					this.cameraDirty = false;
					return true;
				}
				// Unreadable: keep it aside before writing over it.
				if (!await this.store.backupBroken(file, diskText, 'overwritten')) {
					this.store.logService.error(`[volt scratch] board ${this.id}: could not keep a copy of the file on disk; not saving over it`);
					this.scheduleRetry();
					return false;
				}
			}
			if (theirs) {
				ours = mergeBoardDocuments(ours, theirs);
				if (this.scene.inTransaction) {
					// The file gets their part now; the scene takes it once the gesture ends.
					remoteRefused = true;
				} else {
					this.scene.applyRemote(theirs.elements, theirs.deleted, undefined, theirs.runs);
				}
			}
		} else if (this.unreadableText !== undefined) {
			const backup = await this.store.backupBroken(file, this.unreadableText, 'unreadable');
			if (!backup) {
				this.store.logService.error(`[volt scratch] board ${this.id}: could not keep a copy of the unreadable file; not saving over it`);
				this.scheduleRetry();
				return false;
			}
			this.unreadableText = undefined;
		}
		const previousText = this.lastWritten;
		const next: IScratchBoardDocument = { ...ours, revision: Math.max(this.revision, ours.revision) + 1 };
		const content = serializeBoardDocument(next, now);
		try {
			await this.store.writeAtomic(file, content);
		} catch (err) {
			this.store.logService.error(`[volt scratch] could not save board ${this.id}; retrying`, err);
			this.scheduleRetry();
			return false;
		}
		this.failures = 0;
		// Unset after a refused merge, so the next reload or save takes their part in.
		this.lastWritten = remoteRefused ? undefined : content;
		if (remoteRefused) {
			this.reloadScheduler.schedule(400);
		}
		this.revision = next.revision;
		this.updated = next.updated;
		this.savedDirty = dirtyAtStart;
		this.cameraDirty = false;
		if (contentEdit) {
			this.store.noteEdited(this.id, this.scene.getElements());
			if (this.lastSnapshotAt === 0 && this.sessionStartText && this.sessionStartText === previousText) {
				// The first edit of a session: the board as it was opened becomes a version to go back to.
				void this.writeSnapshot(this.sessionStartText, now - 1);
				this.lastSnapshotAt = now;
			} else if (this.snapshotEveryMs() > 0 && now - this.lastSnapshotAt >= this.snapshotEveryMs()) {
				this.lastSnapshotAt = now;
				void this.writeSnapshot(content, now);
			}
			this.sessionStartText = undefined;
		}
		if (this.isDirty) {
			// Edits that came in while this write ran.
			this.saveScheduler.schedule();
		}
		return true;
	}

	private scheduleRetry(): void {
		this.failures++;
		if (this.retryHandle !== undefined) {
			return;
		}
		const delay = Math.min(MAX_SAVE_RETRY_MS, 500 * 2 ** Math.min(this.failures, 6));
		this.retryHandle = setTimeout(() => {
			this.retryHandle = undefined;
			void this.save();
		}, delay);
	}

	private snapshotEveryMs(): number {
		return this.store.snapshotEveryMs?.() ?? 10 * 60_000;
	}

	private async writeSnapshot(content: string, now: number): Promise<void> {
		const dir = joinPath(this.store.root, 'snapshots', this.id);
		try {
			await this.store.writeAtomic(joinPath(dir, `${now}.json`), content);
			const stat = await this.store.fileService.resolve(dir);
			const names = (stat.children ?? []).map(c => c.name).filter(n => /^\d+\.json$/.test(n)).sort((a, b) => parseInt(b) - parseInt(a));
			for (const name of names.slice(SNAPSHOTS_KEPT)) {
				await this.store.fileService.del(joinPath(dir, name)).catch(() => undefined);
			}
		} catch (err) {
			this.store.logService.warn(`[volt scratch] could not keep a snapshot of board ${this.id}`, err);
		}
	}

	/** Replaces the board with a saved snapshot; the current state becomes one undo step away. */
	restore(doc: IScratchBoardDocument): void {
		this.scene.transact('Restore version', tx => {
			for (const el of [...this.scene.getElements()]) {
				if (!doc.elements.some(d => d.id === el.id)) {
					tx.remove(el.id);
				}
			}
			for (const el of doc.elements) {
				tx.replace({ ...el, version: (this.scene.get(el.id)?.version ?? el.version) + 1, updated: Date.now() });
			}
			tx.reorder(doc.elements.map(e => e.id));
			tx.setSettings(doc.settings);
		});
	}
}

class ScratchBoardService extends Disposable implements IScratchBoardService {

	declare readonly _serviceBrand: undefined;

	private readonly root: URI;
	private readonly indexFile: URI;
	private _index: IScratchIndex = emptyIndex();
	private indexLastWritten: string | undefined;
	private indexDirty = false;
	private readonly indexSequencer = new Sequencer();
	private readonly trashing = new Set<string>();
	private readonly indexScheduler: RunOnceScheduler;
	private readonly indexReloadScheduler: RunOnceScheduler;
	private readonly models = new Map<string, { readonly model: ScratchBoardModel; refs: number; release?: ReturnType<typeof setTimeout> }>();
	private readonly assetUrls = new Map<string, Promise<string | undefined>>();
	private readonly atomic: boolean;
	readonly whenReady: Promise<void>;

	private readonly _onDidChangeIndex = this._register(new Emitter<void>());
	readonly onDidChangeIndex = this._onDidChangeIndex.event;

	private readonly storeApi: IBoardStore;

	constructor(
		@IFileService private readonly fileService: IFileService,
		@IEnvironmentService environmentService: IEnvironmentService,
		@ILogService private readonly logService: ILogService,
		@INotificationService private readonly notificationService: INotificationService,
		@ILifecycleService lifecycleService: ILifecycleService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
	) {
		super();
		this.root = joinPath(environmentService.userRoamingDataHome, ROOT);
		this.indexFile = joinPath(this.root, INDEX_FILE);
		this.atomic = fileService.hasCapability(this.root, FileSystemProviderCapabilities.FileAtomicWrite);
		this.indexScheduler = this._register(new RunOnceScheduler(() => void this.saveIndex(), INDEX_SAVE_DELAY_MS));
		this.indexReloadScheduler = this._register(new RunOnceScheduler(() => void this.reloadIndex(), 150));
		this.storeApi = {
			fileService,
			logService,
			root: this.root,
			boardFile: id => this.boardFile(id),
			writeAtomic: (file, content) => this.writeAtomic(file, content),
			backupBroken: (file, content, reason) => this.backupBroken(file, content, reason),
			noteEdited: (id, elements) => this.noteEdited(id, elements),
			notifyUnreadable: (id, backup) => this.notifyUnreadable(id, backup),
			snapshotEveryMs: () => readSnapshotMinutes(this.configurationService.getValue(SCRATCH_SNAPSHOT_MINUTES_SETTING)) * 60_000,
		};
		this.whenReady = this.init();
		// A board trashed here or in another window stops saving; one brought back saves again.
		this._register(this.onDidChangeIndex(() => {
			for (const [id, entry] of this.models) {
				entry.model.setRetired(this.trashing.has(id) || this._index.boards.some(b => b.id === id && b.deleted));
			}
		}));
		this._register(lifecycleService.onWillShutdown(e => e.join(this.flushForShutdown(), { id: 'voltScratchBoards', label: localize('voltScratch.saving', "Saving Scratch boards") })));
		this._register(toDisposable(() => {
			for (const url of this.assetUrls.values()) {
				void url.then(u => u && URL.revokeObjectURL(u));
			}
			for (const entry of this.models.values()) {
				if (entry.release) {
					clearTimeout(entry.release);
				}
				entry.model.dispose();
			}
		}));
	}

	private boardFile(id: string): URI {
		return joinPath(this.root, 'boards', `${id}.json`);
	}

	private async init(): Promise<void> {
		try {
			await this.fileService.createFolder(joinPath(this.root, 'boards'));
		} catch {
			// Exists already.
		}
		await this.reloadIndex();
		// Another window edits the list or a board we have open: merge it in.
		this._register(this.fileService.watch(this.root, { recursive: true, excludes: ['**/snapshots/**', '**/assets/**', '**/trash/**', '**/broken/**'] }));
		this._register(this.fileService.onDidFilesChange(e => {
			if (e.contains(this.indexFile)) {
				this.indexReloadScheduler.schedule();
			}
			for (const [id, entry] of this.models) {
				if (e.contains(this.boardFile(id))) {
					entry.model.scheduleReload();
				}
			}
		}));
		void this.pruneTrash();
	}

	get index(): IScratchIndex {
		return this._index;
	}

	getBoard(id: string): IScratchBoardMeta | undefined {
		return this._index.boards.find(b => b.id === id && !b.deleted);
	}

	getFolder(id: string): IScratchFolder | undefined {
		return this._index.folders.find(f => f.id === id && !f.deleted);
	}

	private setIndex(next: IScratchIndex): void {
		if (next === this._index) {
			return;
		}
		this._index = next;
		this.indexDirty = true;
		this.indexScheduler.schedule();
		this._onDidChangeIndex.fire();
	}

	private async reloadIndex(): Promise<void> {
		await this.indexSequencer.queue(async () => {
			let text: string | undefined;
			try {
				text = (await this.fileService.readFile(this.indexFile)).value.toString();
			} catch (err) {
				if (!isNotFound(err)) {
					this.logService.error('[volt scratch] could not read the board list', err);
				}
			}
			if (text === undefined || text === this.indexLastWritten) {
				if (text === undefined && !this._index.boards.length) {
					await this.rebuildIndexFromFiles();
				}
				return;
			}
			let disk: IScratchIndex;
			try {
				disk = parseIndex(JSON.parse(text));
			} catch (err) {
				this.logService.error('[volt scratch] the board list is not valid JSON; rebuilding it from the boards', err);
				await this.backupBroken(this.indexFile, text, 'index');
				await this.rebuildIndexFromFiles();
				return;
			}
			const merged = this._index.boards.length || this._index.folders.length ? mergeIndexes(this._index, disk) : disk;
			this.indexLastWritten = text;
			this._index = merged;
			// A board file with no entry (lost index, or written by a crash) gets one back.
			await this.adoptOrphans();
			this._onDidChangeIndex.fire();
		});
	}

	/** Board files not in the list come back as entries, so a lost index never hides a board. */
	private async adoptOrphans(): Promise<void> {
		let names: string[] = [];
		try {
			const stat = await this.fileService.resolve(joinPath(this.root, 'boards'));
			names = (stat.children ?? []).filter(c => c.isFile && c.name.endsWith('.json')).map(c => c.name.slice(0, -5));
		} catch {
			return;
		}
		// A file whose entry says "deleted" was saved again after the delete (another window): it comes back.
		const known = new Map(this._index.boards.map(b => [b.id, b]));
		const missing = names.filter(id => /^[A-Za-z0-9_-]+$/.test(id) && !this.trashing.has(id) && (!known.has(id) || known.get(id)!.deleted));
		if (!missing.length) {
			return;
		}
		const now = Date.now();
		const mtimes = new Map<string, number>();
		for (const id of missing) {
			try {
				mtimes.set(id, (await this.fileService.stat(this.boardFile(id))).mtime);
			} catch { /* keep now */ }
		}
		// From the list as it is now: it may have changed while the files were looked at.
		let boards = [...this._index.boards];
		for (const id of missing) {
			const entry = boards.find(b => b.id === id);
			if (entry?.deleted) {
				boards = boards.map(b => b.id === id ? { ...b, deleted: undefined, updated: now } : b);
			} else if (!entry) {
				const edited = mtimes.get(id) ?? now;
				// `updated: 0`: any real entry for it (another window's list) wins the merge.
				boards.push({ id, title: localize('voltScratch.recovered', "Recovered board"), folderId: null, pinned: false, archived: false, created: edited, edited, updated: 0 });
			}
		}
		this._index = { ...this._index, boards, updated: now };
		this.indexDirty = true;
		this.indexScheduler.schedule();
	}

	private async rebuildIndexFromFiles(): Promise<void> {
		await this.adoptOrphans();
		this._onDidChangeIndex.fire();
	}

	private async saveIndex(): Promise<void> {
		await this.indexSequencer.queue(async () => {
			if (!this.indexDirty) {
				return;
			}
			this.indexDirty = false;
			let diskText: string | undefined;
			try {
				diskText = (await this.fileService.readFile(this.indexFile)).value.toString();
			} catch (err) {
				if (!isNotFound(err)) {
					// Writing now could drop another window's entries: try again shortly.
					this.logService.warn('[volt scratch] could not read the board list before saving it; retrying', err);
					this.indexDirty = true;
					this.indexScheduler.schedule(2000);
					return;
				}
			}
			if (diskText !== undefined && diskText !== this.indexLastWritten) {
				try {
					this._index = mergeIndexes(this._index, parseIndex(JSON.parse(diskText)));
					this._onDidChangeIndex.fire();
				} catch {
					await this.backupBroken(this.indexFile, diskText, 'index');
				}
			}
			const content = JSON.stringify(this._index, null, '\t');
			if (content === diskText) {
				this.indexLastWritten = content;
				return;
			}
			try {
				await this.writeAtomic(this.indexFile, content);
				this.indexLastWritten = content;
			} catch (err) {
				this.logService.error('[volt scratch] could not save the board list; retrying', err);
				this.indexDirty = true;
				this.indexScheduler.schedule(2000);
			}
		});
	}

	private async writeAtomic(file: URI, content: string): Promise<void> {
		await this.fileService.writeFile(file, VSBuffer.fromString(content), this.atomic ? { atomic: { postfix: '.vsctmp' } } : undefined);
	}

	private async backupBroken(file: URI, content: string, reason: string): Promise<URI | undefined> {
		const name = file.path.split('/').pop() ?? 'file.json';
		const target = joinPath(this.root, 'broken', `${Date.now()}-${reason}-${name}`);
		try {
			await this.fileService.writeFile(target, VSBuffer.fromString(content));
			this.logService.warn(`[volt scratch] kept a copy of ${name} at ${target.toString()}`);
			return target;
		} catch (err) {
			this.logService.error(`[volt scratch] could not keep a copy of ${name}`, err);
			return undefined;
		}
	}

	private notifyUnreadable(id: string, backup: URI | undefined): void {
		const title = this.getBoard(id)?.title || id;
		this.notificationService.notify({
			severity: Severity.Warning,
			message: backup
				? localize('voltScratch.unreadableKept', "Scratch board \"{0}\" could not be read. A copy of the file was kept in {1}.", title, backup.fsPath)
				: localize('voltScratch.unreadable', "Scratch board \"{0}\" could not be read. It will not be overwritten until a copy can be kept.", title),
		});
	}

	private noteEdited(id: string, elements: readonly ScratchElement[]): void {
		const board = this._index.boards.find(b => b.id === id);
		if (!board) {
			return;
		}
		const excerpt = boardExcerpt(elements);
		this.setIndex({
			...this._index,
			// Content edits change `edited` only; `updated` is for the entry itself (title, pin...).
			boards: this._index.boards.map(b => b.id === id ? { ...b, edited: Date.now(), excerpt, elementCount: elements.length } : b),
		});
	}

	async createBoard(options: { readonly folderId?: string | null; readonly projectId?: string; readonly title?: string; readonly document?: Partial<Pick<IScratchBoardDocument, 'elements' | 'settings' | 'camera'>> } = {}): Promise<string> {
		await this.whenReady;
		const id = newElementId();
		const now = Date.now();
		const settings = readNewBoardSettings(key => this.configurationService.getValue(key));
		const doc: IScratchBoardDocument = { ...emptyBoardDocument(id, now), settings, ...options.document, revision: 1 };
		await this.writeAtomic(this.boardFile(id), serializeBoardDocument(doc, now));
		const meta: IScratchBoardMeta = {
			id,
			title: options.title ?? nextUntitledName(this._index),
			folderId: options.folderId ?? null,
			projectId: options.projectId,
			pinned: false,
			archived: false,
			created: now,
			edited: now,
			updated: now,
			excerpt: doc.elements.length ? boardExcerpt(doc.elements) : undefined,
			elementCount: doc.elements.length,
		};
		this.setIndex({ ...this._index, boards: [...this._index.boards, meta], updated: now });
		return id;
	}

	renameBoard(id: string, title: string): void {
		this.setIndex(updateBoard(this._index, id, { title: title.trim() }));
	}

	setBoardPinned(id: string, pinned: boolean): void {
		this.setIndex(updateBoard(this._index, id, { pinned, archived: pinned ? false : this.getBoard(id)?.archived ?? false }));
	}

	setBoardArchived(id: string, archived: boolean): void {
		this.setIndex(updateBoard(this._index, id, { archived, pinned: archived ? false : this.getBoard(id)?.pinned ?? false }));
	}

	moveBoard(id: string, folderId: string | null): void {
		this.setIndex(updateBoard(this._index, id, { folderId }));
	}

	async duplicateBoard(id: string): Promise<string | undefined> {
		const source = this.getBoard(id);
		const doc = await this.readBoardDocument(id);
		if (!source || !doc) {
			return undefined;
		}
		return this.createBoard({
			folderId: source.folderId,
			projectId: source.projectId,
			title: localize('voltScratch.copyTitle', "{0} copy", source.title || nextUntitledName(this._index)),
			document: { elements: doc.elements, settings: doc.settings, camera: doc.camera },
		});
	}

	async deleteBoard(id: string): Promise<(() => Promise<boolean>) | undefined> {
		const meta = this.getBoard(id);
		if (!meta) {
			return undefined;
		}
		const open = this.models.get(id);
		if (open) {
			if (!await open.model.flush()) {
				// The trash would get a copy without the latest edits.
				this.logService.error(`[volt scratch] board ${id} has edits that could not be saved; not moving it to the trash`);
				return undefined;
			}
			// A save landing after the move would put the file back.
			this.trashing.add(id);
			open.model.setRetired(true);
		}
		const trashed = joinPath(this.root, 'trash', `${Date.now()}-${id}.json`);
		try {
			await this.fileService.move(this.boardFile(id), trashed, true);
		} catch (err) {
			if (!isNotFound(err)) {
				this.logService.error(`[volt scratch] could not move board ${id} to the trash`, err);
				this.trashing.delete(id);
				open?.model.setRetired(false);
				return undefined;
			}
		}
		this.setIndex(updateBoard(this._index, id, { deleted: true, pinned: false }));
		this.trashing.delete(id);
		return async () => {
			try {
				await this.fileService.move(trashed, this.boardFile(id), false);
			} catch (err) {
				// Another window saved the board again meanwhile: keep what both copies hold.
				if (!await this.mergeBoardFiles(this.boardFile(id), trashed)) {
					this.logService.error(`[volt scratch] could not restore board ${id}`, err);
					return false;
				}
			}
			this.setIndex(updateBoard(this._index, id, { deleted: undefined, pinned: meta.pinned, archived: meta.archived }));
			return true;
		};
	}

	/** Writes the union of two copies of a board into `target` and removes `source`. */
	private async mergeBoardFiles(target: URI, source: URI): Promise<boolean> {
		try {
			const id = target.path.split('/').pop()!.replace(/\.json$/, '');
			const read = async (file: URI) => parseBoardDocument(JSON.parse((await this.fileService.readFile(file)).value.toString()), id).document;
			const [current, restored] = await Promise.all([read(target), read(source)]);
			await this.writeAtomic(target, serializeBoardDocument(mergeBoardDocuments(current, restored), Date.now()));
			await this.fileService.del(source).catch(() => undefined);
			return true;
		} catch (err) {
			this.logService.error('[volt scratch] could not merge two copies of a board', err);
			return false;
		}
	}

	createFolder(name: string): string {
		const id = newElementId();
		const now = Date.now();
		this.setIndex({ ...this._index, folders: [...this._index.folders, { id, name: name.trim() || localize('voltScratch.newFolder', "New Folder"), created: now, updated: now }], updated: now });
		return id;
	}

	renameFolder(id: string, name: string): void {
		this.setIndex(updateFolder(this._index, id, { name: name.trim() }));
	}

	deleteFolder(id: string): void {
		this.setIndex(deleteFolder(this._index, id));
	}

	setFolderCollapsed(id: string, collapsed: boolean): void {
		const folder = this.getFolder(id);
		if (folder && !!folder.collapsed !== collapsed) {
			this.setIndex(updateFolder(this._index, id, { collapsed: collapsed || undefined }));
		}
	}

	setLastOpened(id: string): void {
		if (this._index.lastOpened !== id) {
			this.setIndex({ ...this._index, lastOpened: id, updated: Date.now() });
		}
	}

	async acquireModel(id: string): Promise<IReference<ScratchBoardModel>> {
		await this.whenReady;
		let entry = this.models.get(id);
		if (!entry) {
			entry = { model: new ScratchBoardModel(id, this.storeApi), refs: 0 };
			this.models.set(id, entry);
		}
		if (entry.release) {
			clearTimeout(entry.release);
			entry.release = undefined;
		}
		entry.refs++;
		const held = entry;
		await held.model.whenLoaded;
		let released = false;
		return {
			object: held.model,
			dispose: () => {
				if (released) {
					return;
				}
				released = true;
				held.refs--;
				if (held.refs > 0) {
					return;
				}
				void held.model.flush();
				// Kept a little while: switching back and forth between boards stays instant. A model
				// whose edits are not on disk yet is kept (and retried) until they are.
				const scheduleRelease = () => {
					held.release = setTimeout(() => {
						held.release = undefined;
						if (held.refs !== 0 || this.models.get(id) !== held) {
							return;
						}
						void held.model.flush().then(saved => {
							if (held.refs !== 0 || this.models.get(id) !== held) {
								return;
							}
							if (!saved) {
								scheduleRelease();
								return;
							}
							this.models.delete(id);
							held.model.dispose();
						});
					}, 60_000);
				};
				scheduleRelease();
			},
		};
	}

	async putAsset(bytes: Uint8Array, mime: string): Promise<string> {
		const hash = (await sha256Hex(bytes)).slice(0, 32);
		const assetId = `${hash}.${extensionForMime(mime)}`;
		const file = joinPath(this.root, 'assets', assetId);
		if (!(await this.fileService.exists(file))) {
			await this.fileService.writeFile(file, VSBuffer.wrap(bytes), this.atomic ? { atomic: { postfix: '.vsctmp' } } : undefined);
		}
		return assetId;
	}

	async readAsset(assetId: string): Promise<VSBuffer | undefined> {
		if (!/^[A-Za-z0-9._-]+$/.test(assetId)) {
			return undefined;
		}
		try {
			return (await this.fileService.readFile(joinPath(this.root, 'assets', assetId))).value;
		} catch {
			return undefined;
		}
	}

	assetUrl(assetId: string, mime: string): Promise<string | undefined> {
		let url = this.assetUrls.get(assetId);
		if (!url) {
			url = this.readAsset(assetId).then(buffer => buffer ? URL.createObjectURL(new Blob([buffer.buffer as Uint8Array<ArrayBuffer>], { type: mime })) : undefined);
			this.assetUrls.set(assetId, url);
			// A missing file may arrive later (another window still writing it).
			void url.then(u => { if (!u) { this.assetUrls.delete(assetId); } });
		}
		return url;
	}

	async readBoardDocument(id: string): Promise<IScratchBoardDocument | undefined> {
		const open = this.models.get(id);
		if (open) {
			return open.model.toDocument();
		}
		try {
			const text = (await this.fileService.readFile(this.boardFile(id))).value.toString();
			return parseBoardDocument(JSON.parse(text), id).document;
		} catch {
			return undefined;
		}
	}

	async findBoardForSession(sessionId: string): Promise<string | undefined> {
		await this.whenReady;
		for (const [id, entry] of this.models) {
			if (this.getBoard(id) && entry.model.scene.runs.some(r => r.sessionId === sessionId)) {
				return id;
			}
		}
		// Boards not open in this window: the most recently edited first.
		const recent = this._index.boards.filter(b => !b.deleted && !this.models.has(b.id)).sort((a, b) => (b.edited || b.created) - (a.edited || a.created)).slice(0, 40);
		for (const board of recent) {
			const doc = await this.readBoardDocument(board.id);
			if (doc?.runs.some(r => r.sessionId === sessionId)) {
				return board.id;
			}
		}
		return undefined;
	}

	async listSnapshots(id: string): Promise<IScratchSnapshot[]> {
		try {
			const stat = await this.fileService.resolve(joinPath(this.root, 'snapshots', id));
			return (stat.children ?? [])
				.map(c => c.name)
				.filter(n => /^\d+\.json$/.test(n))
				.map(name => ({ name, time: parseInt(name, 10) }))
				.sort((a, b) => b.time - a.time);
		} catch {
			return [];
		}
	}

	async restoreSnapshot(id: string, name: string): Promise<boolean> {
		if (!/^\d+\.json$/.test(name)) {
			return false;
		}
		let doc: IScratchBoardDocument;
		try {
			const text = (await this.fileService.readFile(joinPath(this.root, 'snapshots', id, name))).value.toString();
			doc = parseBoardDocument(JSON.parse(text), id).document;
		} catch {
			return false;
		}
		const ref = await this.acquireModel(id);
		try {
			ref.object.restore(doc);
			await ref.object.flush();
		} finally {
			ref.dispose();
		}
		return true;
	}

	async flush(): Promise<void> {
		await Promise.all([...this.models.values()].map(entry => entry.model.flush().catch(err => this.logService.error('[volt scratch] flush failed', err))));
		this.indexScheduler.cancel();
		if (this.indexDirty) {
			await this.saveIndex();
		} else {
			// A save of the list may be under way.
			await this.indexSequencer.queue(() => Promise.resolve());
		}
	}

	/** Saves everything; edits that still could not be written are kept beside the boards. */
	private async flushForShutdown(): Promise<void> {
		await this.flush();
		for (const [id, entry] of this.models) {
			if (entry.model.hasUnsavedEdits) {
				await this.backupBroken(this.boardFile(id), serializeBoardDocument(entry.model.toDocument(), Date.now()), 'unsaved');
			}
		}
	}

	private async pruneTrash(): Promise<void> {
		try {
			const stat = await this.fileService.resolve(joinPath(this.root, 'trash'));
			const now = Date.now();
			const keepMs = readTrashDays(this.configurationService.getValue(SCRATCH_TRASH_DAYS_SETTING)) * DAY_MS;
			for (const child of stat.children ?? []) {
				const at = parseInt(child.name, 10);
				if (Number.isFinite(at) && now - at > keepMs) {
					await this.fileService.del(child.resource).catch(() => undefined);
				}
			}
		} catch {
			// No trash yet.
		}
	}
}

/** First words on the board, for search and the list's subtitle. */
function boardExcerpt(elements: readonly ScratchElement[]): string | undefined {
	const parts: string[] = [];
	let length = 0;
	const sorted = [...elements].sort((a, b) => (a.y - b.y) || (a.x - b.x));
	for (const el of sorted) {
		let text = '';
		if (isRichText(el)) {
			text = richTextExcerpt(el.html, 120);
		} else if ((el.type === 'shape' || el.type === 'arrow' || el.type === 'line' || el.type === 'icon') && el.label) {
			text = richTextExcerpt(el.label.html, 60);
		} else if (el.type === 'frame') {
			text = el.name;
		}
		if (text) {
			parts.push(text);
			length += text.length;
			if (length > 200) {
				break;
			}
		}
	}
	const joined = parts.join(' · ');
	return joined ? (joined.length > 200 ? `${joined.slice(0, 199)}…` : joined) : undefined;
}

registerSingleton(IScratchBoardService, ScratchBoardService, InstantiationType.Delayed);
