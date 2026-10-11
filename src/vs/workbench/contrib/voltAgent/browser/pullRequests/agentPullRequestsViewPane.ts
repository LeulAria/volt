/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, clearNode, EventHelper, getWindow } from '../../../../../base/browser/dom.js';
import { renderIcon } from '../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { RunOnceScheduler } from '../../../../../base/common/async.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { Event } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { localize } from '../../../../../nls.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService, IContextViewService } from '../../../../../platform/contextview/browser/contextView.js';
import { IHoverService } from '../../../../../platform/hover/browser/hover.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../../platform/keybinding/common/keybinding.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { IThemeService } from '../../../../../platform/theme/common/themeService.js';
import { IVoltPrRepo, IVoltPullRequest, voltPrErrorCode, voltPrErrorMessage } from '../../../../../platform/voltPullRequests/common/voltPullRequests.js';
import { IViewPaneOptions, ViewPane } from '../../../../browser/parts/views/viewPane.js';
import { IViewDescriptorService } from '../../../../common/views.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { IVoltQuery, IVoltQueryCache, IVoltQueryHandle } from '../../../../services/voltRuntime/browser/queryCache.js';
import { AgentPrSort, blockedReason, groupAndRank, IAgentPrLink, isOpenState, resolveMergeMethod, visibleLinks } from '../../common/agentPullRequests.js';
import { setAgentTooltip } from '../chrome/agentTooltip.js';
import { AgentEditorInput } from '../editor/agentEditorInput.js';
import { showVoltMenu } from '../ui/menu/voltMenu.js';
import { agentToolsSessionOnScreen } from '../workspace/agentSurfaceHost.js';
import { IAgentPullRequestService } from './agentPullRequestService.js';
import { onDidChangePullRequestsViewSession, pullRequestsViewSession } from './agentPullRequestsViewState.js';
import { ago, avatar, checkIcon, checksLabel, iconSpan, openPullRequest, problemText, prStateIcon, signInWithGh } from './agentPullRequestUi.js';

const SORT_KEY = 'volt.pullRequests.sort';
const STATE_KEY = 'volt.pullRequests.state';
const LIST_POLL_MS = 60_000;

/**
 * The folder's repository and its pull requests go through the query cache: the list opens on the
 * last read (this window's, or IndexedDB's after a restart) and reads again behind it when stale,
 * with the refresh button spinning meanwhile. `null` is a folder with no remote Volt can read.
 */
function repoQuery(pullRequests: IAgentPullRequestService, folder: string): IVoltQuery<IVoltPrRepo | null> {
	return { key: `pr.repo:${folder}`, fetch: async force => await pullRequests.repoForFolder(folder, force) ?? null, staleTime: 30_000 };
}

function listKey(repo: IVoltPrRepo, state: StateFilter): string {
	return `pr.list:${repo.host}/${repo.owner}/${repo.name}:${state}`.toLowerCase();
}

function listQuery(pullRequests: IAgentPullRequestService, repo: IVoltPrRepo, state: StateFilter): IVoltQuery<readonly IVoltPullRequest[]> {
	return { key: listKey(repo, state), fetch: () => pullRequests.api.list({ repo, state, limit: 100 }), staleTime: 30_000 };
}

const SORT_LABELS: Record<AgentPrSort, string> = {
	blocked: localize('voltPr.sort.blocked', "Blocked on Me"),
	ready: localize('voltPr.sort.ready', "Ready to Merge"),
	updated: localize('voltPr.sort.updated', "Recently Updated"),
	newest: localize('voltPr.sort.newest', "Newest"),
	oldest: localize('voltPr.sort.oldest', "Oldest"),
	largest: localize('voltPr.sort.largest', "Largest"),
	smallest: localize('voltPr.sort.smallest', "Smallest"),
};

type StateFilter = 'open' | 'closed' | 'all';

/**
 * Pull requests of the chat's repository: the chat's own first (with their watch), then yours,
 * the ones waiting on your review, and the rest, sorted by what is blocked on you. Hold Shift for
 * quick Merge / Close / Ready / Reopen on each row.
 */
export class AgentPullRequestsViewPane extends ViewPane {

	private content!: HTMLElement;
	private readonly renderStore = this._register(new DisposableStore());
	private readonly poll = this._register(new RunOnceScheduler(() => void this.load(false), LIST_POLL_MS));
	private readonly repoStore = this._register(new DisposableStore());
	private readonly listStore = this._register(new DisposableStore());
	private repoHandle: IVoltQueryHandle<IVoltPrRepo | null> | undefined;
	private listHandle: IVoltQueryHandle<readonly IVoltPullRequest[]> | undefined;
	/** The list key watched: a repository or filter change watches another one. */
	private listKey: string | undefined;
	private refreshButton: HTMLButtonElement | undefined;
	private repo: IVoltPrRepo | undefined;
	/** The folder's repository was read at least once (it may have none). */
	private repoResolved = false;
	private folder: string | undefined;
	private prs: readonly IVoltPullRequest[] | undefined;
	private error: unknown;
	private loading = false;
	private sort: AgentPrSort;
	private stateFilter: StateFilter;
	private shiftHeld = false;
	private busyKey: string | undefined;

	constructor(
		options: IViewPaneOptions,
		@IKeybindingService keybindingService: IKeybindingService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IConfigurationService configurationService: IConfigurationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IViewDescriptorService viewDescriptorService: IViewDescriptorService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IOpenerService openerService: IOpenerService,
		@IThemeService themeService: IThemeService,
		@IHoverService hoverService: IHoverService,
		@IAgentPullRequestService private readonly pullRequests: IAgentPullRequestService,
		@IContextViewService private readonly contextViewService: IContextViewService,
		@IStorageService private readonly storageService: IStorageService,
		@IEditorService private readonly editorService: IEditorService,
		@INotificationService private readonly notificationService: INotificationService,
		@IVoltQueryCache private readonly cache: IVoltQueryCache,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);
		const sort = this.storageService.get(SORT_KEY, StorageScope.PROFILE);
		this.sort = sort && sort in SORT_LABELS ? sort as AgentPrSort : 'blocked';
		const state = this.storageService.get(STATE_KEY, StorageScope.PROFILE);
		this.stateFilter = state === 'closed' || state === 'all' ? state : 'open';
		this._register(Event.any(onDidChangePullRequestsViewSession, this.editorService.onDidActiveEditorChange)(() => this.syncFolder()));
		this._register(this.pullRequests.onDidChange(() => this.paint()));
		this._register(this.onDidChangeBodyVisibility(visible => {
			if (visible) {
				this.syncFolder(true);
			} else {
				this.poll.cancel();
			}
		}));
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);
		this.content = append(container, $('.volt-pr-list-view'));
		const win = getWindow(container);
		const shift = (e: KeyboardEvent) => {
			const held = e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey;
			if (held !== this.shiftHeld) {
				this.shiftHeld = held;
				this.content.classList.toggle('shift-held', held);
			}
		};
		this._register(addDisposableListener(win, 'keydown', shift, true));
		this._register(addDisposableListener(win, 'keyup', shift, true));
		this._register(addDisposableListener(win, 'blur', () => {
			this.shiftHeld = false;
			this.content.classList.remove('shift-held');
		}));
		this.syncFolder(true);
	}

	protected override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);
		this.content.style.height = `${height}px`;
	}

	/** The chat the list serves: the files sidebar's, the chat on screen, or the active chat editor's. */
	private sessionId(): string | undefined {
		const shown = pullRequestsViewSession();
		if (shown) {
			return shown;
		}
		const active = this.editorService.activeEditor;
		return active instanceof AgentEditorInput ? active.sessionId : agentToolsSessionOnScreen();
	}

	/**
	 * Follows the chat's folder. `rewatch` (shown again) watches its queries anew, which reads
	 * behind the cached list only when that is stale.
	 */
	private syncFolder(rewatch = false): void {
		if (!this.content) {
			return;
		}
		const sessionId = this.sessionId();
		const folder = sessionId ? this.pullRequests.folderFor(sessionId) : undefined;
		if (folder === this.folder && !rewatch) {
			this.paint();
			return;
		}
		this.folder = folder;
		this.watchRepo();
	}

	private watchRepo(): void {
		this.repoStore.clear();
		this.repoHandle = undefined;
		this.listKey = undefined;
		if (this.folder) {
			const handle = this.repoStore.add(this.cache.watch(repoQuery(this.pullRequests, this.folder)));
			this.repoHandle = handle;
			this.repoStore.add(handle.onDidChange(() => this.sync()));
		}
		this.sync();
	}

	/** Watches the list of the repository and filter shown, unless it already does. */
	private watchList(): void {
		const repo = this.repo?.provider === 'github' ? this.repo : undefined;
		const key = repo ? listKey(repo, this.stateFilter) : undefined;
		if (key === this.listKey && (!key || this.listHandle)) {
			return;
		}
		this.listStore.clear();
		this.listHandle = undefined;
		this.listKey = key;
		if (repo) {
			const handle = this.listStore.add(this.cache.watch(listQuery(this.pullRequests, repo, this.stateFilter)));
			this.listHandle = handle;
			this.listStore.add(handle.onDidChange(() => this.sync()));
		}
	}

	/** Takes what the cache holds; a read starting or ending with nothing new only turns the refresh button. */
	private sync(): void {
		const before = { repo: this.repo, repoResolved: this.repoResolved, prs: this.prs, error: this.error };
		const repoState = this.repoHandle?.state;
		this.repo = repoState?.data ?? undefined;
		this.repoResolved = repoState?.updatedAt !== undefined;
		this.watchList();
		const listState = this.listHandle?.state;
		// Another code host's repository has no list to read (yet).
		this.prs = listState ? listState.data : this.repo ? [] : undefined;
		this.error = listState?.error;
		this.loading = !!repoState?.fetching || !!listState?.fetching;
		if (before.repo !== this.repo || before.repoResolved !== this.repoResolved || before.prs !== this.prs || before.error !== this.error) {
			this.paint();
		} else {
			this.syncRefresh();
		}
		if (!this.loading && this.isBodyVisible()) {
			this.poll.schedule();
		}
	}

	/** Reads the repository and its list again; `force` (the refresh button) skips the service's own caches. */
	private async load(force: boolean): Promise<void> {
		await Promise.all([this.repoHandle?.refetch(force), this.listHandle?.refetch(force)]);
	}

	private paint(): void {
		if (!this.content) {
			return;
		}
		this.renderStore.clear();
		clearNode(this.content);
		this.renderToolbar();
		const sessionId = this.sessionId();
		if (!this.folder) {
			this.empty(localize('voltPr.list.noChat', "Open a chat in a GitHub project to see its pull requests."));
			return;
		}
		if (this.repo && this.repo.provider === 'unknown') {
			this.empty(localize('voltPr.list.unsupported', "Volt does not know this project's code host yet. Sign in to it to read its pull requests."));
			return;
		}
		if (!this.repo && this.repoResolved && !this.error) {
			this.empty(localize('voltPr.list.noRemote', "This folder has no GitHub remote."));
			return;
		}
		const linked = sessionId ? visibleLinks(this.pullRequests.links(sessionId)) : [];
		if (linked.length) {
			this.section(localize('voltPr.list.thisChat', "This chat"), linked.length);
			for (const link of [...linked].sort((a, b) => Number(isOpenState(b.snapshot?.state)) - Number(isOpenState(a.snapshot?.state)) || b.linkedAt - a.linkedAt)) {
				const listed = this.prs?.find(candidate => candidate.key === link.key);
				const pr = link.snapshot && (!listed || link.snapshot.updatedAt >= listed.updatedAt) ? link.snapshot : listed ?? link.snapshot;
				if (pr) {
					this.row(pr, link);
				}
			}
		}
		if (this.error) {
			this.problem(this.error);
			return;
		}
		if (!this.prs) {
			const skeleton = append(this.content, $('.volt-pr-skeleton.compact'));
			for (const width of [80, 60, 75, 50]) {
				append(skeleton, $('.volt-pr-skeleton-line')).style.width = `${width}%`;
			}
			return;
		}
		const linkedKeys = new Set(linked.map(link => link.key));
		const rest = this.prs.filter(pr => !linkedKeys.has(pr.key));
		if (!rest.length && !linked.length) {
			this.empty(this.stateFilter === 'open' ? localize('voltPr.list.noneOpen', "No open pull requests.") : localize('voltPr.list.none', "No pull requests."));
			return;
		}
		const labels = {
			authored: localize('voltPr.list.authored', "Authored by you"),
			reviewRequested: localize('voltPr.list.reviewRequested', "Review requested"),
			others: localize('voltPr.list.others', "Others"),
		};
		for (const group of groupAndRank(rest, this.sort)) {
			this.section(labels[group.id], group.items.length);
			for (const pr of group.items) {
				this.row(pr, undefined);
			}
		}
	}

	private renderToolbar(): void {
		const bar = append(this.content, $('.volt-pr-list-toolbar'));
		const repo = append(bar, $('span.volt-pr-list-repo'));
		repo.textContent = this.repo ? `${this.repo.owner}/${this.repo.name}` : this.repoResolved ? '' : localize('voltPr.list.loading', "Loading…");
		if (this.repo?.branch) {
			setAgentTooltip(repo, localize('voltPr.list.onBranch', "{0}/{1} · on {2}", this.repo.owner, this.repo.name, this.repo.branch));
		}
		append(bar, $('.volt-pr-spacer'));
		const stateButton = this.toolbarButton(bar, undefined, this.stateFilter === 'open' ? localize('voltPr.list.open', "Open") : this.stateFilter === 'closed' ? localize('voltPr.list.closed', "Closed") : localize('voltPr.list.all', "All"), localize('voltPr.list.stateFilter', "Show"), button => {
			showVoltMenu<StateFilter>(this.contextViewService, {
				anchor: button, align: 'right', ariaLabel: localize('voltPr.list.stateFilter', "Show"), width: 180,
				sections: [{ id: 's', items: (['open', 'closed', 'all'] as const).map(state => ({ id: state, label: state === 'open' ? localize('voltPr.list.open', "Open") : state === 'closed' ? localize('voltPr.list.closedMerged', "Closed and merged") : localize('voltPr.list.all', "All"), checked: state === this.stateFilter, data: state })) }],
				onPick: item => {
					this.stateFilter = item.data;
					this.storageService.store(STATE_KEY, item.data, StorageScope.PROFILE, StorageTarget.USER);
					this.sync();
				},
			});
		});
		stateButton.classList.add('text');
		this.toolbarButton(bar, Codicon.listFilter, undefined, localize('voltPr.list.sortBy', "Sort: {0}", SORT_LABELS[this.sort]), button => {
			showVoltMenu<AgentPrSort>(this.contextViewService, {
				anchor: button, align: 'right', ariaLabel: localize('voltPr.list.sort', "Sort"), width: 200,
				sections: [{ id: 's', title: localize('voltPr.list.sort', "Sort"), items: (Object.keys(SORT_LABELS) as AgentPrSort[]).map(sort => ({ id: sort, label: SORT_LABELS[sort], checked: sort === this.sort, data: sort })) }],
				onPick: item => {
					this.sort = item.data;
					this.storageService.store(SORT_KEY, item.data, StorageScope.PROFILE, StorageTarget.USER);
					this.paint();
				},
			});
		});
		this.refreshButton = this.toolbarButton(bar, undefined, undefined, localize('voltPr.refresh', "Refresh"), () => {
			void this.pullRequests.refresh();
			void this.load(true);
		});
		this.syncRefresh();
		const create = this.toolbarButton(bar, Codicon.gitPullRequestCreate, undefined, localize('voltPr.list.new', "New Pull Request"), () => {
			if (this.folder) {
				void this.instantiationService.invokeFunction(accessor => openPullRequest(accessor, { kind: 'new', folder: this.folder! }, this.sessionId()));
			}
		});
		create.disabled = !this.folder || !this.repo;
	}

	/** The refresh button is the only sign of a read in flight: the cached list stays as it is. */
	private syncRefresh(): void {
		const button = this.refreshButton;
		if (!button) {
			return;
		}
		clearNode(button);
		button.appendChild(renderIcon(this.loading ? ThemeIcon.modify(Codicon.loading, 'spin') : Codicon.refresh));
		button.disabled = this.loading;
	}

	private toolbarButton(parent: HTMLElement, icon: ThemeIcon | undefined, text: string | undefined, label: string, run: (button: HTMLButtonElement) => void): HTMLButtonElement {
		const button = append(parent, $('button.volt-pr-icon-button')) as HTMLButtonElement;
		button.type = 'button';
		if (icon) {
			button.appendChild(renderIcon(icon));
		}
		if (text) {
			append(button, $('span')).textContent = text;
			append(button, renderIcon(Codicon.chevronDown)).classList.add('chevron');
		}
		button.setAttribute('aria-label', label);
		setAgentTooltip(button, label);
		this.renderStore.add(addDisposableListener(button, 'click', e => {
			EventHelper.stop(e, true);
			run(button);
		}));
		return button;
	}

	private section(label: string, count: number): void {
		const header = append(this.content, $('.volt-pr-list-section'));
		append(header, $('span')).textContent = label;
		append(header, $('span.volt-pr-count')).textContent = String(count);
	}

	private empty(text: string): void {
		append(this.content, $('.volt-pr-list-empty')).textContent = text;
	}

	private problem(err: unknown): void {
		const problem = problemText(voltPrErrorCode(err), voltPrErrorMessage(err));
		const card = append(this.content, $('.volt-pr-problem.compact'));
		append(card, $('.volt-pr-problem-title')).textContent = problem.title;
		append(card, $('.volt-pr-problem-detail')).textContent = problem.detail;
		const actions = append(card, $('.volt-pr-problem-actions'));
		const add = (label: string, run: () => unknown, primary = false) => {
			const button = append(actions, $(`button.volt-pr-button.${primary ? 'primary' : 'secondary'}`)) as HTMLButtonElement;
			button.textContent = label;
			this.renderStore.add(addDisposableListener(button, 'click', () => void run()));
		};
		if (problem.action === 'signIn') {
			add(localize('voltPr.signInButton', "Sign In with GitHub CLI"), () => this.instantiationService.invokeFunction(accessor => signInWithGh(accessor, this.repo?.host ?? 'github.com')), true);
		} else if (problem.action === 'install') {
			add(localize('voltPr.install', "Get the GitHub CLI"), () => this.openerService.open('https://cli.github.com/'), true);
		}
		add(localize('voltPr.retry', "Retry"), async () => {
			await this.pullRequests.api.refreshAccounts();
			await this.load(true);
		});
	}

	/**
	 * T3 Code's two lines: state glyph (a conflict marks its corner), #number, title and checks, with
	 * the size on the right; then the author, branch, labels and what it waits on, with its age.
	 */
	private row(pr: IVoltPullRequest, link: IAgentPrLink | undefined): void {
		const row = append(this.content, $('.volt-pr-list-row')) as HTMLElement;
		row.tabIndex = 0;
		row.setAttribute('role', 'button');
		row.classList.toggle('busy', this.busyKey === pr.key);
		const glyph = append(row, $('.volt-pr-list-glyph'));
		iconSpan(glyph, prStateIcon(pr.state), `state-${pr.state}`);
		if (pr.mergeable === 'conflicting' && isOpenState(pr.state)) {
			const conflict = iconSpan(glyph, Codicon.warning, 'conflict');
			setAgentTooltip(conflict, localize('voltPr.list.conflicts', "Has conflicts with {0}", pr.baseRefName));
		}
		const lines = append(row, $('.volt-pr-list-lines'));
		const line1 = append(lines, $('.volt-pr-list-line'));
		append(line1, $('span.volt-pr-list-number')).textContent = `#${pr.number}`;
		append(line1, $('span.volt-pr-list-title')).textContent = pr.title;
		if (pr.checks.state !== 'none' && isOpenState(pr.state)) {
			const checks = iconSpan(line1, checkIcon(pr.checks.state), `check-${pr.checks.state}`);
			setAgentTooltip(checks, checksLabel(pr));
		}
		if (link?.watch) {
			const eye = iconSpan(line1, Codicon.eye, 'watching');
			setAgentTooltip(eye, localize('voltPr.list.watched', "This chat's agent is watching it"));
		}
		append(line1, $('.volt-pr-spacer'));
		const size = append(line1, $('span.volt-pr-stats'));
		append(size, $('span.add')).textContent = `+${pr.additions}`;
		append(size, $('span.del')).textContent = `\u2212${pr.deletions}`;

		const line2 = append(lines, $('.volt-pr-list-line.sub'));
		avatar(line2, pr.author.login, pr.author.avatarUrl, 14);
		append(line2, $('span.volt-pr-list-author')).textContent = pr.author.login;
		append(line2, $('span.volt-pr-list-branch')).textContent = pr.headRefName;
		for (const label of pr.labels.slice(0, 2)) {
			const chip = append(line2, $('span.volt-pr-label.small'));
			chip.style.setProperty('--volt-pr-label', `#${/^[0-9a-f]{6}$/i.test(label.color) ? label.color : '888888'}`);
			chip.textContent = label.name;
		}
		if (pr.unresolvedThreads) {
			const threads = append(line2, $('span.volt-pr-list-threads'));
			threads.appendChild(renderIcon(Codicon.commentUnresolved));
			append(threads, $('span')).textContent = String(pr.unresolvedThreads);
		}
		const reason = blockedReason(pr);
		if (reason) {
			append(line2, $(`span.volt-pr-list-reason.reason-${reasonClass(pr)}`)).textContent = reason;
		}
		append(line2, $('.volt-pr-spacer'));
		append(line2, $('span.volt-pr-list-age')).textContent = ago(pr.updatedAt);
		this.quickActions(row, pr);

		const open = () => void this.instantiationService.invokeFunction(accessor => openPullRequest(accessor, { kind: 'pr', repo: pr.repo, number: pr.number }, this.sessionId()));
		this.renderStore.add(addDisposableListener(row, 'click', e => {
			if ((e.target as HTMLElement).closest('.volt-pr-quick')) {
				return;
			}
			open();
		}));
		this.renderStore.add(addDisposableListener(row, 'keydown', e => {
			if (e.key === 'Enter' || e.key === ' ') {
				EventHelper.stop(e, true);
				open();
			}
		}));
		setAgentTooltip(row, `#${pr.number} ${pr.title}\n${pr.baseRefName} ← ${pr.headRefName} · ${pr.author.login}\n+${pr.additions} \u2212${pr.deletions} · ${pr.changedFiles} files`);
	}

	/** Shown while Shift is held: one click acts, no confirmation (the Shift is the confirmation). */
	private quickActions(row: HTMLElement, pr: IVoltPullRequest): void {
		const actions = append(row, $('.volt-pr-quick'));
		const add = (label: string, icon: ThemeIcon, run: () => Promise<unknown>) => {
			const button = append(actions, $('button.volt-pr-quick-button')) as HTMLButtonElement;
			button.type = 'button';
			button.appendChild(renderIcon(icon));
			append(button, $('span')).textContent = label;
			this.renderStore.add(addDisposableListener(button, 'click', e => {
				EventHelper.stop(e, true);
				void this.quick(pr, label, run);
			}));
		};
		const request = { repo: pr.repo, number: pr.number };
		if (pr.state === 'closed') {
			add(localize('voltPr.reopenShort', "Reopen"), Codicon.issueReopened, () => this.pullRequests.api.setState({ ...request, state: 'open' }));
		} else if (pr.state === 'draft') {
			add(localize('voltPr.closeShort', "Close"), Codicon.gitPullRequestClosed, () => this.pullRequests.api.setState({ ...request, state: 'closed' }));
			add(localize('voltPr.readyShort', "Ready"), Codicon.eye, () => this.pullRequests.api.setDraft({ ...request, draft: false }));
		} else if (pr.state === 'open') {
			add(localize('voltPr.closeShort', "Close"), Codicon.gitPullRequestClosed, () => this.pullRequests.api.setState({ ...request, state: 'closed' }));
			add(localize('voltPr.mergeShort', "Merge"), Codicon.gitMerge, async () => {
				// Fresh detail first: the merge goes in only on the head and method the repository allows now.
				const detail = await this.pullRequests.detail(request, true);
				if (detail.state !== 'open') {
					throw new Error(localize('voltPr.notMergeable', "#{0} is {1} now.", pr.number, detail.state));
				}
				const method = resolveMergeMethod(detail.mergeOptions, this.pullRequests.lastMergeMethod(pr.repo));
				await this.pullRequests.api.merge({ ...request, method, headOid: detail.headRefOid, deleteBranch: detail.mergeOptions.deleteBranchOnMerge && !detail.crossRepository });
			});
		}
	}

	private async quick(pr: IVoltPullRequest, label: string, run: () => Promise<unknown>): Promise<void> {
		if (this.busyKey) {
			return;
		}
		this.busyKey = pr.key;
		this.paint();
		try {
			await run();
			this.notificationService.info(localize('voltPr.quickDone', "{0}: #{1}", label, pr.number));
		} catch (err) {
			this.notificationService.error(localize('voltPr.quickFailed', "{0} #{1} failed: {2}", label, pr.number, voltPrErrorMessage(err)));
		} finally {
			this.busyKey = undefined;
			await this.load(false);
			void this.pullRequests.refresh([pr.key]);
		}
	}

	override shouldShowWelcome(): boolean {
		return false;
	}
}

function reasonClass(pr: IVoltPullRequest): string {
	if (pr.mergeable === 'conflicting' || pr.checks.state === 'failure' || pr.reviewDecision === 'changesRequested') {
		return 'bad';
	}
	if (pr.state === 'open' && pr.reviewDecision === 'approved' && pr.checks.state !== 'pending') {
		return 'good';
	}
	return 'neutral';
}
