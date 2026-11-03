/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import '../media/agentCustomize.css';
import '../media/agentPullRequests.css';
import '../media/agentPullRequestsPage.css';
import { $, addDisposableListener, append, clearNode, Dimension, EventHelper, EventType } from '../../../../../base/browser/dom.js';
import { renderIcon } from '../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { IListRenderer, IListVirtualDelegate } from '../../../../../base/browser/ui/list/list.js';
import { DomScrollableElement } from '../../../../../base/browser/ui/scrollbar/scrollableElement.js';
import { RunOnceScheduler } from '../../../../../base/common/async.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { DisposableStore, MutableDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { isMacintosh } from '../../../../../base/common/platform.js';
import { basename } from '../../../../../base/common/resources.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { URI } from '../../../../../base/common/uri.js';
import { localize } from '../../../../../nls.js';
import { IClipboardService } from '../../../../../platform/clipboard/common/clipboardService.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IContextViewService } from '../../../../../platform/contextview/browser/contextView.js';
import { IEditorOptions } from '../../../../../platform/editor/common/editor.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { WorkbenchList } from '../../../../../platform/list/browser/listService.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../../platform/theme/common/themeService.js';
import { IVoltPrRepo, IVoltPullRequest, voltPrErrorCode, voltPrErrorMessage } from '../../../../../platform/voltPullRequests/common/voltPullRequests.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { EditorPane } from '../../../../browser/parts/editor/editorPane.js';
import { IEditorOpenContext } from '../../../../common/editor.js';
import { IEditorGroup } from '../../../../services/editor/common/editorGroupsService.js';
import { IWorkbenchLayoutService } from '../../../../services/layout/browser/layoutService.js';
import { IVoltQueryCache, IVoltQueryHandle } from '../../../../services/voltRuntime/browser/queryCache.js';
import { IVoltSessionContextService } from '../../../../services/voltRuntime/common/sessionContext.js';
import { IVoltProjectsService, VoltProjectCommands } from '../../../voltProjects/common/projects.js';
import { compilePrSearch, IPrSearch, IPrSearchHit, rankBySearch } from '../../common/agentPullRequestSearch.js';
import { blockedReason, isOpenState, isReadyToMerge, prInvolvement } from '../../common/agentPullRequests.js';
import { AGENT_HEADER_SEARCH_PATH } from '../chrome/agentTitlebarHeader.js';
import { setAgentTooltip } from '../chrome/agentTooltip.js';
import { createVoltButton } from '../chrome/voltButton.js';
import { createAgentScrollable } from '../editor/agentScrollable.js';
import { OPEN_AGENT_COMMAND_ID } from '../editor/agentEditorInput.js';
import { appendAgentFooterActions } from '../home/agentHomeFooterActions.js';
import { createHomeFilterIcon } from '../home/agentHomeIcons.js';
import { createVoltDropdown } from '../ui/dropdown/voltDropdown.js';
import { IVoltMenuItem, showVoltMenu } from '../ui/menu/voltMenu.js';
import { groupPullRequests, IPrFilter, matchesPrFilter, parsePrFilter, prFilterCount, serializePrFilter, showPrFilterMenu } from './agentPullRequestFilterMenu.js';
import { AgentPullRequestEditorInput } from './agentPullRequestEditorInput.js';
import { IAgentPullRequestService } from './agentPullRequestService.js';
import { AGENT_PULL_REQUESTS_PAGE_EDITOR_ID, AgentPullRequestsPageInput } from './agentPullRequestsPageInput.js';
import { buildPullRequestRow, lineIcon, listQuery, paintMatches, reasonClass, repoQuery } from './agentPullRequestsViewPane.js';
import { ago, avatar, checkIcon, checksLabel, iconSpan, mergePullRequest, openPullRequest, prStateIcon, problemText, signInWithGh } from './agentPullRequestUi.js';
import { AgentPullRequestView } from './agentPullRequestView.js';

const VIEW_KEY = 'volt.pullRequestsPage.filter';
const FILTER_KEY = 'volt.pullRequestsPage.filters';
const POLL_MS = 60_000;
/** Customize's row height (.volt-customize-row min-height). */
const ROW_HEIGHT = 50;
const HEADER_HEIGHT = 32;

type PageView = 'open' | 'mine' | 'review' | 'ready' | 'blocked' | 'draft' | 'linked' | 'merged' | 'closed';

const VIEW_ORDER: readonly PageView[] = ['open', 'mine', 'review', 'ready', 'blocked', 'draft', 'linked', 'merged', 'closed'];

const VIEW_LABELS: Record<PageView, string> = {
	open: localize('voltPrPage.filter.open', "Open"),
	mine: localize('voltPrPage.filter.mine', "Yours"),
	review: localize('voltPrPage.filter.review', "Review Requested"),
	ready: localize('voltPrPage.filter.ready', "Ready"),
	blocked: localize('voltPrPage.filter.blocked', "Blocked"),
	draft: localize('voltPrPage.filter.draft', "Drafts"),
	linked: localize('voltPrPage.filter.linked', "Linked to Chats"),
	merged: localize('voltPrPage.filter.merged', "Merged"),
	closed: localize('voltPrPage.filter.closed', "Closed"),
};

/** Conflicts, changes requested or failing checks: something has to change before it can merge. */
function isBlocked(pr: IVoltPullRequest): boolean {
	return isOpenState(pr.state) && (pr.mergeable === 'conflicting' || pr.reviewDecision === 'changesRequested' || pr.checks.state === 'failure');
}

function matchesView(pr: IVoltPullRequest, view: PageView, linked: boolean): boolean {
	switch (view) {
		case 'open': return isOpenState(pr.state);
		case 'mine': return isOpenState(pr.state) && prInvolvement(pr) === 'authored';
		case 'review': return isOpenState(pr.state) && prInvolvement(pr) === 'reviewRequested';
		case 'ready': return isReadyToMerge(pr);
		case 'blocked': return isBlocked(pr);
		case 'draft': return pr.state === 'draft';
		case 'linked': return linked;
		case 'merged': return pr.state === 'merged';
		case 'closed': return pr.state === 'closed';
	}
}

/** The repositories the picker offers: a folder each, deduplicated by remote. */
interface IRepoChoice {
	readonly folder: string;
	readonly repo: IVoltPrRepo;
}

interface IPrRow {
	readonly kind: 'pr';
	readonly pr: IVoltPullRequest;
	/** Chats it is linked to. */
	readonly chats: readonly string[];
	readonly hit: IPrSearchHit | undefined;
}

interface IHeaderRow {
	readonly kind: 'header';
	readonly id: string;
	readonly label: string;
	readonly count: number;
}

type IRow = IPrRow | IHeaderRow;

interface IRowActions {
	menu(anchor: HTMLElement, row: IPrRow): void;
	merge(pr: IVoltPullRequest): void;
}

interface IPrTemplate {
	readonly row: HTMLElement;
	readonly tile: HTMLElement;
	readonly title: HTMLElement;
	readonly labels: HTMLElement;
	readonly number: HTMLElement;
	readonly author: HTMLElement;
	readonly head: HTMLElement;
	readonly when: HTMLElement;
	readonly trailing: HTMLElement;
	readonly store: DisposableStore;
}

interface IHeaderTemplate {
	readonly label: HTMLElement;
	readonly count: HTMLElement;
}

class RowDelegate implements IListVirtualDelegate<IRow> {
	getHeight(row: IRow): number {
		return row.kind === 'header' ? HEADER_HEIGHT : ROW_HEIGHT;
	}
	getTemplateId(row: IRow): string {
		return row.kind === 'header' ? HeaderRenderer.TEMPLATE_ID : RowRenderer.TEMPLATE_ID;
	}
}

/** A group's name and count, as the sidebar's list sections them. */
class HeaderRenderer implements IListRenderer<IHeaderRow, IHeaderTemplate> {
	static readonly TEMPLATE_ID = 'voltPullRequestsPageHeader';
	readonly templateId = HeaderRenderer.TEMPLATE_ID;

	renderTemplate(container: HTMLElement): IHeaderTemplate {
		container.classList.add('volt-prs-group-row');
		const header = append(container, $('.volt-prs-group'));
		return { label: append(header, $('span')), count: append(header, $('span.volt-pr-count')) };
	}

	renderElement(element: IHeaderRow, _index: number, t: IHeaderTemplate): void {
		t.label.textContent = element.label;
		t.count.textContent = String(element.count);
	}

	disposeTemplate(): void { }
}

/**
 * A pull request as a Customize row: its state in the tile, the title with labels, then number,
 * author, branch and age below; what it waits on, checks and threads at the end, and its menu.
 */
class RowRenderer implements IListRenderer<IPrRow, IPrTemplate> {
	static readonly TEMPLATE_ID = 'voltPullRequestsPageRow';
	readonly templateId = RowRenderer.TEMPLATE_ID;

	constructor(private readonly actions: IRowActions) { }

	renderTemplate(container: HTMLElement): IPrTemplate {
		const row = append(container, $('.volt-customize-row.volt-prs-row'));
		const tile = append(row, $('.volt-customize-tile'));
		const copy = append(row, $('.volt-customize-row-copy'));
		const line = append(copy, $('.volt-customize-row-line'));
		const title = append(line, $('span.name'));
		const labels = append(line, $('span.volt-prs-labels'));
		const description = append(copy, $('span.description'));
		const number = append(description, $('span'));
		append(description, $('span.sep')).textContent = ' · ';
		const author = append(description, $('span'));
		append(description, $('span.sep')).textContent = ' · ';
		const head = append(description, $('span'));
		append(description, $('span.sep')).textContent = ' · ';
		const when = append(description, $('span'));
		const trailing = append(row, $('.volt-prs-trailing'));
		return { row, tile, title, labels, number, author, head, when, trailing, store: new DisposableStore() };
	}

	renderElement(element: IPrRow, _index: number, t: IPrTemplate): void {
		const { pr, hit } = element;
		t.store.clear();
		const open = isOpenState(pr.state);

		clearNode(t.tile);
		iconSpan(t.tile, prStateIcon(pr.state), `state-${pr.state}`);

		paintMatches(t.title, pr.title, hit?.title);
		clearNode(t.labels);
		for (const label of pr.labels.slice(0, 2)) {
			append(t.labels, $('span.volt-customize-badge')).textContent = label.name;
		}
		if (pr.labels.length > 2) {
			append(t.labels, $('span.volt-customize-badge')).textContent = `+${pr.labels.length - 2}`;
		}

		paintMatches(t.number, `#${pr.number}`, hit?.number);
		paintMatches(t.author, pr.author.login, hit?.author);
		paintMatches(t.head, pr.headRefName, hit?.branch);
		const at = pr.state === 'merged' ? pr.mergedAt : pr.state === 'closed' ? pr.closedAt : pr.updatedAt;
		t.when.textContent = ago(at ?? pr.updatedAt);

		clearNode(t.trailing);
		const reason = open ? blockedReason(pr) : undefined;
		if (reason) {
			append(t.trailing, $(`span.volt-prs-reason.reason-${reasonClass(pr)}`)).textContent = reason;
		}
		if (pr.checks.state !== 'none') {
			const checks = iconSpan(t.trailing, checkIcon(pr.checks.state), `check-${pr.checks.state}`);
			setAgentTooltip(checks, checksLabel(pr));
		}
		if (pr.unresolvedThreads || pr.comments) {
			const talk = append(t.trailing, $('span.volt-prs-count'));
			talk.appendChild(renderIcon(pr.unresolvedThreads ? Codicon.commentUnresolved : Codicon.comment));
			append(talk, $('span')).textContent = String(pr.unresolvedThreads || pr.comments);
		}
		avatar(t.trailing, pr.author.login, pr.author.avatarUrl, 20);

		const stop = (button: HTMLElement, run: () => void) => {
			// The list opens a row on its own click; a button in it must not.
			t.store.add(addDisposableListener(button, EventType.MOUSE_DOWN, e => EventHelper.stop(e, true)));
			t.store.add(addDisposableListener(button, EventType.CLICK, e => {
				EventHelper.stop(e, true);
				run();
			}));
		};
		if (isReadyToMerge(pr)) {
			const merge = append(t.trailing, $('button.volt-customize-add-button')) as HTMLButtonElement;
			merge.type = 'button';
			merge.textContent = localize('voltPrPage.merge', "Merge");
			stop(merge, () => this.actions.merge(pr));
		}
		const more = append(t.trailing, $('button.volt-customize-row-more')) as HTMLButtonElement;
		more.type = 'button';
		more.appendChild(renderIcon(Codicon.ellipsis));
		more.setAttribute('aria-label', localize('voltPrPage.moreActions', "More Actions"));
		stop(more, () => this.actions.menu(more, element));

		t.row.classList.toggle('is-closed', !open);
	}

	disposeElement(_element: IPrRow, _index: number, t: IPrTemplate): void {
		t.store.clear();
	}

	disposeTemplate(t: IPrTemplate): void {
		t.store.dispose();
	}
}

/**
 * Pull Requests as a page of its own, opened from the sidebar footer like Usage, laid out like
 * Customize: search and New Pull Request on top, the repository, views and filters under them, and
 * one card of rows. Opening one covers the window like Settings: the pull requests in a sidebar of
 * their own (Back, search, view, filters, the agent list's footer) and the pull request beside it.
 * It reads through the same query cache as the files sidebar's list, so neither fetches twice.
 */
export class AgentPullRequestsPage extends EditorPane {

	static readonly ID = AGENT_PULL_REQUESTS_PAGE_EDITOR_ID;

	private rootEl!: HTMLElement;
	private scroll!: DomScrollableElement;
	private searchInput!: HTMLInputElement;
	private primaryButton!: HTMLButtonElement;
	private repoHost!: HTMLElement;
	private chipsEl!: HTMLElement;
	private filterButton!: HTMLButtonElement;
	private sectionTitle!: HTMLElement;
	private sectionCount!: HTMLElement;
	private syncedEl!: HTMLElement;
	private refreshButton!: HTMLButtonElement;
	private cardEl!: HTMLElement;
	private listHost!: HTMLElement;
	private messageEl!: HTMLElement;
	private list!: WorkbenchList<IRow>;
	private listHeight = 0;

	/** The overlay shown while a pull request is open: its sidebar and the pull request. */
	private detailEl!: HTMLElement;
	private sideSearchBox!: HTMLElement;
	private sideSearchInput!: HTMLInputElement;
	private sideViewText!: HTMLElement;
	private sideFilterButton!: HTMLButtonElement;
	private sideRefreshButton!: HTMLButtonElement;
	private sideCreateButton!: HTMLButtonElement;
	private sideScroll!: DomScrollableElement;
	private sideBody!: HTMLElement;
	private detailView!: AgentPullRequestView;
	private readonly detailInput = this._register(new MutableDisposable<AgentPullRequestEditorInput>());
	/** The pull request open in the overlay. */
	private openKey: string | undefined;
	private sideSearch: IPrSearch = compilePrSearch('');

	private readonly pickerStore = this._register(new DisposableStore());
	private readonly chipsStore = this._register(new DisposableStore());
	private readonly messageStore = this._register(new DisposableStore());
	private readonly sideStore = this._register(new DisposableStore());
	private readonly repoStore = this._register(new DisposableStore());
	private readonly listStore = this._register(new DisposableStore());
	private readonly poll = this._register(new RunOnceScheduler(() => void this.load(false), POLL_MS));
	private readonly repaint = this._register(new RunOnceScheduler(() => this.paint(), 0));

	private repoHandle: IVoltQueryHandle<IVoltPrRepo | null> | undefined;
	private openHandle: IVoltQueryHandle<readonly IVoltPullRequest[]> | undefined;
	private closedHandle: IVoltQueryHandle<readonly IVoltPullRequest[]> | undefined;
	private listRepoKey: string | undefined;
	private folder: string | undefined;
	private choices: readonly IRepoChoice[] = [];
	private view: PageView;
	private readonly filter: IPrFilter;
	private search: IPrSearch = compilePrSearch('');

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService private readonly storage: IStorageService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IAgentPullRequestService private readonly pullRequests: IAgentPullRequestService,
		@IVoltQueryCache private readonly cache: IVoltQueryCache,
		@IContextViewService private readonly contextViewService: IContextViewService,
		@IWorkspaceContextService private readonly workspace: IWorkspaceContextService,
		@IClipboardService private readonly clipboard: IClipboardService,
		@IOpenerService private readonly opener: IOpenerService,
		@ICommandService private readonly commands: ICommandService,
		@INotificationService private readonly notifications: INotificationService,
		@IVoltSessionContextService private readonly sessionContext: IVoltSessionContextService,
		@IVoltProjectsService private readonly projects: IVoltProjectsService,
		@IWorkbenchLayoutService private readonly layoutService: IWorkbenchLayoutService,
	) {
		super(AgentPullRequestsPage.ID, group, telemetryService, themeService, storage);
		const view = storage.get(VIEW_KEY, StorageScope.PROFILE);
		this.view = view && view in VIEW_LABELS ? view as PageView : 'open';
		this.filter = parsePrFilter(storage.get(FILTER_KEY, StorageScope.PROFILE));
		this._register(this.pullRequests.onDidChange(() => this.repaint.schedule()));
		// A project added while the page is open joins the picker (and fills an empty page).
		this._register(this.projects.onDidChange(() => {
			if (this.input) {
				void this.findRepos();
			}
		}));
	}

	protected override createEditor(parent: HTMLElement): void {
		this.rootEl = append(parent, $('.volt-customize-root.volt-prs-page'));
		this.rootEl.tabIndex = -1;
		const main = append(this.rootEl, $('.volt-customize-main'));
		const page = append(main, $('.volt-customize'));

		const header = append(page, $('.volt-customize-header-area'));
		const top = append(header, $('.volt-customize-top'));
		const search = append(top, $('.volt-customize-search'));
		search.appendChild(renderIcon(Codicon.search));
		const input = this.searchInput = append(search, $('input.volt-customize-search-input')) as HTMLInputElement;
		input.type = 'text';
		input.spellcheck = false;
		input.autocomplete = 'off';
		input.placeholder = localize('voltPrPage.search', "Search pull requests, authors, branches, labels...");
		input.setAttribute('aria-label', localize('voltPrPage.searchAria', "Search pull requests"));
		this._register(addDisposableListener(input, EventType.INPUT, () => {
			const compiled = compilePrSearch(input.value);
			search.classList.toggle('invalid', !!compiled.error);
			if (!compiled.error) {
				this.search = compiled;
				this.paintList();
			}
		}));
		this._register(addDisposableListener(input, EventType.KEY_DOWN, e => {
			if (e.key === 'Escape' && input.value) {
				EventHelper.stop(e, true);
				input.value = '';
				this.search = compilePrSearch('');
				this.paintList();
			} else if (e.key === 'ArrowDown' || e.key === 'Enter') {
				const first = this.firstPrIndex();
				if (first >= 0) {
					EventHelper.stop(e, true);
					this.list.domFocus();
					this.list.setFocus([first]);
					if (e.key === 'Enter') {
						this.openPr((this.list.element(first) as IPrRow).pr);
					}
				}
			}
		}));
		this.primaryButton = append(top, $('button.volt-customize-primary')) as HTMLButtonElement;
		this.primaryButton.type = 'button';
		this.primaryButton.textContent = localize('voltPrPage.new', "New Pull Request");
		this._register(addDisposableListener(this.primaryButton, EventType.CLICK, () => this.createPullRequest()));

		const filters = append(header, $('.volt-customize-filters'));
		this.repoHost = append(filters, $('.volt-customize-resource-scope'));
		append(filters, $('span.volt-customize-divider'));
		this.chipsEl = append(filters, $('.volt-customize-chips'));
		this.filterButton = append(filters, $('button.volt-customize-icon-button.filter')) as HTMLButtonElement;
		this.filterButton.type = 'button';
		this.filterButton.appendChild(createHomeFilterIcon());
		this.filterButton.setAttribute('aria-label', localize('voltPrPage.filterSort', "Filter and Sort"));
		this._register(addDisposableListener(this.filterButton, EventType.CLICK, () => this.openFilterMenu(this.filterButton)));

		const body = $('.volt-customize-body');
		const listEl = append(body, $('.volt-customize-list'));
		this.scroll = this._register(createAgentScrollable(body));
		append(page, this.scroll.getDomNode()).classList.add('volt-customize-scroll');

		const section = append(listEl, $('.volt-customize-section'));
		const sectionHeader = append(section, $('.volt-customize-section-header'));
		const title = append(sectionHeader, $('h3.volt-customize-section-title'));
		this.sectionTitle = append(title, $('span'));
		this.sectionCount = append(title, $('span.count'));
		const sectionActions = append(sectionHeader, $('.volt-customize-section-actions'));
		this.syncedEl = append(sectionActions, $('span.volt-prs-synced'));
		this.refreshButton = append(sectionActions, $('button.volt-customize-icon-button')) as HTMLButtonElement;
		this.refreshButton.type = 'button';
		this.refreshButton.setAttribute('aria-label', localize('voltPrPage.refresh', "Refresh"));
		this._register(addDisposableListener(this.refreshButton, EventType.CLICK, () => this.refresh()));
		this.cardEl = append(section, $('.volt-customize-card'));
		this.listHost = append(this.cardEl, $('.volt-prs-list'));
		this.messageEl = append(section, $('.volt-prs-message'));
		this.createList();
		this.createDetail();
		this.paintChips();

		this._register(addDisposableListener(this.rootEl, EventType.KEY_DOWN, e => {
			if ((isMacintosh ? e.metaKey : e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'f') {
				EventHelper.stop(e, true);
				this.searchInput.focus();
				this.searchInput.select();
			}
		}));
	}

	override async setInput(input: AgentPullRequestsPageInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);
		if (token.isCancellationRequested) {
			return;
		}
		const fromChat = input.sessionId ? this.pullRequests.folderFor(input.sessionId) : undefined;
		// The page was just opened from a chat: that chat's repository; otherwise the one picked last.
		this.useFolder(input.folder ?? fromChat ?? this.candidateFolders()[0]);
		input.folder = this.folder;
		void this.findRepos();
	}

	override clearInput(): void {
		this.poll.cancel();
		this.closeDetail();
		super.clearInput();
	}

	protected override setEditorVisible(visible: boolean): void {
		super.setEditorVisible(visible);
		if (visible && this.input) {
			void this.load(false);
		} else {
			this.poll.cancel();
		}
		this.syncOverlay();
	}

	//#region Data

	/** The chat's folder, the active project, the window's folders and Volt's projects, then folders of chats with linked pull requests. */
	private candidateFolders(): string[] {
		const input = this.input instanceof AgentPullRequestsPageInput ? this.input : undefined;
		const active = this.sessionContext.activeProject?.root;
		const folders = [
			input?.sessionId ? this.pullRequests.folderFor(input.sessionId) : undefined,
			active?.scheme === 'file' ? active.fsPath : undefined,
			...this.workspace.getWorkspace().folders.filter(folder => folder.uri.scheme === 'file').map(folder => folder.uri.fsPath),
			...this.projects.list().filter(project => project.uri.scheme === 'file' && project.state.kind !== 'cloning').map(project => project.uri.fsPath),
			...this.pullRequests.linkedChats().map(sessionId => this.pullRequests.folderFor(sessionId)),
		];
		return [...new Set(folders.filter((folder): folder is string => !!folder))];
	}

	/** Reads every candidate folder's repository for the picker; one entry per remote repository. */
	private async findRepos(): Promise<void> {
		const found = await Promise.all(this.candidateFolders().slice(0, 24).map(async folder => {
			try {
				const repo = await this.pullRequests.repoForFolder(folder);
				return repo && repo.provider === 'github' ? { folder, repo } : undefined;
			} catch {
				return undefined;
			}
		}));
		const seen = new Set<string>();
		const choices: IRepoChoice[] = [];
		for (const choice of found) {
			const key = choice && `${choice.repo.host}/${choice.repo.owner}/${choice.repo.name}`.toLowerCase();
			if (choice && key && !seen.has(key)) {
				seen.add(key);
				choices.push(choice);
			}
		}
		this.choices = choices;
		if (!this.folder && choices.length) {
			this.useFolder(choices[0].folder);
		} else {
			this.paintPicker();
		}
	}

	private useFolder(folder: string | undefined): void {
		this.folder = folder;
		this.repoStore.clear();
		this.listStore.clear();
		this.repoHandle = this.openHandle = this.closedHandle = undefined;
		this.listRepoKey = undefined;
		if (folder) {
			const handle = this.repoStore.add(this.cache.watch(repoQuery(this.pullRequests, folder)));
			this.repoHandle = handle;
			this.repoStore.add(handle.onDidChange(() => this.sync()));
		}
		this.sync();
	}

	private get repo(): IVoltPrRepo | undefined {
		return this.repoHandle?.state.data ?? undefined;
	}

	/** Watches the open and closed lists of the repository shown, unless it already does. */
	private sync(): void {
		const repo = this.repo?.provider === 'github' ? this.repo : undefined;
		const key = repo && `${repo.host}/${repo.owner}/${repo.name}`.toLowerCase();
		if (key !== this.listRepoKey) {
			this.listStore.clear();
			this.openHandle = this.closedHandle = undefined;
			this.listRepoKey = key;
			if (repo) {
				this.openHandle = this.listStore.add(this.cache.watch(listQuery(this.pullRequests, repo, 'open')));
				this.closedHandle = this.listStore.add(this.cache.watch(listQuery(this.pullRequests, repo, 'closed')));
				this.listStore.add(this.openHandle.onDidChange(() => this.repaint.schedule()));
				this.listStore.add(this.closedHandle.onDidChange(() => this.repaint.schedule()));
			}
		}
		this.repaint.schedule();
	}

	private async load(force: boolean): Promise<void> {
		await Promise.all([this.repoHandle?.refetch(force), this.openHandle?.refetch(force), this.closedHandle?.refetch(force)]);
	}

	private refresh(): void {
		void this.pullRequests.refresh();
		void this.load(true);
	}

	private get loading(): boolean {
		return !!this.repoHandle?.state.fetching || !!this.openHandle?.state.fetching || !!this.closedHandle?.state.fetching;
	}

	/** Open and closed reads together; undefined until the open list has been read once. */
	private all(): readonly IVoltPullRequest[] | undefined {
		const open = this.openHandle?.state.data;
		if (!open) {
			return undefined;
		}
		return [...open, ...(this.closedHandle?.state.data ?? [])];
	}

	/** The pull requests the current view and filters let through, before any search. */
	private shown(all: readonly IVoltPullRequest[]): IVoltPullRequest[] {
		return all.filter(pr => {
			const linked = this.pullRequests.sessionsFor(pr.key).length > 0;
			return matchesView(pr, this.view, linked) && matchesPrFilter(pr, this.filter, linked);
		});
	}

	//#endregion

	//#region Actions

	private createList(): void {
		const actions: IRowActions = {
			menu: (anchor, row) => this.showRowMenu(anchor, row),
			merge: pr => void this.instantiationService.invokeFunction(accessor => mergePullRequest(accessor, pr)).then(merged => merged ? this.load(true) : undefined),
		};
		this.list = this._register(this.instantiationService.createInstance(WorkbenchList<IRow>, 'voltPullRequestsPage', this.listHost, new RowDelegate(), [new RowRenderer(actions), new HeaderRenderer()], {
			identityProvider: { getId: (row: IRow) => row.kind === 'pr' ? row.pr.key : `header:${row.id}` },
			multipleSelectionSupport: false,
			horizontalScrolling: false,
			alwaysConsumeMouseWheel: false,
			setRowLineHeight: false,
			accessibilityProvider: {
				getWidgetAriaLabel: () => localize('voltPrPage.listAria', "Pull requests"),
				getAriaLabel: (row: IRow) => row.kind === 'header' ? `${row.label}, ${row.count}` : `#${row.pr.number} ${row.pr.title}, ${row.pr.author.login}, ${blockedReason(row.pr) ?? row.pr.state}`,
			},
		}));
		this._register(this.list.onDidOpen(e => e.element?.kind === 'pr' && this.openPr(e.element.pr)));
		this._register(this.list.onKeyDown(e => {
			// Up from the first row goes back to the search.
			if (e.key === 'ArrowUp' && this.list.getFocus()[0] <= this.firstPrIndex()) {
				EventHelper.stop(e, true);
				this.searchInput.focus();
			}
		}));
	}

	private firstPrIndex(): number {
		for (let i = 0; i < this.list.length; i++) {
			if (this.list.element(i).kind === 'pr') {
				return i;
			}
		}
		return -1;
	}

	private createPullRequest(): void {
		const folder = this.folder;
		const input = this.input instanceof AgentPullRequestsPageInput ? this.input : undefined;
		if (folder && this.repo) {
			void this.instantiationService.invokeFunction(accessor => openPullRequest(accessor, { kind: 'new', folder }, input?.sessionId));
		}
	}

	private showRowMenu(anchor: HTMLElement, row: IPrRow): void {
		const { pr } = row;
		const items: IVoltMenuItem<() => void>[] = [
			{ id: 'open', label: localize('voltPrPage.open', "Open"), icon: Codicon.gitPullRequest, data: () => this.openPr(pr) },
		];
		if (row.chats.length) {
			items.push({ id: 'chat', label: localize('voltPrPage.openChat', "Open Linked Chat"), icon: Codicon.commentDiscussion, data: () => void this.commands.executeCommand(OPEN_AGENT_COMMAND_ID, row.chats[0]) });
		}
		items.push(
			{ id: 'browse', label: localize('voltPrPage.browse', "Open on GitHub"), icon: Codicon.linkExternal, data: () => void this.opener.open(URI.parse(pr.url), { openExternal: true }) },
			{
				id: 'copy', label: localize('voltPrPage.copyLink', "Copy Link"), icon: Codicon.copy, data: () => {
					void this.clipboard.writeText(pr.url);
					this.notifications.info(localize('voltPrPage.copied', "Copied the link to #{0}.", pr.number));
				}
			},
		);
		showVoltMenu<() => void>(this.contextViewService, {
			anchor,
			align: 'right',
			gap: 4,
			width: 200,
			className: 'volt-customize-menu',
			ariaLabel: localize('voltPrPage.moreActions', "More Actions"),
			sections: [{ id: 'actions', items }],
			onPick: item => item.data(),
		});
	}

	private openFilterMenu(anchor: HTMLButtonElement): void {
		showPrFilterMenu(this.contextViewService, anchor, this.filter, this.all() ?? [], () => {
			this.storage.store(FILTER_KEY, serializePrFilter(this.filter), StorageScope.PROFILE, StorageTarget.USER);
			this.paintChips();
			this.paintList();
			this.paintSidebar();
		});
	}

	private openViewMenu(anchor: HTMLElement): void {
		showVoltMenu<PageView>(this.contextViewService, {
			anchor,
			align: 'right',
			gap: 4,
			width: 200,
			ariaLabel: localize('voltPrPage.view', "Show"),
			sections: [{ id: 'view', items: VIEW_ORDER.map(id => ({ id, label: VIEW_LABELS[id], checked: id === this.view, data: id })) }],
			onPick: item => this.setView(item.data),
		});
	}

	private setView(view: PageView): void {
		this.view = view;
		this.storage.store(VIEW_KEY, view, StorageScope.PROFILE, StorageTarget.USER);
		this.paintChips();
		this.paintList();
		this.paintSidebar();
		this.scroll.setScrollPosition({ scrollTop: 0 });
	}

	//#endregion

	//#region Detail

	/** Built once and kept off the page until a pull request opens. */
	private createDetail(): void {
		this.detailEl = $('.volt-prs-page.volt-prs-detail');
		this._register(toDisposable(() => {
			this.detailEl.remove();
			this.layoutService.mainContainer.classList.remove('volt-prs-detail-open');
		}));
		const sidebar = append(this.detailEl, $('.volt-prs-sidebar'));
		const doc = sidebar.ownerDocument;

		const head = append(sidebar, $('.volt-prs-sidebar-head'));
		const back = append(head, $('button.volt-prs-back')) as HTMLButtonElement;
		back.type = 'button';
		back.appendChild(renderIcon(Codicon.arrowLeft));
		append(back, $('span')).textContent = localize('voltPrPage.back', "Back");
		back.setAttribute('aria-label', localize('voltPrPage.backAria', "Back to Pull Requests"));
		this._register(addDisposableListener(back, EventType.CLICK, () => this.closeDetail()));

		append(sidebar, $('.volt-prs-sidebar-title')).textContent = localize('voltPrPage.title', "Pull Requests");

		// The files sidebar's Pull Requests toolbar: search, view, filters, refresh and New.
		const bar = append(sidebar, $('.volt-pr-list-toolbar.volt-prs-sidebar-toolbar'));
		this.sideSearchBox = append(bar, $('.volt-pr-search'));
		append(this.sideSearchBox, $('span.volt-pr-search-icon')).appendChild(lineIcon(doc, [AGENT_HEADER_SEARCH_PATH], 14));
		const input = this.sideSearchInput = append(this.sideSearchBox, $('input.volt-pr-search-input')) as HTMLInputElement;
		input.type = 'text';
		input.spellcheck = false;
		input.autocomplete = 'off';
		input.setAttribute('aria-label', localize('voltPrPage.searchAria', "Search pull requests"));
		this._register(addDisposableListener(input, EventType.INPUT, () => {
			const search = compilePrSearch(input.value);
			this.sideSearchBox.classList.toggle('has-value', !!input.value);
			this.sideSearchBox.classList.toggle('invalid', !!search.error);
			if (!search.error) {
				this.sideSearch = search;
				this.paintSidebar();
			}
		}));
		this._register(addDisposableListener(input, EventType.KEY_DOWN, e => {
			if (e.key === 'Escape' && input.value) {
				EventHelper.stop(e, true);
				input.value = '';
				this.sideSearch = compilePrSearch('');
				this.sideSearchBox.classList.remove('has-value');
				this.paintSidebar();
			} else if (e.key === 'ArrowDown' || e.key === 'Enter') {
				EventHelper.stop(e, true);
				const first = this.sideRows()[0];
				if (e.key === 'Enter') {
					first?.click();
				} else {
					first?.focus();
				}
			}
		}));
		const toolbarButton = (label: string, glyph: Element | undefined, run: (button: HTMLButtonElement) => void) => {
			const button = append(bar, $('button.volt-pr-icon-button')) as HTMLButtonElement;
			button.type = 'button';
			if (glyph) {
				button.appendChild(glyph);
			}
			button.setAttribute('aria-label', label);
			this._register(addDisposableListener(button, EventType.CLICK, e => {
				EventHelper.stop(e, true);
				run(button);
			}));
			return button;
		};
		const viewButton = toolbarButton(localize('voltPrPage.view', "Show"), undefined, button => this.openViewMenu(button));
		viewButton.classList.add('text');
		this.sideViewText = append(viewButton, $('span'));
		append(viewButton, renderIcon(Codicon.chevronDown)).classList.add('chevron');
		this.sideFilterButton = toolbarButton(localize('voltPrPage.filterSort', "Filter and Sort"), createHomeFilterIcon(), button => this.openFilterMenu(button));
		this.sideFilterButton.classList.add('volt-prs-filter-button');
		this.sideRefreshButton = toolbarButton(localize('voltPrPage.refresh', "Refresh"), undefined, () => this.refresh());
		this.sideCreateButton = toolbarButton(localize('voltPrPage.new', "New Pull Request"), renderIcon(Codicon.gitPullRequestCreate), () => this.createPullRequest());

		const listView = $('.volt-pr-list-view.volt-prs-sidebar-list');
		this.sideBody = append(listView, $('.volt-pr-list-body'));
		this.sideScroll = this._register(createAgentScrollable(listView));
		append(sidebar, this.sideScroll.getDomNode()).classList.add('volt-prs-sidebar-scroll');

		// The agent list's footer row, so Settings, Usage and the rest are a click away here too.
		const footer = append(sidebar, $('.volt-prs-sidebar-footer'));
		const footerActions = appendAgentFooterActions(footer, this.commands, this._store, this.instantiationService);
		footerActions.pullRequests.classList.add('active');
		// Pull Requests is this page: it goes back to the list instead of opening the page again.
		this._register(addDisposableListener(footerActions.pullRequests, EventType.CLICK, e => {
			e.preventDefault();
			e.stopImmediatePropagation();
			this.closeDetail();
		}, true));

		const detailMain = append(this.detailEl, $('.volt-prs-detail-main'));
		const host = append(detailMain, $('.volt-pr-editor.volt-prs-detail-view'));
		this.detailView = this._register(this.instantiationService.createInstance(AgentPullRequestView, host));
	}

	private openPr(pr: IVoltPullRequest): void {
		const chats = this.pullRequests.sessionsFor(pr.key);
		this.openKey = pr.key;
		const input = this.instantiationService.createInstance(AgentPullRequestEditorInput, { kind: 'pr', repo: pr.repo, number: pr.number }, chats[0]);
		this.detailView.setInput(input);
		this.detailInput.value = input;
		this.syncOverlay();
		this.paintSidebar();
		this.detailView.focus();
	}

	private closeDetail(): void {
		if (!this.openKey) {
			return;
		}
		this.openKey = undefined;
		this.detailView.setInput(undefined);
		this.detailInput.clear();
		this.syncOverlay();
		this.searchInput.focus();
	}

	/** The overlay covers the window while a pull request is open and the page is on screen, as Settings does. */
	private syncOverlay(): void {
		if (!this.detailEl) {
			return;
		}
		const show = !!this.openKey && this.isVisible();
		const container = this.layoutService.mainContainer;
		this.detailView.setVisible(show);
		if (show) {
			container.classList.add('volt-prs-detail-open');
			if (this.detailEl.parentElement !== container) {
				container.appendChild(this.detailEl);
			}
			this.syncSidebarWidth();
		} else {
			container.classList.remove('volt-prs-detail-open');
			this.detailEl.remove();
		}
	}

	/** The sidebar takes the agent list's width, so the swap does not move the window's edge. */
	private syncSidebarWidth(): void {
		const sidebar = this.layoutService.mainContainer.querySelector<HTMLElement>('.part.auxiliarybar');
		const width = sidebar?.offsetWidth;
		this.detailEl.style.setProperty('--volt-prs-sidebar-width', width ? `${width}px` : '');
	}

	private sideRows(): HTMLElement[] {
		return [...this.sideBody.querySelectorAll<HTMLElement>('.volt-pr-list-row')];
	}

	private paintSidebar(): void {
		if (!this.detailEl || !this.openKey) {
			return;
		}
		this.sideStore.clear();
		clearNode(this.sideBody);
		const repo = this.repo;
		this.sideSearchInput.placeholder = repo
			? localize('voltPrPage.searchRepo', "Search {0}/{1}", repo.owner, repo.name)
			: localize('voltPrPage.searchShort', "Search pull requests");
		this.sideViewText.textContent = VIEW_LABELS[this.view];
		this.sideFilterButton.classList.toggle('active', prFilterCount(this.filter) > 0);
		clearNode(this.sideRefreshButton);
		this.sideRefreshButton.appendChild(renderIcon(this.loading ? ThemeIcon.modify(Codicon.loading, 'spin') : Codicon.refresh));
		this.sideRefreshButton.disabled = this.loading;
		this.sideCreateButton.disabled = !repo;

		const all = this.all();
		if (!all) {
			append(this.sideBody, $('.volt-pr-list-empty')).textContent = localize('voltPrPage.loading', "Loading pull requests...");
			return;
		}
		const shown = this.shown(all);
		const section = (label: string, count: number) => {
			const header = append(this.sideBody, $('.volt-pr-list-section'));
			append(header, $('span')).textContent = label;
			append(header, $('span.volt-pr-count')).textContent = String(count);
		};
		const addRow = (pr: IVoltPullRequest, hit: IPrSearchHit | undefined) => {
			const parts = buildPullRequestRow(pr, false);
			if (hit) {
				paintMatches(parts.number, `#${pr.number}`, hit.number);
				paintMatches(parts.title, pr.title, hit.title);
				paintMatches(parts.author, pr.author.login, hit.author);
				paintMatches(parts.branch, pr.headRefName, hit.branch);
			}
			parts.row.classList.toggle('selected', pr.key === this.openKey);
			parts.row.setAttribute('aria-current', String(pr.key === this.openKey));
			this.sideStore.add(addDisposableListener(parts.row, EventType.CLICK, () => this.openPr(pr)));
			this.sideStore.add(addDisposableListener(parts.row, EventType.KEY_DOWN, e => {
				if (e.key === 'Enter' || e.key === ' ') {
					EventHelper.stop(e, true);
					this.openPr(pr);
				} else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
					EventHelper.stop(e, true);
					const rows = this.sideRows();
					const next = rows[rows.indexOf(parts.row) + (e.key === 'ArrowDown' ? 1 : -1)];
					(next ?? (e.key === 'ArrowUp' ? this.sideSearchInput : undefined))?.focus();
				}
			}));
			this.sideBody.appendChild(parts.row);
		};
		if (this.sideSearch.empty) {
			for (const group of groupPullRequests(shown, this.filter)) {
				if (this.filter.grouping !== 'none') {
					section(group.label, group.items.length);
				}
				for (const pr of group.items) {
					addRow(pr, undefined);
				}
			}
		} else {
			const hits = rankBySearch(shown, this.sideSearch, pr => pr);
			if (hits.length) {
				section(localize('voltPrPage.matches', "Matches"), hits.length);
			}
			for (const { item, hit } of hits) {
				addRow(item, hit);
			}
		}
		if (!this.sideBody.childElementCount) {
			append(this.sideBody, $('.volt-pr-list-empty')).textContent = localize('voltPrPage.sideEmpty', "No pull requests match.");
		}
		this.sideScroll.scanDomNode();
	}

	//#endregion

	//#region Painting

	private paint(): void {
		if (!this.rootEl) {
			return;
		}
		this.paintPicker();
		this.paintChips();
		this.paintList();
		this.paintSidebar();
		if (!this.loading && this.isVisible()) {
			this.poll.schedule();
		}
	}

	/** The repository, as Customize's scope dropdown; a label when there is none to pick. */
	private paintPicker(): void {
		this.pickerStore.clear();
		clearNode(this.repoHost);
		const choices = [...this.choices];
		if (this.folder && this.repo && !choices.some(choice => choice.folder === this.folder)) {
			choices.unshift({ folder: this.folder, repo: this.repo });
		}
		if (!choices.length) {
			const chip = append(this.repoHost, $('span.volt-customize-chip.scope'));
			chip.appendChild(renderIcon(Codicon.repo));
			append(chip, $('span')).textContent = this.folder ? basename(URI.file(this.folder)) : localize('voltPrPage.noRepo', "No Repository");
			return;
		}
		const current = choices.find(choice => choice.folder === this.folder) ?? choices.find(choice => this.repo && choice.repo.owner === this.repo.owner && choice.repo.name === this.repo.name);
		createVoltDropdown<string>(this.repoHost, this.contextViewService, {
			options: choices.map(choice => ({ id: choice.folder, label: `${choice.repo.owner}/${choice.repo.name}`, description: choice.folder, icon: Codicon.repo })),
			value: current?.folder ?? choices[0].folder,
			ariaLabel: localize('voltPrPage.repo', "Repository"),
			align: 'left',
			width: 320,
			leadingIcon: Codicon.repo,
			onChange: folder => {
				if (this.input instanceof AgentPullRequestsPageInput) {
					this.input.folder = folder;
				}
				this.closeDetail();
				this.useFolder(folder);
			},
		}, this.pickerStore);
	}

	private paintChips(): void {
		const scrollLeft = this.chipsEl.scrollLeft;
		this.chipsStore.clear();
		clearNode(this.chipsEl);
		for (const view of VIEW_ORDER) {
			const chip = append(this.chipsEl, $('button.volt-customize-chip')) as HTMLButtonElement;
			chip.type = 'button';
			chip.textContent = VIEW_LABELS[view];
			chip.classList.toggle('active', view === this.view);
			chip.setAttribute('aria-pressed', String(view === this.view));
			this.chipsStore.add(addDisposableListener(chip, EventType.CLICK, () => this.setView(view)));
		}
		this.chipsEl.scrollLeft = scrollLeft;
		this.primaryButton.disabled = !this.repo;
		this.filterButton.classList.toggle('active', prFilterCount(this.filter) > 0);
	}

	private showMessage(title: string, hint?: string): HTMLElement {
		this.setRows([]);
		this.cardEl.classList.add('hidden');
		this.messageEl.hidden = false;
		const box = append(this.messageEl, $('.volt-customize-empty-box.bordered'));
		append(box, $('.title')).textContent = title;
		if (hint) {
			append(box, $('.hint')).textContent = hint;
		}
		return box;
	}

	private setRows(rows: IRow[]): void {
		this.listHeight = rows.reduce((sum, row) => sum + (row.kind === 'header' ? HEADER_HEIGHT : ROW_HEIGHT), 0);
		this.listHost.style.height = `${this.listHeight}px`;
		this.list.layout(this.listHeight);
		this.list.splice(0, this.list.length, rows);
		this.scroll.scanDomNode();
	}

	private paintList(): void {
		this.messageStore.clear();
		clearNode(this.messageEl);
		this.sectionTitle.textContent = VIEW_LABELS[this.view];
		this.sectionCount.textContent = '';
		const updated = this.openHandle?.state.updatedAt;
		this.syncedEl.textContent = this.loading
			? localize('voltPrPage.syncing', "Syncing...")
			: updated ? localize('voltPrPage.synced', "Updated {0}", ago(updated)) : '';
		clearNode(this.refreshButton);
		this.refreshButton.appendChild(renderIcon(this.loading ? ThemeIcon.modify(Codicon.loading, 'spin') : Codicon.refresh));
		this.refreshButton.disabled = this.loading;

		const repoState = this.repoHandle?.state;
		if (!this.folder) {
			const box = this.showMessage(localize('voltPrPage.noFolder', "No project"), localize('voltPrPage.noFolderHint', "Add a project with a GitHub remote to see its pull requests here."));
			const add = this.messageStore.add(createVoltButton(append(box, $('.volt-prs-actions')), 'primary'));
			add.label = localize('voltPrPage.addProject', "Add Project");
			this.messageStore.add(add.onDidClick(() => void this.commands.executeCommand(VoltProjectCommands.addProject, { anchor: add.element })));
			return;
		}
		if (repoState?.updatedAt !== undefined && !this.repo && !repoState.error) {
			this.showMessage(localize('voltPrPage.noRemote', "No GitHub remote"), localize('voltPrPage.noRemoteHint', "This project has no GitHub remote."));
			return;
		}
		if (this.repo && this.repo.provider !== 'github') {
			this.showMessage(localize('voltPrPage.unsupported', "Code host not supported"), localize('voltPrPage.unsupportedHint', "Volt reads pull requests from GitHub."));
			return;
		}
		const error = this.openHandle?.state.error ?? repoState?.error;
		const all = this.all();
		if (error && !all) {
			this.paintProblem(error);
			return;
		}
		if (!all) {
			this.setRows([]);
			this.cardEl.classList.add('hidden');
			this.messageEl.hidden = false;
			append(this.messageEl, $('.volt-customize-message')).textContent = localize('voltPrPage.loading', "Loading pull requests...");
			return;
		}

		const shown = this.shown(all);
		const rows: IRow[] = [];
		const prRow = (pr: IVoltPullRequest, hit: IPrSearchHit | undefined): IPrRow => ({ kind: 'pr', pr, chats: this.pullRequests.sessionsFor(pr.key), hit });
		let count = 0;
		if (this.search.empty) {
			for (const group of groupPullRequests(shown, this.filter)) {
				if (this.filter.grouping !== 'none') {
					rows.push({ kind: 'header', id: group.id, label: group.label, count: group.items.length });
				}
				for (const pr of group.items) {
					rows.push(prRow(pr, undefined));
					count++;
				}
			}
		} else {
			for (const { item, hit } of rankBySearch(shown, this.search, pr => pr)) {
				rows.push(prRow(item, hit));
				count++;
			}
		}
		this.sectionCount.textContent = String(count);
		if (!count) {
			this.showMessage(this.search.empty
				? localize('voltPrPage.emptyFilter', "No pull requests")
				: localize('voltPrPage.noMatch', "No pull request matches \"{0}\"", this.searchInput.value.trim()),
				prFilterCount(this.filter) ? localize('voltPrPage.filtersOn', "Filters are on; reset them from the filter menu.") : undefined);
			return;
		}
		this.messageEl.hidden = true;
		this.cardEl.classList.remove('hidden');
		this.setRows(rows);
	}

	private paintProblem(err: unknown): void {
		const problem = problemText(voltPrErrorCode(err), voltPrErrorMessage(err));
		const box = this.showMessage(problem.title, problem.detail);
		const actions = append(box, $('.volt-prs-actions'));
		if (problem.action === 'signIn' || problem.action === 'install') {
			const button = this.messageStore.add(createVoltButton(actions, 'primary'));
			button.label = problem.action === 'signIn' ? localize('voltPrPage.signIn', "Sign In with GitHub CLI") : localize('voltPrPage.install', "Get the GitHub CLI");
			this.messageStore.add(button.onDidClick(() => problem.action === 'signIn'
				? void this.instantiationService.invokeFunction(accessor => signInWithGh(accessor, this.repo?.host ?? 'github.com'))
				: void this.opener.open('https://cli.github.com/')));
		}
		const retry = this.messageStore.add(createVoltButton(actions, 'secondary'));
		retry.label = localize('voltPrPage.retry', "Retry");
		this.messageStore.add(retry.onDidClick(async () => {
			await this.pullRequests.api.refreshAccounts();
			await this.load(true);
		}));
	}

	//#endregion

	override layout(dimension: Dimension): void {
		this.rootEl.style.height = `${dimension.height}px`;
		this.rootEl.style.width = `${dimension.width}px`;
		this.list.layout(this.listHeight, this.listHost.clientWidth || undefined);
		this.scroll.scanDomNode();
		if (this.openKey) {
			this.syncSidebarWidth();
		}
	}

	override focus(): void {
		super.focus();
		if (this.openKey) {
			this.detailView.focus();
		} else {
			this.searchInput?.focus();
		}
	}
}
