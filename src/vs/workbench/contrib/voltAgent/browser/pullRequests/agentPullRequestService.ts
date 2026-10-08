/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IntervalTimer, RunOnceScheduler, SequencerByKey } from '../../../../../base/common/async.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable, DisposableMap } from '../../../../../base/common/lifecycle.js';
import { joinPath } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { localize } from '../../../../../nls.js';
import { IEnvironmentService } from '../../../../../platform/environment/common/environment.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { INotificationService, Severity } from '../../../../../platform/notification/common/notification.js';
import { IHostService } from '../../../../services/host/browser/host.js';
import { ILifecycleService } from '../../../../services/lifecycle/common/lifecycle.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { ISecretStorageService } from '../../../../../platform/secrets/common/secrets.js';
import { parsePullRequestUrl, prKey } from '../../../../../platform/voltPullRequests/common/voltPullRequestParse.js';
import { buildRestackConflictPrompt } from '../../../../../platform/voltPullRequests/common/voltPrStacks.js';
import {
	IVoltPrAccount,
	IVoltPrCreateRequest,
	IVoltPrHostCredential,
	IVoltPrRepo,
	IVoltPrRepoRef,
	IVoltPrRequest,
	IVoltPrRestackOutcome,
	IVoltPrSignInRequest,
	IVoltPrStackView,
	IVoltPullRequest,
	IVoltPullRequestDetail,
	IVoltPullRequestService,
	VoltPrErrorCode,
	VoltPrMergeMethod,
	voltPrErrorCode,
	voltPrErrorMessage,
} from '../../../../../platform/voltPullRequests/common/voltPullRequests.js';
import { IAgentHistoryService, IAgentSessionMeta } from '../../../../services/voltRuntime/common/history/agentHistory.js';
import { IVoltHostToolCall, IVoltHostToolInfo, IVoltHostToolResult, IVoltHostToolService } from '../../../../services/voltRuntime/common/hostTools.js';
import { IAgentOrchestratorService } from '../../../../services/voltRuntime/common/orchestration/orchestrator.js';
import { IAgentRuntimeService } from '../../../../services/voltRuntime/common/runtime.js';
import { IVoltSessionContextService } from '../../../../services/voltRuntime/common/sessionContext.js';
import {
	addLink,
	buildPullRequestTextPrompt,
	buildCommitMessagePrompt,
	buildWatchMessage,
	collectRemarks,
	commitMessageFrom,
	currentLink,
	discoveredPrBelongs,
	evaluateWatch,
	findPullRequestUrls,
	IAgentPrLink,
	isOpenState,
	isTerminalState,
	isTrunkBranch,
	newLink,
	parseGeneratedJson,
	PR_WATCH_FAILURE_LIMIT,
	removeLink,
	resolveChains,
	sanitizeCommitSubject,
	shouldSettleForPullRequests,
	showsPullRequests,
	startWatch,
	visibleLinks,
	watchSummary,
	AgentPrLinkSource,
} from '../../common/agentPullRequests.js';

export const IAgentPullRequestService = createDecorator<IAgentPullRequestService>('agentPullRequestService');

/** Where to find a pull request: its URL, or repository and number (the repository defaults to the chat's). */
export interface IAgentPrTarget {
	readonly url?: string;
	readonly repo?: IVoltPrRepoRef;
	readonly number?: number;
}

export interface IAgentPrCreateOptions {
	readonly title: string;
	readonly body: string;
	readonly base: string;
	readonly draft: boolean;
}

export interface IAgentPullRequestService {
	readonly _serviceBrand: undefined;
	/** Chats whose links or snapshots changed. */
	readonly onDidChange: Event<readonly string[]>;
	/** A pull request's snapshot or detail changed (by key). */
	readonly onDidChangePullRequest: Event<string>;
	/** Every fresh full read, so views showing it (viewed files, threads) update without reading again. */
	readonly onDidReadDetail: Event<IVoltPullRequestDetail>;
	/** A folder's repository gained or lost its `origin` remote (see {@link hasOrigin}). */
	readonly onDidChangeOrigin: Event<string>;
	readonly whenReady: Promise<void>;
	/** The platform service, for actions the views run directly. */
	readonly api: IVoltPullRequestService;

	links(sessionId: string): readonly IAgentPrLink[];
	/** Chats a pull request is linked to. */
	sessionsFor(key: string): string[];
	snapshot(key: string): IVoltPullRequest | undefined;
	link(sessionId: string, target: IAgentPrTarget, source: AgentPrLinkSource): Promise<IAgentPrLink>;
	unlink(sessionId: string, key: string): void;
	watch(sessionId: string, key: string): Promise<IAgentPrLink>;
	unwatch(sessionId: string, key: string): void;
	/** Syncs these pull requests (or every linked one) now. */
	refresh(keys?: readonly string[]): Promise<void>;
	/** The folder a chat's agent works in. */
	folderFor(sessionId: string): string | undefined;
	repoFor(sessionId: string): Promise<IVoltPrRepo | undefined>;
	repoForFolder(folder: string, force?: boolean): Promise<IVoltPrRepo | undefined>;
	/**
	 * Whether the folder's repository has an `origin` remote: pull request features show only then.
	 * Undefined until read; asking starts the read, and remote edits read it again.
	 */
	hasOrigin(folder: string): boolean | undefined;
	/** Full read for the pull request view; reused for a few seconds unless `force`. */
	detail(request: IVoltPrRequest, force?: boolean): Promise<IVoltPullRequestDetail>;
	/** Pushes the branch when needed, opens the pull request, and links it to the chat. */
	create(sessionId: string | undefined, folder: string, options: IAgentPrCreateOptions): Promise<IVoltPullRequest>;
	generatePullRequestText(folder: string, base: string, sessionId?: string): Promise<{ title: string; body: string } | undefined>;
	/** The stack a folder's branch (the checked out one by default) is in, bottom first, with each layer's pull request. */
	stack(folder: string, branch?: string): Promise<IVoltPrStackView | undefined>;
	/** Makes a layer on the checked out branch of `folder`, named from `title`, and checks it out. */
	stackNewBranch(folder: string, title: string): Promise<{ readonly branch: string; readonly parent: string }>;
	/** Restacks the stack `branch` is in and refreshes the pull requests it touched. */
	restack(folder: string, branch: string | undefined, syncTrunk: boolean): Promise<IVoltPrRestackOutcome>;
	/** A message for committing everything, or exactly `paths`. */
	generateCommitMessage(folder: string, sessionId?: string, paths?: readonly string[]): Promise<string | undefined>;
	/** The merge method last picked for a repository. */
	lastMergeMethod(repo: IVoltPrRepoRef): VoltPrMergeMethod | undefined;
	rememberMergeMethod(repo: IVoltPrRepoRef, method: VoltPrMergeMethod): void;
	/** What stopped the last sync of a host (no CLI, signed out); undefined when it works. */
	hostProblem(host: string): { readonly code: VoltPrErrorCode; readonly message: string } | undefined;
	/** Checks a token against its host, keeps it in secret storage, and syncs with it. */
	signInHost(request: IVoltPrSignInRequest): Promise<IVoltPrAccount>;
	/** Forgets the token Volt holds for a host. */
	signOutHost(host: string): Promise<void>;
	/** The hosts Volt holds a token for (never the tokens themselves). */
	signedInHosts(): readonly IVoltPrHostCredential[];
}

const STORE_VERSION = 1;
const TICK_MS = 15_000;
const OPEN_SYNC_MS = 60_000;
const PENDING_SYNC_MS = 40_000;
const WATCH_SYNC_MS = 45_000;
const CLOSED_SYNC_MS = 15 * 60_000;
const DISCOVERY_MS = 2 * 60_000;
/** Chats untouched for longer are not searched for branch pull requests. */
const DISCOVERY_RECENT_MS = 7 * 24 * 3_600_000;
const REPO_TTL_MS = 30_000;
/** Remotes are re-read on config edits and focus; this only catches what neither saw. */
const ORIGIN_TTL_MS = 60_000;
const DETAIL_TTL_MS = 8_000;
const MAX_BACKOFF_MS = 10 * 60_000;
const MERGE_METHOD_KEY = 'volt.pullRequests.mergeMethods';
/** Tokens the user gave Volt for code hosts other than GitHub (secret storage, JSON). */
const HOST_TOKENS_KEY = 'volt.pullRequests.hostTokens';

interface IStoreFile {
	readonly version: number;
	readonly chats: Record<string, IAgentPrLink[]>;
}

interface IOriginState {
	at: number;
	/** Undefined until the first read finishes. */
	shows?: boolean;
	configFile?: string;
	reading?: boolean;
}

interface IHostState {
	failures: number;
	until: number;
	problem?: { code: VoltPrErrorCode; message: string };
}

export class AgentPullRequestService extends Disposable implements IAgentPullRequestService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChange = this._register(new Emitter<readonly string[]>());
	readonly onDidChange = this._onDidChange.event;
	private readonly _onDidChangePullRequest = this._register(new Emitter<string>());
	readonly onDidChangePullRequest = this._onDidChangePullRequest.event;
	private readonly _onDidReadDetail = this._register(new Emitter<IVoltPullRequestDetail>());
	readonly onDidReadDetail = this._onDidReadDetail.event;
	private readonly _onDidChangeOrigin = this._register(new Emitter<string>());
	readonly onDidChangeOrigin = this._onDidChangeOrigin.event;

	readonly whenReady: Promise<void>;

	private readonly chats = new Map<string, readonly IAgentPrLink[]>();
	private readonly storeFile: URI;
	private readonly saveScheduler = this._register(new RunOnceScheduler(() => void this.save(), 400));
	private readonly repos = new Map<string, { at: number; repo: Promise<IVoltPrRepo | undefined> }>();
	private readonly origins = new Map<string, IOriginState>();
	/** Repository config files watched for remote edits (a linked worktree's is its main repository's). */
	private readonly configWatches = this._register(new DisposableMap<string>());
	private readonly details = new Map<string, { at: number; detail: Promise<IVoltPullRequestDetail> }>();
	private readonly hosts = new Map<string, IHostState>();
	private hostTokens: IVoltPrHostCredential[] = [];
	/** When each pull request was last read in a watch pass. */
	private readonly watchedAt = new Map<string, number>();
	private readonly linkLocks = new SequencerByKey<string>();
	private syncing: Promise<void> | undefined;
	private historyReady = false;
	private lastDiscovery = 0;
	private loaded = false;
	/** The last read of every pull request seen this session, linked or not (tab titles, lists). */
	private readonly known = new Map<string, IVoltPullRequest>();
	/** Turns already scanned for pull request URLs, per chat. */
	private readonly scannedTurns = new Map<string, string>();

	constructor(
		@IVoltPullRequestService public readonly api: IVoltPullRequestService,
		@IFileService private readonly fileService: IFileService,
		@IEnvironmentService environmentService: IEnvironmentService,
		@ILogService private readonly logService: ILogService,
		@IAgentHistoryService private readonly history: IAgentHistoryService,
		@IAgentOrchestratorService private readonly orchestrator: IAgentOrchestratorService,
		@IVoltSessionContextService private readonly sessionContext: IVoltSessionContextService,
		@IAgentRuntimeService private readonly runtime: IAgentRuntimeService,
		@IVoltHostToolService hostTools: IVoltHostToolService,
		@IStorageService private readonly storageService: IStorageService,
		@INotificationService private readonly notificationService: INotificationService,
		@ILifecycleService lifecycleService: ILifecycleService,
		@IHostService hostService: IHostService,
		@ISecretStorageService private readonly secretStorage: ISecretStorageService,
	) {
		super();
		this.storeFile = joinPath(environmentService.userRoamingDataHome, 'voltPullRequests', 'links.json');
		this.whenReady = Promise.all([this.load(), this.loadHostTokens()]).then(() => undefined);
		this._register(hostTools.registerToolProvider({
			tools: PULL_REQUEST_TOOLS,
			invoke: (name, args, call) => this.invokeTool(name, args, call),
		}));
		this._register(this.api.onDidChangeAccounts(() => {
			this.hosts.clear();
			void this.tick(true);
		}));
		// The user stopped the chat: it is no longer working on its own, so nothing wakes it (as in T3 Code).
		this._register(this.orchestrator.onDidStop(threadId => {
			for (const link of this.links(threadId)) {
				if (link.watch) {
					this.unwatch(threadId, link.key);
				}
			}
		}));
		// A finished turn may have pushed a branch or opened a pull request.
		this._register(this.orchestrator.onDidChange(change => {
			for (const threadId of change.threads) {
				const last = this.orchestrator.getThread(threadId)?.last;
				if (last && last.outcome === 'done' && this.scannedTurns.get(threadId) !== last.turnId) {
					this.scannedTurns.set(threadId, last.turnId);
					void this.afterTurn(threadId);
				}
			}
		}));
		void this.history.whenReady.then(() => {
			this.historyReady = true;
			this.dropDeletedChats();
		}, () => undefined);
		this._register(this.history.onDidChange(() => this.dropDeletedChats()));
		// Links and watch progress written in the last moments before the window closes are kept.
		this._register(lifecycleService.onWillShutdown(e => {
			if (this.saveScheduler.isScheduled()) {
				this.saveScheduler.cancel();
				e.join(this.save(), { id: 'voltPullRequests', label: localize('voltPr.saving', "Saving linked pull requests") });
			}
		}));
		// `git remote add/remove` writes the repository's config; a focus catches edits made while away.
		this._register(this.fileService.onDidFilesChange(e => {
			for (const [folder, state] of this.origins) {
				if (state.configFile && e.contains(URI.file(state.configFile))) {
					void this.readOrigin(folder);
				}
			}
		}));
		this._register(hostService.onDidChangeFocus(focused => {
			if (focused) {
				for (const folder of this.origins.keys()) {
					void this.readOrigin(folder);
				}
			}
		}));
		this._register(new IntervalTimer()).cancelAndSet(() => void this.tick(false), TICK_MS);
		void this.whenReady.then(() => this.tick(true));
	}

	//#region Store

	private async load(): Promise<void> {
		try {
			const content = await this.fileService.readFile(this.storeFile);
			const parsed = JSON.parse(content.value.toString()) as Partial<IStoreFile>;
			if (parsed?.version === STORE_VERSION && parsed.chats && typeof parsed.chats === 'object') {
				for (const [sessionId, links] of Object.entries(parsed.chats)) {
					const valid = Array.isArray(links) ? links.filter(isStoredLink) : [];
					if (valid.length) {
						this.chats.set(sessionId, valid);
					}
				}
			}
		} catch (err) {
			if ((err as { fileOperationResult?: number })?.fileOperationResult !== 1 /* FILE_NOT_FOUND */) {
				// Keep the unreadable file for the user (and do not overwrite it with an empty list).
				this.logService.warn('[volt-pr] could not read linked pull requests; keeping a copy as links.json.broken', err);
				await this.fileService.copy(this.storeFile, joinPath(this.storeFile, '..', 'links.json.broken'), true).catch(() => undefined);
			}
		}
		this.loaded = true;
		if (this.chats.size) {
			this._onDidChange.fire([...this.chats.keys()]);
		}
	}

	private async save(): Promise<void> {
		if (!this.loaded) {
			this.saveScheduler.schedule();
			return;
		}
		const chats: Record<string, IAgentPrLink[]> = {};
		for (const [sessionId, links] of this.chats) {
			if (links.length) {
				chats[sessionId] = [...links];
			}
		}
		try {
			// Atomic: a crash mid-write never leaves half a file (which would read back as no links).
			await this.fileService.writeFile(this.storeFile, VSBuffer.fromString(JSON.stringify({ version: STORE_VERSION, chats } satisfies IStoreFile)), { atomic: { postfix: '.vsctmp' } });
		} catch (err) {
			this.logService.warn('[volt-pr] could not save linked pull requests', err);
		}
	}

	private setLinks(sessionId: string, links: readonly IAgentPrLink[]): void {
		const before = this.chats.get(sessionId) ?? [];
		if (before === links) {
			return;
		}
		if (links.length) {
			this.chats.set(sessionId, links);
		} else {
			this.chats.delete(sessionId);
		}
		this.saveScheduler.schedule();
		this._onDidChange.fire([sessionId]);
	}

	private dropDeletedChats(): void {
		// Before the history index loads, every chat looks deleted.
		if (!this.loaded || !this.historyReady) {
			return;
		}
		for (const sessionId of [...this.chats.keys()]) {
			if (!this.history.has(sessionId)) {
				this.chats.delete(sessionId);
				this.saveScheduler.schedule();
			}
		}
	}

	//#endregion

	//#region Queries

	links(sessionId: string): readonly IAgentPrLink[] {
		return this.chats.get(sessionId) ?? [];
	}

	sessionsFor(key: string): string[] {
		const out: string[] = [];
		for (const [sessionId, links] of this.chats) {
			if (links.some(link => link.key === key && link.source !== 'dismissed')) {
				out.push(sessionId);
			}
		}
		return out;
	}

	snapshot(key: string): IVoltPullRequest | undefined {
		let best: IAgentPrLink | undefined;
		for (const links of this.chats.values()) {
			for (const link of links) {
				if (link.key === key && link.snapshot && (!best || (link.syncedAt ?? 0) > (best.syncedAt ?? 0))) {
					best = link;
				}
			}
		}
		return best?.snapshot ?? this.known.get(key);
	}

	hostProblem(host: string): { readonly code: VoltPrErrorCode; readonly message: string } | undefined {
		return this.hosts.get(host.toLowerCase())?.problem;
	}

	signedInHosts(): readonly IVoltPrHostCredential[] {
		return this.hostTokens;
	}

	async signInHost(request: IVoltPrSignInRequest): Promise<IVoltPrAccount> {
		const account = await this.api.signInHost(request);
		const credential: IVoltPrHostCredential = { host: account.host, provider: request.provider, token: request.token.trim(), login: account.login, ...(request.webUrl ? { webUrl: request.webUrl } : {}), ...(request.username ? { username: request.username } : {}) };
		await this.saveHostTokens([...this.hostTokens.filter(existing => existing.host !== account.host), credential]);
		this.hosts.clear();
		void this.tick(true);
		return account;
	}

	async signOutHost(host: string): Promise<void> {
		await this.saveHostTokens(this.hostTokens.filter(existing => existing.host !== host.toLowerCase()));
		this.hosts.clear();
		void this.tick(true);
	}

	private async loadHostTokens(): Promise<void> {
		try {
			const raw = await this.secretStorage.get(HOST_TOKENS_KEY);
			this.hostTokens = raw ? JSON.parse(raw) as IVoltPrHostCredential[] : [];
		} catch (err) {
			this.logService.warn('[volt pull requests] could not read host tokens', err);
			this.hostTokens = [];
		}
		await this.api.setHostCredentials(this.hostTokens);
	}

	private async saveHostTokens(credentials: IVoltPrHostCredential[]): Promise<void> {
		this.hostTokens = credentials;
		await this.secretStorage.set(HOST_TOKENS_KEY, JSON.stringify(credentials));
		await this.api.setHostCredentials(credentials);
	}

	stack(folder: string, branch?: string): Promise<IVoltPrStackView | undefined> {
		return this.api.stack({ folder, branch });
	}

	stackNewBranch(folder: string, title: string): Promise<{ readonly branch: string; readonly parent: string }> {
		return this.api.stackNewBranch({ folder, title });
	}

	async restack(folder: string, branch: string | undefined, syncTrunk: boolean): Promise<IVoltPrRestackOutcome> {
		const outcome = await this.api.restack({ folder, branch, syncTrunk });
		void this.refresh();
		return outcome;
	}

	folderFor(sessionId: string): string | undefined {
		const meta = this.history.get(sessionId);
		if (meta?.worktreePath) {
			return meta.worktreePath;
		}
		const root = this.sessionContext.rootFor(sessionId);
		if (root?.scheme === 'file') {
			return root.fsPath;
		}
		const folder = meta?.workspaceFolders?.[0] ?? meta?.workspaceFolder;
		return folder && !folder.includes('://') ? folder : undefined;
	}

	async repoFor(sessionId: string): Promise<IVoltPrRepo | undefined> {
		const folder = this.folderFor(sessionId);
		return folder ? this.repoForFolder(folder) : undefined;
	}

	repoForFolder(folder: string, force = false): Promise<IVoltPrRepo | undefined> {
		const now = Date.now();
		const cached = this.repos.get(folder);
		if (cached && !force && now - cached.at < REPO_TTL_MS) {
			return cached.repo;
		}
		const repo = this.api.resolveRepo(folder).catch(err => {
			this.logService.trace('[volt-pr] could not read the repository of', folder, err);
			return undefined;
		});
		this.repos.set(folder, { at: now, repo });
		return repo;
	}

	hasOrigin(folder: string): boolean | undefined {
		const state = this.origins.get(folder);
		if (!state || Date.now() - state.at > ORIGIN_TTL_MS) {
			void this.readOrigin(folder);
		}
		return state?.shows;
	}

	private async readOrigin(folder: string): Promise<void> {
		let state = this.origins.get(folder);
		if (!state) {
			state = { at: 0 };
			this.origins.set(folder, state);
		}
		if (state.reading) {
			return;
		}
		state.reading = true;
		state.at = Date.now();
		const remotes = await this.api.repoRemotes(folder).catch(err => {
			this.logService.trace('[volt-pr] could not read the remotes of', folder, err);
			return undefined;
		});
		state.reading = false;
		const configFile = remotes?.configFile;
		if (configFile && !this.configWatches.has(configFile)) {
			this.configWatches.set(configFile, this.fileService.watch(URI.file(configFile)));
		}
		state.configFile = configFile;
		const shows = showsPullRequests(remotes?.remotes);
		if (state.shows !== shows) {
			const known = state.shows !== undefined;
			state.shows = shows;
			if (known) {
				// The remote it resolved to may have gone with it.
				this.repos.delete(folder);
			}
			this._onDidChangeOrigin.fire(folder);
		}
	}

	detail(request: IVoltPrRequest, force = false): Promise<IVoltPullRequestDetail> {
		const key = prKey(request.repo, request.number);
		const now = Date.now();
		const cached = this.details.get(key);
		if (cached && !force && now - cached.at < DETAIL_TTL_MS) {
			return cached.detail;
		}
		const detail = this.api.detail(request);
		this.details.set(key, { at: now, detail });
		detail.then(read => {
			this.markHostOk(request.repo.host);
			this.applySnapshots([read]);
			this._onDidReadDetail.fire(read);
		}, err => {
			if (this.details.get(key)?.detail === detail) {
				this.details.delete(key);
			}
			this.markHostFailed(request.repo.host, err);
		});
		return detail;
	}

	lastMergeMethod(repo: IVoltPrRepoRef): VoltPrMergeMethod | undefined {
		const all = this.readMergeMethods();
		const method = all[repoId(repo)];
		return method === 'merge' || method === 'squash' || method === 'rebase' ? method : undefined;
	}

	rememberMergeMethod(repo: IVoltPrRepoRef, method: VoltPrMergeMethod): void {
		const all = this.readMergeMethods();
		all[repoId(repo)] = method;
		this.storageService.store(MERGE_METHOD_KEY, JSON.stringify(all), StorageScope.PROFILE, StorageTarget.USER);
	}

	private readMergeMethods(): Record<string, string> {
		try {
			const parsed = JSON.parse(this.storageService.get(MERGE_METHOD_KEY, StorageScope.PROFILE, '{}'));
			return parsed && typeof parsed === 'object' ? parsed : {};
		} catch {
			return {};
		}
	}

	//#endregion

	//#region Link, watch

	async link(sessionId: string, target: IAgentPrTarget, source: AgentPrLinkSource): Promise<IAgentPrLink> {
		await this.whenReady;
		const ref = await this.resolveTarget(sessionId, target);
		const [pr] = await this.api.getMany([{ repo: ref.repo, number: ref.number }]);
		if (!pr) {
			throw new Error(localize('voltPr.notFound', "Pull request #{0} was not found in {1}/{2}.", ref.number, ref.repo.owner, ref.repo.name));
		}
		return this.linkLocks.queue(sessionId, async () => {
			const fresh = newLink(pr.repo, pr.number, pr.url, source, Date.now(), pr);
			const links = addLink(this.links(sessionId), fresh);
			this.setLinks(sessionId, links);
			this.applySnapshots([pr]);
			return this.links(sessionId).find(link => link.key === fresh.key)!;
		});
	}

	unlink(sessionId: string, key: string): void {
		this.setLinks(sessionId, removeLink(this.links(sessionId), key));
	}

	async watch(sessionId: string, key: string): Promise<IAgentPrLink> {
		await this.whenReady;
		let link = this.links(sessionId).find(candidate => candidate.key === key && candidate.source !== 'dismissed');
		if (!link) {
			throw new Error(localize('voltPr.notLinked', "That pull request is not linked to this chat."));
		}
		if (!link.snapshot || !link.syncedAt || Date.now() - link.syncedAt > 30_000) {
			await this.refresh([key]);
			link = this.links(sessionId).find(candidate => candidate.key === key) ?? link;
		}
		if (link.snapshot && !isOpenState(link.snapshot.state)) {
			throw new Error(localize('voltPr.notOpen', "Pull request #{0} is {1}; only open pull requests can be watched.", link.number, link.snapshot.state));
		}
		if (!link.watch) {
			const watched = { ...link, watch: startWatch(Date.now()) };
			this.replaceLink(sessionId, watched);
			this.watchedAt.delete(key);
			// The first pass runs soon: failing checks are reported right away.
			setTimeout(() => void this.tick(true), 1_000);
			return watched;
		}
		return link;
	}

	unwatch(sessionId: string, key: string): void {
		const link = this.links(sessionId).find(candidate => candidate.key === key);
		if (link?.watch) {
			const { watch: _watch, ...rest } = link;
			this.replaceLink(sessionId, rest);
		}
	}

	private replaceLink(sessionId: string, next: IAgentPrLink): void {
		const links = this.links(sessionId);
		if (links.some(link => link.key === next.key)) {
			this.setLinks(sessionId, links.map(link => link.key === next.key ? next : link));
		}
	}

	private async resolveTarget(sessionId: string, target: IAgentPrTarget): Promise<{ repo: IVoltPrRepoRef; number: number }> {
		if (target.url) {
			const parsed = parsePullRequestUrl(target.url);
			if (!parsed) {
				throw new Error(localize('voltPr.badUrl', "{0} is not a pull request URL.", target.url));
			}
			return parsed;
		}
		if (!target.number || !Number.isSafeInteger(target.number) || target.number <= 0) {
			throw new Error(localize('voltPr.noNumber', "Give the pull request's URL or its number."));
		}
		const repo = target.repo ?? await this.repoFor(sessionId);
		if (!repo) {
			throw new Error(localize('voltPr.noRepo', "This chat's folder has no GitHub remote; give the pull request's URL."));
		}
		return { repo: { host: repo.host, owner: repo.owner, name: repo.name }, number: target.number };
	}

	//#endregion

	//#region Sync

	async refresh(keys?: readonly string[]): Promise<void> {
		await this.whenReady;
		const wanted = new Map<string, IAgentPrLink>();
		for (const links of this.chats.values()) {
			for (const link of links) {
				if (link.source !== 'dismissed' && (!keys || keys.includes(link.key))) {
					wanted.set(link.key, link);
				}
			}
		}
		await this.readSummaries([...wanted.values()], true);
	}

	private async tick(force: boolean): Promise<void> {
		if (!this.loaded || this._store.isDisposed) {
			return;
		}
		if (this.syncing) {
			return this.syncing;
		}
		this.syncing = this.runTick(force).catch(err => this.logService.warn('[volt-pr] sync failed', err)).finally(() => this.syncing = undefined);
		return this.syncing;
	}

	private async runTick(force: boolean): Promise<void> {
		const now = Date.now();
		const due = new Map<string, IAgentPrLink>();
		const watched = new Map<string, { sessionId: string; link: IAgentPrLink }[]>();
		for (const [sessionId, links] of this.chats) {
			const meta = this.history.get(sessionId);
			for (const link of links) {
				if (link.source === 'dismissed') {
					continue;
				}
				// A watched pull request gets its own pass even when another read saw it merge first: the
				// pass reports the merge and ends the watch.
				if (link.watch) {
					const list = watched.get(link.key) ?? [];
					list.push({ sessionId, link });
					watched.set(link.key, list);
					continue;
				}
				if (meta?.archived && link.snapshot) {
					continue;
				}
				if (this.isDue(link, now, force)) {
					due.set(link.key, link);
				}
			}
		}
		await this.readSummaries([...due.values()], false);
		await this.runWatches(watched, now, force);
		if (force || now - this.lastDiscovery > DISCOVERY_MS) {
			this.lastDiscovery = now;
			await this.discover();
		}
		this.settleFinished();
	}

	private isDue(link: IAgentPrLink, now: number, force: boolean): boolean {
		const snapshot = link.snapshot;
		if (!snapshot || !link.syncedAt) {
			return true;
		}
		if (snapshot.state === 'merged') {
			return false;
		}
		const age = now - link.syncedAt;
		if (snapshot.state === 'closed') {
			return age > CLOSED_SYNC_MS;
		}
		if (force) {
			return age > 5_000;
		}
		return age > (snapshot.checks.state === 'pending' || snapshot.mergeable === 'unknown' ? PENDING_SYNC_MS : OPEN_SYNC_MS);
	}

	private hostReady(host: string, force: boolean): boolean {
		const state = this.hosts.get(host.toLowerCase());
		if (!state) {
			return true;
		}
		if (state.problem && (state.problem.code === 'noCli' || state.problem.code === 'unsupported')) {
			return false;
		}
		return force || Date.now() >= state.until;
	}

	private markHostOk(host: string): void {
		const key = host.toLowerCase();
		if (this.hosts.has(key)) {
			this.hosts.delete(key);
		}
	}

	private markHostFailed(host: string, err: unknown): void {
		const key = host.toLowerCase();
		const state = this.hosts.get(key) ?? { failures: 0, until: 0 };
		state.failures++;
		const code = voltPrErrorCode(err) ?? 'failed';
		state.until = Date.now() + Math.min(MAX_BACKOFF_MS, OPEN_SYNC_MS * 2 ** Math.min(state.failures - 1, 4));
		state.problem = { code, message: voltPrErrorMessage(err) };
		this.hosts.set(key, state);
		this.logService.trace('[volt-pr] read failed', host, code, voltPrErrorMessage(err));
	}

	private async readSummaries(links: readonly IAgentPrLink[], force: boolean): Promise<void> {
		const byHost = new Map<string, IAgentPrLink[]>();
		for (const link of links) {
			if (!this.hostReady(link.repo.host, force)) {
				continue;
			}
			const list = byHost.get(link.repo.host) ?? [];
			list.push(link);
			byHost.set(link.repo.host, list);
		}
		await Promise.all([...byHost].map(async ([host, list]) => {
			try {
				const read = await this.api.getMany(list.map(link => ({ repo: link.repo, number: link.number, ...(link.account ? { account: link.account } : {}) })));
				this.markHostOk(host);
				this.applySnapshots(read);
			} catch (err) {
				this.markHostFailed(host, err);
			}
		}));
	}

	/** Writes fresh reads into every chat that links them. Only chats whose snapshot changed are told. */
	private applySnapshots(prs: readonly IVoltPullRequest[]): void {
		if (!prs.length) {
			return;
		}
		const now = Date.now();
		const byKey = new Map(prs.map(pr => [pr.key, pr]));
		const changedKeys = new Set<string>();
		for (const pr of prs) {
			const before = this.known.get(pr.key);
			this.known.set(pr.key, toSummary(pr));
			// Also tells views of pull requests no chat links (tab titles).
			if (!before || !sameSnapshot(before, pr)) {
				changedKeys.add(pr.key);
			}
		}
		const changedChats: string[] = [];
		for (const [sessionId, links] of this.chats) {
			let changed = false;
			const next = links.map(link => {
				const pr = byKey.get(link.key);
				if (!pr) {
					return link;
				}
				const same = link.snapshot && sameSnapshot(link.snapshot, pr);
				if (same) {
					return link.syncedAt === now ? link : { ...link, syncedAt: now };
				}
				changed = true;
				changedKeys.add(link.key);
				// A pull request that opened again may settle the chat again when it ends.
				const reopened = link.settleHandled && isOpenState(pr.state);
				const { settleHandled: _handled, ...rest } = link;
				return { ...(reopened ? rest : link), snapshot: toSummary(pr), syncedAt: now };
			});
			// syncedAt alone is not worth an event, but it is worth keeping.
			this.chats.set(sessionId, next);
			if (changed) {
				changedChats.push(sessionId);
			}
		}
		this.saveScheduler.schedule();
		if (changedChats.length) {
			this._onDidChange.fire(changedChats);
		}
		for (const key of changedKeys) {
			this._onDidChangePullRequest.fire(key);
		}
	}

	//#endregion

	//#region Watch passes

	private async runWatches(watched: Map<string, { sessionId: string; link: IAgentPrLink }[]>, now: number, force: boolean): Promise<void> {
		const due = [...watched].filter(([key]) => force || now - (this.watchedAt.get(key) ?? 0) >= WATCH_SYNC_MS);
		// A few at a time: each pass is one detail read.
		for (let i = 0; i < due.length; i += 4) {
			await Promise.all(due.slice(i, i + 4).map(([key, owners]) => this.watchPass(key, owners)));
		}
	}

	private async watchPass(key: string, owners: { sessionId: string; link: IAgentPrLink }[]): Promise<void> {
		const first = owners[0].link;
		if (!this.hostReady(first.repo.host, false)) {
			return;
		}
		this.watchedAt.set(key, Date.now());
		let detail: IVoltPullRequestDetail;
		try {
			detail = await this.detail({ repo: first.repo, number: first.number, ...(first.account ? { account: first.account } : {}) }, true);
		} catch (err) {
			for (const { sessionId } of owners) {
				const link = this.links(sessionId).find(candidate => candidate.key === key);
				if (!link?.watch) {
					continue;
				}
				const failures = link.watch.failures + 1;
				if (failures >= PR_WATCH_FAILURE_LIMIT) {
					const { watch: _watch, ...rest } = link;
					this.replaceLink(sessionId, rest);
					void this.wake(sessionId, link, `[Volt] Volt stopped watching pull request #${link.number} (${link.url}): it could not be read ${PR_WATCH_FAILURE_LIMIT} times in a row (${voltPrErrorMessage(err)}). Call watch_pull_request to try again.`, `#${link.number}: stopped watching (read failed)`);
				} else {
					this.replaceLink(sessionId, { ...link, watch: { ...link.watch, failures } });
				}
			}
			return;
		}
		const remarks = collectRemarks(detail);
		for (const { sessionId } of owners) {
			const link = this.links(sessionId).find(candidate => candidate.key === key);
			if (!link?.watch) {
				continue;
			}
			const result = evaluateWatch(link.watch, detail, remarks);
			const next: IAgentPrLink = result.ended ? (({ watch: _watch, ...rest }) => rest)(link) : { ...link, watch: result.next };
			this.replaceLink(sessionId, next);
			if (result.changes.length) {
				const text = buildWatchMessage(detail, result.changes, result.ended);
				void this.wake(sessionId, link, text, watchSummary(detail.number, result.changes));
			}
		}
	}

	/** Wakes the chat's agent. A chat that already woke too often keeps the watch quiet and tells the user. */
	private async wake(sessionId: string, link: IAgentPrLink, text: string, summary: string): Promise<void> {
		const turnId = `pr-${link.number}-${Date.now().toString(36)}`;
		// News for a parked chat brings it back to the inbox, where the user sees it working.
		await this.unpark(sessionId);
		const current = this.links(sessionId).find(candidate => candidate.key === link.key);
		if (current) {
			this.replaceLink(sessionId, { ...current, notifiedAt: Date.now() });
		}
		try {
			const result = await this.orchestrator.notify(sessionId, { text, display: { text: summary, notification: true } }, turnId);
			if (result.outcome === 'rejected') {
				this.unwatch(sessionId, link.key);
				const title = this.history.get(sessionId)?.title || localize('voltPr.chat', "a chat");
				this.notificationService.notify({
					severity: Severity.Info,
					message: localize('voltPr.wakeRefused', "Stopped watching #{0} for {1}: {2}", link.number, title, result.reason ?? ''),
				});
			}
		} catch (err) {
			this.logService.warn('[volt-pr] could not wake the chat', err);
		}
	}

	/** Takes a chat off the Settled or Snoozed shelf (it has new pull request work). */
	private async unpark(sessionId: string): Promise<void> {
		const meta = this.history.get(sessionId);
		if (meta?.settled) {
			await this.history.setSettled(sessionId, false);
		}
		if (meta?.snoozed) {
			await this.history.setSnoozed(sessionId, false);
		}
	}

	//#endregion

	//#region Settling

	private settleFinished(): void {
		for (const [sessionId, links] of this.chats) {
			const meta = this.history.get(sessionId);
			if (!meta || !visibleLinks(links).length) {
				continue;
			}
			const thread = this.orchestrator.getThread(sessionId);
			const busy = !!thread?.active || !!thread?.queue.length || !!thread?.inputs.length || meta.status === 'running' || !!meta.attention;
			if (shouldSettleForPullRequests(links, { createdAt: meta.createdAt, lastPromptAt: meta.lastPromptAt, pinned: meta.pinned, settled: meta.settled, snoozed: meta.snoozed, archived: meta.archived, autoSettle: meta.autoSettle, busy })) {
				void this.history.setSettled(sessionId, true);
			}
			// Every link finished and the chat idle: handled, so moving the chat back out of Settled sticks.
			// A busy chat is looked at again when its turn ends.
			if (!busy && visibleLinks(links).every(link => link.snapshot && isTerminalState(link.snapshot.state)) && links.some(link => link.source !== 'dismissed' && !link.settleHandled)) {
				this.setLinks(sessionId, links.map(link => link.source === 'dismissed' ? link : { ...link, settleHandled: true }));
			}
		}
	}

	//#endregion

	//#region Discovery

	/** After a turn: pull request URLs in the reply are linked; the chat's branch is looked up again. */
	private async afterTurn(sessionId: string): Promise<void> {
		await this.whenReady;
		try {
			const transcript = await this.history.open(sessionId).load();
			const reply = transcript.turns.at(-1)?.assistant?.text ?? '';
			const urls = findPullRequestUrls(reply);
			if (urls.length) {
				const repo = await this.repoFor(sessionId);
				for (const url of urls.slice(0, 5)) {
					const parsed = parsePullRequestUrl(url);
					// Only the chat's own repository: a reply that cites some other project's PR is not this chat's work.
					if (parsed && repo && sameRepoRef(parsed.repo, repo) && !this.links(sessionId).some(link => link.key === prKey(parsed.repo, parsed.number))) {
						await this.link(sessionId, { url }, 'agent').catch(err => this.logService.trace('[volt-pr] could not link', url, err));
					}
				}
			}
		} catch (err) {
			this.logService.trace('[volt-pr] could not read the finished turn', err);
		}
		this.repos.delete(this.folderFor(sessionId) ?? '');
		await this.discoverFor([sessionId]);
	}

	private async discover(): Promise<void> {
		const now = Date.now();
		const recent = this.history.list({ includeArchived: false })
			.filter(meta => !meta.subagent && meta.turnCount > 0 && now - meta.updatedAt < DISCOVERY_RECENT_MS)
			.map(meta => meta.id);
		await this.discoverFor(recent);
	}

	/** Links the open pull request of each chat's branch, by the rules in {@link discoveredPrBelongs}. */
	private async discoverFor(sessionIds: readonly string[]): Promise<void> {
		const byBranch = new Map<string, { repo: IVoltPrRepo; chats: IAgentSessionMeta[] }>();
		for (const sessionId of sessionIds) {
			const meta = this.history.get(sessionId);
			const folder = this.folderFor(sessionId);
			if (!meta || !folder) {
				continue;
			}
			const repo = await this.repoForFolder(folder);
			if (!repo || repo.provider !== 'github' || !repo.branch || isTrunkBranch(repo.branch) || !this.hostReady(repo.host, false)) {
				continue;
			}
			const key = `${repoId(repo)}\u0000${repo.branch}`;
			const entry = byBranch.get(key) ?? { repo, chats: [] };
			entry.chats.push(meta);
			byBranch.set(key, entry);
		}
		for (const { repo, chats } of byBranch.values()) {
			let found: IVoltPullRequest[];
			try {
				found = await this.api.forBranch({ repo, branch: repo.branch! });
				this.markHostOk(repo.host);
			} catch (err) {
				this.markHostFailed(repo.host, err);
				continue;
			}
			const pr = found[0];
			if (!pr) {
				continue;
			}
			for (const meta of chats) {
				const ownBranch = !!meta.worktreePath && meta.worktreeBranch === repo.branch;
				if (this.links(meta.id).some(link => link.key === pr.key)) {
					continue;
				}
				if (!discoveredPrBelongs(pr, { ownBranch, createdAt: meta.createdAt, lastPromptAt: meta.lastPromptAt, updatedAt: meta.updatedAt })) {
					continue;
				}
				await this.linkLocks.queue(meta.id, async () => {
					this.setLinks(meta.id, addLink(this.links(meta.id), newLink(pr.repo, pr.number, pr.url, 'branch', Date.now(), pr)));
				});
			}
			this.applySnapshots([pr]);
		}
	}

	//#endregion

	//#region Create, generate

	async create(sessionId: string | undefined, folder: string, options: IAgentPrCreateOptions): Promise<IVoltPullRequest> {
		let repo = await this.repoForFolder(folder, true);
		if (!repo) {
			throw new Error(localize('voltPr.noRemote', "This folder has no GitHub remote to open a pull request on."));
		}
		if (!repo.branch) {
			throw new Error(localize('voltPr.detached', "Check out a branch before opening a pull request."));
		}
		if (!repo.upstream || repo.upstream !== repo.branch || (repo.ahead ?? 0) > 0) {
			await this.api.push({ folder, remote: repo.remote });
			repo = await this.repoForFolder(folder, true) ?? repo;
		}
		const request: IVoltPrCreateRequest = {
			repo: { host: repo.host, owner: repo.owner, name: repo.name },
			head: repo.branch!,
			base: options.base,
			title: options.title.trim(),
			body: options.body,
			draft: options.draft,
		};
		const pr = await this.api.create(request);
		if (sessionId) {
			await this.unpark(sessionId);
			await this.linkLocks.queue(sessionId, async () => {
				this.setLinks(sessionId, addLink(this.links(sessionId), newLink(pr.repo, pr.number, pr.url, 'created', Date.now(), pr)));
			});
		}
		this.applySnapshots([pr]);
		return pr;
	}

	async generatePullRequestText(folder: string, base: string, sessionId?: string): Promise<{ title: string; body: string } | undefined> {
		const summary = await this.api.describeBranch({ folder, base });
		if (!summary.commits.length && !summary.patch.trim()) {
			return undefined;
		}
		const raw = await this.runtime.generateText(buildPullRequestTextPrompt(summary.head, summary.base, summary.commits, summary.stat, summary.patch, summary.template), { sessionId, slot: 'git' });
		const parsed = parseGeneratedJson(raw, ['title', 'body'] as const);
		if (parsed?.title) {
			return { title: sanitizeCommitSubject(parsed.title, summary.commits.at(-1)), body: (parsed.body ?? '').trim() };
		}
		// No model answered: the commits say it.
		const title = summary.commits.length === 1 ? summary.commits[0] : summary.head.replace(/[-_/]+/g, ' ');
		const body = summary.commits.length > 1 ? `## Summary\n${summary.commits.map(commit => `- ${commit}`).join('\n')}` : '';
		return { title: sanitizeCommitSubject(title), body };
	}

	async generateCommitMessage(folder: string, sessionId?: string, paths?: readonly string[]): Promise<string | undefined> {
		const summary = await this.api.describeChanges({ folder, ...(paths ? { paths } : {}) });
		if (!summary.files.trim()) {
			return undefined;
		}
		const raw = await this.runtime.generateText(buildCommitMessagePrompt(summary.branch, summary.files, summary.patch, summary.recentSubjects), { sessionId, slot: 'git' });
		return commitMessageFrom(raw);
	}

	//#endregion

	//#region Agent tools

	private async invokeTool(name: string, args: Record<string, unknown>, call: IVoltHostToolCall | undefined): Promise<IVoltHostToolResult> {
		const caller = call?.sessionId ? this.runtime.chatFor(call.sessionId) : undefined;
		if (!caller) {
			return { error: 'This tool needs a Volt chat.' };
		}
		// An orchestrating agent may link and watch for a chat it launched (`thread_id`).
		const other = typeof args.thread_id === 'string' && args.thread_id.trim() && args.thread_id.trim() !== caller ? args.thread_id.trim() : undefined;
		if (other && !this.history.get(other) && !this.orchestrator.getThread(other)) {
			return { error: `No chat ${other}. thread_list shows chat ids.` };
		}
		const sessionId = other ?? caller;
		if (name === WATCH_TOOL && (this.orchestrator.getThread(sessionId)?.taskId || this.history.get(sessionId)?.subagent)) {
			return { error: 'A subagent cannot watch pull requests: its parent chat owns them. Name the pull request in your report; the parent can call watch_pull_request.' };
		}
		try {
			const target: IAgentPrTarget = {
				...(typeof args.url === 'string' && args.url ? { url: args.url } : {}),
				...(typeof args.number === 'number' ? { number: args.number } : typeof args.number === 'string' && /^\d+$/.test(args.number) ? { number: Number(args.number) } : {}),
				...(typeof args.repository === 'string' && args.repository.includes('/') ? { repo: repoFromArg(args.repository, typeof args.host === 'string' ? args.host : 'github.com') } : {}),
			};
			switch (name) {
				case LINK_TOOL: {
					const before = this.links(sessionId).length;
					const ref = await this.resolveTarget(sessionId, target);
					const already = this.links(sessionId).some(link => link.key === prKey(ref.repo, ref.number) && link.source !== 'dismissed');
					const link = await this.link(sessionId, { repo: ref.repo, number: ref.number }, 'agent');
					return json({ ...describeLink(link), alreadyLinked: already && this.links(sessionId).length === before });
				}
				case UNLINK_TOOL: {
					const ref = await this.resolveTarget(sessionId, target);
					const key = prKey(ref.repo, ref.number);
					const was = this.links(sessionId).some(link => link.key === key && link.source !== 'dismissed');
					this.unlink(sessionId, key);
					return json({ host: ref.repo.host, repository: `${ref.repo.owner}/${ref.repo.name}`, number: ref.number, wasLinked: was });
				}
				case LIST_TOOL: {
					const links = visibleLinks(this.links(sessionId));
					const chains = resolveChains(links).filter(chain => chain.length > 1);
					return json({
						pullRequests: links.map(link => {
							const chain = chains.find(candidate => candidate.includes(link));
							return { ...describeLink(link), source: link.source, ...(chain ? { stack: { position: chain.indexOf(link) + 1, size: chain.length } } : {}) };
						}),
						current: currentLink(links)?.number,
						stacks: chains.map(chain => chain.map(link => link.number)),
					});
				}
				case WATCH_TOOL: {
					const ref = await this.resolveTarget(sessionId, target);
					const key = prKey(ref.repo, ref.number);
					if (!this.links(sessionId).some(link => link.key === key && link.source !== 'dismissed')) {
						await this.link(sessionId, { repo: ref.repo, number: ref.number }, 'agent');
					}
					const wasWatching = !!this.links(sessionId).find(link => link.key === key)?.watch;
					const link = await this.watch(sessionId, key);
					return json({ ...describeLink(link), watching: true, wasWatching, ...(other ? { threadId: other } : {}), note: other ? 'Volt wakes that chat (not this one) when checks fail or pass, a review or comment comes in, or the branch conflicts.' : 'Volt wakes this chat when checks fail or pass, a review or comment comes in, or the branch conflicts. Handle the comments that are already there first, then end your turn now.' });
				}
				case UNWATCH_TOOL: {
					const ref = await this.resolveTarget(sessionId, target);
					const key = prKey(ref.repo, ref.number);
					const wasWatching = !!this.links(sessionId).find(link => link.key === key)?.watch;
					this.unwatch(sessionId, key);
					return json({ host: ref.repo.host, repository: `${ref.repo.owner}/${ref.repo.name}`, number: ref.number, watching: false, wasWatching });
				}
				case STACK_STATUS_TOOL: {
					const folder = this.folderFor(sessionId);
					const view = folder ? await this.api.stack({ folder, branch: typeof args.branch === 'string' && args.branch.trim() ? args.branch.trim() : undefined }) : undefined;
					return view ? json(describeStack(view)) : { error: 'This chat is not in a git repository.' };
				}
				case STACK_BRANCH_TOOL: {
					const folder = this.folderFor(sessionId);
					const title = typeof args.title === 'string' ? args.title.trim() : '';
					if (!folder) {
						return { error: 'This chat is not in a git repository.' };
					}
					if (!title) {
						return { error: 'Give a title for the new layer.' };
					}
					return json(await this.api.stackNewBranch({ folder, title }));
				}
				case RESTACK_TOOL: {
					const folder = this.folderFor(sessionId);
					if (!folder) {
						return { error: 'This chat is not in a git repository.' };
					}
					const branch = typeof args.branch === 'string' && args.branch.trim() ? args.branch.trim() : undefined;
					const outcome = await this.api.restack({ folder, branch, syncTrunk: args.sync_trunk === true });
					if (!outcome.stopped) {
						return json(outcome);
					}
					const view = await this.api.stack({ folder, branch });
					const stackBranches = view?.stack.layers.map(layer => layer.branch) ?? [outcome.stopped.branch];
					return json({ ...outcome, prompt: buildRestackConflictPrompt(outcome.stopped, stackBranches) });
				}
				default:
					return { error: `Unknown tool ${name}` };
			}
		} catch (err) {
			return { error: voltPrErrorMessage(err) };
		}
	}

	//#endregion
}

const LINK_TOOL = 'link_pull_request';
const UNLINK_TOOL = 'unlink_pull_request';
const LIST_TOOL = 'list_thread_pull_requests';
const WATCH_TOOL = 'watch_pull_request';
const UNWATCH_TOOL = 'unwatch_pull_request';
const STACK_STATUS_TOOL = 'stack_status';
const STACK_BRANCH_TOOL = 'stack_branch';
const RESTACK_TOOL = 'restack_stack';

const TARGET_SCHEMA = {
	type: 'object',
	properties: {
		url: { type: 'string', description: 'The pull request URL, e.g. https://github.com/owner/repo/pull/12. Wins over the other fields.' },
		repository: { type: 'string', description: '"owner/repo". Defaults to the repository of this chat\'s folder.' },
		number: { type: 'number', description: 'The pull request number.' },
		host: { type: 'string', description: 'Code host, default github.com (an Enterprise host otherwise).' },
		thread_id: { type: 'string', description: 'Another chat to act for (one you launched or manage, from thread_list). Omit for this chat.' },
	},
};

export const PULL_REQUEST_TOOLS: readonly IVoltHostToolInfo[] = [
	{
		name: LINK_TOOL,
		title: 'Linked pull request',
		group: 'pullRequests',
		description: 'Link a pull request to this Volt chat so it shows in the sidebar and the chat\'s pull request view. Call it for every pull request you create or work on; for a stack, call it for every layer.',
		inputSchema: TARGET_SCHEMA,
	},
	{
		name: UNLINK_TOOL,
		title: 'Unlinked pull request',
		group: 'pullRequests',
		description: 'Remove a pull request from this Volt chat.',
		inputSchema: TARGET_SCHEMA,
	},
	{
		name: LIST_TOOL,
		title: 'Listed pull requests',
		group: 'pullRequests',
		description: 'List the pull requests linked to this Volt chat (or thread_id) with their state, branches, checks, whether Volt watches them, and stacks.',
		inputSchema: { type: 'object', properties: { thread_id: TARGET_SCHEMA.properties.thread_id } },
	},
	{
		name: WATCH_TOOL,
		title: 'Watching pull request',
		group: 'pullRequests',
		description: 'Watch an open pull request instead of polling, sleeping or running a watcher: Volt checks it and wakes this chat with a message when a check fails, the required checks pass, someone else comments or reviews, or the branch starts to conflict. Links it if needed. Only comments posted after this call wake you, so handle the existing ones first, then end your turn. A wake is news, not a merge decision: check readiness yourself before merging. Watching ends when it merges or closes, when the user stops this chat, after 10 comment-only updates in a row, or with unwatch_pull_request; call unwatch_pull_request before you hand the work back to the user. A subagent cannot watch (its parent owns the pull request).',
		inputSchema: TARGET_SCHEMA,
	},
	{
		name: UNWATCH_TOOL,
		title: 'Stopped watching pull request',
		group: 'pullRequests',
		description: 'Stop watching a pull request for this chat (or thread_id). It stays linked.',
		inputSchema: TARGET_SCHEMA,
	},
	{
		name: STACK_STATUS_TOOL,
		title: 'Stack',
		group: 'pullRequests',
		description: 'Read the stack the branch (the checked out one by default) is in, bottom first: each layer\'s parent, commits ahead, whether it needs a restack, is unpushed, or has a rebase waiting, and its pull request.',
		inputSchema: { type: 'object', properties: { branch: { type: 'string', description: 'A branch of the stack. Default: the checked out branch.' } } },
	},
	{
		name: STACK_BRANCH_TOOL,
		title: 'Stacked branch',
		group: 'pullRequests',
		description: 'Make a new layer on top of the checked out branch: a branch named from the title that records the current branch as its parent, so its pull request targets that branch. Commit the work on it afterwards and open the pull request with base set to the parent.',
		inputSchema: { type: 'object', properties: { title: { type: 'string', description: 'What the layer does; becomes the branch name (volt/<slug>).' } }, required: ['title'] },
	},
	{
		name: RESTACK_TOOL,
		title: 'Restacked',
		group: 'pullRequests',
		description: 'Restack the stack the branch is in: move each layer above a parent that changed (amended, rebased, or squash-merged) onto it, then push the moved layers with a lease. Children of merged parents are retargeted to the grandparent and their pull requests changed to match. When it stops on a conflict, follow the prompt it returns: resolve the files in the rebase it leaves, then call this tool again.',
		inputSchema: { type: 'object', properties: { branch: { type: 'string', description: 'A branch of the stack. Default: the checked out branch.' }, sync_trunk: { type: 'boolean', description: 'Also move the bottom layer onto the latest trunk.' } } },
	},
];

function json(value: unknown): IVoltHostToolResult {
	return { text: JSON.stringify(value, null, 2) };
}

function describeStack(view: IVoltPrStackView): Record<string, unknown> {
	return {
		trunk: view.stack.trunk,
		current: view.stack.current,
		layers: view.layers.map(({ layer, pullRequest }) => ({
			branch: layer.branch,
			parent: layer.parent,
			ahead: layer.ahead,
			needsRestack: layer.needsRestack,
			unpushed: layer.unpushed,
			dirty: layer.dirty ?? false,
			rebaseInProgress: layer.rebaseInProgress ?? false,
			...(pullRequest ? { number: pullRequest.number, url: pullRequest.url, state: pullRequest.state, baseRefName: pullRequest.baseRefName } : {}),
		})),
	};
}

function describeLink(link: IAgentPrLink): Record<string, unknown> {
	const pr = link.snapshot;
	return {
		host: link.repo.host,
		repository: `${link.repo.owner}/${link.repo.name}`,
		number: link.number,
		url: link.url,
		watching: !!link.watch,
		...(pr ? {
			title: pr.title,
			state: pr.state,
			headBranch: pr.headRefName,
			baseBranch: pr.baseRefName,
			checks: pr.checks.state,
			failingChecks: pr.checks.failing,
			mergeable: pr.mergeable,
			reviewDecision: pr.reviewDecision ?? null,
			unresolvedThreads: pr.unresolvedThreads,
		} : {}),
	};
}

function repoFromArg(value: string, host: string): IVoltPrRepoRef {
	const [owner, name] = value.split('/');
	return { host: host.toLowerCase(), owner, name: name.replace(/\.git$/, '') };
}

function repoId(repo: IVoltPrRepoRef): string {
	return `${repo.host}/${repo.owner}/${repo.name}`.toLowerCase();
}

function sameRepoRef(a: IVoltPrRepoRef, b: IVoltPrRepoRef): boolean {
	return repoId(a) === repoId(b);
}

/** Links keep the summary fields only (a detail read carries files and comments too). */
function toSummary(pr: IVoltPullRequest): IVoltPullRequest {
	return {
		key: pr.key, repo: pr.repo, number: pr.number, id: pr.id, title: pr.title, url: pr.url, state: pr.state, author: pr.author,
		headRefName: pr.headRefName, headRefOid: pr.headRefOid, baseRefName: pr.baseRefName, ...(pr.headOwner ? { headOwner: pr.headOwner } : {}),
		crossRepository: pr.crossRepository, createdAt: pr.createdAt, updatedAt: pr.updatedAt,
		...(pr.mergedAt !== undefined ? { mergedAt: pr.mergedAt } : {}), ...(pr.closedAt !== undefined ? { closedAt: pr.closedAt } : {}),
		additions: pr.additions, deletions: pr.deletions, changedFiles: pr.changedFiles, mergeable: pr.mergeable, mergeState: pr.mergeState,
		...(pr.reviewDecision ? { reviewDecision: pr.reviewDecision } : {}), checks: pr.checks, labels: pr.labels, assignees: pr.assignees,
		reviewRequests: pr.reviewRequests, reviews: pr.reviews, unresolvedThreads: pr.unresolvedThreads, comments: pr.comments,
		autoMerge: pr.autoMerge, viewer: pr.viewer,
	};
}

function sameSnapshot(a: IVoltPullRequest, b: IVoltPullRequest): boolean {
	return JSON.stringify(toSummary(a)) === JSON.stringify(toSummary(b));
}

function isStoredLink(value: unknown): value is IAgentPrLink {
	const link = value as Partial<IAgentPrLink> | undefined;
	return !!link && typeof link.key === 'string' && typeof link.number === 'number' && typeof link.url === 'string'
		&& !!link.repo && typeof link.repo.host === 'string' && typeof link.repo.owner === 'string' && typeof link.repo.name === 'string'
		&& (link.source === 'manual' || link.source === 'created' || link.source === 'agent' || link.source === 'branch' || link.source === 'dismissed');
}
