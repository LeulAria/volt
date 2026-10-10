/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append } from '../../../../../base/browser/dom.js';
import { RunOnceScheduler, Sequencer } from '../../../../../base/common/async.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable, DisposableStore, MutableDisposable } from '../../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../../base/common/network.js';
import { URI } from '../../../../../base/common/uri.js';
import { localize } from '../../../../../nls.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { IUriIdentityService } from '../../../../../platform/uriIdentity/common/uriIdentity.js';
import { IVoltStdioService } from '../../../../../platform/voltStdio/common/voltStdio.js';
import { IWorkspaceContextService, WorkbenchState } from '../../../../../platform/workspace/common/workspace.js';
import { IViewDescriptorService } from '../../../../common/views.js';
import { getLayoutMode } from '../../../../browser/parts/titlebar/layoutModeSwitch.js';
import { WorkbenchPhase, registerWorkbenchContribution2 } from '../../../../common/contributions.js';
import { IWorkbenchLayoutService, Parts } from '../../../../services/layout/browser/layoutService.js';
import { ILentPaneCompositePart, IPaneCompositePartService } from '../../../../services/panecomposite/browser/panecomposite.js';
import { VIEWLET_ID as SEARCH_VIEWLET_ID } from '../../../../services/search/common/search.js';
import { IAgentHistoryService } from '../../../../services/voltRuntime/common/history/agentHistory.js';
import { IAgentRuntimeService } from '../../../../services/voltRuntime/common/runtime.js';
import { IVoltSessionContextService, uriFromStoredRoot } from '../../../../services/voltRuntime/common/sessionContext.js';
import { IWorkspaceEditingService } from '../../../../services/workspaces/common/workspaceEditing.js';
import { VIEWLET_ID as EXPLORER_VIEWLET_ID } from '../../../files/common/files.js';
import { IExplorerService } from '../../../files/browser/files.js';
import { VIEWLET_ID as SCM_VIEWLET_ID } from '../../../scm/common/scm.js';
import { setAgentTooltip } from '../chrome/agentTooltip.js';
import { INIT_TIMEOUT_MS, runGit } from '../home/agentHomeWorkspaceActions.js';
import { trackLentPanesCollapsed } from '../review/agentChangesEditor.js';
import { AgentScmRepositoryFocus } from '../review/agentScmRepository.js';
import { setAgentChangesSession } from '../review/agentTurnsView.js';
import { EXPLORER_ICON_SHAPES, type SvgIconShapes } from './agentSurfaceMenu.js';
import { AGENT_PULL_REQUESTS_CONTAINER_ID, setPullRequestsViewSession } from '../pullRequests/agentPullRequestsViewState.js';
import { IAgentPullRequestService } from '../pullRequests/agentPullRequestService.js';

export type AgentFilesSidebarView = 'explorer' | 'scm' | 'search' | 'pullRequests';

const OPEN_KEY = 'volt.agent.filesSidebar.open';
const VIEW_KEY = 'volt.agent.filesSidebar.view';
/** Renamed when the default width went up, so a width saved under the old default does not stick. */
const WIDTH_KEY = 'volt.agent.filesSidebar.sidebarWidth';
const DEFAULT_WIDTH = 300;
const MIN_WIDTH = 200;
/** Room the tabs beside the sidebar always keep. */
const MIN_TABS_WIDTH = 320;

const VIEWS: readonly { readonly id: AgentFilesSidebarView; readonly container: string; readonly icon: SvgIconShapes; readonly label: string }[] = [
	{
		id: 'explorer', container: EXPLORER_VIEWLET_ID, label: localize('voltAgent.filesSidebar.explorer', "Explorer"), icon: EXPLORER_ICON_SHAPES
	},
	{
		id: 'scm', container: SCM_VIEWLET_ID, label: localize('voltAgent.filesSidebar.scm', "Source Control"), icon: [
			['line', { x1: 6, y1: 3, x2: 6, y2: 15 }],
			['circle', { cx: 18, cy: 6, r: 3 }],
			['circle', { cx: 6, cy: 18, r: 3 }],
			['path', { d: 'M18 9a9 9 0 0 1-9 9' }],
		]
	},
	{
		id: 'pullRequests', container: AGENT_PULL_REQUESTS_CONTAINER_ID, label: localize('voltAgent.filesSidebar.pullRequests', "Pull Requests"), icon: [
			['circle', { cx: 6, cy: 6, r: 2.5 }],
			['circle', { cx: 6, cy: 18, r: 2.5 }],
			['circle', { cx: 18, cy: 18, r: 2.5 }],
			['line', { x1: 6, y1: 8.5, x2: 6, y2: 15.5 }],
			['path', { d: 'M18 15.5V9a3 3 0 0 0-3-3h-4' }],
			['path', { d: 'M13 3.5L10.5 6 13 8.5' }],
		]
	},
	{
		id: 'search', container: SEARCH_VIEWLET_ID, label: localize('voltAgent.filesSidebar.search', "Search"), icon: [
			['path', { d: 'M17 17L21 21' }],
			['path', { d: 'M3 11C3 15.4183 6.58172 19 11 19C13.213 19 15.2161 18.1015 16.6644 16.6493C18.1077 15.2022 19 13.2053 19 11C19 6.58172 15.4183 3 11 3C6.58172 3 3 6.58172 3 11Z' }],
		]
	},
];

/** Open, view and width are the window's, not a chat's: every chat's tools show the same sidebar. */
interface ISidebarState {
	open: boolean;
	view: AgentFilesSidebarView;
	width: number;
}

let sharedState: ISidebarState | undefined;
const stateEmitter = new Emitter<void>();
/** Sidebars on screen now. While there is one, the agents list on the left is narrower. */
const shownSidebars = new Set<AgentFilesSidebar>();
const shownEmitter = new Emitter<void>();
const shownViewEmitter = new Emitter<void>();

function readState(storage: IStorageService): ISidebarState {
	if (!sharedState) {
		const view = storage.get(VIEW_KEY, StorageScope.PROFILE);
		sharedState = {
			open: storage.getBoolean(OPEN_KEY, StorageScope.PROFILE, false),
			view: VIEWS.some(candidate => candidate.id === view) ? view as AgentFilesSidebarView : 'scm',
			width: storage.getNumber(WIDTH_KEY, StorageScope.PROFILE, DEFAULT_WIDTH),
		};
	}
	return sharedState;
}

/**
 * The right edge of a chat's tools: the workbench's own Explorer, Source Control or Search side
 * bar, lent in (lendPaneComposite), with icons on top to switch between them. Files and diffs
 * opened from it open as tabs beside it, so the list stays on screen while you review.
 * Styles: agentChangesEditor.css.
 */
export class AgentFilesSidebar extends Disposable {

	readonly element: HTMLElement;
	/** Shows or hides the sidebar; it sits at the end of the tools' first tab row. */
	readonly toggleButton: HTMLButtonElement;
	private readonly header: HTMLElement;
	private readonly body: HTMLElement;
	private readonly repositoryStatus: HTMLElement;
	private readonly repositoryMessage: HTMLElement;
	private readonly initRepositoryButton: HTMLButtonElement;
	private readonly explorerScope = this._register(new MutableDisposable());
	private explorerFolder: URI | undefined;
	private readonly sash: HTMLElement;
	private readonly buttons = new Map<AgentFilesSidebarView, HTMLButtonElement>();
	private readonly lent = this._register(new MutableDisposable<ILentPaneCompositePart>());
	private readonly lentPanesCollapsed = this._register(new MutableDisposable());
	private lentView: AgentFilesSidebarView | undefined;
	/** The chat whose repository Source Control shows. */
	private scmSession: string | undefined;
	private scmFolder: URI | undefined;
	private readonly scmRepository: AgentScmRepositoryFocus;
	private readonly pullRequests: IAgentPullRequestService | undefined;
	private shown = false;
	/** No tab beside it: it is the whole tools area. */
	private fills = false;
	private sessionId: string | undefined;
	/** The chat whose folder the window was last moved to; cleared when the sidebar stops showing. */
	private folderSession: string | undefined;
	/** Folder moves run one after another: each stops and restarts the extension host. */
	private readonly folderSequencer = new Sequencer();
	private size: { width: number; height: number } | undefined;

	/** The sidebar opened, closed, switched view, or was resized: the tools lay out again. */
	static readonly onDidChange: Event<void> = stateEmitter.event;
	/** A sidebar on screen started or stopped showing a view, such as Source Control. */
	static readonly onDidChangeShownView: Event<void> = shownViewEmitter.event;
	/** The view this sidebar last announced as showing, and for which chat. */
	private announcedView: string | undefined;

	constructor(
		parent: HTMLElement,
		@IStorageService private readonly storageService: IStorageService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IViewDescriptorService private readonly viewDescriptorService: IViewDescriptorService,
		@IPaneCompositePartService private readonly paneCompositeService: IPaneCompositePartService,
		@IWorkbenchLayoutService private readonly layoutService: IWorkbenchLayoutService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@IWorkspaceEditingService private readonly workspaceEditingService: IWorkspaceEditingService,
		@IUriIdentityService private readonly uriIdentityService: IUriIdentityService,
		@IAgentHistoryService private readonly history: IAgentHistoryService,
		@IAgentRuntimeService private readonly runtime: IAgentRuntimeService,
		@IVoltSessionContextService private readonly sessionContext: IVoltSessionContextService,
		@ILogService private readonly logService: ILogService,
		@IExplorerService private readonly explorerService: IExplorerService,
		@IVoltStdioService private readonly stdio: IVoltStdioService,
		@INotificationService private readonly notificationService: INotificationService,
	) {
		super();
		this.scmRepository = this._register(instantiationService.createInstance(AgentScmRepositoryFocus));
		this.pullRequests = instantiationService.invokeFunction(accessor => accessor.getIfExists(IAgentPullRequestService));
		if (this.pullRequests) {
			this._register(this.pullRequests.onDidChangeOrigin(folder => {
				if (this.sessionId && folder === this.folderOf(this.sessionId)?.fsPath) {
					this.sync();
				}
			}));
		}
		this.element = append(parent, $('.volt-agent-files-sidebar.hidden'));
		this.sash = append(this.element, $('.volt-agent-files-sidebar-sash'));
		this.sash.title = localize('voltAgent.filesSidebar.resize', "Resize sidebar");
		this.header = append(this.element, $('.volt-agent-files-sidebar-header'));
		for (const view of VIEWS) {
			const button = append(this.header, $('button.volt-agent-files-sidebar-tab')) as HTMLButtonElement;
			button.type = 'button';
			button.setAttribute('aria-label', view.label);
			setAgentTooltip(button, view.label);
			button.appendChild(createTabIcon(button.ownerDocument, view.icon));
			this._register(addDisposableListener(button, 'click', () => AgentFilesSidebar.show(this.storageService, view.id)));
			this.buttons.set(view.id, button);
		}
		const hide = append(this.header, $('button.volt-agent-files-sidebar-tab.hide')) as HTMLButtonElement;
		hide.type = 'button';
		const hideLabel = localize('voltAgent.filesSidebar.hide', "Hide Files Sidebar");
		hide.setAttribute('aria-label', hideLabel);
		setAgentTooltip(hide, hideLabel);
		hide.appendChild(createSidebarRightIcon(hide.ownerDocument));
		this._register(addDisposableListener(hide, 'click', () => AgentFilesSidebar.setOpen(this.storageService, false)));
		this.body = append(this.element, $('.volt-agent-files-sidebar-body.volt-agent-changes-scm'));
		const unavailable = append(this.body, $('.volt-agent-changes-scm-unavailable'));
		unavailable.textContent = localize('voltAgent.filesSidebar.unavailable', "This view is open in another part of the window.");
		this.repositoryStatus = append(this.body, $('.volt-agent-files-repository-status'));
		this.repositoryStatus.setAttribute('role', 'status');
		this.repositoryMessage = append(this.repositoryStatus, $('.volt-agent-files-repository-message'));
		// Source Control's empty state: make the chat's folder a repository right here.
		this.initRepositoryButton = append(this.repositoryStatus, $('button.volt-agent-files-repository-init.hidden')) as HTMLButtonElement;
		this.initRepositoryButton.type = 'button';
		this.initRepositoryButton.appendChild(createTabIcon(this.initRepositoryButton.ownerDocument, VIEWS.find(view => view.id === 'scm')!.icon));
		append(this.initRepositoryButton, $('span')).textContent = localize('voltAgent.filesSidebar.initRepository', "Initialize Repository");
		this._register(addDisposableListener(this.initRepositoryButton, 'click', () => void this.initRepository()));

		this.toggleButton = $('button.volt-agent-tools-files-toggle') as HTMLButtonElement;
		this.toggleButton.type = 'button';
		// The Explorer tab's folder, so it reads apart from the right-panel toggle beside it.
		this.toggleButton.appendChild(createTabIcon(this.toggleButton.ownerDocument, EXPLORER_ICON_SHAPES));
		this._register(addDisposableListener(this.toggleButton, 'click', () => AgentFilesSidebar.setOpen(this.storageService, !readState(this.storageService).open)));

		this._register(addDisposableListener(this.sash, 'pointerdown', e => this.beginResize(e)));
		this._register(AgentFilesSidebar.onDidChange(() => this.sync()));
		// The workbench gave a part back (back to agent layout): take it again.
		this._register(layoutService.onDidChangePartVisibility(() => this.sync()));
		this.syncChrome();
	}

	static isOpen(storage: IStorageService): boolean {
		return readState(storage).open;
	}

	static view(storage: IStorageService): AgentFilesSidebarView {
		return readState(storage).view;
	}

	static setOpen(storage: IStorageService, open: boolean): void {
		const state = readState(storage);
		if (state.open === open) {
			return;
		}
		state.open = open;
		storage.store(OPEN_KEY, open, StorageScope.PROFILE, StorageTarget.USER);
		stateEmitter.fire();
	}

	/** Opens the sidebar on `view`. */
	static show(storage: IStorageService, view: AgentFilesSidebarView): void {
		const state = readState(storage);
		if (state.view !== view) {
			state.view = view;
			storage.store(VIEW_KEY, view, StorageScope.PROFILE, StorageTarget.USER);
			if (state.open) {
				stateEmitter.fire();
				return;
			}
		}
		AgentFilesSidebar.setOpen(storage, true);
	}

	/** The width the sidebar asks for. The tools may give it less (see {@link widthFor}). */
	static preferredWidth(storage: IStorageService): number {
		return Math.max(MIN_WIDTH, Math.round(readState(storage).width));
	}

	/** Sets the width, from the split line while the sidebar is the whole tools area. `persist` once the drag ends. */
	static setWidth(storage: IStorageService, width: number, persist: boolean): void {
		const state = readState(storage);
		state.width = Math.max(MIN_WIDTH, Math.round(width));
		if (persist) {
			storage.store(WIDTH_KEY, state.width, StorageScope.PROFILE, StorageTarget.USER);
		}
		stateEmitter.fire();
	}

	/** The sidebar's width beside `available` pixels of tools, or 0 while it is closed. */
	widthFor(available: number): number {
		const state = readState(this.storageService);
		if (!state.open) {
			return 0;
		}
		const max = Math.max(MIN_WIDTH, available - MIN_TABS_WIDTH);
		return Math.round(Math.min(max, Math.max(MIN_WIDTH, state.width)));
	}

	/**
	 * Lays the sidebar out at the right edge of the tools, with its icons in a row `headerHeight` tall.
	 * `fills`: no tab is open beside it, so it takes the whole tools area and the split line resizes it.
	 */
	layout(sessionId: string | undefined, width: number, height: number, headerHeight: number, fills: boolean): void {
		const visible = width > 0 && height > 0 && !!sessionId;
		this.sessionId = sessionId;
		this.element.classList.toggle('fills', fills);
		if (this.fills !== fills) {
			this.fills = fills;
			if (this.shown) {
				shownEmitter.fire();
			}
		}
		this.element.style.width = `${width}px`;
		this.element.style.setProperty('--volt-files-sidebar-header', `${headerHeight}px`);
		// Less its 1px left border.
		this.size = visible ? { width: Math.max(0, width - 1), height: Math.max(0, height - headerHeight) } : undefined;
		this.setShown(visible);
		this.layoutLent();
	}

	hide(): void {
		this.size = undefined;
		this.setShown(false);
	}

	/** Shows Source Control for this chat now. */
	showsScmFor(sessionId: string): boolean {
		return this.shown && this.sessionId === sessionId && this.lentView === 'scm';
	}

	private setShown(shown: boolean): void {
		if (this.shown !== shown) {
			this.shown = shown;
			this.element.classList.toggle('hidden', !shown);
			if (shown) {
				shownSidebars.add(this);
			} else {
				shownSidebars.delete(this);
			}
			shownEmitter.fire();
		}
		this.sync();
	}

	/** Borrows the chosen view's part while the sidebar shows, and gives it back when it does not. */
	private sync(): void {
		this.syncChrome();
		const state = readState(this.storageService);
		const want = this.shown && state.open ? this.viewFor(state) : undefined;
		if (this.lentView !== want || (want && !this.lent.value)) {
			this.giveBack();
			if (want) {
				this.borrow(want);
			}
		}
		// Source Control opens the repository directly. Explorer borrows a cached folder tree.
		// Neither needs to move the whole workspace and restart its extension host.
		const explorerFolder = want === 'explorer' && this.sessionId && getLayoutMode(this.layoutService) === 'agent'
			? this.folderOf(this.sessionId) : undefined;
		if (!this.uriIdentityService.extUri.isEqual(explorerFolder, this.explorerFolder)) {
			this.explorerFolder = explorerFolder;
			this.explorerScope.value = explorerFolder ? this.explorerService.scopeToFolder(explorerFolder) : undefined;
		}
		if (want === 'pullRequests' && this.lent.value) {
			setPullRequestsViewSession(this.sessionId);
		}
		const folderSession = want === 'search' ? this.sessionId : undefined;
		if (folderSession !== this.folderSession) {
			this.folderSession = folderSession;
			if (folderSession) {
				this.followChatFolder(folderSession);
			}
		}
		const scmSession = want === 'scm' && this.lent.value ? this.sessionId : undefined;
		const scmFolder = scmSession ? this.folderOf(scmSession) : undefined;
		if (scmSession && (this.scmSession !== scmSession || !this.uriIdentityService.extUri.isEqual(scmFolder, this.scmFolder))) {
			this.scmSession = scmSession;
			this.scmFolder = scmFolder;
			setAgentChangesSession(scmSession);
			void this.scmRepository.show(scmSession, () => this.showsScmFor(scmSession), scmFolder, state => {
				this.body.classList.toggle('repository-pending', state !== 'ready');
				this.repositoryMessage.textContent = state === 'loading'
					? localize('voltAgent.filesSidebar.loadingRepository', "Loading repository…")
					: state === 'unavailable' ? localize('voltAgent.filesSidebar.repositoryUnavailable', "No Git repository is available for this folder.") : '';
				this.initRepositoryButton.classList.toggle('hidden', state !== 'unavailable' || scmFolder?.scheme !== Schemas.file);
			});
		}
		this.layoutLent();
		this.announceShownView();
	}

	/** `git init` in the chat's folder, then Source Control opens the new repository. */
	private async initRepository(): Promise<void> {
		const session = this.scmSession;
		const folder = this.scmFolder;
		if (!session || folder?.scheme !== Schemas.file || this.initRepositoryButton.disabled) {
			return;
		}
		this.initRepositoryButton.disabled = true;
		try {
			const result = await runGit(this.stdio, folder.fsPath, ['init'], INIT_TIMEOUT_MS);
			if (result.exitCode !== 0) {
				this.notificationService.error(result.timedOut
					? localize('voltAgent.initTimedOut', "git init did not finish in time")
					: result.stderr.trim() || localize('voltAgent.initFailed', "git init failed"));
				return;
			}
		} finally {
			this.initRepositoryButton.disabled = false;
		}
		if (this.scmSession === session && this.uriIdentityService.extUri.isEqual(this.scmFolder, folder)) {
			// Forget the folder so sync asks Git to open it again.
			this.scmSession = undefined;
			this.sync();
		}
	}

	/**
	 * The view this sidebar shows: the window's pick, but Source Control while the chat's
	 * repository has no `origin` remote and so no pull requests (the pick stays for other chats).
	 */
	private viewFor(state: ISidebarState): AgentFilesSidebarView {
		return state.view === 'pullRequests' && !this.showsPullRequests() ? 'scm' : state.view;
	}

	private showsPullRequests(): boolean {
		const folder = this.sessionId ? this.folderOf(this.sessionId) : undefined;
		return folder?.scheme === 'file' && !!this.pullRequests?.hasOrigin(folder.fsPath);
	}

	private announceShownView(): void {
		const view = this.shown && this.lentView ? `${this.sessionId}/${this.lentView}` : undefined;
		if (view !== this.announcedView) {
			this.announcedView = view;
			shownViewEmitter.fire();
		}
	}

	/**
	 * Search shows the window's folder, so it becomes this chat's: its worktree, else its
	 * project. In place, as the IDE layout does (agentIdeWorkspace.ts): no reload, running agents
	 * carry on, the extension host restarts. Once per chat shown, so two sidebars cannot trade it back and forth.
	 */
	private followChatFolder(sessionId: string): void {
		if (getLayoutMode(this.layoutService) !== 'agent') {
			return;
		}
		const folder = this.folderOf(sessionId);
		if (!folder) {
			return;
		}
		void this.folderSequencer.queue(async () => {
			if (this.folderSession !== sessionId || this.isWindowFolder(folder)) {
				return;
			}
			try {
				await this.workspaceEditingService.enterFolder?.(folder);
			} catch (error) {
				this.logService.error('[voltAgent] could not open the chat\'s folder', error);
			}
		});
	}

	/** Where a chat runs: its worktree, else its project. Matches agentIdeWorkspace.ts. */
	private folderOf(sessionId: string): URI | undefined {
		const meta = this.history.get(sessionId);
		const worktree = meta?.worktreePath ?? this.runtime.getOrCreateSession(sessionId).worktreePath;
		if (worktree) {
			return URI.file(worktree);
		}
		return this.sessionContext.rootFor(sessionId) ?? (meta?.workspaceFolder ? uriFromStoredRoot(meta.workspaceFolder) : undefined);
	}

	/** Compared the way the disk does: a project's root can differ from the window's in case alone on macOS. */
	private isWindowFolder(folder: URI): boolean {
		const folders = this.workspaceContextService.getWorkspace().folders;
		return this.workspaceContextService.getWorkbenchState() === WorkbenchState.FOLDER
			&& folders.length === 1 && this.uriIdentityService.extUri.isEqual(folders[0].uri, folder);
	}

	private borrow(view: AgentFilesSidebarView): void {
		const id = VIEWS.find(candidate => candidate.id === view)!.container;
		const container = this.viewDescriptorService.getViewContainerById(id);
		const location = container ? this.viewDescriptorService.getViewContainerLocation(container) : null;
		const lent = location !== null ? this.paneCompositeService.lendPaneComposite(id, location, this.body) : undefined;
		this.body.classList.toggle('unavailable', !lent);
		this.lentView = view;
		if (!lent) {
			return;
		}
		this.lent.value = lent;
		this.lentPanesCollapsed.value = trackLentPanesCollapsed(this.paneCompositeService, this.viewDescriptorService, id, this.body);
		Event.once(lent.onDidReturn)(() => {
			if (this.lent.value === lent) {
				this.lentPanesCollapsed.clear();
				// Taken back by the workbench (shown in the IDE layout): say where it is.
				this.lent.clear();
				this.body.classList.add('unavailable');
			}
		});
	}

	private giveBack(): void {
		this.explorerScope.clear();
		this.explorerFolder = undefined;
		this.body.classList.remove('repository-pending');
		if (this.scmSession) {
			this.scmSession = undefined;
			this.scmFolder = undefined;
			this.scmRepository.clear();
			setAgentChangesSession(undefined);
		}
		this.lentView = undefined;
		this.lentPanesCollapsed.clear();
		this.lent.clear();
		this.body.classList.remove('unavailable');
	}

	private layoutLent(): void {
		if (this.size) {
			this.lent.value?.layout(this.size.width, this.size.height);
		}
	}

	private syncChrome(): void {
		const state = readState(this.storageService);
		const shown = this.viewFor(state);
		this.buttons.get('pullRequests')!.style.display = this.showsPullRequests() ? '' : 'none';
		for (const [view, button] of this.buttons) {
			const active = view === shown;
			button.classList.toggle('active', active);
			button.setAttribute('aria-pressed', String(active));
		}
		const label = state.open
			? localize('voltAgent.filesSidebar.hide', "Hide Files Sidebar")
			: localize('voltAgent.filesSidebar.show', "Show Files Sidebar");
		this.toggleButton.setAttribute('aria-label', label);
		this.toggleButton.setAttribute('aria-pressed', String(state.open));
		this.toggleButton.classList.toggle('active', state.open);
		setAgentTooltip(this.toggleButton, label);
	}

	private beginResize(event: PointerEvent): void {
		if (event.button !== 0) {
			return;
		}
		event.preventDefault();
		this.sash.setPointerCapture(event.pointerId);
		this.sash.classList.add('active');
		this.element.classList.add('resizing');
		// On the tools area, so its tabs ignore the pointer (agentChangesEditor.css); no :has() needed.
		const area = this.element.parentElement;
		area?.classList.add('files-sidebar-resizing');
		const startX = event.clientX;
		const startWidth = this.element.getBoundingClientRect().width;
		const store = new DisposableStore();
		const move = (e: PointerEvent) => {
			// The left edge moves; the right edge stays at the window's edge.
			AgentFilesSidebar.setWidth(this.storageService, startWidth - (e.clientX - startX), false);
		};
		const end = () => {
			store.dispose();
			this.sash.classList.remove('active');
			this.element.classList.remove('resizing');
			area?.classList.remove('files-sidebar-resizing');
			// Keep what is on screen, so a width past the maximum does not come back later.
			const shown = Math.round(this.element.getBoundingClientRect().width);
			AgentFilesSidebar.setWidth(this.storageService, shown > 0 ? shown : readState(this.storageService).width, true);
		};
		store.add(addDisposableListener(this.sash, 'pointermove', move));
		store.add(addDisposableListener(this.sash, 'pointerup', end));
		store.add(addDisposableListener(this.sash, 'pointercancel', end));
		store.add(addDisposableListener(this.sash, 'lostpointercapture', end));
	}

	override dispose(): void {
		if (shownSidebars.delete(this)) {
			shownEmitter.fire();
		}
		this.giveBack();
		if (this.announcedView) {
			this.announcedView = undefined;
			shownViewEmitter.fire();
		}
		this.toggleButton.remove();
		this.element.remove();
		super.dispose();
	}
}

/** The agents list's width from before the files sidebar narrowed it, to give back when the sidebar closes. */
const LEFT_WIDTH_KEY = 'volt.agent.filesSidebar.leftSidebarWidth';
/** While the files sidebar shows, the agents list keeps this share of its width, and at least LEFT_NARROW_MIN. */
const LEFT_NARROW_RATIO = 0.8;
const LEFT_NARROW_MIN = 220;

/**
 * Makes room for the files sidebar: while one is on screen the agents list on the left is a bit
 * narrower, and it gets its width back when the sidebar closes. (The chat gives up some room too:
 * see the split in agentSurfaceHost.ts.) The width to give back is stored, so it survives a restart
 * with the sidebar open. The list only closes when the window has no room for it: the layout's
 * drawer mode decides that (agentNeedsSidebarDrawer).
 */
class AgentFilesSidebarRoomContribution extends Disposable {

	static readonly ID = 'workbench.contrib.voltAgentFilesSidebarRoom';

	constructor(
		@IWorkbenchLayoutService private readonly layoutService: IWorkbenchLayoutService,
		@IStorageService private readonly storageService: IStorageService,
	) {
		super();
		// Sidebars hide and show again while a chat switches; act on where they settle.
		const scheduler = this._register(new RunOnceScheduler(() => this.apply(), 120));
		this._register(shownEmitter.event(() => scheduler.schedule()));
		// The list came back (shown again, or out of drawer mode): it may still owe its width.
		this._register(this.layoutService.onDidChangePartVisibility(() => scheduler.schedule()));
		scheduler.schedule();
	}

	private apply(): void {
		const saved = this.storageService.getNumber(LEFT_WIDTH_KEY, StorageScope.PROFILE);
		// A drawer floats over the window and has a fixed width; only the column is narrowed.
		const column = this.isColumnShowing();
		if (!column) {
			return;
		}
		const size = this.layoutService.getSize(Parts.AUXILIARYBAR_PART);
		if (shownSidebars.size > 0) {
			if (saved !== undefined) {
				return;
			}
			const narrow = Math.max(LEFT_NARROW_MIN, Math.round(size.width * LEFT_NARROW_RATIO));
			if (narrow < size.width) {
				this.storageService.store(LEFT_WIDTH_KEY, size.width, StorageScope.PROFILE, StorageTarget.MACHINE);
				this.layoutService.setSize(Parts.AUXILIARYBAR_PART, { width: narrow, height: size.height });
			}
		} else if (saved !== undefined) {
			this.storageService.remove(LEFT_WIDTH_KEY, StorageScope.PROFILE);
			this.layoutService.setSize(Parts.AUXILIARYBAR_PART, { width: saved, height: size.height });
		}
	}

	private isColumnShowing(): boolean {
		return getLayoutMode(this.layoutService) === 'agent'
			&& this.layoutService.isVisible(Parts.AUXILIARYBAR_PART)
			&& !this.layoutService.mainContainer.classList.contains('volt-agent-drawer-mode');
	}
}

registerWorkbenchContribution2(AgentFilesSidebarRoomContribution.ID, AgentFilesSidebarRoomContribution, WorkbenchPhase.AfterRestored);

const SVG_NS = 'http://www.w3.org/2000/svg';

/** A tab's outline icon: thin strokes in currentColor, sized by CSS. */
function createTabIcon(doc: Document, shapes: SvgIconShapes): SVGSVGElement {
	const svg = doc.createElementNS(SVG_NS, 'svg');
	svg.setAttribute('viewBox', '0 0 24 24');
	svg.setAttribute('fill', 'none');
	svg.setAttribute('stroke', 'currentColor');
	svg.setAttribute('stroke-width', '1.5');
	svg.setAttribute('stroke-linecap', 'round');
	svg.setAttribute('stroke-linejoin', 'round');
	svg.setAttribute('aria-hidden', 'true');
	for (const [tag, attributes] of shapes) {
		const shape = doc.createElementNS(SVG_NS, tag);
		for (const [name, value] of Object.entries(attributes)) {
			shape.setAttribute(name, String(value));
		}
		svg.appendChild(shape);
	}
	return svg;
}

/** A window with a panel on its right, like the tools' other title actions (16px on a 24 grid). */
function createSidebarRightIcon(doc: Document): SVGSVGElement {
	const svg = doc.createElementNS(SVG_NS, 'svg');
	svg.setAttribute('viewBox', '0 0 24 24');
	svg.setAttribute('width', '16');
	svg.setAttribute('height', '16');
	svg.setAttribute('fill', 'none');
	svg.setAttribute('stroke', 'currentColor');
	svg.setAttribute('stroke-width', '1.6');
	svg.setAttribute('stroke-linecap', 'round');
	svg.setAttribute('stroke-linejoin', 'round');
	svg.setAttribute('aria-hidden', 'true');
	const rect = doc.createElementNS(SVG_NS, 'rect');
	for (const [name, value] of Object.entries({ x: 3, y: 4, width: 18, height: 16, rx: 2.5 })) {
		rect.setAttribute(name, String(value));
	}
	const line = doc.createElementNS(SVG_NS, 'path');
	line.setAttribute('d', 'M15 4v16');
	svg.append(rect, line);
	return svg;
}
