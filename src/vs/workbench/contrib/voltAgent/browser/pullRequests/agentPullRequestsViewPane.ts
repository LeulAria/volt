/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, clearNode, EventHelper, getWindow } from '../../../../../base/browser/dom.js';
import { renderIcon } from '../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { RunOnceScheduler } from '../../../../../base/common/async.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { Event } from '../../../../../base/common/event.js';
import { IMatch } from '../../../../../base/common/filters.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { isMacintosh } from '../../../../../base/common/platform.js';
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
import { compilePrSearch, IPrSearch, IPrSearchHit, rankBySearch } from '../../common/agentPullRequestSearch.js';
import { AgentPrInvolvement, AgentPrSort, blockedReason, groupAndRank, IAgentPrLink, isOpenState, resolveMergeMethod, visibleLinks } from '../../common/agentPullRequests.js';
import { AGENT_HEADER_SEARCH_PATH } from '../chrome/agentTitlebarHeader.js';
import { setAgentTooltip } from '../chrome/agentTooltip.js';
import { AgentEditorInput } from '../editor/agentEditorInput.js';
import { showVoltMenu } from '../ui/menu/voltMenu.js';
import { agentToolsSessionOnScreen } from '../workspace/agentSurfaceHost.js';
import { IAgentPullRequestService } from './agentPullRequestService.js';
import { onDidChangePullRequestsViewSession, pullRequestsViewSession } from './agentPullRequestsViewState.js';
import { ago, avatar, checkIcon, checksLabel, iconSpan, openPullRequest, problemText, prStateIcon, signInWithGh } from './agentPullRequestUi.js';

const SORT_KEY = 'volt.pullRequests.sort';
const STATE_KEY = 'volt.pullRequests.state';
const REGEX_KEY = 'volt.pullRequests.searchRegex';
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

const SORT_ORDER: readonly AgentPrSort[] = ['ready', 'blocked', 'updated', 'newest', 'oldest', 'largest', 'smallest'];

const SORT_LABELS: Record<AgentPrSort, string> = {
	ready: localize('voltPr.sort.ready', "Merge readiness"),
	blocked: localize('voltPr.sort.blocked', "Blocked on me"),
	updated: localize('voltPr.sort.updated', "Recently updated"),
	newest: localize('voltPr.sort.newest', "Newest first"),
	oldest: localize('voltPr.sort.oldest', "Oldest first"),
	largest: localize('voltPr.sort.largest', "Largest first"),
	smallest: localize('voltPr.sort.smallest', "Smallest first"),
};

/** Line icons (Lucide's shapes, 24-unit box) for the sort button and its menu. */
const SORT_BUTTON_ICON = ['m3 16 4 4 4-4', 'M7 20V4', 'm21 8-4-4-4 4', 'M17 4v16'];
const SORT_ICONS: Record<AgentPrSort, readonly string[]> = {
	ready: ['M13 5h8', 'M13 12h8', 'M13 19h8', 'm3 17 2 2 4-4', 'm3 7 2 2 4-4'],
	blocked: ['M14 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0', 'M10.3 15H7a4 4 0 0 0-4 4v2', 'M15 15.5V14a2 2 0 0 1 4 0v1.5', 'M13.9 16h6.2a.9.9 0 0 1 .9.9v3.2a.9.9 0 0 1-.9.9h-6.2a.9.9 0 0 1-.9-.9v-3.2a.9.9 0 0 1 .9-.9z'],
	updated: ['M12 6v6l4 2', 'M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0'],
	newest: ['m14 18 4 4 4-4', 'M16 2v4', 'M18 14v8', 'M21 11.354V6a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h7.343', 'M3 10h18', 'M8 2v4'],
	oldest: ['m14 18 4-4 4 4', 'M16 2v4', 'M18 22v-8', 'M21 11.343V6a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h9', 'M3 10h18', 'M8 2v4'],
	largest: ['M15 3h6v6', 'm21 3-7 7', 'm3 21 7-7', 'M9 21H3v-6'],
	smallest: ['m14 10 7-7', 'M20 10h-6V4', 'm3 21 7-7', 'M4 14h6v6'],
};

const SEARCH_HELP = localize('voltPr.list.searchHelp', "Fuzzy search over numbers, titles, branches, authors, labels and status.\nauthor: (or @), label:, branch:, base:, title: and is: keep a word to one field; \"quotes\" match as typed; -word leaves matches out.\n/pattern/ or the .* toggle searches with a regular expression.\n{0} focuses the search, Enter opens the top match.", isMacintosh ? '⌘F' : 'Ctrl+F');

type StateFilter = 'open' | 'closed' | 'all';

type ListGroup = 'thisChat' | AgentPrInvolvement;

const GROUP_LABELS: Record<ListGroup, string> = {
	thisChat: localize('voltPr.list.thisChat', "This chat"),
	authored: localize('voltPr.list.authored', "Authored by you"),
	reviewRequested: localize('voltPr.list.reviewRequested', "Review requested"),
	others: localize('voltPr.list.others', "Others"),
};

/** A row built for the current data: a search only reorders, hides and highlights it. */
interface IListEntry {
	readonly pr: IVoltPullRequest;
	readonly group: ListGroup;
	readonly row: HTMLElement;
	readonly number: HTMLElement;
	readonly title: HTMLElement;
	readonly author: HTMLElement;
	readonly branch: HTMLElement;
	/** Holds highlights to clear. */
	lit: boolean;
}

/** A stroked line icon at `size` px from 24-unit path data, drawn like the sidebar's header icons. */
function lineIcon(doc: Document, paths: readonly string[], size: number): SVGElement {
	const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
	svg.setAttribute('viewBox', '0 0 24 24');
	svg.setAttribute('width', String(size));
	svg.setAttribute('height', String(size));
	svg.setAttribute('fill', 'none');
	svg.setAttribute('stroke', 'currentColor');
	svg.setAttribute('stroke-width', '1.5');
	svg.setAttribute('stroke-linecap', 'round');
	svg.setAttribute('stroke-linejoin', 'round');
	svg.setAttribute('aria-hidden', 'true');
	for (const d of paths) {
		const path = doc.createElementNS('http://www.w3.org/2000/svg', 'path');
		path.setAttribute('d', d);
		svg.appendChild(path);
	}
	return svg;
}

/** `text` with its matched ranges wrapped for highlighting; plain text when there are none. */
function paintMatches(element: HTMLElement, text: string, matches: readonly IMatch[] | undefined): void {
	if (!matches?.length) {
		element.textContent = text;
		return;
	}
	element.textContent = '';
	let at = 0;
	for (const match of matches) {
		if (match.start > at) {
			element.append(text.slice(at, match.start));
		}
		append(element, $('span.volt-pr-hit')).textContent = text.slice(match.start, match.end);
		at = match.end;
	}
	if (at < text.length) {
		element.append(text.slice(at));
	}
}

/**
 * Pull requests of the chat's repository: the chat's own first (with their watch), then yours,
 * the ones waiting on your review, and the rest, sorted by what is blocked on you. Hold Shift for
 * quick Merge / Close / Ready / Reopen on each row. The search above them ranks every pull request
 * by how well it matches (agentPullRequestSearch.ts) as you type.
 */
export class AgentPullRequestsViewPane extends ViewPane {

	private content!: HTMLElement;
	/** Rows, section headers and messages; the toolbar above stays put, so typing survives a repaint. */
	private listBody!: HTMLElement;
	private searchBox!: HTMLElement;
	private searchInput!: HTMLInputElement;
	private regexToggle!: HTMLButtonElement;
	private stateText!: HTMLElement;
	private sortButton!: HTMLButtonElement;
	private createButton!: HTMLButtonElement;
	private search: IPrSearch = compilePrSearch('');
	private searchRegex: boolean;
	private entries: IListEntry[] = [];
	/** The body lists rows (not a message), so a search lays them out again. */
	private listing = false;
	/** After the rows: the problem card or the loading skeleton. */
	private trailer: HTMLElement | undefined;
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
		this.searchRegex = this.storageService.getBoolean(REGEX_KEY, StorageScope.PROFILE, false);
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
		this.createToolbar();
		this.listBody = append(this.content, $('.volt-pr-list-body'));
		this._register(addDisposableListener(this.content, 'keydown', e => {
			if ((isMacintosh ? e.metaKey : e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'f') {
				EventHelper.stop(e, true);
				this.searchInput.focus();
				this.searchInput.select();
			}
		}));
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
		clearNode(this.listBody);
		this.entries = [];
		this.listing = false;
		this.trailer = undefined;
		this.updateToolbar();
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
		for (const link of [...linked].sort((a, b) => Number(isOpenState(b.snapshot?.state)) - Number(isOpenState(a.snapshot?.state)) || b.linkedAt - a.linkedAt)) {
			const listed = this.prs?.find(candidate => candidate.key === link.key);
			const pr = link.snapshot && (!listed || link.snapshot.updatedAt >= listed.updatedAt) ? link.snapshot : listed ?? link.snapshot;
			if (pr) {
				this.entries.push(this.row(pr, link, 'thisChat'));
			}
		}
		if (this.error) {
			this.trailer = this.problem(this.error);
		} else if (!this.prs) {
			this.trailer = $('.volt-pr-skeleton.compact');
			for (const width of [80, 60, 75, 50]) {
				append(this.trailer, $('.volt-pr-skeleton-line')).style.width = `${width}%`;
			}
		} else {
			const linkedKeys = new Set(linked.map(link => link.key));
			const rest = this.prs.filter(pr => !linkedKeys.has(pr.key));
			if (!rest.length && !linked.length) {
				this.empty(this.stateFilter === 'open' ? localize('voltPr.list.noneOpen', "No open pull requests.") : localize('voltPr.list.none', "No pull requests."));
				return;
			}
			for (const group of groupAndRank(rest, this.sort)) {
				for (const pr of group.items) {
					this.entries.push(this.row(pr, undefined, group.id));
				}
			}
		}
		this.listing = true;
		this.layoutRows();
	}

	/**
	 * Puts the built rows in the body: by section with no search; otherwise only the matches, best
	 * first, with the matched letters lit. Rows are moved, never rebuilt, so this keeps up with typing.
	 */
	private layoutRows(): void {
		if (!this.listing) {
			return;
		}
		clearNode(this.listBody);
		if (this.search.empty) {
			const counts = new Map<ListGroup, number>();
			for (const entry of this.entries) {
				counts.set(entry.group, (counts.get(entry.group) ?? 0) + 1);
			}
			let group: ListGroup | undefined;
			for (const entry of this.entries) {
				if (entry.group !== group) {
					group = entry.group;
					this.section(GROUP_LABELS[group], counts.get(group) ?? 0);
				}
				this.light(entry, undefined);
				this.listBody.appendChild(entry.row);
			}
		} else {
			const hits = rankBySearch(this.entries, this.search, entry => entry.pr);
			if (hits.length) {
				this.section(localize('voltPr.list.matches', "Matches"), hits.length);
				for (const { item, hit } of hits) {
					this.light(item, hit);
					this.listBody.appendChild(item.row);
				}
			} else if (!this.trailer) {
				const query = this.searchInput.value.trim();
				this.empty(this.stateFilter === 'open'
					? localize('voltPr.list.noOpenMatch', "No open pull requests match \"{0}\".", query)
					: localize('voltPr.list.noMatch', "No pull requests match \"{0}\".", query));
			}
		}
		if (this.trailer) {
			this.listBody.appendChild(this.trailer);
		}
	}

	private light(entry: IListEntry, hit: IPrSearchHit | undefined): void {
		const lit = !!hit && (hit.number.length + hit.title.length + hit.author.length + hit.branch.length) > 0;
		if (!lit && !entry.lit) {
			return;
		}
		entry.lit = lit;
		paintMatches(entry.number, `#${entry.pr.number}`, hit?.number);
		paintMatches(entry.title, entry.pr.title, hit?.title);
		paintMatches(entry.author, entry.pr.author.login, hit?.author);
		paintMatches(entry.branch, entry.pr.headRefName, hit?.branch);
	}

	/** Reads the search box; a regular expression that does not compile yet keeps the last list. */
	private applySearch(): void {
		const query = this.searchInput.value;
		const search = compilePrSearch(query, this.searchRegex);
		this.searchBox.classList.toggle('has-value', !!query);
		this.searchBox.classList.toggle('invalid', !!search.error);
		setAgentTooltip(this.searchInput, search.error ? localize('voltPr.list.badRegex', "Not a valid regular expression: {0}", search.error) : undefined);
		if (search.error) {
			return;
		}
		this.search = search;
		this.layoutRows();
	}

	/** The rows on screen, in order, for the arrow keys and Enter. */
	private shownRows(): HTMLElement[] {
		return [...this.listBody.querySelectorAll<HTMLElement>('.volt-pr-list-row')];
	}

	/**
	 * Built once: the search (the sidebar's magnifier, a bare field, a regex toggle and a clear
	 * button), the state filter, Sort, Refresh and New Pull Request. Their labels follow the data in
	 * {@link updateToolbar}.
	 */
	private createToolbar(): void {
		const bar = append(this.content, $('.volt-pr-list-toolbar'));
		const doc = bar.ownerDocument;
		this.searchBox = append(bar, $('.volt-pr-search'));
		const glass = append(this.searchBox, $('span.volt-pr-search-icon'));
		glass.appendChild(lineIcon(doc, [AGENT_HEADER_SEARCH_PATH], 14));
		setAgentTooltip(glass, SEARCH_HELP);
		const input = this.searchInput = append(this.searchBox, $('input.volt-pr-search-input')) as HTMLInputElement;
		input.type = 'text';
		input.spellcheck = false;
		input.autocomplete = 'off';
		input.setAttribute('aria-label', localize('voltPr.list.searchAria', "Search pull requests"));
		this._register(addDisposableListener(input, 'input', () => this.applySearch()));
		this._register(addDisposableListener(input, 'keydown', e => {
			if (e.key === 'Escape' && input.value) {
				EventHelper.stop(e, true);
				input.value = '';
				this.applySearch();
			} else if (e.key === 'Enter') {
				EventHelper.stop(e, true);
				this.shownRows()[0]?.click();
			} else if (e.key === 'ArrowDown') {
				EventHelper.stop(e, true);
				this.shownRows()[0]?.focus();
			}
		}));
		const clear = append(this.searchBox, $('button.volt-pr-search-button.volt-pr-search-clear')) as HTMLButtonElement;
		clear.type = 'button';
		clear.appendChild(renderIcon(Codicon.close));
		clear.setAttribute('aria-label', localize('voltPr.list.clearSearch', "Clear Search"));
		setAgentTooltip(clear, localize('voltPr.list.clearSearch', "Clear Search"), 'Escape');
		this._register(addDisposableListener(clear, 'click', e => {
			EventHelper.stop(e, true);
			input.value = '';
			this.applySearch();
			input.focus();
		}));
		const regex = this.regexToggle = append(this.searchBox, $('button.volt-pr-search-button.volt-pr-search-regex')) as HTMLButtonElement;
		regex.type = 'button';
		regex.appendChild(renderIcon(Codicon.regex));
		regex.setAttribute('aria-label', localize('voltPr.list.regex', "Use Regular Expression"));
		setAgentTooltip(regex, localize('voltPr.list.regex', "Use Regular Expression"));
		this._register(addDisposableListener(regex, 'click', e => {
			EventHelper.stop(e, true);
			this.searchRegex = !this.searchRegex;
			this.storageService.store(REGEX_KEY, this.searchRegex, StorageScope.PROFILE, StorageTarget.USER);
			this.syncRegexToggle();
			this.applySearch();
			input.focus();
		}));
		this.syncRegexToggle();

		const stateButton = this.toolbarButton(bar, undefined, ' ', localize('voltPr.list.stateFilter', "Show"), button => {
			showVoltMenu<StateFilter>(this.contextViewService, {
				anchor: button, align: 'right', ariaLabel: localize('voltPr.list.stateFilter', "Show"), width: 180,
				sections: [{ id: 's', items: (['open', 'closed', 'all'] as const).map(state => ({ id: state, label: state === 'open' ? localize('voltPr.list.open', "Open") : state === 'closed' ? localize('voltPr.list.closedMerged', "Closed and merged") : localize('voltPr.list.all', "All"), checked: state === this.stateFilter, data: state })) }],
				onPick: item => {
					this.stateFilter = item.data;
					this.storageService.store(STATE_KEY, item.data, StorageScope.PROFILE, StorageTarget.USER);
					this.updateToolbar();
					this.sync();
				},
			});
		});
		stateButton.classList.add('text');
		this.stateText = stateButton.querySelector('span:not(.codicon)') as HTMLElement;
		this.sortButton = this.toolbarButton(bar, undefined, undefined, localize('voltPr.list.sort', "Sort"), button => {
			showVoltMenu<AgentPrSort>(this.contextViewService, {
				anchor: button, align: 'right', ariaLabel: localize('voltPr.list.sort', "Sort"), width: 210,
				sections: [{ id: 's', items: SORT_ORDER.map(sort => ({ id: sort, label: SORT_LABELS[sort], icon: () => lineIcon(doc, SORT_ICONS[sort], 16), checked: sort === this.sort, data: sort })) }],
				onPick: item => {
					this.sort = item.data;
					this.storageService.store(SORT_KEY, item.data, StorageScope.PROFILE, StorageTarget.USER);
					this.paint();
				},
			});
		});
		this.sortButton.appendChild(lineIcon(doc, SORT_BUTTON_ICON, 14));
		this.refreshButton = this.toolbarButton(bar, undefined, undefined, localize('voltPr.refresh', "Refresh"), () => {
			void this.pullRequests.refresh();
			void this.load(true);
		});
		this.createButton = this.toolbarButton(bar, Codicon.gitPullRequestCreate, undefined, localize('voltPr.list.new', "New Pull Request"), () => {
			if (this.folder) {
				void this.instantiationService.invokeFunction(accessor => openPullRequest(accessor, { kind: 'new', folder: this.folder! }, this.sessionId()));
			}
		});
		// Labelled now: the first read may finish with nothing new, which paints nothing.
		this.updateToolbar();
	}

	private updateToolbar(): void {
		this.searchInput.placeholder = this.repo
			? localize('voltPr.list.searchRepo', "Search {0}/{1}", this.repo.owner, this.repo.name)
			: this.repoResolved || !this.folder ? localize('voltPr.list.search', "Search pull requests") : localize('voltPr.list.loading', "Loading…");
		this.stateText.textContent = this.stateFilter === 'open' ? localize('voltPr.list.open', "Open") : this.stateFilter === 'closed' ? localize('voltPr.list.closed', "Closed") : localize('voltPr.list.all', "All");
		const sortLabel = localize('voltPr.list.sortBy', "Sort: {0}", SORT_LABELS[this.sort]);
		this.sortButton.setAttribute('aria-label', sortLabel);
		setAgentTooltip(this.sortButton, sortLabel);
		this.createButton.disabled = !this.folder || !this.repo;
		this.syncRefresh();
	}

	private syncRegexToggle(): void {
		this.regexToggle.classList.toggle('on', this.searchRegex);
		this.regexToggle.setAttribute('aria-pressed', String(this.searchRegex));
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
		// The toolbar is built once, so its buttons live as long as the view.
		this._register(addDisposableListener(button, 'click', e => {
			EventHelper.stop(e, true);
			run(button);
		}));
		return button;
	}

	private section(label: string, count: number): void {
		const header = append(this.listBody, $('.volt-pr-list-section'));
		append(header, $('span')).textContent = label;
		append(header, $('span.volt-pr-count')).textContent = String(count);
	}

	private empty(text: string): void {
		append(this.listBody, $('.volt-pr-list-empty')).textContent = text;
	}

	/** The card for a failed read, not yet placed: it goes after the rows. */
	private problem(err: unknown): HTMLElement {
		const problem = problemText(voltPrErrorCode(err), voltPrErrorMessage(err));
		const card = $('.volt-pr-problem.compact');
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
		return card;
	}

	/**
	 * T3 Code's two lines: state glyph (a conflict marks its corner), #number, title and checks, with
	 * the size on the right; then the author, branch, labels and what it waits on, with its age.
	 */
	private row(pr: IVoltPullRequest, link: IAgentPrLink | undefined, group: ListGroup): IListEntry {
		const row = $('.volt-pr-list-row');
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
		const number = append(line1, $('span.volt-pr-list-number'));
		number.textContent = `#${pr.number}`;
		const title = append(line1, $('span.volt-pr-list-title'));
		title.textContent = pr.title;
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
		const author = append(line2, $('span.volt-pr-list-author'));
		author.textContent = pr.author.login;
		const branch = append(line2, $('span.volt-pr-list-branch'));
		branch.textContent = pr.headRefName;
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
			} else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
				EventHelper.stop(e, true);
				const rows = this.shownRows();
				const next = rows[rows.indexOf(row) + (e.key === 'ArrowDown' ? 1 : -1)];
				// Up from the first row goes back to the search.
				(next ?? (e.key === 'ArrowUp' ? this.searchInput : undefined))?.focus();
			}
		}));
		setAgentTooltip(row, `#${pr.number} ${pr.title}\n${pr.baseRefName} ← ${pr.headRefName} · ${pr.author.login}\n+${pr.additions} \u2212${pr.deletions} · ${pr.changedFiles} files`);
		return { pr, group, row, number, title, author, branch, lit: false };
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

	/** The keyboard lands in the search, so Ctrl+Option+3 and typing finds a pull request. */
	override focus(): void {
		super.focus();
		this.searchInput?.focus();
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
