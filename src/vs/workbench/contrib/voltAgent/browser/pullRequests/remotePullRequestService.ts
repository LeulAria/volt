/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter } from '../../../../../base/common/event.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { IStorageService } from '../../../../../platform/storage/common/storage.js';
import { IVoltPrRepo, IVoltPrRepoRef, IVoltPrRequest, IVoltPullRequest, IVoltPullRequestDetail, IVoltPullRequestService, VoltPrErrorCode, VoltPrMergeMethod } from '../../../../../platform/voltPullRequests/common/voltPullRequests.js';
import { IAgentServerClientService } from '../../../../services/voltAgentServer/common/agentServerClient.js';
import { IAgentHistoryService } from '../../../../services/voltRuntime/common/history/agentHistory.js';
import { IVoltSessionContextService } from '../../../../services/voltRuntime/common/sessionContext.js';
import { AgentPrLinkSource, IAgentPrLink } from '../../common/agentPullRequests.js';
import { IAgentPrCreateOptions, IAgentPrTarget, IAgentPullRequestService, prFolderFor, prSessionsFor, prSnapshot, readPrMergeMethod, storePrMergeMethod } from './agentPullRequestService.js';

const CHAT_PREFIX = 'chat:';

/**
 * Linked pull requests and their watches live in the agent server (watches wake chats while no
 * window is open). This window mirrors the links and reads, asks the server to act, and reaches
 * GitHub directly for its own views through `api`.
 */
export class RemotePullRequestService extends Disposable implements IAgentPullRequestService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChange = this._register(new Emitter<readonly string[]>());
	readonly onDidChange = this._onDidChange.event;
	private readonly _onDidChangePullRequest = this._register(new Emitter<string>());
	readonly onDidChangePullRequest = this._onDidChangePullRequest.event;
	private readonly _onDidReadDetail = this._register(new Emitter<IVoltPullRequestDetail>());
	readonly onDidReadDetail = this._onDidReadDetail.event;
	readonly whenReady: Promise<void>;

	constructor(
		@IVoltPullRequestService readonly api: IVoltPullRequestService,
		@IAgentServerClientService private readonly client: IAgentServerClientService,
		@IAgentHistoryService private readonly history: IAgentHistoryService,
		@IVoltSessionContextService private readonly sessionContext: IVoltSessionContextService,
		@IStorageService private readonly storageService: IStorageService,
	) {
		super();
		this.whenReady = client.whenReady;
		this._register(client.onDidChangeCollection(e => {
			if (e.col !== 'prs') {
				return;
			}
			const chats = e.keys.filter(key => key.startsWith(CHAT_PREFIX)).map(key => key.slice(CHAT_PREFIX.length));
			if (chats.length) {
				this._onDidChange.fire(chats);
			}
		}));
		this._register(client.onServerEvent(event => {
			const e = event as { kind?: string; key?: string; detail?: IVoltPullRequestDetail };
			if (e.kind === 'pr.changed' && e.key) {
				this._onDidChangePullRequest.fire(e.key);
			} else if (e.kind === 'pr.detail' && e.detail) {
				this._onDidReadDetail.fire(e.detail);
			}
		}));
	}

	private chats(): Map<string, readonly IAgentPrLink[]> {
		return new Map(this.client.mirror.entries<readonly IAgentPrLink[]>('prs')
			.filter(([key]) => key.startsWith(CHAT_PREFIX))
			.map(([key, links]) => [key.slice(CHAT_PREFIX.length), links]));
	}

	links(sessionId: string): readonly IAgentPrLink[] {
		return this.client.mirror.get<readonly IAgentPrLink[]>('prs', CHAT_PREFIX + sessionId) ?? [];
	}

	sessionsFor(key: string): string[] {
		return prSessionsFor(this.chats(), key);
	}

	snapshot(key: string): IVoltPullRequest | undefined {
		const known = this.client.mirror.get<Record<string, IVoltPullRequest>>('prs', 'known') ?? {};
		return prSnapshot(this.chats(), new Map(Object.entries(known)), key);
	}

	hostProblem(host: string): { readonly code: VoltPrErrorCode; readonly message: string } | undefined {
		return this.client.mirror.get<Record<string, { code: VoltPrErrorCode; message: string }>>('prs', 'hosts')?.[host.toLowerCase()];
	}

	folderFor(sessionId: string): string | undefined {
		return prFolderFor(this.history.get(sessionId), this.sessionContext.rootFor(sessionId));
	}

	link(sessionId: string, target: IAgentPrTarget, source: AgentPrLinkSource): Promise<IAgentPrLink> {
		return this.client.call('prs.link', sessionId, target, source);
	}

	unlink(sessionId: string, key: string): void {
		this.client.send('prs.unlink', sessionId, key);
	}

	watch(sessionId: string, key: string): Promise<IAgentPrLink> {
		return this.client.call('prs.watch', sessionId, key);
	}

	unwatch(sessionId: string, key: string): void {
		this.client.send('prs.unwatch', sessionId, key);
	}

	refresh(keys?: readonly string[]): Promise<void> {
		return this.client.call('prs.refresh', keys);
	}

	repoFor(sessionId: string): Promise<IVoltPrRepo | undefined> {
		return this.client.call('prs.repoFor', sessionId);
	}

	repoForFolder(folder: string, force?: boolean): Promise<IVoltPrRepo | undefined> {
		return this.client.call('prs.repoForFolder', folder, force);
	}

	detail(request: IVoltPrRequest, force?: boolean): Promise<IVoltPullRequestDetail> {
		return this.client.call('prs.detail', request, force);
	}

	create(sessionId: string | undefined, folder: string, options: IAgentPrCreateOptions): Promise<IVoltPullRequest> {
		return this.client.call('prs.create', sessionId, folder, options);
	}

	generatePullRequestText(folder: string, base: string, sessionId?: string): Promise<{ title: string; body: string } | undefined> {
		return this.client.call('prs.generatePullRequestText', folder, base, sessionId);
	}

	generateCommitMessage(folder: string, sessionId?: string): Promise<string | undefined> {
		return this.client.call('prs.generateCommitMessage', folder, sessionId);
	}

	/** The merge button's default is this window's preference, as before. */
	lastMergeMethod(repo: IVoltPrRepoRef): VoltPrMergeMethod | undefined {
		return readPrMergeMethod(this.storageService, repo);
	}

	rememberMergeMethod(repo: IVoltPrRepoRef, method: VoltPrMergeMethod): void {
		storePrMergeMethod(this.storageService, repo, method);
	}
}
