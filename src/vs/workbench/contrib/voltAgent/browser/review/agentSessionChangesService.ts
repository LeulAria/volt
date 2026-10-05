/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event, IValueWithChangeEvent } from '../../../../../base/common/event.js';
import { Disposable, DisposableStore } from '../../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../../base/common/network.js';
import { basename, isAbsolute } from '../../../../../base/common/path.js';
import { isEqual, isEqualOrParent, joinPath } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { ILanguageService } from '../../../../../editor/common/languages/language.js';
import { IModelService } from '../../../../../editor/common/services/model.js';
import { ITextModel } from '../../../../../editor/common/model.js';
import { ITextModelContentProvider } from '../../../../../editor/common/services/resolverService.js';
import { localize } from '../../../../../nls.js';
import { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { InstantiationType, registerSingleton } from '../../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IVoltGitService } from '../../../../../platform/voltGit/common/voltGit.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { IMultiDiffSourceResolver, IResolvedMultiDiffSource, MultiDiffEditorItem } from '../../../multiDiffEditor/browser/multiDiffSourceResolverService.js';
import { ISCMRepository, ISCMResource, ISCMService } from '../../../scm/common/scm.js';
import {
	AgentChangesScope,
	agentScopeTurnId,
	collectLastTurnFileChanges,
	collectSessionFileChanges,
	fileChangesSignature,
	IAgentChangesTurn,
	IAgentChangeTranscriptMessage,
	IAgentSessionChangeStats,
	IAgentSessionFileChange,
	IAgentSnapshotFileChange,
	mergeSnapshotChanges,
	normalizeAgentChangePath,
	sumAgentChangeStats,
} from './agentSessionChanges.js';
import { IAgentEditsService, IAgentPendingFile } from './agentEditsService.js';
import { IAgentCheckpointService, IAgentSnapshotChange } from './agentCheckpointService.js';
import { IVoltSessionContextService } from '../../../../services/voltRuntime/common/sessionContext.js';

export const IAgentSessionChangesService = createDecorator<IAgentSessionChangesService>('voltAgentSessionChanges');

export interface IAgentChangesOverview {
	readonly filesChanged: IAgentSessionChangeStats;
	readonly lastTurn: IAgentSessionChangeStats;
	readonly staged: IAgentSessionChangeStats;
	readonly unstaged: IAgentSessionChangeStats;
}

export interface IAgentSessionChangesService {
	readonly _serviceBrand: undefined;
	readonly onDidChange: Event<string>;
	setSessionTranscript(sessionId: string, messages: readonly IAgentChangeTranscriptMessage[]): void;
	clearSession(sessionId: string): void;
	getFiles(sessionId: string, scope: 'uncommitted' | 'lastTurn'): readonly IAgentSessionFileChange[];
	getStats(sessionId: string, scope?: AgentChangesScope): IAgentSessionChangeStats;
	getOverview(sessionId: string): IAgentChangesOverview;
	getMultiDiffItems(sessionId: string, scope: AgentChangesScope): readonly MultiDiffEditorItem[];
	/** A file's line counts in `scope`, for the review's file headers; undefined when unknown (Staged, Unstaged). */
	getFileStats(sessionId: string, scope: AgentChangesScope, uri: URI): IAgentSessionChangeStats | undefined;
	/** The chat's turns that changed files, oldest first. */
	getTurns(sessionId: string): readonly IAgentChangesTurn[];
	/** Reads one turn's changes from its snapshots; {@link getStats} has them afterwards. */
	loadTurn(sessionId: string, turnId: string): Promise<IAgentSessionChangeStats>;
	getSnapshotText(resource: URI): string | undefined;
	discardFile(sessionId: string, uri: URI): Promise<boolean>;
}

interface ISessionRecord {
	/** What the transcript's file blocks say. */
	transcript: { uncommitted: IAgentSessionFileChange[]; lastTurn: IAgentSessionFileChange[] };
	/** What the agent's snapshots say (shell side effects, renames, binaries included). */
	snapshot: { uncommitted: IAgentSnapshotFileChange[]; lastTurn: IAgentSnapshotFileChange[] };
	/** The two merged, minus discarded files. */
	uncommitted: IAgentSessionFileChange[];
	lastTurn: IAgentSessionFileChange[];
	resolved: Map<string, URI>;
	discarded: Map<string, { modified?: string }>;
	/** The file blocks this record was computed from; see fileChangesSignature. */
	signature?: string;
	/** User message prompts by message id, to name turns. */
	prompts: Map<string, string>;
}

export function getAgentChangesSourceUri(sessionId: string, scope: AgentChangesScope): URI {
	return URI.from({
		scheme: Schemas.voltAgentChanges,
		path: `/${sessionId}`,
		query: `scope=${scope}`,
	});
}

export function parseAgentChangesSourceUri(uri: URI): { sessionId: string; scope: AgentChangesScope } | undefined {
	if (uri.scheme !== Schemas.voltAgentChanges) {
		return undefined;
	}
	const sessionId = uri.path.replace(/\//g, '');
	if (!sessionId) {
		return undefined;
	}
	const scope = new URLSearchParams(uri.query).get('scope');
	if (scope === 'pending' || scope === 'lastTurn' || scope === 'staged' || scope === 'unstaged' || scope === 'uncommitted') {
		return { sessionId, scope };
	}
	const turnId = scope ? agentScopeTurnId(scope) : undefined;
	if (turnId) {
		return { sessionId, scope: `turn:${turnId}` };
	}
	return { sessionId, scope: 'uncommitted' };
}

export function parseAgentSnapshotUri(uri: URI): { sessionId: string; path: string; side: 'original' | 'modified' } | undefined {
	if (uri.scheme !== Schemas.voltAgentSnapshot) {
		return undefined;
	}
	const query = new URLSearchParams(uri.query);
	const sessionId = query.get('session');
	const side = query.get('side');
	const path = normalizeAgentChangePath(uri.path);
	if (!sessionId || !path || (side !== 'original' && side !== 'modified')) {
		return undefined;
	}
	return { sessionId, path, side };
}

function snapshotUri(sessionId: string, path: string, side: 'original' | 'modified', blob?: { repoRoot: string; sha: string }): URI {
	return URI.from({
		scheme: Schemas.voltAgentSnapshot,
		path: `/${path}`,
		query: `session=${encodeURIComponent(sessionId)}&side=${side}${blob ? `&repo=${encodeURIComponent(blob.repoRoot)}&blob=${blob.sha}` : ''}`,
	});
}

/** A snapshot URI that names a git blob: its text comes from the snapshot repo. */
export function parseAgentBlobUri(uri: URI): { repoRoot: string; sha: string; path: string } | undefined {
	if (uri.scheme !== Schemas.voltAgentSnapshot) {
		return undefined;
	}
	const query = new URLSearchParams(uri.query);
	const repoRoot = query.get('repo');
	const sha = query.get('blob');
	return repoRoot && sha && /^[0-9a-f]{40,64}$/.test(sha) ? { repoRoot, sha, path: normalizeAgentChangePath(uri.path) } : undefined;
}

function toSnapshotFileChange(change: IAgentSnapshotChange, oldUri: URI | undefined): IAgentSnapshotFileChange {
	return {
		path: change.path,
		oldPath: change.oldPath,
		absolutePath: change.uri.fsPath,
		oldAbsolutePath: oldUri?.fsPath,
		kind: change.kind,
		binary: change.binary,
		additions: change.additions,
		deletions: change.deletions,
		repoRoot: change.repoRoot,
		oldBlob: change.oldBlob,
		newBlob: change.newBlob,
		turnId: change.turnId,
	};
}

export class AgentSessionChangesService extends Disposable implements IAgentSessionChangesService {

	declare readonly _serviceBrand: undefined;

	private readonly sessions = new Map<string, ISessionRecord>();
	/** One turn's changes per chat, by turn id; dropped when the chat's snapshots change. */
	private readonly turnFiles = new Map<string, Map<string, { files?: IAgentSessionFileChange[]; load: Promise<IAgentSessionFileChange[]> }>>();
	private readonly repoListeners = this._register(new DisposableStore());
	private readonly _onDidChange = this._register(new Emitter<string>());
	readonly onDidChange = this._onDidChange.event;

	constructor(
		@IFileService private readonly fileService: IFileService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@ISCMService private readonly scmService: ISCMService,
		@IDialogService private readonly dialogService: IDialogService,
		@IAgentEditsService private readonly edits: IAgentEditsService,
		@IVoltSessionContextService private readonly sessionContext: IVoltSessionContextService,
		@IAgentCheckpointService private readonly checkpoints: IAgentCheckpointService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this._register(this.checkpoints.onDidChange(sessionId => {
			this.turnFiles.delete(sessionId);
			if (this.sessions.has(sessionId)) {
				void this.refreshSnapshot(sessionId);
			}
		}));
		this._register(this.edits.onDidChange(uri => {
			const owner = this.edits.getPendingFile(uri)?.sessionId;
			if (owner) {
				this._onDidChange.fire(owner);
			} else {
				this.fireAll();
			}
		}));
		this._register(this.scmService.onDidAddRepository(() => this.bindRepositories()));
		this._register(this.scmService.onDidRemoveRepository(() => this.bindRepositories()));
		this.bindRepositories();
	}

	setSessionTranscript(sessionId: string, messages: readonly IAgentChangeTranscriptMessage[]): void {
		const previous = this.sessions.get(sessionId);
		const prompts = new Map<string, string>();
		for (const message of messages) {
			if (message.kind === 'user' && message.id && message.text) {
				prompts.set(message.id, message.text);
			}
		}
		if (previous) {
			previous.prompts = prompts;
		}
		const signature = fileChangesSignature(messages);
		if (previous && previous.signature === signature) {
			return;
		}
		const inProject = (path: string) => this.isInProject(sessionId, path);
		const record: ISessionRecord = {
			transcript: { uncommitted: collectSessionFileChanges(messages, inProject), lastTurn: collectLastTurnFileChanges(messages, inProject) },
			snapshot: previous?.snapshot ?? { uncommitted: [], lastTurn: [] },
			uncommitted: [],
			lastTurn: [],
			resolved: previous?.resolved ?? new Map<string, URI>(),
			discarded: previous?.discarded ?? new Map<string, { modified?: string }>(),
			signature,
			prompts,
		};
		this.merge(record);
		this.sessions.set(sessionId, record);
		if (!previous) {
			void this.refreshSnapshot(sessionId);
		}
		void this.resolveSessionPaths(sessionId);
		this._onDidChange.fire(sessionId);
	}

	private merge(record: ISessionRecord): void {
		record.uncommitted = this.applyDiscards(mergeSnapshotChanges(record.transcript.uncommitted, record.snapshot.uncommitted), record.discarded);
		record.lastTurn = this.applyDiscards(mergeSnapshotChanges(record.transcript.lastTurn, record.snapshot.lastTurn), record.discarded);
	}

	/** Pulls the chat's snapshot diff, so changes no tool reported show up too. */
	private async refreshSnapshot(sessionId: string): Promise<void> {
		try {
			const [uncommitted, lastTurn] = await Promise.all([this.checkpoints.getChanges(sessionId, 'session'), this.checkpoints.getChanges(sessionId, 'lastTurn')]);
			const record = this.sessions.get(sessionId);
			if (!record) {
				return;
			}
			const map = (changes: readonly IAgentSnapshotChange[]) => changes.map(change => {
				const oldUri = change.oldUri;
				for (const [path, uri] of [[change.path, change.uri], [change.oldPath, oldUri]] as const) {
					if (path && uri && !record.resolved.has(path)) {
						record.resolved.set(path, uri);
					}
				}
				return toSnapshotFileChange(change, oldUri);
			});
			record.snapshot = { uncommitted: map(uncommitted), lastTurn: map(lastTurn) };
			this.merge(record);
			this._onDidChange.fire(sessionId);
		} catch (err) {
			this.logService.trace('[volt] reading snapshot changes failed', err);
		}
	}

	/**
	 * Agents also write their own files outside the project (Claude's plan in ~/.claude/plans).
	 * Those are not changes the user reviews or commits. Relative paths are the project's.
	 */
	private isInProject(sessionId: string, path: string): boolean {
		path = path.replace(/^["'`]+|["'`]+$/g, '').trim();
		if (!isAbsolute(path)) {
			return true;
		}
		const roots = [this.sessionContext.rootFor(sessionId), ...this.workspaceContextService.getWorkspace().folders.map(folder => folder.uri)];
		const file = URI.file(path);
		return roots.some(root => !!root && isEqualOrParent(file, root));
	}

	clearSession(sessionId: string): void {
		this.turnFiles.delete(sessionId);
		if (!this.sessions.delete(sessionId)) {
			return;
		}
		this._onDidChange.fire(sessionId);
	}

	getFiles(sessionId: string, scope: 'uncommitted' | 'lastTurn'): readonly IAgentSessionFileChange[] {
		const session = this.sessions.get(sessionId);
		if (!session) {
			return [];
		}
		return scope === 'lastTurn' ? session.lastTurn : session.uncommitted;
	}

	getStats(sessionId: string, scope: AgentChangesScope = 'uncommitted'): IAgentSessionChangeStats {
		if (scope === 'pending') {
			const files = this.edits.getPendingFiles(sessionId);
			return {
				files: files.length,
				additions: files.reduce((sum, file) => sum + file.additions, 0),
				deletions: files.reduce((sum, file) => sum + file.deletions, 0),
			};
		}
		if (scope === 'staged') {
			return this.scmStats('index');
		}
		if (scope === 'unstaged') {
			return this.scmStats('workingTree', 'untracked');
		}
		const turnId = agentScopeTurnId(scope);
		if (turnId) {
			return sumAgentChangeStats(this.turnChanges(sessionId, turnId));
		}
		return sumAgentChangeStats(this.getFiles(sessionId, scope === 'lastTurn' ? 'lastTurn' : 'uncommitted'));
	}

	getOverview(sessionId: string): IAgentChangesOverview {
		return {
			filesChanged: this.getStats(sessionId, 'uncommitted'),
			lastTurn: this.getStats(sessionId, 'lastTurn'),
			staged: this.getStats(sessionId, 'staged'),
			unstaged: this.getStats(sessionId, 'unstaged'),
		};
	}

	getMultiDiffItems(sessionId: string, scope: AgentChangesScope): readonly MultiDiffEditorItem[] {
		if (scope === 'pending') {
			return this.edits.getPendingFiles(sessionId).map(file => this.pendingItem(sessionId, file));
		}
		if (scope === 'staged') {
			return this.scmItems('index');
		}
		if (scope === 'unstaged') {
			return this.scmItems('workingTree', 'untracked');
		}
		const turnId = agentScopeTurnId(scope);
		if (turnId) {
			return this.turnChanges(sessionId, turnId).map(file => this.toDiffItem(sessionId, file, true));
		}
		return this.getFiles(sessionId, scope === 'lastTurn' ? 'lastTurn' : 'uncommitted')
			.map(file => this.toDiffItem(sessionId, file));
	}

	getFileStats(sessionId: string, scope: AgentChangesScope, uri: URI): IAgentSessionChangeStats | undefined {
		if (scope === 'staged' || scope === 'unstaged') {
			return undefined;
		}
		if (scope === 'pending') {
			const file = this.edits.getPendingFiles(sessionId).find(file =>
				isEqual(file.uri, uri) || isEqual(file.modifiedUri, uri) || isEqual(file.baselineUri, uri));
			return file && { files: 1, additions: file.additions, deletions: file.deletions };
		}
		const session = this.sessions.get(sessionId);
		const turnId = agentScopeTurnId(scope);
		const files = turnId ? this.turnChanges(sessionId, turnId) : this.getFiles(sessionId, scope === 'lastTurn' ? 'lastTurn' : 'uncommitted');
		const file = session && this.matchFile(session, files, uri);
		return file && { files: 1, additions: file.additions, deletions: file.deletions };
	}

	getTurns(sessionId: string): readonly IAgentChangesTurn[] {
		const prompts = this.sessions.get(sessionId)?.prompts;
		return this.checkpoints.getCheckpoints(sessionId)
			.filter(checkpoint => checkpoint.after && checkpoint.after !== checkpoint.before)
			.map(checkpoint => ({ turnId: checkpoint.turnId, number: checkpoint.userTurn + 1, prompt: prompts?.get(checkpoint.turnId) }));
	}

	async loadTurn(sessionId: string, turnId: string): Promise<IAgentSessionChangeStats> {
		this.turnChanges(sessionId, turnId);
		return sumAgentChangeStats(await this.turnFiles.get(sessionId)?.get(turnId)?.load ?? []);
	}

	/** What is known of one turn's changes now; the first call reads them and fires a change when they arrive. */
	private turnChanges(sessionId: string, turnId: string): IAgentSessionFileChange[] {
		let turns = this.turnFiles.get(sessionId);
		if (!turns) {
			turns = new Map();
			this.turnFiles.set(sessionId, turns);
		}
		let entry = turns.get(turnId);
		if (!entry) {
			const created: { files?: IAgentSessionFileChange[]; load: Promise<IAgentSessionFileChange[]> } = {
				load: this.checkpoints.getChanges(sessionId, { turnId }).then(changes => {
					const resolved = this.sessions.get(sessionId)?.resolved;
					for (const change of changes) {
						if (resolved && !resolved.has(change.path)) {
							resolved.set(change.path, change.uri);
						}
					}
					created.files = mergeSnapshotChanges([], changes.map(change => toSnapshotFileChange(change, change.oldUri)));
					if (this.turnFiles.get(sessionId)?.get(turnId) === created) {
						this._onDidChange.fire(sessionId);
					}
					return created.files;
				}, err => {
					this.logService.trace('[volt] reading turn changes failed', err);
					return created.files = [];
				}),
			};
			entry = created;
			turns.set(turnId, entry);
		}
		return entry.files ?? [];
	}

	getSnapshotText(resource: URI): string | undefined {
		const parsed = parseAgentSnapshotUri(resource);
		if (!parsed) {
			return undefined;
		}
		const file = this.getFiles(parsed.sessionId, 'uncommitted').find(item => item.path === parsed.path)
			?? this.getFiles(parsed.sessionId, 'lastTurn').find(item => item.path === parsed.path);
		if (!file) {
			return undefined;
		}
		return parsed.side === 'original' ? file.original : file.modified;
	}

	async discardFile(sessionId: string, uri: URI): Promise<boolean> {
		const session = this.sessions.get(sessionId);
		if (!session) {
			return false;
		}
		const file = this.findFile(session, uri);
		if (!file) {
			return false;
		}
		const { confirmed } = await this.dialogService.confirm({
			type: 'warning',
			message: localize('voltAgent.discardConfirm', "Discard changes in {0}?", basename(file.path)),
			detail: localize('voltAgent.discardDetail', "Restores this file to how it looked before this agent edited it."),
			primaryButton: localize({ key: 'voltAgent.discardButton', comment: ['&& denotes a mnemonic'] }, "&&Discard"),
		});
		if (!confirmed) {
			return false;
		}

		// Only real baselines: this chat's pending entry, else its snapshots. Never transcript fragments.
		const direct = uri.scheme === Schemas.file || uri.scheme === Schemas.vscodeRemote ? uri : undefined;
		const target = session.resolved.get(file.path) ?? direct ?? await this.resolvePath(file.path);
		let done = false;
		if (target && this.edits.getPendingFile(target, sessionId)) {
			done = await this.edits.undoFile(target, sessionId);
		} else if (target) {
			let outcome = await this.checkpoints.restoreFile(sessionId, target);
			if (outcome === 'conflict') {
				const overwrite = await this.dialogService.confirm({
					type: 'warning',
					message: localize('voltAgent.discardConflict', "{0} was edited after the agent changed it.", basename(file.path)),
					detail: localize('voltAgent.discardConflictDetail', "Discarding the agent's changes would also discard those edits."),
					primaryButton: localize({ key: 'voltAgent.discardAnyway', comment: ['&& denotes a mnemonic'] }, "&&Discard Anyway"),
				});
				outcome = overwrite.confirmed ? await this.checkpoints.restoreFile(sessionId, target, { overwrite: true }) : 'conflict';
			}
			done = outcome !== 'conflict' && outcome !== 'unavailable';
			if (outcome === 'unavailable') {
				await this.dialogService.info(
					localize('voltAgent.discardUnavailable', "Volt has no copy of {0} from before the agent changed it.", basename(file.path)),
					localize('voltAgent.discardUnavailableDetail', "The file was left as it is. Use Source Control to restore it."),
				);
			}
		} else {
			await this.dialogService.info(localize('voltAgent.discardMissing', "Could not find {0} in the project.", basename(file.path)));
		}
		if (!done) {
			return false;
		}

		session.discarded.set(file.path, { modified: changeIdentity(file) });
		session.uncommitted = session.uncommitted.filter(item => item.path !== file.path);
		session.lastTurn = session.lastTurn.filter(item => item.path !== file.path);
		this._onDidChange.fire(sessionId);
		return true;
	}

	private applyDiscards(files: IAgentSessionFileChange[], discarded: Map<string, { modified?: string }>): IAgentSessionFileChange[] {
		return files.filter(file => {
			const discardedAt = discarded.get(file.path);
			if (!discardedAt) {
				return true;
			}
			if (discardedAt.modified !== changeIdentity(file)) {
				discarded.delete(file.path);
				return true;
			}
			return false;
		});
	}

	/** `pinned`: both sides from the snapshots (a past turn), never the file as it is now. */
	private toDiffItem(sessionId: string, file: IAgentSessionFileChange, pinned = false): MultiDiffEditorItem {
		const workspace = this.sessions.get(sessionId)?.resolved.get(file.path);
		const blob = (sha: string | undefined) => sha && file.snapshot ? { repoRoot: file.snapshot.repoRoot, sha } : undefined;
		const originalSnapshot = file.kind !== 'added'
			? snapshotUri(sessionId, file.path, 'original', blob(file.snapshot?.oldBlob))
			: undefined;
		const modifiedSnapshot = file.kind !== 'deleted'
			? snapshotUri(sessionId, file.path, 'modified', blob(file.snapshot?.newBlob))
			: undefined;
		const originalUri = file.kind === 'added' ? undefined : originalSnapshot;
		const modifiedUri = file.kind === 'deleted' ? undefined : pinned ? modifiedSnapshot : (workspace ?? modifiedSnapshot);
		const goTo = workspace ?? modifiedUri ?? originalUri ?? snapshotUri(sessionId, file.path, 'modified');
		return new MultiDiffEditorItem(
			originalUri,
			modifiedUri ?? (file.kind === 'deleted' ? undefined : goTo),
			goTo,
			undefined,
			// A past turn is history: nothing to discard from there.
			pinned ? {
				voltAgentChangeKind: file.kind,
				voltAgentChangesSession: sessionId,
			} : {
				voltAgentChangeKind: file.kind,
				voltAgentChangesFile: true,
				voltAgentChangesSession: sessionId,
				scmProvider: 'git',
				scmResourceGroup: 'workingTree',
			},
		);
	}

	private pendingItem(sessionId: string, file: IAgentPendingFile): MultiDiffEditorItem {
		return new MultiDiffEditorItem(
			file.kind === 'added' || file.binary ? undefined : file.baselineUri,
			file.kind === 'deleted' ? undefined : file.modifiedUri ?? file.uri,
			file.uri,
			undefined,
			{
				voltAgentChangeKind: file.kind,
				voltAgentPendingFile: true,
				voltAgentChangesSession: sessionId,
			},
		);
	}

	private findFile(session: ISessionRecord, uri: URI): IAgentSessionFileChange | undefined {
		return this.matchFile(session, [...session.uncommitted, ...session.lastTurn], uri);
	}

	private matchFile(session: ISessionRecord, files: readonly IAgentSessionFileChange[], uri: URI): IAgentSessionFileChange | undefined {
		const snapshot = parseAgentSnapshotUri(uri);
		if (snapshot) {
			return files.find(file => file.path === snapshot.path);
		}
		const resolved = files.find(file => session.resolved.get(file.path)?.toString() === uri.toString());
		if (resolved) {
			return resolved;
		}
		const path = normalizeAgentChangePath(uri.path);
		return files.find(file => file.path === path || path.endsWith(file.path) || file.path.endsWith(path));
	}

	private scmStats(...groupIds: string[]): IAgentSessionChangeStats {
		const items = this.scmItems(...groupIds);
		return { files: items.length, additions: 0, deletions: 0 };
	}

	private scmItems(...groupIds: string[]): MultiDiffEditorItem[] {
		const items: MultiDiffEditorItem[] = [];
		const seen = new Set<string>();
		for (const repository of this.scmService.repositories) {
			for (const group of repository.provider.groups) {
				if (!groupIds.includes(group.id)) {
					continue;
				}
				for (const resource of group.resources) {
					const key = (resource.multiDiffEditorModifiedUri ?? resource.sourceUri).toString();
					if (seen.has(key)) {
						continue;
					}
					seen.add(key);
					items.push(this.scmItem(resource, group.id));
				}
			}
		}
		return items;
	}

	private scmItem(resource: ISCMResource, groupId: string): MultiDiffEditorItem {
		const kind = !resource.multiDiffEditorOriginalUri && resource.multiDiffEditorModifiedUri
			? 'added'
			: !resource.multiDiffEditorModifiedUri && resource.multiDiffEditorOriginalUri
				? 'deleted'
				: 'modified';
		return new MultiDiffEditorItem(
			resource.multiDiffEditorOriginalUri,
			resource.multiDiffEditorModifiedUri,
			resource.sourceUri,
			undefined,
			{
				voltAgentChangeKind: kind,
				scmProvider: resource.resourceGroup.provider.providerId,
				scmResourceGroup: groupId,
			},
		);
	}

	private async resolveSessionPaths(sessionId: string): Promise<void> {
		const session = this.sessions.get(sessionId);
		if (!session) {
			return;
		}
		let changed = false;
		for (const file of [...session.uncommitted, ...session.lastTurn]) {
			if (session.resolved.has(file.path)) {
				continue;
			}
			const uri = await this.resolvePath(file.path);
			if (uri) {
				session.resolved.set(file.path, uri);
				changed = true;
			}
		}
		if (changed) {
			this._onDidChange.fire(sessionId);
		}
	}

	private async resolvePath(path: string): Promise<URI | undefined> {
		const trimmed = path.replace(/^["'`]+|["'`]+$/g, '').trim();
		if (!trimmed) {
			return undefined;
		}
		const candidates: URI[] = [];
		if (isAbsolute(trimmed)) {
			candidates.push(URI.file(trimmed));
		}
		for (const folder of this.workspaceContextService.getWorkspace().folders) {
			candidates.push(joinPath(folder.uri, trimmed.replace(/^\.\//, '')));
		}
		const seen = new Set<string>();
		for (const uri of candidates) {
			const key = uri.toString();
			if (seen.has(key)) {
				continue;
			}
			seen.add(key);
			if (await this.fileService.exists(uri)) {
				return uri;
			}
		}
		return undefined;
	}

	private bindRepositories(): void {
		this.repoListeners.clear();
		for (const repository of this.scmService.repositories) {
			this.bindRepository(repository);
		}
		this.fireAll();
	}

	private bindRepository(repository: ISCMRepository): void {
		this.repoListeners.add(repository.provider.onDidChangeResources(() => this.fireAll()));
		this.repoListeners.add(repository.provider.onDidChangeResourceGroups(() => this.fireAll()));
		for (const group of repository.provider.groups) {
			this.repoListeners.add(group.onDidChangeResources(() => this.fireAll()));
		}
	}

	private fireAll(): void {
		if (!this.sessions.size) {
			this._onDidChange.fire('');
			return;
		}
		for (const sessionId of this.sessions.keys()) {
			this._onDidChange.fire(sessionId);
		}
	}
}

export class AgentChangesMultiDiffSourceResolver implements IMultiDiffSourceResolver {

	constructor(@IAgentSessionChangesService private readonly changesService: IAgentSessionChangesService) { }

	canHandleUri(uri: URI): boolean {
		return parseAgentChangesSourceUri(uri) !== undefined;
	}

	async resolveDiffSource(uri: URI): Promise<IResolvedMultiDiffSource> {
		const parsed = parseAgentChangesSourceUri(uri)!;
		return new AgentChangesResolvedSource(this.changesService, parsed.sessionId, parsed.scope);
	}
}

class AgentChangesResolvedSource implements IResolvedMultiDiffSource {

	readonly resources;
	readonly contextKeys;

	constructor(
		private readonly changesService: IAgentSessionChangesService,
		private readonly sessionId: string,
		private readonly scope: AgentChangesScope,
	) {
		this.resources = new ValueWithChangeEventFromEvent(
			Event.filter(this.changesService.onDidChange, id => !id || id === this.sessionId),
			() => this.changesService.getMultiDiffItems(this.sessionId, this.scope),
		);
		this.contextKeys = {
			voltAgentChangesScope: this.scope,
			voltAgentChangesSession: this.sessionId,
		};
	}
}

class ValueWithChangeEventFromEvent<T> implements IValueWithChangeEvent<T> {

	readonly onDidChange: Event<void>;

	constructor(
		onDidChange: Event<unknown>,
		private readonly read: () => T,
	) {
		this.onDidChange = Event.map(onDidChange, () => undefined);
	}

	get value(): T {
		return this.read();
	}
}

export class AgentSnapshotContentProvider implements ITextModelContentProvider {

	constructor(
		@IAgentSessionChangesService private readonly changesService: IAgentSessionChangesService,
		@IModelService private readonly modelService: IModelService,
		@ILanguageService private readonly languageService: ILanguageService,
		@IVoltGitService private readonly gitService: IVoltGitService,
	) { }

	async provideTextContent(resource: URI): Promise<ITextModel | null> {
		const blob = parseAgentBlobUri(resource);
		const text = blob
			? (await this.gitService.readBlob({ repoRoot: blob.repoRoot, sha: blob.sha, path: blob.path }).catch(() => undefined))?.toString() ?? ''
			: this.changesService.getSnapshotText(resource) ?? '';
		const existing = this.modelService.getModel(resource);
		if (existing && !existing.isDisposed()) {
			if (existing.getValue() !== text) {
				existing.setValue(text);
			}
			return existing;
		}
		const language = this.languageService.createByFilepathOrFirstLine(resource, text.split(/\r?\n/, 1)[0]);
		return this.modelService.createModel(text, language, resource);
	}
}

/** What a discard is remembered by: the agent's last text, or its snapshot blob. */
function changeIdentity(file: IAgentSessionFileChange): string | undefined {
	return file.modified ?? file.snapshot?.newBlob;
}

registerSingleton(IAgentSessionChangesService, AgentSessionChangesService, InstantiationType.Delayed);
