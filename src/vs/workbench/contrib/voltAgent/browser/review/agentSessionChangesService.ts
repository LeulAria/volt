/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { VSBuffer } from '../../../../../base/common/buffer.js';
import { Emitter, Event, IValueWithChangeEvent } from '../../../../../base/common/event.js';
import { Disposable, DisposableStore } from '../../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../../base/common/network.js';
import { basename, isAbsolute } from '../../../../../base/common/path.js';
import { joinPath } from '../../../../../base/common/resources.js';
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
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { IMultiDiffSourceResolver, IResolvedMultiDiffSource, MultiDiffEditorItem } from '../../../multiDiffEditor/browser/multiDiffSourceResolverService.js';
import { ISCMRepository, ISCMResource, ISCMService } from '../../../scm/common/scm.js';
import {
	AgentChangesScope,
	collectLastTurnFileChanges,
	collectSessionFileChanges,
	IAgentChangeTranscriptMessage,
	IAgentSessionChangeStats,
	IAgentSessionFileChange,
	normalizeAgentChangePath,
	sumAgentChangeStats,
} from './agentSessionChanges.js';

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
	getSnapshotText(resource: URI): string | undefined;
	discardFile(sessionId: string, uri: URI): Promise<boolean>;
}

interface ISessionRecord {
	uncommitted: IAgentSessionFileChange[];
	lastTurn: IAgentSessionFileChange[];
	resolved: Map<string, URI>;
	discarded: Map<string, { modified?: string }>;
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
	if (scope === 'lastTurn' || scope === 'staged' || scope === 'unstaged' || scope === 'uncommitted') {
		return { sessionId, scope };
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

function snapshotUri(sessionId: string, path: string, side: 'original' | 'modified'): URI {
	return URI.from({
		scheme: Schemas.voltAgentSnapshot,
		path: `/${path}`,
		query: `session=${encodeURIComponent(sessionId)}&side=${side}`,
	});
}

export class AgentSessionChangesService extends Disposable implements IAgentSessionChangesService {

	declare readonly _serviceBrand: undefined;

	private readonly sessions = new Map<string, ISessionRecord>();
	private readonly repoListeners = this._register(new DisposableStore());
	private readonly _onDidChange = this._register(new Emitter<string>());
	readonly onDidChange = this._onDidChange.event;

	constructor(
		@IFileService private readonly fileService: IFileService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@ISCMService private readonly scmService: ISCMService,
		@IDialogService private readonly dialogService: IDialogService,
	) {
		super();
		this._register(this.scmService.onDidAddRepository(() => this.bindRepositories()));
		this._register(this.scmService.onDidRemoveRepository(() => this.bindRepositories()));
		this.bindRepositories();
	}

	setSessionTranscript(sessionId: string, messages: readonly IAgentChangeTranscriptMessage[]): void {
		const previous = this.sessions.get(sessionId);
		const discarded = previous?.discarded ?? new Map<string, { modified?: string }>();
		const uncommitted = this.applyDiscards(collectSessionFileChanges(messages), discarded);
		const lastTurn = this.applyDiscards(collectLastTurnFileChanges(messages), discarded);
		this.sessions.set(sessionId, {
			uncommitted,
			lastTurn,
			resolved: previous?.resolved ?? new Map<string, URI>(),
			discarded,
		});
		void this.resolveSessionPaths(sessionId);
		this._onDidChange.fire(sessionId);
	}

	clearSession(sessionId: string): void {
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
		if (scope === 'staged') {
			return this.scmStats('index');
		}
		if (scope === 'unstaged') {
			return this.scmStats('workingTree', 'untracked');
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
		if (scope === 'staged') {
			return this.scmItems('index');
		}
		if (scope === 'unstaged') {
			return this.scmItems('workingTree', 'untracked');
		}
		return this.getFiles(sessionId, scope === 'lastTurn' ? 'lastTurn' : 'uncommitted')
			.map(file => this.toDiffItem(sessionId, file));
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

		const target = session.resolved.get(file.path) ?? (uri.scheme === Schemas.file || uri.scheme === Schemas.vscodeRemote ? uri : undefined);
		if (file.kind === 'added') {
			if (target && await this.fileService.exists(target)) {
				await this.fileService.del(target, { useTrash: true });
			}
		} else if (target || file.original !== undefined) {
			const resource = target ?? await this.resolvePath(file.path);
			if (resource) {
				await this.fileService.writeFile(resource, VSBuffer.fromString(file.original ?? ''));
			}
		}

		session.discarded.set(file.path, { modified: file.modified });
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
			if (discardedAt.modified !== file.modified) {
				discarded.delete(file.path);
				return true;
			}
			return false;
		});
	}

	private toDiffItem(sessionId: string, file: IAgentSessionFileChange): MultiDiffEditorItem {
		const workspace = this.sessions.get(sessionId)?.resolved.get(file.path);
		const originalSnapshot = file.kind !== 'added'
			? snapshotUri(sessionId, file.path, 'original')
			: undefined;
		const modifiedSnapshot = file.kind !== 'deleted'
			? snapshotUri(sessionId, file.path, 'modified')
			: undefined;
		const originalUri = file.kind === 'added' ? undefined : originalSnapshot;
		const modifiedUri = file.kind === 'deleted' ? undefined : (workspace ?? modifiedSnapshot);
		const goTo = workspace ?? modifiedUri ?? originalUri ?? snapshotUri(sessionId, file.path, 'modified');
		return new MultiDiffEditorItem(
			originalUri,
			modifiedUri ?? (file.kind === 'deleted' ? undefined : goTo),
			goTo,
			undefined,
			{
				voltAgentChangeKind: file.kind,
				voltAgentChangesFile: true,
				voltAgentChangesSession: sessionId,
				scmProvider: 'git',
				scmResourceGroup: 'workingTree',
			},
		);
	}

	private findFile(session: ISessionRecord, uri: URI): IAgentSessionFileChange | undefined {
		const snapshot = parseAgentSnapshotUri(uri);
		const files = [...session.uncommitted, ...session.lastTurn];
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
	) { }

	async provideTextContent(resource: URI): Promise<ITextModel | null> {
		const text = this.changesService.getSnapshotText(resource) ?? '';
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

registerSingleton(IAgentSessionChangesService, AgentSessionChangesService, InstantiationType.Delayed);
