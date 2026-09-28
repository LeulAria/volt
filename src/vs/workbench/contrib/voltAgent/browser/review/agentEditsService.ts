/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { RunOnceScheduler } from '../../../../../base/common/async.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable, DisposableStore, IReference, toDisposable } from '../../../../../base/common/lifecycle.js';
import { ResourceMap } from '../../../../../base/common/map.js';
import { Schemas } from '../../../../../base/common/network.js';
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
import { IFileService } from '../../../../../platform/files/common/files.js';
import { InstantiationType, registerSingleton } from '../../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
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
}

export interface IAgentEditsService {
	readonly _serviceBrand: undefined;
	/** Fires with the file whose pending state changed. */
	readonly onDidChange: Event<URI>;
	getPendingFiles(sessionId?: string): readonly IAgentPendingFile[];
	getPendingFile(uri: URI): IAgentPendingFile | undefined;
	getBaselineModel(uri: URI): ITextModel | undefined;
	/**
	 * Start tracking `uri` for `sessionId` with the text it had before the agent's edit
	 * (undefined when the agent created it). Ignored while the file already has pending edits:
	 * the oldest unreviewed text stays the baseline.
	 */
	recordBaseline(sessionId: string, uri: URI, before: string | undefined): void;
	keepHunk(uri: URI, change: DetailedLineRangeMapping): Promise<boolean>;
	undoHunk(uri: URI, change: DetailedLineRangeMapping): Promise<boolean>;
	keepFile(uri: URI): Promise<void>;
	undoFile(uri: URI): Promise<void>;
	keepAll(sessionId: string): Promise<void>;
	undoAll(sessionId: string): Promise<void>;
	/** Resolves once every pending diff reflects the latest file text. */
	whenSettled(): Promise<void>;
}

const STORAGE_KEY = 'volt.agent.pendingEdits';
/** Larger baselines stay in memory for this window only. */
const PERSIST_LIMIT = 1024 * 1024;

interface IStoredEntry {
	readonly sessionId: string;
	readonly uri: string;
	/** null when the agent created the file. */
	readonly baseline: string | null;
}

export function agentBaselineUri(uri: URI): URI {
	return URI.from({ scheme: Schemas.voltAgentBaseline, path: uri.path, query: uri.toString() });
}

export function fileUriFromBaseline(uri: URI): URI | undefined {
	return uri.scheme === Schemas.voltAgentBaseline && uri.query ? URI.parse(uri.query) : undefined;
}

class PendingEntry extends Disposable {

	readonly baseline: ITextModel;
	readonly baselineUri: URI;
	private modifiedRef: IReference<IResolvedTextEditorModel> | undefined;
	private diff: IDocumentDiff | undefined;
	private deleted = false;
	private readonly scheduler: RunOnceScheduler;
	private computing: Promise<void> | undefined;
	private dirtyAgain = false;

	constructor(
		readonly sessionId: string,
		readonly uri: URI,
		/** False when the agent created the file: undo deletes it. */
		readonly existed: boolean,
		baselineText: string,
		private readonly onChanged: (entry: PendingEntry) => void,
		modelService: IModelService,
		languageService: ILanguageService,
		private readonly textModelService: ITextModelService,
		private readonly editorWorkerService: IEditorWorkerService,
		private readonly logService: ILogService,
	) {
		super();
		this.baselineUri = agentBaselineUri(uri);
		modelService.getModel(this.baselineUri)?.dispose();
		this.baseline = this._register(modelService.createModel(baselineText, languageService.createByFilepathOrFirstLine(uri), this.baselineUri, false));
		this.scheduler = this._register(new RunOnceScheduler(() => void this.refresh(), 60));
		this._register(this.baseline.onDidChangeContent(() => this.scheduler.schedule()));
		this._register(toDisposable(() => this.modifiedRef?.dispose()));
	}

	get modified(): ITextModel | undefined {
		return this.modifiedRef?.object.textEditorModel;
	}

	get isDeleted(): boolean {
		return this.deleted;
	}

	get changes(): readonly DetailedLineRangeMapping[] {
		return this.diff?.changes ?? [];
	}

	/** True once a diff ran and the file matches its baseline. */
	get identical(): boolean {
		return !this.deleted && !!this.diff?.identical;
	}

	stats(): { additions: number; deletions: number } {
		if (this.deleted) {
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

	async init(): Promise<void> {
		try {
			this.modifiedRef = await this.textModelService.createModelReference(this.uri);
		} catch {
			this.deleted = true;
			this.onChanged(this);
			return;
		}
		if (this._store.isDisposed) {
			this.modifiedRef.dispose();
			this.modifiedRef = undefined;
			return;
		}
		this._register(this.modifiedRef.object.textEditorModel.onDidChangeContent(() => this.scheduler.schedule()));
		await this.refresh();
	}

	/** The file came back or went away on disk. */
	async fileChanged(exists: boolean): Promise<void> {
		if (exists && this.deleted) {
			this.deleted = false;
			await this.init();
		} else if (!exists && !this.deleted) {
			this.deleted = true;
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
		if (!modified || this.baseline.isDisposed()) {
			return;
		}
		const versions = [this.baseline.getVersionId(), modified.getVersionId()];
		try {
			const diff = await this.editorWorkerService.computeDiff(this.baselineUri, this.uri, {
				ignoreTrimWhitespace: false,
				maxComputationTimeMs: 3000,
				computeMoves: false,
			}, 'advanced');
			if (this._store.isDisposed || this.baseline.getVersionId() !== versions[0] || modified.getVersionId() !== versions[1]) {
				this.dirtyAgain = true;
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

export class AgentEditsService extends Disposable implements IAgentEditsService {

	declare readonly _serviceBrand: undefined;

	private readonly entries = new ResourceMap<PendingEntry>();
	private readonly _onDidChange = this._register(new Emitter<URI>());
	readonly onDidChange = this._onDidChange.event;
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
			}
		}));
		this._register(this.fileService.onDidFilesChange(e => {
			for (const [uri, entry] of this.entries) {
				if (e.contains(uri)) {
					void this.fileService.exists(uri).then(exists => entry.fileChanged(exists));
				}
			}
		}));
		this._register(toDisposable(() => {
			for (const entry of this.entries.values()) {
				entry.dispose();
			}
			this.entries.clear();
		}));
		this.restore();
	}

	getPendingFiles(sessionId?: string): readonly IAgentPendingFile[] {
		const out: IAgentPendingFile[] = [];
		for (const entry of this.entries.values()) {
			if (sessionId && entry.sessionId !== sessionId) {
				continue;
			}
			const file = this.toPendingFile(entry);
			if (file) {
				out.push(file);
			}
		}
		return out;
	}

	getPendingFile(uri: URI): IAgentPendingFile | undefined {
		const entry = this.entries.get(uri);
		return entry ? this.toPendingFile(entry) : undefined;
	}

	getBaselineModel(uri: URI): ITextModel | undefined {
		return this.entries.get(fileUriFromBaseline(uri) ?? uri)?.baseline;
	}

	recordBaseline(sessionId: string, uri: URI, before: string | undefined): void {
		if (this.entries.has(uri)) {
			return;
		}
		const entry = new PendingEntry(sessionId, uri, before !== undefined, before ?? '', changed => this.onEntryChanged(changed),
			this.modelService, this.languageService, this.textModelService, this.editorWorkerService, this.logService);
		this.entries.set(uri, entry);
		this.persistScheduler.schedule();
		void entry.init();
	}

	async keepHunk(uri: URI, change: DetailedLineRangeMapping): Promise<boolean> {
		const entry = this.entries.get(uri);
		const modified = entry?.modified;
		if (!entry || !modified || !hasChange(entry.changes, change)) {
			return false;
		}
		entry.baseline.pushEditOperations(null, hunkEdits(change, modified, entry.baseline, 'keep'), () => null);
		await entry.refresh();
		return true;
	}

	async undoHunk(uri: URI, change: DetailedLineRangeMapping): Promise<boolean> {
		const entry = this.entries.get(uri);
		const modified = entry?.modified;
		if (!entry || !modified || !hasChange(entry.changes, change)) {
			return false;
		}
		modified.pushEditOperations(null, hunkEdits(change, entry.baseline, modified, 'undo'), () => null);
		await entry.refresh();
		await this.save(uri);
		return true;
	}

	async keepFile(uri: URI): Promise<void> {
		const entry = this.entries.get(uri);
		if (!entry) {
			return;
		}
		this.remove(entry);
	}

	async undoFile(uri: URI): Promise<void> {
		const entry = this.entries.get(uri);
		if (!entry) {
			return;
		}
		const text = entry.baseline.getValue();
		const modified = entry.modified;
		this.remove(entry);
		try {
			if (!entry.existed) {
				if (await this.fileService.exists(uri)) {
					await this.textFileService.revert(uri).catch(() => undefined);
					await this.fileService.del(uri, { useTrash: true });
				}
			} else if (!modified || modified.isDisposed()) {
				await this.fileService.writeFile(uri, VSBuffer.fromString(text));
			} else {
				modified.pushEditOperations(null, [EditOperation.replace(modified.getFullModelRange(), text)], () => null);
				await this.save(uri);
			}
		} catch (err) {
			this.logService.error('[volt] undo file failed', err);
		}
	}

	async keepAll(sessionId: string): Promise<void> {
		for (const file of this.getPendingFiles(sessionId)) {
			await this.keepFile(file.uri);
		}
	}

	async undoAll(sessionId: string): Promise<void> {
		for (const file of this.getPendingFiles(sessionId)) {
			await this.undoFile(file.uri);
		}
	}

	async whenSettled(): Promise<void> {
		await Promise.all([...this.entries.values()].map(entry => entry.whenSettled()));
	}

	private toPendingFile(entry: PendingEntry): IAgentPendingFile | undefined {
		if (!entry.isDeleted && !entry.modified) {
			return undefined;
		}
		const stats = entry.stats();
		return {
			uri: entry.uri,
			sessionId: entry.sessionId,
			baselineUri: entry.baselineUri,
			kind: !entry.existed ? 'added' : entry.isDeleted ? 'deleted' : 'modified',
			additions: stats.additions,
			deletions: stats.deletions,
			changes: entry.changes,
		};
	}

	private onEntryChanged(entry: PendingEntry): void {
		if (this.entries.get(entry.uri) !== entry) {
			return;
		}
		if (entry.identical || (entry.isDeleted && !entry.existed)) {
			this.remove(entry);
			return;
		}
		this._onDidChange.fire(entry.uri);
	}

	private remove(entry: PendingEntry): void {
		if (this.entries.get(entry.uri) !== entry) {
			return;
		}
		this.entries.delete(entry.uri);
		entry.dispose();
		this.persistScheduler.schedule();
		this._onDidChange.fire(entry.uri);
	}

	private async save(uri: URI): Promise<void> {
		await this.textFileService.save(uri, { reason: SaveReason.EXPLICIT, skipSaveParticipants: true }).catch(err => {
			this.logService.error('[volt] saving undone edit failed', err);
		});
	}

	private persist(): void {
		const stored: IStoredEntry[] = [];
		for (const entry of this.entries.values()) {
			const baseline = entry.existed ? entry.baseline.getValue() : null;
			if (baseline && baseline.length > PERSIST_LIMIT) {
				continue;
			}
			stored.push({ sessionId: entry.sessionId, uri: entry.uri.toString(), baseline });
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
			if (typeof item?.sessionId === 'string' && typeof item.uri === 'string') {
				this.recordBaseline(item.sessionId, URI.parse(item.uri), item.baseline ?? undefined);
			}
		}
		// Kept baselines move as hunks are accepted; save them as they change too.
		this.disposables.add(this.onDidChange(() => this.persistScheduler.schedule()));
	}
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

/** Serves `volt-agent-baseline:` models to diff editors. */
export class AgentBaselineContentProvider implements ITextModelContentProvider {

	constructor(@IAgentEditsService private readonly edits: IAgentEditsService) { }

	async provideTextContent(resource: URI): Promise<ITextModel | null> {
		return this.edits.getBaselineModel(resource) ?? null;
	}
}

registerSingleton(IAgentEditsService, AgentEditsService, InstantiationType.Delayed);
