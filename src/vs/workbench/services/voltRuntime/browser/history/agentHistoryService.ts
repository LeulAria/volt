/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { VSBuffer } from '../../../../../base/common/buffer.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { hashAsync } from '../../../../../base/common/hash.js';
import { Disposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { basename, joinPath } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { IEnvironmentService } from '../../../../../platform/environment/common/environment.js';
import { FileOperationError, FileOperationResult, IFileService } from '../../../../../platform/files/common/files.js';
import { InstantiationType, registerSingleton } from '../../../../../platform/instantiation/common/extensions.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { ILifecycleService } from '../../../lifecycle/common/lifecycle.js';
import { IAgentWorktreeService } from '../../common/git/agentWorktree.js';
import {
	AGENT_HISTORY_FORMAT_VERSION,
	AgentHistoryEntry,
	AgentHistoryRecord,
	AgentSessionAttention,
	IAgentForkOrigin,
	IAgentHistoryIndex,
	IAgentHistoryListOptions,
	IAgentHistoryService,
	IAgentSessionAppendAssistant,
	IAgentSessionDraft,
	IAgentSessionHandle,
	IAgentSessionHeader,
	IAgentSessionLifecycle,
	IAgentSessionMeta,
	IAgentSessionTranscript,
	IAgentSessionWorkspace,
} from '../../common/history/agentHistory.js';
import {
	attachmentFileName,
	attachmentRef,
	compactRecords,
	createEmptyIndex,
	decodeLog,
	deriveMeta,
	derivePreview,
	deriveTitle,
	encodeRecord,
	encodeRecords,
	foldTranscript,
	metaAfterEntry,
	normalizeIndex,
	parseAttachmentRef,
	searchSessions,
	settleIndexAfterRestart,
	deriveStatus,
	shouldCompact,
	sortSessions,
} from '../../common/history/agentHistoryLog.js';

const ROOT_DIR = 'agentSessions';
const SESSIONS_DIR = 'sessions';
const ATTACHMENTS_DIR = 'attachments';
const INDEX_FILE = 'index.json';
const LOG_EXT = '.jsonl';
const DRAFT_EXT = '.draft.json';
const ATOMIC = { atomic: { postfix: '.tmp' } } as const;

/** Batching window for write-behind appends. Later appends join without resetting it. */
const APPEND_WINDOW_MS = 200;
const INDEX_WINDOW_MS = 400;
const DRAFT_WINDOW_MS = 600;
/** Longest single wait for a snooze to end; setTimeout cannot count past ~24.8 days. */
const SNOOZE_TIMER_MAX_MS = 86_400_000;

function isNotFound(err: unknown): boolean {
	return err instanceof FileOperationError && err.fileOperationResult === FileOperationResult.FILE_NOT_FOUND;
}

function safeSessionId(id: string): string | undefined {
	return /^[A-Za-z0-9._-]{1,128}$/.test(id) ? id : undefined;
}

/**
 * A serial write queue: work runs one at a time, in order, and errors never
 * poison later work.
 */
class WriteQueue {
	private tail: Promise<void> = Promise.resolve();

	run<T>(work: () => Promise<T>): Promise<T> {
		const next = this.tail.then(work, work);
		this.tail = next.then(() => undefined, () => undefined);
		return next;
	}

	get idle(): Promise<void> {
		return this.tail;
	}
}

class SessionHandle implements IAgentSessionHandle {

	private header: IAgentSessionHeader;
	private entries: AgentHistoryEntry[] = [];
	/** Encoded eagerly so later mutation of a live message object cannot leak into the log. */
	private pending: string[] = [];
	private loaded: Promise<IAgentSessionTranscript> | undefined;
	private transcript: IAgentSessionTranscript | undefined;
	private recordCount = 0;
	private damaged = false;
	private materialized = false;
	private appendTimer: ReturnType<typeof setTimeout> | undefined;
	private draftTimer: ReturnType<typeof setTimeout> | undefined;
	private pendingDraft: IAgentSessionDraft | null | undefined;
	private readonly queue = new WriteQueue();
	private closed = false;
	private closing: Promise<void> | undefined;

	constructor(
		readonly id: string,
		private readonly logFile: URI,
		private readonly draftFile: URI,
		private readonly service: AgentHistoryService,
		existsOnDisk: boolean,
		/** Resolves once a previous handle for the same id has finished writing. */
		private readonly barrier: Promise<void> | undefined,
	) {
		this.materialized = existsOnDisk;
		this.header = {
			type: 'header',
			version: AGENT_HISTORY_FORMAT_VERSION,
			id,
			createdAt: service.get(id)?.createdAt ?? Date.now(),
			workspace: service.pinnedWorkspace(id) ?? service.currentWorkspace,
			...(service.sessionParent(id) ? { parentId: service.sessionParent(id) } : {}),
			...(service.isSubagentSession(id) ? { subagent: true } : {}),
		};
	}

	/** A new chat can be bound after the handle exists and before the first append. */
	adoptWorkspace(workspace: IAgentSessionWorkspace): void {
		if (this.materialized) {
			return;
		}
		this.header = { ...this.header, workspace };
	}

	adoptParent(parentId: string, subagent: boolean): void {
		if (this.materialized) {
			return;
		}
		this.header = { ...this.header, parentId, ...(subagent ? { subagent: true } : {}) };
	}

	get meta(): IAgentSessionMeta | undefined {
		return this.service.get(this.id);
	}

	async load(): Promise<IAgentSessionTranscript> {
		if (!this.loaded) {
			this.loaded = this.doLoad();
		}
		await this.loaded;
		// Later calls see appends made since the file was read.
		return this.transcript ?? await this.loaded;
	}

	private async doLoad(): Promise<IAgentSessionTranscript> {
		await this.barrier;
		if (this.materialized) {
			try {
				const content = await this.service.fileService.readFile(this.logFile);
				const decoded = decodeLog(content.value.buffer);
				if (decoded.header) {
					this.header = decoded.header;
				}
				// Appends that raced the load stay after the stored entries.
				this.entries = [...decoded.entries, ...this.entries];
				this.recordCount = decoded.recordCount;
				this.damaged = decoded.damaged;
				if (!decoded.header) {
					// Unreadable header: rewrite with a fresh one so the log stays usable.
					this.damaged = true;
				}
			} catch (err) {
				if (!isNotFound(err)) {
					this.service.logService.warn(`[agent history] failed to read ${this.logFile.toString()}`, err);
				}
				this.materialized = false;
			}
		}
		this.transcript = foldTranscript(this.header, this.entries);
		if (this.materialized && this.damaged) {
			// Runs outside the write queue on purpose: queued work awaits load()
			// before touching the file, so nesting here would deadlock.
			await this.rewrite().catch(err => this.service.logService.warn(`[agent history] repair failed for ${this.logFile.toString()}`, err));
		}
		return this.transcript;
	}

	async loadDraft(): Promise<IAgentSessionDraft | undefined> {
		if (this.pendingDraft !== undefined) {
			return this.pendingDraft ?? undefined;
		}
		try {
			const content = await this.service.fileService.readFile(this.draftFile);
			const value = JSON.parse(content.value.toString()) as Partial<IAgentSessionDraft> | null;
			if (value && typeof value.text === 'string') {
				return { text: value.text, mentions: Array.isArray(value.mentions) ? value.mentions : undefined, queue: Array.isArray(value.queue) ? value.queue : undefined, updatedAt: typeof value.updatedAt === 'number' ? value.updatedAt : 0 };
			}
		} catch (err) {
			if (!isNotFound(err)) {
				this.service.logService.warn(`[agent history] failed to read draft ${this.draftFile.toString()}`, err);
			}
		}
		return undefined;
	}

	appendUser(turn: string, text: string, message: unknown): void {
		this.append({ type: 'user', turn, at: Date.now(), text, message });
		void this.flush();
	}

	appendAssistant(entry: IAgentSessionAppendAssistant): void {
		this.append({ type: 'agent', at: Date.now(), ...entry });
		if (entry.final) {
			void this.flush();
		}
	}

	truncate(fromTurn: string): void {
		this.append({ type: 'truncate', at: Date.now(), from: fromTurn });
	}

	setMeta(meta: { title?: string; agentTitle?: string; mode?: string; model?: string; worktreePath?: string; worktreeBranch?: string; forkOf?: IAgentForkOrigin }): void {
		this.append({ type: 'meta', at: Date.now(), ...meta });
	}

	private append(entry: AgentHistoryEntry): void {
		if (this.closed) {
			return;
		}
		// Freeze now: the editor keeps mutating the live message, and a later
		// rewrite must not JSON.stringify those objects (or lose the turn).
		const { encoded, snapshot } = this.freezeEntry(entry);
		this.entries.push(snapshot);
		this.pending.push(encoded);
		this.transcript = foldTranscript(this.header, this.entries);
		this.service.updateMeta(metaAfterEntry(deriveMeta(this.transcript, this.meta), snapshot));
		if (this.appendTimer === undefined) {
			this.appendTimer = setTimeout(() => {
				this.appendTimer = undefined;
				void this.drain();
			}, APPEND_WINDOW_MS);
		}
	}

	private freezeEntry(entry: AgentHistoryEntry): { encoded: string; snapshot: AgentHistoryEntry } {
		try {
			const encoded = encodeRecord(entry);
			return { encoded, snapshot: JSON.parse(encoded) as AgentHistoryEntry };
		} catch (err) {
			this.service.logService.warn(`[agent history] record was not JSON-serializable, storing a safe subset`, err);
			const safe = entry.type === 'user' || entry.type === 'agent' ? { ...entry, message: undefined } : entry;
			const encoded = encodeRecord(safe);
			return { encoded, snapshot: safe };
		}
	}

	saveDraft(draft: Omit<IAgentSessionDraft, 'updatedAt'> | undefined): void {
		if (this.closed) {
			return;
		}
		const next = draft && (draft.text.trim() || draft.queue?.length) ? { ...draft, updatedAt: Date.now() } : null;
		this.pendingDraft = next;
		const hasDraft = !!next;
		const meta = this.meta ?? deriveMeta(this.transcript ?? foldTranscript(this.header, this.entries));
		let updated: IAgentSessionMeta = { ...meta, hasDraft };
		if (meta.turnCount === 0 && !meta.customTitle) {
			// A session that only has a draft is listed by that draft.
			const text = next?.text ?? '';
			updated = { ...updated, title: deriveTitle(text), preview: derivePreview(text), updatedAt: hasDraft ? Date.now() : meta.updatedAt };
		}
		this.service.updateMeta(updated);
		if (this.draftTimer === undefined) {
			this.draftTimer = setTimeout(() => {
				this.draftTimer = undefined;
				void this.queue.run(() => this.writeDraft());
			}, DRAFT_WINDOW_MS);
		}
	}

	private async writeDraft(): Promise<void> {
		const draft = this.pendingDraft;
		if (draft === undefined) {
			return;
		}
		this.pendingDraft = undefined;
		try {
			if (draft === null) {
				await this.service.fileService.del(this.draftFile).catch(err => { if (!isNotFound(err)) { throw err; } });
			} else {
				await this.service.ensureDirectories();
				await this.service.fileService.writeFile(this.draftFile, VSBuffer.fromString(JSON.stringify(draft)), ATOMIC);
			}
		} catch (err) {
			this.service.logService.error(`[agent history] failed to write draft ${this.draftFile.toString()}`, err);
		}
	}

	async flush(): Promise<void> {
		if (this.appendTimer !== undefined) {
			clearTimeout(this.appendTimer);
			this.appendTimer = undefined;
		}
		if (this.draftTimer !== undefined) {
			clearTimeout(this.draftTimer);
			this.draftTimer = undefined;
			void this.queue.run(() => this.writeDraft());
		}
		await this.drain();
		await this.queue.idle;
	}

	private drain(): Promise<void> {
		return this.queue.run(async () => {
			if (!this.pending.length) {
				return;
			}
			if (this.materialized && !this.loaded) {
				// Never append to a log we have not read: the header and offsets must be known first.
				await this.load();
			}
			const batch = this.pending;
			this.pending = [];
			try {
				await this.writeBatch(batch);
			} catch (err) {
				// Keep the batch, in order, ahead of anything appended since; the next drain retries.
				this.pending = [...batch, ...this.pending];
				this.service.logService.error(`[agent history] failed to append to ${this.logFile.toString()}`, err);
				throw err;
			}
		});
	}

	private async writeBatch(_batch: readonly string[]): Promise<void> {
		// Atomic rewrite on vscode-userdata: offset appends on that provider can
		// succeed without the new bytes being readable after a reload.
		await this.rewrite();
	}

	/** Atomically rewrite the log with only the effective records. */
	private async rewrite(): Promise<void> {
		// Records appended while the write is in flight are not in this snapshot; keep them
		// (in `entries` and `pending`) so the next drain writes them instead of losing them.
		const entriesAtStart = this.entries.length;
		const pendingAtStart = this.pending.length;
		const transcript = this.transcript ?? foldTranscript(this.header, this.entries);
		const records: AgentHistoryRecord[] = compactRecords(transcript);
		const content = VSBuffer.fromString(encodeRecords(records));
		await this.service.ensureDirectories();
		await this.service.fileService.writeFile(this.logFile, content, ATOMIC);
		const arrived = this.entries.slice(entriesAtStart);
		this.entries = [...records.filter((record): record is AgentHistoryEntry => record.type !== 'header'), ...arrived];
		this.pending = this.pending.slice(pendingAtStart);
		this.recordCount = records.length + arrived.length;
		this.damaged = false;
		this.materialized = true;
		this.service.rememberOnDisk(this.id);
	}

	close(): Promise<void> {
		if (this.closing) {
			return this.closing;
		}
		this.closed = true;
		this.closing = (async () => {
			await this.flush();
			if (this.materialized) {
				const effective = compactRecords(this.transcript ?? foldTranscript(this.header, this.entries)).length;
				if (shouldCompact(this.recordCount, effective, this.damaged)) {
					await this.queue.run(() => this.rewrite().catch(err => this.service.logService.warn(`[agent history] compaction failed for ${this.logFile.toString()}`, err)));
				}
			}
		})().catch(() => undefined);
		this.service.releaseHandle(this, this.closing);
		return this.closing;
	}

	/** Discard without writing (used by delete). */
	abandon(): void {
		this.closed = true;
		if (this.appendTimer !== undefined) {
			clearTimeout(this.appendTimer);
		}
		if (this.draftTimer !== undefined) {
			clearTimeout(this.draftTimer);
		}
		this.pending = [];
		this.pendingDraft = undefined;
	}

	get idle(): Promise<void> {
		return this.queue.idle;
	}
}

export class AgentHistoryService extends Disposable implements IAgentHistoryService {

	declare readonly _serviceBrand: undefined;

	private readonly root: URI;
	private readonly sessionsDir: URI;
	private readonly attachmentsDir: URI;
	private readonly indexFile: URI;

	private readonly sessions = new Map<string, IAgentSessionMeta>();
	private readonly onDisk = new Set<string>();
	private readonly handles = new Map<string, SessionHandle>();
	private readonly pinnedWorkspaces = new Map<string, IAgentSessionWorkspace>();
	private readonly pinnedParents = new Map<string, string>();
	private readonly pinnedSubagents = new Set<string>();
	private readonly closing = new Map<string, Promise<void>>();
	private readonly indexQueue = new WriteQueue();
	private indexTimer: ReturnType<typeof setTimeout> | undefined;
	private indexDirty = false;
	private snoozeTimer: ReturnType<typeof setTimeout> | undefined;
	private directoriesReady: Promise<void> | undefined;

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange: Event<void> = this._onDidChange.event;
	readonly whenReady: Promise<void>;
	readonly currentWorkspace: IAgentSessionWorkspace;

	constructor(
		@IFileService public readonly fileService: IFileService,
		@IEnvironmentService environmentService: IEnvironmentService,
		@IWorkspaceContextService workspaceContextService: IWorkspaceContextService,
		@ILifecycleService lifecycleService: ILifecycleService,
		@ILogService public readonly logService: ILogService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
	) {
		super();
		this.root = joinPath(environmentService.userRoamingDataHome, ROOT_DIR);
		this.sessionsDir = joinPath(this.root, SESSIONS_DIR);
		this.attachmentsDir = joinPath(this.root, ATTACHMENTS_DIR);
		this.indexFile = joinPath(this.root, INDEX_FILE);
		this.currentWorkspace = describeWorkspace(workspaceContextService);
		this.whenReady = this.loadIndex();
		this._register(lifecycleService.onWillShutdown(e => e.join(this.flushAll(), { id: 'volt.agentHistory', label: 'Saving agent history' })));
		this._register(toDisposable(() => {
			if (this.indexTimer !== undefined) {
				clearTimeout(this.indexTimer);
			}
			if (this.snoozeTimer !== undefined) {
				clearTimeout(this.snoozeTimer);
			}
		}));
	}

	//#region Index

	private async loadIndex(): Promise<void> {
		let index: IAgentHistoryIndex | undefined;
		try {
			const content = await this.fileService.readFile(this.indexFile);
			index = normalizeIndex(JSON.parse(content.value.toString()));
			if (!index) {
				this.logService.warn('[agent history] index unreadable, rebuilding from logs');
			}
		} catch (err) {
			if (!isNotFound(err)) {
				this.logService.warn('[agent history] failed to read index, rebuilding from logs', err);
			}
		}
		const files = await this.listLogFiles();
		for (const id of files) {
			this.onDisk.add(id);
		}
		let rebuilt = false;
		if (!index) {
			index = createEmptyIndex();
			rebuilt = true;
		}
		// The index is written on a short debounce; a log is flushed as soon as a reply is final. A
		// window that closed in between left the index saying "running" for a turn that finished.
		const indexedRunning = index.sessions.filter(meta => meta.status === 'running').map(meta => meta.id);
		index = settleIndexAfterRestart(index);
		for (const meta of index.sessions) {
			if (this.onDisk.has(meta.id) || meta.turnCount === 0) {
				this.sessions.set(meta.id, meta);
			} else {
				rebuilt = true; // log vanished; drop the stale entry
			}
		}
		const missing = files.filter(id => !this.sessions.has(id));
		if (missing.length) {
			rebuilt = true;
			await Promise.all(missing.map(id => this.rebuildMeta(id)));
		}
		const settledFromLogs = await Promise.all(indexedRunning.filter(id => this.onDisk.has(id)).map(id => this.statusFromLog(id)));
		if (settledFromLogs.some(Boolean)) {
			rebuilt = true;
		}
		if (rebuilt) {
			this.scheduleIndexWrite();
		}
		this.scheduleSnoozeWake();
		this._onDidChange.fire();
	}

	private async listLogFiles(): Promise<string[]> {
		try {
			const stat = await this.fileService.resolve(this.sessionsDir);
			const ids: string[] = [];
			for (const child of stat.children ?? []) {
				if (child.isFile && child.name.endsWith(LOG_EXT)) {
					const id = safeSessionId(child.name.slice(0, -LOG_EXT.length));
					if (id) {
						ids.push(id);
					}
				}
			}
			return ids;
		} catch (err) {
			if (!isNotFound(err)) {
				this.logService.warn('[agent history] failed to list sessions', err);
			}
			return [];
		}
	}

	/** The log is the record: a session the index left "running" gets the status its last reply has. True when it changed. */
	private async statusFromLog(id: string): Promise<boolean> {
		try {
			const meta = this.sessions.get(id);
			const content = await this.fileService.readFile(this.logFileFor(id));
			const decoded = decodeLog(content.value.buffer);
			if (!meta || !decoded.header) {
				return false;
			}
			const status = deriveStatus(foldTranscript(decoded.header, decoded.entries));
			if (status === 'running' || status === meta.status) {
				return false;
			}
			this.sessions.set(id, { ...meta, status });
			return true;
		} catch {
			return false;
		}
	}

	private async rebuildMeta(id: string): Promise<void> {
		try {
			const content = await this.fileService.readFile(this.logFileFor(id));
			const decoded = decodeLog(content.value.buffer);
			if (!decoded.header) {
				return;
			}
			const transcript = foldTranscript(decoded.header, decoded.entries);
			const meta = deriveMeta(transcript);
			const hasDraft = await this.fileService.exists(this.draftFileFor(id));
			this.sessions.set(id, { ...meta, status: meta.status === 'running' ? 'interrupted' : meta.status, hasDraft });
		} catch (err) {
			this.logService.warn(`[agent history] failed to rebuild ${id}`, err);
		}
	}

	private scheduleIndexWrite(): void {
		this.indexDirty = true;
		if (this.indexTimer !== undefined) {
			return;
		}
		this.indexTimer = setTimeout(() => {
			this.indexTimer = undefined;
			void this.writeIndex();
		}, INDEX_WINDOW_MS);
	}

	private writeIndex(): Promise<void> {
		return this.indexQueue.run(async () => {
			if (!this.indexDirty) {
				return;
			}
			this.indexDirty = false;
			const index: IAgentHistoryIndex = { version: AGENT_HISTORY_FORMAT_VERSION, sessions: sortSessions([...this.sessions.values()]) };
			try {
				await this.ensureDirectories();
				await this.fileService.writeFile(this.indexFile, VSBuffer.fromString(JSON.stringify(index)), ATOMIC);
			} catch (err) {
				this.indexDirty = true;
				this.logService.error('[agent history] failed to write index', err);
			}
		});
	}

	/** @internal */
	updateMeta(meta: IAgentSessionMeta): void {
		const previous = this.sessions.get(meta.id);
		if (previous && shallowEqualMeta(previous, meta)) {
			return;
		}
		this.sessions.set(meta.id, meta);
		this.scheduleIndexWrite();
		this._onDidChange.fire();
	}

	//#endregion

	//#region Queries

	list(options?: IAgentHistoryListOptions): IAgentSessionMeta[] {
		const result: IAgentSessionMeta[] = [];
		for (const meta of this.sessions.values()) {
			if (!this.matches(meta, options)) {
				continue;
			}
			result.push(meta);
		}
		const sorted = sortSessions(result);
		return options?.limit !== undefined ? sorted.slice(0, options.limit) : sorted;
	}

	search(query: string, options?: IAgentHistoryListOptions): IAgentSessionMeta[] {
		const candidates = [...this.sessions.values()].filter(meta => this.matches(meta, options));
		const ranked = searchSessions(candidates, query, options);
		return options?.limit !== undefined ? ranked.slice(0, options.limit) : ranked;
	}

	private matches(meta: IAgentSessionMeta, options?: IAgentHistoryListOptions): boolean {
		if (meta.turnCount === 0 && !meta.hasDraft) {
			return false;
		}
		if (!options?.includeArchived && meta.archived) {
			return false;
		}
		if (options?.workspaceId && meta.workspaceId !== options.workspaceId) {
			return false;
		}
		return true;
	}

	get(id: string): IAgentSessionMeta | undefined {
		return this.sessions.get(id);
	}

	has(id: string): boolean {
		return this.onDisk.has(id) || this.handles.has(id);
	}

	//#endregion

	//#region Handles

	pinSessionWorkspace(id: string, workspace: IAgentSessionWorkspace): void {
		const safe = safeSessionId(id);
		if (!safe) {
			return;
		}
		this.pinnedWorkspaces.set(safe, workspace);
		this.handles.get(safe)?.adoptWorkspace(workspace);
	}

	pinnedWorkspace(id: string): IAgentSessionWorkspace | undefined {
		return this.pinnedWorkspaces.get(id);
	}

	pinSessionParent(id: string, parentId: string, options?: { readonly subagent?: boolean }): void {
		const safe = safeSessionId(id);
		if (!safe || !parentId || parentId === safe) {
			return;
		}
		this.pinnedParents.set(safe, parentId);
		if (options?.subagent) {
			this.pinnedSubagents.add(safe);
		}
		this.handles.get(safe)?.adoptParent(parentId, this.isSubagentSession(safe));
		// A chat saved before it became a side chat keeps the link in the index.
		const meta = this.sessions.get(safe);
		if (meta && (!meta.parentId || (options?.subagent && !meta.subagent))) {
			this.updateMeta({ ...meta, parentId: meta.parentId ?? parentId, ...(options?.subagent ? { subagent: true } : {}) });
		}
	}

	/** @internal */
	isSubagentSession(id: string): boolean {
		return this.pinnedSubagents.has(id) || !!this.sessions.get(id)?.subagent;
	}

	sessionParent(id: string): string | undefined {
		return this.pinnedParents.get(id) ?? this.sessions.get(id)?.parentId;
	}

	open(id: string): IAgentSessionHandle {
		const safe = safeSessionId(id);
		if (!safe) {
			throw new Error(`Invalid agent session id: ${id}`);
		}
		let handle = this.handles.get(safe);
		if (!handle) {
			handle = new SessionHandle(safe, this.logFileFor(safe), this.draftFileFor(safe), this, this.onDisk.has(safe), this.closing.get(safe));
			this.handles.set(safe, handle);
		}
		return handle;
	}

	/** @internal */
	rememberOnDisk(id: string): void {
		this.onDisk.add(id);
	}

	/** @internal */
	releaseHandle(handle: SessionHandle, closing: Promise<void>): void {
		if (this.handles.get(handle.id) === handle) {
			this.handles.delete(handle.id);
		}
		this.closing.set(handle.id, closing);
		void closing.finally(() => {
			if (this.closing.get(handle.id) === closing) {
				this.closing.delete(handle.id);
			}
		});
	}

	async flushAll(): Promise<void> {
		await Promise.all([...this.handles.values()].map(handle => handle.flush().catch(() => undefined)));
		if (this.indexTimer !== undefined) {
			clearTimeout(this.indexTimer);
			this.indexTimer = undefined;
		}
		await this.writeIndex();
	}

	//#endregion

	//#region Mutations

	async setPinned(id: string, pinned: boolean): Promise<void> {
		const meta = this.sessions.get(id);
		if (meta && !!meta.pinned !== pinned) {
			this.updateMeta({ ...meta, pinned });
		}
	}

	async setArchived(id: string, archived: boolean): Promise<void> {
		const meta = this.sessions.get(id);
		if (meta && !!meta.archived !== archived) {
			this.updateMeta({ ...meta, archived, pinned: archived ? false : meta.pinned });
		}
		if (archived) {
			const pending = this.instantiationService.invokeFunction(accessor => accessor.get(IAgentWorktreeService).pruneArchived());
			void pending.catch(err => this.logService.warn('[agent history] worktree prune failed', err));
		}
	}

	async setSettled(id: string, settled: boolean, options?: { readonly byUser?: boolean }): Promise<void> {
		const meta = this.sessions.get(id);
		if (!meta || !!meta.settled === settled) {
			return;
		}
		this.updateMeta({
			...meta,
			settled: settled || undefined,
			// Settled work leaves the pinned list too, the way T3 Code settles a thread.
			pinned: settled ? undefined : meta.pinned,
			unsettledAt: settled ? undefined : options?.byUser ? Date.now() : meta.unsettledAt,
			snoozed: settled ? undefined : meta.snoozed,
			snoozedUntil: settled ? undefined : meta.snoozedUntil,
			wokeAt: settled ? undefined : meta.wokeAt,
		});
		this.scheduleSnoozeWake();
	}

	async setAutoSettle(id: string, enabled: boolean): Promise<void> {
		const meta = this.sessions.get(id);
		if (meta && (meta.autoSettle !== false) !== enabled) {
			this.updateMeta({ ...meta, autoSettle: enabled ? undefined : false });
		}
	}

	async setSnoozed(id: string, snoozed: boolean, until?: number): Promise<void> {
		const meta = this.sessions.get(id);
		const snoozedUntil = snoozed ? until : undefined;
		if (!meta || (!!meta.snoozed === snoozed && meta.snoozedUntil === snoozedUntil)) {
			return;
		}
		this.updateMeta({
			...meta,
			snoozed: snoozed || undefined,
			snoozedUntil,
			settled: snoozed ? undefined : meta.settled,
			// Snoozing again drops the last wake; waking by hand is not a timed wake.
			wokeAt: undefined,
		});
		this.scheduleSnoozeWake();
	}

	async restoreLifecycle(id: string, lifecycle: IAgentSessionLifecycle): Promise<void> {
		const meta = this.sessions.get(id);
		if (!meta) {
			return;
		}
		this.updateMeta({ ...meta, ...lifecycle });
		this.scheduleSnoozeWake();
	}

	/** Returns snoozed sessions whose time has come, then waits for the next one. */
	private scheduleSnoozeWake(): void {
		if (this.snoozeTimer !== undefined) {
			clearTimeout(this.snoozeTimer);
			this.snoozeTimer = undefined;
		}
		const now = Date.now();
		let next = Number.POSITIVE_INFINITY;
		for (const meta of this.sessions.values()) {
			if (!meta.snoozed || meta.snoozedUntil === undefined) {
				continue;
			}
			if (meta.snoozedUntil <= now) {
				// Back in the list as something to look at again, marked as woken until it is opened.
				this.updateMeta({ ...meta, snoozed: undefined, snoozedUntil: undefined, unread: true, wokeAt: meta.snoozedUntil });
			} else {
				next = Math.min(next, meta.snoozedUntil);
			}
		}
		if (next !== Number.POSITIVE_INFINITY) {
			// setTimeout overflows past ~24.8 days; wake up early and look again.
			this.snoozeTimer = setTimeout(() => this.scheduleSnoozeWake(), Math.min(next - now, SNOOZE_TIMER_MAX_MS));
		}
	}

	async setUnread(id: string, unread: boolean): Promise<void> {
		const meta = this.sessions.get(id);
		if (meta && !!meta.unread !== unread) {
			this.updateMeta({ ...meta, unread: unread || undefined });
		}
	}

	async clearWoke(id: string): Promise<void> {
		const meta = this.sessions.get(id);
		if (meta?.wokeAt !== undefined) {
			// The row stays where waking put it: the chat you just opened does not jump down the list.
			this.updateMeta({ ...meta, wokeAt: undefined, updatedAt: Math.max(meta.updatedAt, meta.wokeAt) });
		}
	}

	async markAllRead(): Promise<void> {
		let changed = false;
		for (const meta of this.sessions.values()) {
			if (meta.unread) {
				this.sessions.set(meta.id, { ...meta, unread: undefined });
				changed = true;
			}
		}
		if (changed) {
			this.scheduleIndexWrite();
			this._onDidChange.fire();
		}
	}

	async setAttention(id: string, attention: AgentSessionAttention | undefined): Promise<void> {
		const meta = this.sessions.get(id);
		if (meta && meta.attention !== attention) {
			this.updateMeta({ ...meta, attention });
		}
	}

	async rename(id: string, title: string | undefined): Promise<void> {
		const meta = this.sessions.get(id);
		if (!meta) {
			return;
		}
		const handle = this.open(id);
		await handle.load();
		handle.setMeta({ title: title?.trim() ?? '' });
		await handle.flush();
	}

	async setAgentTitle(id: string, title: string): Promise<void> {
		const text = title.trim();
		const meta = this.sessions.get(id);
		if (!meta || !text || meta.customTitle) {
			return;
		}
		const handle = this.open(id);
		await handle.load();
		handle.setMeta({ agentTitle: text });
	}

	async delete(id: string): Promise<void> {
		const meta = this.sessions.get(id);
		if (meta?.worktreePath) {
			await this.instantiationService.invokeFunction(accessor => accessor.get(IAgentWorktreeService).removeForDeletedChat(meta.workspaceFolder, meta.worktreePath, meta.worktreeBranch));
		}
		const handle = this.handles.get(id);
		if (handle) {
			handle.abandon();
			await handle.idle;
			this.handles.delete(id);
		}
		await this.closing.get(id);
		this.sessions.delete(id);
		this.onDisk.delete(id);
		await Promise.all([
			this.fileService.del(this.logFileFor(id)).catch(err => { if (!isNotFound(err)) { this.logService.warn(`[agent history] failed to delete ${id}`, err); } }),
			this.fileService.del(this.draftFileFor(id)).catch(() => undefined),
		]);
		this.scheduleIndexWrite();
		this._onDidChange.fire();
	}

	//#endregion

	//#region Attachments

	async putAttachment(bytes: Uint8Array, mime: string): Promise<string> {
		const hash = await hashAsync(bytes);
		const fileName = attachmentFileName(hash, mime);
		const target = joinPath(this.attachmentsDir, fileName);
		await this.ensureDirectories();
		if (!(await this.fileService.exists(target))) {
			await this.fileService.writeFile(target, VSBuffer.wrap(bytes), ATOMIC);
		}
		return attachmentRef(fileName);
	}

	attachmentResource(ref: string): URI | undefined {
		const parsed = parseAttachmentRef(ref);
		return parsed ? joinPath(this.attachmentsDir, parsed.fileName) : undefined;
	}

	async getAttachment(ref: string): Promise<{ bytes: Uint8Array; mime: string } | undefined> {
		const parsed = parseAttachmentRef(ref);
		if (!parsed) {
			return undefined;
		}
		try {
			const content = await this.fileService.readFile(joinPath(this.attachmentsDir, parsed.fileName));
			return { bytes: content.value.buffer, mime: parsed.mime };
		} catch (err) {
			if (!isNotFound(err)) {
				this.logService.warn(`[agent history] failed to read attachment ${parsed.fileName}`, err);
			}
			return undefined;
		}
	}

	//#endregion

	//#region Storage helpers

	private logFileFor(id: string): URI {
		return joinPath(this.sessionsDir, `${id}${LOG_EXT}`);
	}

	private draftFileFor(id: string): URI {
		return joinPath(this.sessionsDir, `${id}${DRAFT_EXT}`);
	}

	/** @internal */
	ensureDirectories(): Promise<void> {
		if (!this.directoriesReady) {
			this.directoriesReady = (async () => {
				await this.fileService.createFolder(this.sessionsDir);
				await this.fileService.createFolder(this.attachmentsDir);
			})().catch(err => {
				this.directoriesReady = undefined;
				throw err;
			});
		}
		return this.directoriesReady;
	}

	//#endregion
}

function describeWorkspace(workspaceContextService: IWorkspaceContextService): IAgentSessionWorkspace {
	const workspace = workspaceContextService.getWorkspace();
	const folders = workspace.folders.map(folder => folder.uri.fsPath);
	const label = workspace.folders[0]?.name
		|| (workspace.configuration ? basename(workspace.configuration).replace(/\.code-workspace$/, '') : '')
		|| 'Untitled';
	return { id: workspace.id, label, folders };
}

function shallowEqualMeta(a: IAgentSessionMeta, b: IAgentSessionMeta): boolean {
	const keys = new Set([...Object.keys(a), ...Object.keys(b)]) as Set<keyof IAgentSessionMeta>;
	for (const key of keys) {
		if (a[key] !== b[key]) {
			return false;
		}
	}
	return true;
}

registerSingleton(IAgentHistoryService, AgentHistoryService, InstantiationType.Delayed);
