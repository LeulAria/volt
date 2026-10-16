/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { joinPath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { IEnvironmentService } from '../../../../platform/environment/common/environment.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { AgentSessionAttention, IAgentForkOrigin, IAgentHistoryListOptions, IAgentHistoryService, IAgentSessionAppendAssistant, IAgentSessionDraft, IAgentSessionHandle, IAgentSessionLifecycle, IAgentSessionMeta, IAgentSessionTranscript, IAgentSessionTruncation, IAgentSessionWorkspace } from '../../voltRuntime/common/history/agentHistory.js';
import { describeWorkspace, matchesHistoryListOptions, parseAttachmentRef, searchSessions, sortSessions } from '../../voltRuntime/common/history/agentHistoryLog.js';
import { IAgentServerClientService } from './agentServerClient.js';

interface IHistoryMetaState {
	readonly onDisk: readonly string[];
	readonly pinnedWorkspaces: Readonly<Record<string, IAgentSessionWorkspace>>;
	readonly pinnedParents: Readonly<Record<string, string>>;
	readonly pinnedSubagents: readonly string[];
}

/**
 * Chat history kept by the agent server, as this window sees it: the index is the mirrored
 * `history` collection, reads and writes of a chat's log are calls. Pins are applied here at once
 * (views read them back right away) and on the server.
 */
export class RemoteAgentHistoryService extends Disposable implements IAgentHistoryService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange = this._onDidChange.event;
	private readonly _onDidTruncate = this._register(new Emitter<IAgentSessionTruncation>());
	readonly onDidTruncate = this._onDidTruncate.event;
	readonly whenReady: Promise<void>;
	readonly currentWorkspace: IAgentSessionWorkspace;

	private readonly handles = new Map<string, RemoteSessionHandle>();
	private readonly localWorkspaces = new Map<string, IAgentSessionWorkspace>();
	private readonly localParents = new Map<string, string>();
	private readonly attachmentsDir: URI;

	constructor(
		@IAgentServerClientService private readonly client: IAgentServerClientService,
		@IWorkspaceContextService workspaceContextService: IWorkspaceContextService,
		@IEnvironmentService environmentService: IEnvironmentService,
	) {
		super();
		this.whenReady = client.whenReady;
		this.currentWorkspace = describeWorkspace(workspaceContextService);
		// The server writes attachments into this profile's own user data, on this machine.
		this.attachmentsDir = joinPath(environmentService.userRoamingDataHome, 'agentSessions', 'attachments');
		this._register(client.onDidChangeCollection(e => {
			if (e.col === 'history' || e.col === 'history.meta') {
				this._onDidChange.fire();
			}
		}));
	}

	private get metaState(): IHistoryMetaState | undefined {
		return this.client.mirror.get<IHistoryMetaState>('history.meta', 'state');
	}

	private all(): IAgentSessionMeta[] {
		return this.client.mirror.values<IAgentSessionMeta>('history');
	}

	list(options?: IAgentHistoryListOptions): IAgentSessionMeta[] {
		const sorted = sortSessions(this.all().filter(meta => matchesHistoryListOptions(meta, options)));
		return options?.limit !== undefined ? sorted.slice(0, options.limit) : sorted;
	}

	search(query: string, options?: IAgentHistoryListOptions): IAgentSessionMeta[] {
		const ranked = searchSessions(this.all().filter(meta => matchesHistoryListOptions(meta, options)), query, options);
		return options?.limit !== undefined ? ranked.slice(0, options.limit) : ranked;
	}

	get(id: string): IAgentSessionMeta | undefined {
		return this.client.mirror.get<IAgentSessionMeta>('history', id);
	}

	has(id: string): boolean {
		return !!this.metaState?.onDisk.includes(id) || this.handles.has(id) || this.client.mirror.has('history', id);
	}

	open(id: string): IAgentSessionHandle {
		let handle = this.handles.get(id);
		if (!handle) {
			handle = new RemoteSessionHandle(id, this.client, () => this.get(id), truncation => this._onDidTruncate.fire(truncation));
			this.handles.set(id, handle);
		}
		return handle;
	}

	/** Reads ahead only where logs are local; the agent server answers opens itself. */
	prefetch(_id: string): void { }

	readTranscript(id: string): Promise<IAgentSessionTranscript | undefined> {
		return this.client.call('history.readTranscript', id);
	}

	pinSessionWorkspace(id: string, workspace: IAgentSessionWorkspace): void {
		this.localWorkspaces.set(id, workspace);
		this.client.send('history.pinSessionWorkspace', id, workspace);
	}

	pinnedWorkspace(id: string): IAgentSessionWorkspace | undefined {
		return this.localWorkspaces.get(id) ?? this.metaState?.pinnedWorkspaces[id];
	}

	pinSessionParent(id: string, parentId: string, options?: { readonly subagent?: boolean }): void {
		this.localParents.set(id, parentId);
		this.client.send('history.pinSessionParent', id, parentId, options);
	}

	sessionParent(id: string): string | undefined {
		return this.localParents.get(id) ?? this.metaState?.pinnedParents[id] ?? this.get(id)?.parentId;
	}

	setPinned(id: string, pinned: boolean): Promise<void> { return this.client.call('history.setPinned', id, pinned); }
	setArchived(id: string, archived: boolean): Promise<void> { return this.client.call('history.setArchived', id, archived); }
	setSettled(id: string, settled: boolean, options?: { readonly byUser?: boolean }): Promise<void> { return this.client.call('history.setSettled', id, settled, options); }
	setAutoSettle(id: string, enabled: boolean): Promise<void> { return this.client.call('history.setAutoSettle', id, enabled); }
	setSnoozed(id: string, snoozed: boolean, until?: number): Promise<void> { return this.client.call('history.setSnoozed', id, snoozed, until); }
	restoreLifecycle(id: string, lifecycle: IAgentSessionLifecycle): Promise<void> { return this.client.call('history.restoreLifecycle', id, lifecycle); }
	setUnread(id: string, unread: boolean): Promise<void> { return this.client.call('history.setUnread', id, unread); }
	clearWoke(id: string): Promise<void> { return this.client.call('history.clearWoke', id); }
	markAllRead(): Promise<void> { return this.client.call('history.markAllRead'); }
	setAttention(id: string, attention: AgentSessionAttention | undefined): Promise<void> { return this.client.call('history.setAttention', id, attention); }
	rename(id: string, title: string | undefined): Promise<void> { return this.client.call('history.rename', id, title); }
	setAgentTitle(id: string, title: string): Promise<void> { return this.client.call('history.setAgentTitle', id, title); }

	async delete(id: string): Promise<void> {
		this.handles.delete(id);
		await this.client.call('history.delete', id);
	}

	putAttachment(bytes: Uint8Array, mime: string): Promise<string> {
		return this.client.call('history.putAttachment', bytes, mime);
	}

	getAttachment(ref: string): Promise<{ bytes: Uint8Array; mime: string } | undefined> {
		return this.client.call('history.getAttachment', ref);
	}

	attachmentResource(ref: string): URI | undefined {
		const parsed = parseAttachmentRef(ref);
		return parsed ? joinPath(this.attachmentsDir, parsed.fileName) : undefined;
	}

	async flushAll(): Promise<void> {
		await Promise.all([...this.handles.values()].map(handle => handle.flush()));
	}
}

/** One chat's log on the server. Writes are sent in order; reads ask the server. */
class RemoteSessionHandle implements IAgentSessionHandle {

	private chain: Promise<unknown> = Promise.resolve();

	constructor(
		readonly id: string,
		private readonly client: IAgentServerClientService,
		private readonly readMeta: () => IAgentSessionMeta | undefined,
		private readonly didTruncate: (truncation: IAgentSessionTruncation) => void,
	) { }

	get meta(): IAgentSessionMeta | undefined {
		return this.readMeta();
	}

	load(): Promise<IAgentSessionTranscript> {
		return this.client.call('history.handle.load', this.id);
	}

	loadDraft(): Promise<IAgentSessionDraft | undefined> {
		return this.client.call('history.handle.loadDraft', this.id);
	}

	appendUser(turn: string, text: string, message: unknown): void {
		this.write('appendUser', turn, text, message);
	}

	appendAssistant(entry: IAgentSessionAppendAssistant): void {
		this.write('appendAssistant', entry);
	}

	truncate(fromTurn: string): void {
		// The turns it drops, read before the write lands, for listeners such as the usage ledger.
		const next = this.chain.then(async () => {
			const turns = (await this.load().catch(() => undefined))?.turns ?? [];
			await this.client.call('history.handle.truncate', this.id, fromTurn);
			const index = turns.findIndex(turn => turn.id === fromTurn);
			if (index >= 0) {
				this.didTruncate({ sessionId: this.id, index, turns: turns.slice(index) });
			}
		});
		this.chain = next.catch(() => undefined);
	}

	setMeta(meta: { title?: string; agentTitle?: string; mode?: string; model?: string; worktreePath?: string; worktreeBranch?: string; forkOf?: IAgentForkOrigin }): void {
		this.write('setMeta', meta);
	}

	saveDraft(draft: Omit<IAgentSessionDraft, 'updatedAt'> | undefined): void {
		this.write('saveDraft', draft);
	}

	flush(): Promise<void> {
		return this.chain.then(() => this.client.call('history.handle.flush', this.id));
	}

	close(): Promise<void> {
		return this.flush();
	}

	private write(method: string, ...args: unknown[]): void {
		const next = this.chain.then(() => this.client.call(`history.handle.${method}`, this.id, ...args));
		this.chain = next.catch(() => undefined);
	}
}
