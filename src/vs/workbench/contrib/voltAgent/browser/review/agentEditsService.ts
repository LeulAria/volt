/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { RunOnceScheduler } from '../../../../../base/common/async.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { LcsDiff } from '../../../../../base/common/diff/diff.js';
import { toErrorMessage } from '../../../../../base/common/errorMessage.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable, DisposableStore, IReference, toDisposable } from '../../../../../base/common/lifecycle.js';
import { ResourceMap } from '../../../../../base/common/map.js';
import { Schemas } from '../../../../../base/common/network.js';
import { basename } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { EditOperation, ISingleEditOperation } from '../../../../../editor/common/core/editOperation.js';
import { Position } from '../../../../../editor/common/core/position.js';
import { Range } from '../../../../../editor/common/core/range.js';
import { IDocumentDiff } from '../../../../../editor/common/diff/documentDiffProvider.js';
import { DetailedLineRangeMapping } from '../../../../../editor/common/diff/rangeMapping.js';
import { ILanguageService } from '../../../../../editor/common/languages/language.js';
import { ITextModel } from '../../../../../editor/common/model.js';
import { IEditorWorkerService } from '../../../../../editor/common/services/editorWorker.js';
import { IModelService } from '../../../../../editor/common/services/model.js';
import { IResolvedTextEditorModel, ITextModelContentProvider, ITextModelService } from '../../../../../editor/common/services/resolverService.js';
import { localize } from '../../../../../nls.js';
import { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { InstantiationType, registerSingleton } from '../../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { IVoltGitService } from '../../../../../platform/voltGit/common/voltGit.js';
import { SaveReason } from '../../../../common/editor.js';
import { IAgentRuntimeService } from '../../../../services/voltRuntime/common/runtime.js';
import { ITextFileService } from '../../../../services/textfile/common/textfiles.js';

export const IAgentEditsService = createDecorator<IAgentEditsService>('voltAgentEdits');

/** A file an agent changed that the user has not kept or undone yet. */
export interface IAgentPendingFile {
	readonly uri: URI;
	readonly sessionId: string;
	/** The text the user has accepted so far: what the file looked like before the agent, plus kept hunks. */
	readonly baselineUri: URI;
	readonly kind: 'added' | 'modified' | 'deleted';
	readonly additions: number;
	readonly deletions: number;
	/** Hunks between the baseline and the file, in file order. Empty until the first diff lands. */
	readonly changes: readonly DetailedLineRangeMapping[];
	/** No line diff: Undo writes the saved bytes back. */
	readonly binary?: boolean;
	/** The agent moved the file here from this path (listed on its own as deleted). */
	readonly renamedFrom?: URI;
	/**
	 * Set when another chat changed the file after this one: the diff runs against this frozen
	 * copy of the file, so it shows only this chat's changes. Such a file is not decorated inline.
	 */
	readonly modifiedUri?: URI;
}

export interface IAgentBaselineOptions {
	/** What the agent left in the file. Undo compares the file with it to find edits made since. */
	readonly agentText?: string;
	readonly renamedFrom?: URI;
}

/** Where a binary file's pre-agent bytes live: a blob in a snapshot repo. */
export interface IAgentBinaryBaseline {
	readonly repoRoot: string;
	readonly blob: string;
	/** Repo-relative path, for checkout filters. */
	readonly path: string;
}

export interface IAgentEditResolution {
	readonly sessionId: string;
	readonly uri: URI;
	readonly outcome: 'kept' | 'undone';
}

export interface IAgentEditsService {
	readonly _serviceBrand: undefined;
	/** Fires with the file whose pending state changed. */
	readonly onDidChange: Event<URI>;
	/** The user kept or undid a whole file. */
	readonly onDidResolve: Event<IAgentEditResolution>;
	/** Every pending file of a chat (all chats when omitted). A file two chats changed is listed once per chat. */
	getPendingFiles(sessionId?: string): readonly IAgentPendingFile[];
	/** The chat's entry for `uri`; without a chat, the newest entry (the one whose diff runs against the live file). */
	getPendingFile(uri: URI, sessionId?: string): IAgentPendingFile | undefined;
	getBaselineModel(uri: URI): ITextModel | undefined;
	/**
	 * Start tracking `uri` for `sessionId` with the text it had before the agent's edit
	 * (undefined when the agent created it). Ignored while the chat already has pending edits in
	 * the file: the oldest unreviewed text stays the baseline. When another chat has pending
	 * edits in the file, that chat's entry is frozen at `before`, so neither chat is credited
	 * with, or undoes, the other's changes.
	 */
	recordBaseline(sessionId: string, uri: URI, before: string | undefined, options?: IAgentBaselineOptions): void;
	/** Start tracking a binary file; `baseline` undefined when the agent created it. */
	recordBinaryBaseline(sessionId: string, uri: URI, baseline: IAgentBinaryBaseline | undefined, options?: { readonly renamedFrom?: URI }): void;
	keepHunk(uri: URI, change: DetailedLineRangeMapping, sessionId?: string): Promise<boolean>;
	undoHunk(uri: URI, change: DetailedLineRangeMapping, sessionId?: string): Promise<boolean>;
	keepFile(uri: URI, sessionId?: string): Promise<void>;
	/**
	 * Puts the file back as it was before the chat's agent changed it. Edits made since (by the
	 * user or another chat) are kept when they merge; otherwise the user is asked first. False
	 * when nothing was undone (cancelled, or the write failed: the entry then stays pending).
	 */
	undoFile(uri: URI, sessionId?: string): Promise<boolean>;
	keepAll(sessionId: string): Promise<void>;
	undoAll(sessionId: string): Promise<void>;
	/** Resolves once every pending diff reflects the latest file text. */
	whenSettled(): Promise<void>;
}

const STORAGE_KEY = 'volt.agent.pendingEdits';
/** Larger texts stay in memory for this window only. */
const PERSIST_LIMIT = 1024 * 1024;
const FROZEN_SUFFIX = '/frozen';

interface IStoredEntry {
	readonly sessionId: string;
	readonly uri: string;
	/** null when the agent created the file. */
	readonly baseline: string | null;
	/** What the agent left; null when it deleted the file. */
	readonly agentText?: string | null;
	/** Present when another chat took over the file; null when the file was gone at that point. */
	readonly frozen?: string | null;
	readonly renamedFrom?: string;
	/** A binary entry; null baseline when the agent created the file. */
	readonly binary?: IAgentBinaryBaseline | null;
}

/** `sessionId` keeps two chats' baselines of one file apart. */
export function agentBaselineUri(uri: URI, sessionId?: string): URI {
	return URI.from({ scheme: Schemas.voltAgentBaseline, path: uri.path, query: uri.toString(), fragment: sessionId ?? '' });
}

function agentFrozenUri(uri: URI, sessionId: string): URI {
	return URI.from({ scheme: Schemas.voltAgentBaseline, path: uri.path, query: uri.toString(), fragment: `${sessionId}${FROZEN_SUFFIX}` });
}

export function fileUriFromBaseline(uri: URI): URI | undefined {
	return uri.scheme === Schemas.voltAgentBaseline && uri.query ? URI.parse(uri.query) : undefined;
}

/** The chat a baseline (or frozen) URI belongs to. */
export function sessionFromBaseline(uri: URI): string | undefined {
	if (uri.scheme !== Schemas.voltAgentBaseline || !uri.fragment) {
		return undefined;
	}
	return uri.fragment.endsWith(FROZEN_SUFFIX) ? uri.fragment.slice(0, -FROZEN_SUFFIX.length) : uri.fragment;
}

interface IEntry extends Disposable {
	readonly sessionId: string;
	readonly uri: URI;
	readonly existed: boolean;
	readonly renamedFrom: URI | undefined;
	/** Another chat changed the file after this one. */
	readonly covered: boolean;
	/** Writing an undo: identical diffs must not drop the entry before the write lands. */
	busy: boolean;
	toPendingFile(): IAgentPendingFile | undefined;
	whenSettled(): Promise<void>;
}

class PendingEntry extends Disposable implements IEntry {

	readonly baseline: ITextModel;
	readonly baselineUri: URI;
	private modifiedRef: IReference<IResolvedTextEditorModel> | undefined;
	private readonly liveStore = this._register(new DisposableStore());
	private frozenModel: ITextModel | undefined;
	/** Frozen while the file did not exist. */
	private frozenGone = false;
	private diff: IDocumentDiff | undefined;
	private deleted = false;
	private readonly scheduler: RunOnceScheduler;
	private computing: Promise<void> | undefined;
	private dirtyAgain = false;
	/** What the agent left in the file at the end of its turn; null when it deleted the file. */
	agentText: string | null | undefined;
	busy = false;

	constructor(
		readonly sessionId: string,
		readonly uri: URI,
		/** False when the agent created the file: undo deletes it. */
		readonly existed: boolean,
		baselineText: string,
		readonly renamedFrom: URI | undefined,
		private readonly onChanged: (entry: PendingEntry) => void,
		private readonly modelService: IModelService,
		private readonly languageService: ILanguageService,
		private readonly textModelService: ITextModelService,
		private readonly editorWorkerService: IEditorWorkerService,
		private readonly logService: ILogService,
	) {
		super();
		this.baselineUri = agentBaselineUri(uri, sessionId);
		modelService.getModel(this.baselineUri)?.dispose();
		this.baseline = this._register(modelService.createModel(baselineText, languageService.createByFilepathOrFirstLine(uri), this.baselineUri, false));
		this.scheduler = this._register(new RunOnceScheduler(() => void this.refresh(), 60));
		this._register(this.baseline.onDidChangeContent(() => this.scheduler.schedule()));
		this._register(toDisposable(() => {
			this.modifiedRef?.dispose();
			this.frozenModel?.dispose();
		}));
	}

	/** The live file model, or the frozen copy once another chat took over the file. */
	get modified(): ITextModel | undefined {
		return this.frozenModel ?? this.modifiedRef?.object.textEditorModel;
	}

	get live(): ITextModel | undefined {
		return this.frozenModel ? undefined : this.modifiedRef?.object.textEditorModel;
	}

	get covered(): boolean {
		return !!this.frozenModel || this.frozenGone;
	}

	/** The text this entry's diff ends at: the frozen copy, or the file; undefined when gone. */
	get currentText(): string | undefined {
		if (this.frozenGone) {
			return undefined;
		}
		if (this.frozenModel) {
			return this.frozenModel.getValue();
		}
		return this.deleted ? undefined : this.modifiedRef?.object.textEditorModel.getValue();
	}

	get isDeleted(): boolean {
		return this.frozenGone || (!this.frozenModel && this.deleted);
	}

	get changes(): readonly DetailedLineRangeMapping[] {
		return this.diff?.changes ?? [];
	}

	/** True once a diff ran and the file matches its baseline. */
	get identical(): boolean {
		return !this.isDeleted && !!this.diff?.identical;
	}

	stats(): { additions: number; deletions: number } {
		if (this.isDeleted) {
			return { additions: 0, deletions: this.existed ? this.baseline.getLineCount() : 0 };
		}
		if (!this.existed) {
			return { additions: this.modified?.getLineCount() ?? 0, deletions: 0 };
		}
		let additions = 0;
		let deletions = 0;
		for (const change of this.changes) {
			additions += change.modified.length;
			deletions += change.original.length;
		}
		return { additions, deletions };
	}

	toPendingFile(): IAgentPendingFile | undefined {
		if (!this.isDeleted && !this.modified) {
			return undefined;
		}
		const stats = this.stats();
		return {
			uri: this.uri,
			sessionId: this.sessionId,
			baselineUri: this.baselineUri,
			kind: !this.existed ? 'added' : this.isDeleted ? 'deleted' : 'modified',
			additions: stats.additions,
			deletions: stats.deletions,
			changes: this.changes,
			...(this.renamedFrom ? { renamedFrom: this.renamedFrom } : {}),
			...(this.frozenModel ? { modifiedUri: this.frozenModel.uri } : {}),
		};
	}

	async init(): Promise<void> {
		if (this.covered) {
			return;
		}
		let ref: IReference<IResolvedTextEditorModel>;
		try {
			ref = await this.textModelService.createModelReference(this.uri);
		} catch {
			this.deleted = true;
			this.onChanged(this);
			return;
		}
		if (this._store.isDisposed || this.covered) {
			ref.dispose();
			return;
		}
		this.modifiedRef?.dispose();
		this.modifiedRef = ref;
		this.liveStore.clear();
		this.liveStore.add(ref.object.textEditorModel.onDidChangeContent(() => this.scheduler.schedule()));
		await this.refresh();
	}

	/** Another chat is about to change the file: from now on this entry diffs against `text`. */
	freeze(text: string | undefined): void {
		this.liveStore.clear();
		this.modifiedRef?.dispose();
		this.modifiedRef = undefined;
		this.frozenModel?.dispose();
		this.frozenModel = undefined;
		this.frozenGone = text === undefined;
		if (text !== undefined) {
			const uri = agentFrozenUri(this.uri, this.sessionId);
			this.modelService.getModel(uri)?.dispose();
			this.frozenModel = this.modelService.createModel(text, this.languageService.createByFilepathOrFirstLine(this.uri), uri, false);
			this.liveStore.add(this.frozenModel.onDidChangeContent(() => this.scheduler.schedule()));
		}
		this.diff = undefined;
		void this.refresh().then(() => this.onChanged(this));
	}

	/** The chat on top went away and the file is back to the frozen text: follow the file again. */
	async thaw(): Promise<void> {
		this.liveStore.clear();
		this.frozenModel?.dispose();
		this.frozenModel = undefined;
		this.frozenGone = false;
		this.deleted = false;
		this.diff = undefined;
		await this.init();
	}

	/** The file came back or went away on disk. */
	async fileChanged(exists: boolean): Promise<void> {
		if (this.covered) {
			return;
		}
		if (exists && this.deleted) {
			this.deleted = false;
			await this.init();
		} else if (!exists && !this.deleted) {
			this.deleted = true;
			this.liveStore.clear();
			this.modifiedRef?.dispose();
			this.modifiedRef = undefined;
			this.diff = undefined;
			this.onChanged(this);
		}
	}

	refresh(): Promise<void> {
		if (this.computing) {
			this.dirtyAgain = true;
			return this.computing;
		}
		this.computing = this.computeDiff().finally(() => {
			this.computing = undefined;
			if (this.dirtyAgain) {
				this.dirtyAgain = false;
				void this.refresh();
			}
		});
		return this.computing;
	}

	whenSettled(): Promise<void> {
		if (this.scheduler.isScheduled()) {
			this.scheduler.cancel();
			return this.refresh();
		}
		return this.computing ?? Promise.resolve();
	}

	private async computeDiff(): Promise<void> {
		const modified = this.modified;
		if (!modified || this.baseline.isDisposed() || modified.isDisposed()) {
			return;
		}
		const versions = [this.baseline.getVersionId(), modified.getVersionId()];
		try {
			const diff = await this.editorWorkerService.computeDiff(this.baselineUri, modified.uri, {
				ignoreTrimWhitespace: false,
				maxComputationTimeMs: 3000,
				computeMoves: false,
			}, 'advanced');
			if (this._store.isDisposed || modified.isDisposed() || this.modified !== modified || this.baseline.getVersionId() !== versions[0] || modified.getVersionId() !== versions[1]) {
				this.dirtyAgain = !this._store.isDisposed;
				return;
			}
			this.diff = diff ?? undefined;
		} catch (err) {
			this.logService.trace('[volt] pending edit diff failed', err);
			return;
		}
		this.onChanged(this);
	}
}

/** A binary file: no diff, the pre-agent bytes stay in a snapshot repo. */
class BinaryEntry extends Disposable implements IEntry {

	busy = false;
	covered = false;
	deleted = false;

	constructor(
		readonly sessionId: string,
		readonly uri: URI,
		readonly baseline: IAgentBinaryBaseline | undefined,
		readonly renamedFrom: URI | undefined,
	) {
		super();
	}

	get existed(): boolean {
		return !!this.baseline;
	}

	toPendingFile(): IAgentPendingFile {
		return {
			uri: this.uri,
			sessionId: this.sessionId,
			baselineUri: agentBaselineUri(this.uri, this.sessionId),
			kind: !this.baseline ? 'added' : this.deleted ? 'deleted' : 'modified',
			additions: 0,
			deletions: 0,
			changes: [],
			binary: true,
			...(this.renamedFrom ? { renamedFrom: this.renamedFrom } : {}),
		};
	}

	whenSettled(): Promise<void> {
		return Promise.resolve();
	}
}

export class AgentEditsService extends Disposable implements IAgentEditsService {

	declare readonly _serviceBrand: undefined;

	/** Per file, one entry per chat, oldest first. Only the newest follows the live file. */
	private readonly entries = new ResourceMap<IEntry[]>();
	private readonly _onDidChange = this._register(new Emitter<URI>());
	readonly onDidChange = this._onDidChange.event;
	private readonly _onDidResolve = this._register(new Emitter<IAgentEditResolution>());
	readonly onDidResolve = this._onDidResolve.event;
	private readonly persistScheduler = this._register(new RunOnceScheduler(() => this.persist(), 500));
	private readonly disposables = this._register(new DisposableStore());

	constructor(
		@IAgentRuntimeService runtime: IAgentRuntimeService,
		@IFileService private readonly fileService: IFileService,
		@ITextFileService private readonly textFileService: ITextFileService,
		@IStorageService private readonly storageService: IStorageService,
		@IModelService private readonly modelService: IModelService,
		@ILanguageService private readonly languageService: ILanguageService,
		@ITextModelService private readonly textModelService: ITextModelService,
		@IEditorWorkerService private readonly editorWorkerService: IEditorWorkerService,
		@ILogService private readonly logService: ILogService,
		@IDialogService private readonly dialogService: IDialogService,
		@INotificationService private readonly notificationService: INotificationService,
		@IVoltGitService private readonly gitService: IVoltGitService,
	) {
		super();
		this._register(runtime.onDidEmit(envelope => {
			const event = envelope.event;
			if (event.type === 'file.change' && URI.isUri(event.uri)) {
				const existed = event.existed ?? event.kind !== 'create';
				if (existed && event.before === undefined) {
					return;
				}
				this.recordBaseline(envelope.sessionId, event.uri, existed ? event.before : undefined);
			} else if (event.type === 'run.end') {
				void this.noteAgentFinished(envelope.sessionId);
			}
		}));
		this._register(this.fileService.onDidFilesChange(e => {
			for (const [uri, stack] of this.entries) {
				if (!e.contains(uri)) {
					continue;
				}
				const top = stack[stack.length - 1];
				void this.fileService.exists(uri).then(exists => {
					if (top instanceof PendingEntry) {
						void top.fileChanged(exists);
					} else if (top instanceof BinaryEntry && top.deleted === exists) {
						top.deleted = !exists;
						this._onDidChange.fire(uri);
					}
				});
			}
		}));
		this._register(toDisposable(() => {
			for (const stack of this.entries.values()) {
				for (const entry of stack) {
					entry.dispose();
				}
			}
			this.entries.clear();
		}));
		this.restore();
	}

	getPendingFiles(sessionId?: string): readonly IAgentPendingFile[] {
		const out: IAgentPendingFile[] = [];
		for (const stack of this.entries.values()) {
			for (const entry of stack) {
				if (sessionId && entry.sessionId !== sessionId) {
					continue;
				}
				const file = entry.toPendingFile();
				if (file) {
					out.push(file);
				}
			}
		}
		return out;
	}

	getPendingFile(uri: URI, sessionId?: string): IAgentPendingFile | undefined {
		return this.find(uri, sessionId)?.toPendingFile();
	}

	getBaselineModel(uri: URI): ITextModel | undefined {
		const file = fileUriFromBaseline(uri) ?? uri;
		const entry = this.find(file, sessionFromBaseline(uri) || undefined);
		if (!(entry instanceof PendingEntry)) {
			return undefined;
		}
		return uri.fragment.endsWith(FROZEN_SUFFIX) ? entry.modified : entry.baseline;
	}

	recordBaseline(sessionId: string, uri: URI, before: string | undefined, options?: IAgentBaselineOptions): void {
		if (!this.coverPrevious(sessionId, uri, before)) {
			return;
		}
		const entry = this.createEntry(sessionId, uri, before, options?.renamedFrom);
		if (options?.agentText !== undefined) {
			entry.agentText = options.agentText;
		}
		this.push(entry);
		void entry.init();
	}

	recordBinaryBaseline(sessionId: string, uri: URI, baseline: IAgentBinaryBaseline | undefined, options?: { readonly renamedFrom?: URI }): void {
		if (!this.coverPrevious(sessionId, uri, undefined)) {
			return;
		}
		const entry = new BinaryEntry(sessionId, uri, baseline, options?.renamedFrom);
		this.push(entry);
		void this.fileService.exists(uri).then(exists => {
			entry.deleted = !exists;
			this._onDidChange.fire(uri);
		});
	}

	async keepHunk(uri: URI, change: DetailedLineRangeMapping, sessionId?: string): Promise<boolean> {
		const entry = this.find(uri, sessionId);
		const modified = entry instanceof PendingEntry ? entry.modified : undefined;
		if (!(entry instanceof PendingEntry) || !modified || !hasChange(entry.changes, change)) {
			return false;
		}
		entry.baseline.pushEditOperations(null, hunkEdits(change, modified, entry.baseline, 'keep'), () => null);
		await entry.refresh();
		return true;
	}

	async undoHunk(uri: URI, change: DetailedLineRangeMapping, sessionId?: string): Promise<boolean> {
		const entry = this.find(uri, sessionId);
		// Only the entry that follows the live file can write a hunk back into it.
		const modified = entry instanceof PendingEntry ? entry.live : undefined;
		if (!(entry instanceof PendingEntry) || !modified || !hasChange(entry.changes, change)) {
			return false;
		}
		modified.pushEditOperations(null, hunkEdits(change, entry.baseline, modified, 'undo'), () => null);
		await entry.refresh();
		await this.save(uri);
		return true;
	}

	async keepFile(uri: URI, sessionId?: string): Promise<void> {
		const entry = this.find(uri, sessionId);
		if (!entry) {
			return;
		}
		this.remove(entry);
		this._onDidResolve.fire({ sessionId: entry.sessionId, uri, outcome: 'kept' });
	}

	async undoFile(uri: URI, sessionId?: string): Promise<boolean> {
		const entry = this.find(uri, sessionId);
		if (!entry || entry.busy) {
			return false;
		}
		entry.busy = true;
		let done = false;
		try {
			done = entry instanceof BinaryEntry
				? await this.undoBinary(entry)
				: entry.covered
					? await this.undoCovered(entry as PendingEntry)
					: await this.undoLive(entry as PendingEntry);
		} catch (err) {
			this.logService.error('[volt] undo file failed', err);
			this.notificationService.error(localize('voltAgent.undoFailed', "Could not undo the changes in {0}: {1}", basename(uri), toErrorMessage(err)));
		} finally {
			entry.busy = false;
		}
		if (!done) {
			// The entry stays pending, baseline intact; refresh so its diff reflects the file again.
			if (entry instanceof PendingEntry && this.isListed(entry)) {
				void entry.refresh();
			}
			return false;
		}
		this.remove(entry);
		this._onDidResolve.fire({ sessionId: entry.sessionId, uri, outcome: 'undone' });
		await this.thawBelow(uri);
		return true;
	}

	async keepAll(sessionId: string): Promise<void> {
		for (const file of this.getPendingFiles(sessionId)) {
			await this.keepFile(file.uri, sessionId);
		}
	}

	async undoAll(sessionId: string): Promise<void> {
		for (const file of this.getPendingFiles(sessionId)) {
			await this.undoFile(file.uri, sessionId);
		}
	}

	async whenSettled(): Promise<void> {
		await Promise.all([...this.entries.values()].flat().map(entry => entry.whenSettled()));
	}

	private find(uri: URI, sessionId?: string): IEntry | undefined {
		const stack = this.entries.get(uri);
		if (!stack?.length) {
			return undefined;
		}
		return sessionId ? stack.find(entry => entry.sessionId === sessionId) : stack[stack.length - 1];
	}

	private isListed(entry: IEntry): boolean {
		return !!this.entries.get(entry.uri)?.includes(entry);
	}

	/**
	 * Before `sessionId` starts tracking `uri`: false when it already does. Otherwise the chat
	 * currently following the file is frozen at `before`, the text the new chat starts from.
	 */
	private coverPrevious(sessionId: string, uri: URI, before: string | undefined): boolean {
		const stack = this.entries.get(uri);
		if (!stack?.length) {
			return true;
		}
		if (stack.some(entry => entry.sessionId === sessionId)) {
			return false;
		}
		const top = stack[stack.length - 1];
		if (top instanceof PendingEntry) {
			top.freeze(before);
		} else if (top instanceof BinaryEntry) {
			top.covered = true;
		}
		return true;
	}

	private createEntry(sessionId: string, uri: URI, before: string | undefined, renamedFrom: URI | undefined): PendingEntry {
		return new PendingEntry(sessionId, uri, before !== undefined, before ?? '', renamedFrom, changed => this.onEntryChanged(changed),
			this.modelService, this.languageService, this.textModelService, this.editorWorkerService, this.logService);
	}

	private push(entry: IEntry): void {
		const stack = this.entries.get(entry.uri) ?? [];
		stack.push(entry);
		this.entries.set(entry.uri, stack);
		this.persistScheduler.schedule();
		this._onDidChange.fire(entry.uri);
	}

	/** The live entry: write its baseline back, merging in edits made after the agent. */
	private async undoLive(entry: PendingEntry): Promise<boolean> {
		const target = entry.existed ? entry.baseline.getValue() : undefined;
		const current = entry.isDeleted ? undefined : (entry.live?.getValue() ?? await this.readText(entry.uri));
		const agent = entry.agentText;
		if (agent !== undefined && (agent ?? undefined) !== current) {
			// Changed since the agent finished. Keep those edits where they don't overlap the agent's.
			const merged = agent !== null && target !== undefined && current !== undefined ? mergeText3(agent, current, target) : undefined;
			if (merged !== undefined) {
				return this.writeText(entry.uri, merged, entry.live);
			}
			const { confirmed } = await this.dialogService.confirm({
				type: 'warning',
				message: localize('voltAgent.undoEditedSince', "{0} was edited after the agent changed it.", basename(entry.uri)),
				detail: localize('voltAgent.undoEditedSinceDetail', "Undoing the agent's changes would also discard those edits."),
				primaryButton: localize({ key: 'voltAgent.undoAnyway', comment: ['&& denotes a mnemonic'] }, "&&Undo and Discard Edits"),
			});
			if (!confirmed) {
				return false;
			}
		}
		return this.writeText(entry.uri, target, entry.live);
	}

	/**
	 * An entry another chat built on: take this chat's changes out of the live file with a
	 * three-way merge, and out of the baselines of the entries above it, so their diffs stay theirs.
	 */
	private async undoCovered(entry: PendingEntry): Promise<boolean> {
		const stack = this.entries.get(entry.uri) ?? [];
		const above = stack.slice(stack.indexOf(entry) + 1).filter((other): other is PendingEntry => other instanceof PendingEntry);
		const top = stack[stack.length - 1];
		const target = entry.existed ? entry.baseline.getValue() : undefined;
		const frozen = entry.currentText;
		const live = top instanceof PendingEntry ? top.live : undefined;
		const current = top instanceof PendingEntry && top.isDeleted ? undefined : (live?.getValue() ?? await this.readText(entry.uri));
		const merged = frozen !== undefined && target !== undefined && current !== undefined ? mergeText3(frozen, current, target) : undefined;
		if (merged === undefined) {
			const { confirmed } = await this.dialogService.confirm({
				type: 'warning',
				message: localize('voltAgent.undoCovered', "{0} was changed after this chat's edits.", basename(entry.uri)),
				detail: localize('voltAgent.undoCoveredDetail', "Another chat or you changed the same lines. Undoing would discard those changes too, and drop them from review."),
				primaryButton: localize({ key: 'voltAgent.undoAnyway', comment: ['&& denotes a mnemonic'] }, "&&Undo and Discard Edits"),
			});
			if (!confirmed || !await this.writeText(entry.uri, target, live)) {
				return false;
			}
			for (const other of stack.slice(stack.indexOf(entry) + 1)) {
				this.remove(other);
			}
			return true;
		}
		if (!await this.writeText(entry.uri, merged, live)) {
			return false;
		}
		for (const other of above) {
			const baseline = other.baseline.getValue();
			const rebased = mergeText3(frozen!, baseline, target!);
			if (rebased !== undefined && rebased !== baseline) {
				other.baseline.setValue(rebased);
			}
		}
		return true;
	}

	private async undoBinary(entry: BinaryEntry): Promise<boolean> {
		if (entry.covered) {
			const { confirmed } = await this.dialogService.confirm({
				type: 'warning',
				message: localize('voltAgent.undoCovered', "{0} was changed after this chat's edits.", basename(entry.uri)),
				detail: localize('voltAgent.undoBinaryCoveredDetail', "Undoing puts back the file from before this chat, discarding the later changes."),
				primaryButton: localize({ key: 'voltAgent.undoAnyway', comment: ['&& denotes a mnemonic'] }, "&&Undo and Discard Edits"),
			});
			if (!confirmed) {
				return false;
			}
		}
		if (!entry.baseline) {
			return this.writeText(entry.uri, undefined, undefined);
		}
		const bytes = await this.gitService.readBlob({ repoRoot: entry.baseline.repoRoot, sha: entry.baseline.blob, path: entry.baseline.path });
		await this.fileService.writeFile(entry.uri, bytes);
		return true;
	}

	/**
	 * Writes `text` (undefined deletes the file). Through the open model when there is one, so
	 * the editor's undo still works; a failed save puts the model back. Throws or returns false
	 * on failure; never loses the caller's entry.
	 */
	private async writeText(uri: URI, text: string | undefined, model: ITextModel | undefined): Promise<boolean> {
		if (text === undefined) {
			if (!await this.fileService.exists(uri)) {
				return true;
			}
			await this.textFileService.revert(uri).catch(() => undefined);
			try {
				await this.fileService.del(uri, { useTrash: true });
			} catch {
				// No trash on this file system; the content is in the agent's snapshot anyway.
				await this.fileService.del(uri, { useTrash: false });
			}
			return true;
		}
		if (!model || model.isDisposed()) {
			await this.fileService.writeFile(uri, VSBuffer.fromString(text));
			return true;
		}
		if (model.getValue() === text) {
			return this.save(uri);
		}
		model.pushStackElement();
		model.pushEditOperations(null, [EditOperation.replace(model.getFullModelRange(), text)], () => null);
		model.pushStackElement();
		if (await this.save(uri)) {
			return true;
		}
		model.undo();
		return false;
	}

	/** At the end of a chat's turn, remember what its agent left in each file it is tracking. */
	private async noteAgentFinished(sessionId: string): Promise<void> {
		for (const stack of this.entries.values()) {
			const entry = stack[stack.length - 1];
			if (entry instanceof PendingEntry && entry.sessionId === sessionId) {
				const text = await this.readText(entry.uri);
				entry.agentText = text ?? null;
			}
		}
		this.persistScheduler.schedule();
	}

	/** The entry on top went away; the one below follows the file again if the file is back to where it froze. */
	private async thawBelow(uri: URI): Promise<void> {
		const stack = this.entries.get(uri);
		const below = stack?.[stack.length - 1];
		if (!(below instanceof PendingEntry) || !below.covered) {
			return;
		}
		const current = await this.readText(uri);
		if (current === below.currentText) {
			await below.thaw();
		}
	}

	private async readText(uri: URI): Promise<string | undefined> {
		try {
			return (await this.fileService.readFile(uri)).value.toString();
		} catch {
			return undefined;
		}
	}

	private onEntryChanged(entry: PendingEntry): void {
		if (!this.isListed(entry)) {
			return;
		}
		if (!entry.busy && entry.isDeleted && !entry.existed) {
			this.remove(entry);
			void this.thawBelow(entry.uri);
			return;
		}
		if (!entry.busy && entry.identical) {
			void this.removeIfReverted(entry);
			return;
		}
		this._onDidChange.fire(entry.uri);
	}

	/**
	 * The diff came out empty. An open model can lag the agent's write by a moment, so the file
	 * on disk decides; once the model reloads, its diff runs again.
	 */
	private async removeIfReverted(entry: PendingEntry): Promise<void> {
		const disk = entry.covered ? entry.currentText : await this.readText(entry.uri);
		if (!this.isListed(entry) || entry.busy || !entry.identical) {
			return;
		}
		if (disk !== undefined && disk !== entry.baseline.getValue()) {
			this._onDidChange.fire(entry.uri);
			return;
		}
		this.remove(entry);
		void this.thawBelow(entry.uri);
	}

	private remove(entry: IEntry): void {
		const stack = this.entries.get(entry.uri);
		const index = stack?.indexOf(entry) ?? -1;
		if (!stack || index < 0) {
			return;
		}
		stack.splice(index, 1);
		if (!stack.length) {
			this.entries.delete(entry.uri);
		}
		entry.dispose();
		this.persistScheduler.schedule();
		this._onDidChange.fire(entry.uri);
	}

	private async save(uri: URI): Promise<boolean> {
		try {
			return !!await this.textFileService.save(uri, { reason: SaveReason.EXPLICIT, skipSaveParticipants: true });
		} catch (err) {
			this.logService.error('[volt] saving undone edit failed', err);
			this.notificationService.error(localize('voltAgent.undoSaveFailed', "Could not save {0}: {1}", basename(uri), toErrorMessage(err)));
			return false;
		}
	}

	private persist(): void {
		const stored: IStoredEntry[] = [];
		for (const stack of this.entries.values()) {
			for (const entry of stack) {
				if (entry instanceof BinaryEntry) {
					stored.push({ sessionId: entry.sessionId, uri: entry.uri.toString(), baseline: null, binary: entry.baseline ?? null, renamedFrom: entry.renamedFrom?.toString() });
					continue;
				}
				if (!(entry instanceof PendingEntry)) {
					continue;
				}
				const baseline = entry.existed ? entry.baseline.getValue() : null;
				const frozen = entry.covered ? entry.currentText ?? null : undefined;
				if ((baseline?.length ?? 0) > PERSIST_LIMIT || (frozen?.length ?? 0) > PERSIST_LIMIT) {
					continue;
				}
				const agentText = entry.agentText !== undefined && (entry.agentText?.length ?? 0) <= PERSIST_LIMIT ? entry.agentText : undefined;
				stored.push({
					sessionId: entry.sessionId,
					uri: entry.uri.toString(),
					baseline,
					...(agentText !== undefined ? { agentText } : {}),
					...(frozen !== undefined ? { frozen } : {}),
					...(entry.renamedFrom ? { renamedFrom: entry.renamedFrom.toString() } : {}),
				});
			}
		}
		if (stored.length) {
			this.storageService.store(STORAGE_KEY, JSON.stringify(stored), StorageScope.WORKSPACE, StorageTarget.MACHINE);
		} else {
			this.storageService.remove(STORAGE_KEY, StorageScope.WORKSPACE);
		}
	}

	private restore(): void {
		let stored: IStoredEntry[] = [];
		try {
			stored = JSON.parse(this.storageService.get(STORAGE_KEY, StorageScope.WORKSPACE, '[]')) as IStoredEntry[];
		} catch {
			return;
		}
		for (const item of Array.isArray(stored) ? stored : []) {
			if (typeof item?.sessionId !== 'string' || typeof item.uri !== 'string') {
				continue;
			}
			const uri = URI.parse(item.uri);
			const renamedFrom = typeof item.renamedFrom === 'string' ? URI.parse(item.renamedFrom) : undefined;
			if (item.binary !== undefined) {
				if (!this.entries.get(uri)?.some(entry => entry.sessionId === item.sessionId)) {
					this.push(new BinaryEntry(item.sessionId, uri, item.binary ?? undefined, renamedFrom));
				}
				continue;
			}
			// Saved oldest first; covered entries carry their own frozen text.
			if (this.entries.get(uri)?.some(entry => entry.sessionId === item.sessionId)) {
				continue;
			}
			const entry = this.createEntry(item.sessionId, uri, item.baseline ?? undefined, renamedFrom);
			if (item.agentText !== undefined) {
				entry.agentText = item.agentText;
			}
			this.push(entry);
			if (item.frozen !== undefined) {
				entry.freeze(item.frozen ?? undefined);
			} else {
				void entry.init();
			}
		}
		for (const stack of this.entries.values()) {
			for (const entry of stack.slice(0, -1)) {
				if (entry instanceof BinaryEntry) {
					entry.covered = true;
				}
			}
		}
		// Kept baselines move as hunks are accepted; save them as they change too.
		this.disposables.add(this.onDidChange(() => this.persistScheduler.schedule()));
	}
}

/**
 * Three-way line merge: `ours` with the change from `base` to `theirs` applied. Returns
 * undefined when both sides changed the same or adjacent lines differently (as `git merge-file`
 * treats them).
 */
export function mergeText3(base: string, ours: string, theirs: string): string | undefined {
	if (ours === base) {
		return theirs;
	}
	if (theirs === base || theirs === ours) {
		return ours;
	}
	const baseLines = splitLines(base);
	const oursLines = splitLines(ours);
	const theirsLines = splitLines(theirs);
	const changes = [
		...lineDiff(baseLines, oursLines).map(change => ({ ...change, side: 0 })),
		...lineDiff(baseLines, theirsLines).map(change => ({ ...change, side: 1 })),
	].sort((a, b) => a.originalStart - b.originalStart || a.side - b.side);
	const sides = [oursLines, theirsLines];
	const out: string[] = [];
	let pos = 0;
	for (let i = 0; i < changes.length;) {
		const start = changes[i].originalStart;
		let end = start + changes[i].originalLength;
		let j = i + 1;
		// Overlapping or touching changes form one region.
		while (j < changes.length && changes[j].originalStart <= end) {
			end = Math.max(end, changes[j].originalStart + changes[j].originalLength);
			j++;
		}
		const group = changes.slice(i, j);
		const texts = [0, 1].map(side => {
			const own = group.filter(change => change.side === side);
			if (!own.length) {
				return undefined;
			}
			const lines: string[] = [];
			let cursor = start;
			for (const change of own) {
				lines.push(...baseLines.slice(cursor, change.originalStart));
				lines.push(...sides[side].slice(change.modifiedStart, change.modifiedStart + change.modifiedLength));
				cursor = change.originalStart + change.originalLength;
			}
			lines.push(...baseLines.slice(cursor, end));
			return lines.join('');
		});
		if (texts[0] !== undefined && texts[1] !== undefined && texts[0] !== texts[1]) {
			return undefined;
		}
		out.push(...baseLines.slice(pos, start), texts[0] ?? texts[1] ?? '');
		pos = end;
		i = j;
	}
	out.push(...baseLines.slice(pos));
	return out.join('');
}

function splitLines(text: string): string[] {
	return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

function lineDiff(original: string[], modified: string[]): { originalStart: number; originalLength: number; modifiedStart: number; modifiedLength: number }[] {
	return new LcsDiff({ getElements: () => original }, { getElements: () => modified }).ComputeDiff(false).changes;
}

function hasChange(changes: readonly DetailedLineRangeMapping[], change: DetailedLineRangeMapping): boolean {
	return changes.some(candidate => candidate === change
		|| (candidate.original.equals(change.original) && candidate.modified.equals(change.modified)));
}

/**
 * The edits that make `target` take `source`'s side of one hunk. Keep writes the file's text
 * into the baseline; undo writes the baseline's text into the file.
 */
function hunkEdits(change: DetailedLineRangeMapping, source: ITextModel, target: ITextModel, direction: 'keep' | 'undo'): ISingleEditOperation[] {
	if (change.innerChanges?.length) {
		return change.innerChanges.map(inner => {
			const from = direction === 'keep' ? inner.modifiedRange : inner.originalRange;
			const to = direction === 'keep' ? inner.originalRange : inner.modifiedRange;
			return EditOperation.replace(to, source.getValueInRange(from));
		});
	}
	// No character-level detail (the diff timed out): swap whole lines.
	const from = direction === 'keep' ? change.modified : change.original;
	const to = direction === 'keep' ? change.original : change.modified;
	const eol = target.getEOL();
	const lines = from.isEmpty ? [] : source.getLinesContent().slice(from.startLineNumber - 1, from.endLineNumberExclusive - 1);
	if (!to.isEmpty) {
		const end = to.endLineNumberExclusive - 1;
		const range = new Range(to.startLineNumber, 1, end, target.getLineMaxColumn(end));
		if (lines.length) {
			return [EditOperation.replace(range, lines.join(eol))];
		}
		// Remove the lines together with one line break.
		return [EditOperation.delete(end < target.getLineCount()
			? new Range(to.startLineNumber, 1, end + 1, 1)
			: new Range(Math.max(1, to.startLineNumber - 1), to.startLineNumber > 1 ? target.getLineMaxColumn(to.startLineNumber - 1) : 1, end, target.getLineMaxColumn(end)))];
	}
	if (!lines.length) {
		return [];
	}
	const at = to.startLineNumber;
	return at <= target.getLineCount()
		? [EditOperation.insert(new Position(at, 1), lines.join(eol) + eol)]
		: [EditOperation.insert(new Position(target.getLineCount(), target.getLineMaxColumn(target.getLineCount())), eol + lines.join(eol))];
}

/** Serves `volt-agent-baseline:` models (baselines and frozen copies) to diff editors. */
export class AgentBaselineContentProvider implements ITextModelContentProvider {

	constructor(@IAgentEditsService private readonly edits: IAgentEditsService) { }

	async provideTextContent(resource: URI): Promise<ITextModel | null> {
		return this.edits.getBaselineModel(resource) ?? null;
	}
}

registerSingleton(IAgentEditsService, AgentEditsService, InstantiationType.Delayed);
