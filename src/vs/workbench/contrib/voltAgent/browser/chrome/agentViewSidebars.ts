/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import '../media/agentViewSidebars.css';
import { $, addDisposableListener, append, EventHelper, isHTMLElement } from '../../../../../base/browser/dom.js';
import { mainWindow } from '../../../../../base/browser/window.js';
import { renderIcon } from '../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { Disposable, DisposableStore, MutableDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { disposableTimeout } from '../../../../../base/common/async.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { localize } from '../../../../../nls.js';
import { CommandsRegistry, ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { EditorInput } from '../../../../common/editor/editorInput.js';
import { IEditorGroupsService } from '../../../../services/editor/common/editorGroupsService.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { IWorkbenchLayoutService, Parts } from '../../../../services/layout/browser/layoutService.js';
import { WorkbenchPhase, registerWorkbenchContribution2 } from '../../../../common/contributions.js';
import {
	AGENT_RIGHT_DOCK_COLLAPSED_KEY,
	isAgentRightDockCollapsed,
	SET_IDE_LAYOUT_MODE_COMMAND_ID,
} from '../../../../browser/parts/titlebar/layoutModeSwitch.js';
import { AgentEditorInput } from '../editor/agentEditorInput.js';
import { showAgentBranchMenu } from '../picker/agentBranchMenu.js';
import { OPEN_BROWSER_COMMAND_ID, VoltBrowserEditorInput } from '../preview/browserEditorInput.js';
import { AgentChangesEditorInput, OPEN_AGENT_CHANGES_COMMAND_ID } from '../review/agentChangesEditor.js';
import { createPrimarySidebarToggleIcon } from '../../../../browser/parts/titlebar/sidebarToggleIcon.js';
import { SHOW_PULL_REQUESTS_COMMAND_ID } from '../pullRequests/agentPullRequestCommands.js';
import { AgentPullRequestDockControl } from '../pullRequests/agentPullRequestDockControl.js';
import { IAgentPullRequestService } from '../pullRequests/agentPullRequestService.js';
import { setAgentTooltip } from './agentTooltip.js';
import { closeAgentToolEditor, onDidChangeAgentToolEditors, openAgentToolsPanel, revealAgentToolEditor, SHOW_AGENT_FILES_COMMAND_ID, shownAgentToolEditors } from '../workspace/agentSurfaceHost.js';
import { CHANGES_ICON_PATH, createSurfaceStrokeIcon, EXPLORER_ICON_SHAPES, SCRATCH_ICON_SHAPES, type SvgIconShapes } from '../workspace/agentSurfaceMenu.js';
import { AGENT_TOOLS_VISIBILITY_EVENT } from '../../../../browser/parts/titlebar/layoutModeStartup.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { AgentLineageDock } from './agentLineageDock.js';
import { createModeIcon } from './agentModeIcons.js';
import { ISubagentCounts } from './agentSubagents.js';
import { IAgentSessionChangesService } from '../review/agentSessionChangesService.js';
import { autorun } from '../../../../../base/common/observable.js';
import { ISCMRepository, ISCMService } from '../../../scm/common/scm.js';
import { isEqual } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { IAgentHistoryService } from '../../../../services/voltRuntime/common/history/agentHistory.js';
import { OPEN_CANVAS_COMMAND_ID } from '../visuals/canvas/canvasCard.js';
import { IVoltCanvasService } from '../visuals/canvas/canvasService.js';
import { boardDisplayTitle } from '../../common/scratchBoard/scratchIndex.js';
import { OPEN_SCRATCH_BOARD_BESIDE_COMMAND_ID, OPEN_SCRATCH_BOARD_COMMAND_ID } from '../scratchBoard/scratchBoardInput.js';
import { IScratchBoardService } from '../scratchBoard/scratchBoardService.js';
import { IScratchSessionLinks } from '../scratchBoard/scratchSessionLinks.js';

/** Chevrons point right. Collapsed state rotates this 180deg. */
const CHEVRON_RIGHT_PATH = 'M6 7L11 12L6 17M13 7L18 12L13 17';
/** A bar over three lines: the Quick Open Actions list. Drawn at 16px, so a 1.5 stroke is 1px. */
const QUICK_OPEN_ICON_PATH = 'M3.75 12H20.25M3.75 15.75H20.25M3.75 19.5H20.25M5.625 4.5H18.375C19.4105 4.5 20.25 5.33947 20.25 6.375C20.25 7.41053 19.4105 8.25 18.375 8.25H5.625C4.58947 8.25 3.75 7.41053 3.75 6.375C3.75 5.33947 4.58947 4.5 5.625 4.5Z';
/** The user hid Quick Open Actions with the title bar button. */
const QUICK_OPEN_HIDDEN_KEY = 'volt.agent.quickOpenActions.hidden';
const TOGGLE_TERMINAL_COMMAND_ID = 'workbench.action.terminal.toggleTerminal';
/** An arrow out to the top right, after the "IDE" label. */
const ARROW_UP_RIGHT_PATH = 'M7 7h10v10M7 17 17 7';
/** Opens the chat side toolbar on its agents: expanded beside the chat, or as a popup under its title bar button when there is no room. */
export const SHOW_AGENTS_IN_SIDE_TOOLBAR_COMMAND_ID = 'volt.agent.showAgentsInSideToolbar';
/** Expanded Quick Open Actions are 228px. Below this window width they collapse. */
export const QUICK_OPEN_NARROW_WINDOW_WIDTH = 1100;

/** Below this chat column width the actions leave too little room for the conversation. */
export const QUICK_OPEN_NARROW_CHAT_WIDTH = 900;

/** Below this chat column width even the collapsed rail crowds the conversation: the toolbar opens from its title bar button. */
export const QUICK_OPEN_POPUP_CHAT_WIDTH = 480;

/** Same editor stays the same row when its title changes, so a click is not lost to a rebuild. */
export function dockTabKey(editor: { readonly typeId: string; readonly resource?: { toString(): string }; getName(): string }): string {
	const resource = editor.resource?.toString();
	return resource ? `${editor.typeId}\0${resource}` : `${editor.typeId}\0${editor.getName()}`;
}

/** A narrow window, or a chat column squeezed by tools opened beside it. Zero means not measured yet. */
export function quickOpenNarrowForSpace(windowWidth: number, chatWidth: number): boolean {
	return (windowWidth > 0 && windowWidth <= QUICK_OPEN_NARROW_WINDOW_WIDTH)
		|| (chatWidth > 0 && chatWidth <= QUICK_OPEN_NARROW_CHAT_WIDTH);
}

/** Narrow windows collapse Quick Open Actions unless the user opened them in this narrow session. */
export function quickOpenCollapsedForWidth(windowWidth: number, userCollapsed: boolean, narrowOverride?: boolean): boolean {
	if (typeof narrowOverride === 'boolean') {
		return narrowOverride;
	}
	const narrow = windowWidth > 0 && windowWidth <= QUICK_OPEN_NARROW_WINDOW_WIDTH;
	return narrow || userCollapsed;
}

interface IDockAction {
	readonly id: string;
	readonly label: string;
	readonly icon?: ThemeIcon;
	readonly iconPath?: string | SvgIconShapes;
	readonly command: string;
	/** Arguments read at click time. */
	readonly args?: () => unknown[];
	/** Runs instead of {@link command}, given the row, e.g. to open a menu under it. */
	readonly run?: (row: HTMLElement) => void;
}

/**
 * Quick Open Actions live on the chat scroller, the same node as its scrollbar.
 * They take in-flow width there and push the transcript. Collapse only changes this component.
 */
export function agentQuickOpenActionsHost(editorPart: HTMLElement | undefined, fallback: HTMLElement): HTMLElement {
	const scope = editorPart ?? fallback;
	const chat = scope.classList.contains('volt-agent-editor')
		? scope
		: scope.querySelector('.volt-agent-editor:not(.browser-hosted)');
	if (isHTMLElement(chat) && !chat.classList.contains('browser-hosted')) {
		// A new chat hides its empty transcript, so the actions float on the chat column until the first turn.
		const main = chat.classList.contains('has-turns') ? null : chat.querySelector(':scope > .volt-agent-editor-main');
		if (isHTMLElement(main)) {
			return main;
		}
		const scroller = chat.querySelector('.volt-agent-thread > .monaco-scrollable-element');
		if (isHTMLElement(scroller)) {
			return scroller;
		}
		return chat;
	}
	return editorPart ?? fallback;
}

/** Sit on the scroller immediately before the vertical scrollbar, not in a column outside it. */
export function mountAgentQuickOpenActions(host: HTMLElement, quickOpen: HTMLElement): void {
	const scrollbar = host.classList.contains('monaco-scrollable-element')
		? host.querySelector(':scope > .scrollbar.vertical')
		: null;
	if (quickOpen.parentElement === host && (!isHTMLElement(scrollbar) || quickOpen.nextElementSibling === scrollbar)) {
		return;
	}
	if (isHTMLElement(scrollbar)) {
		host.insertBefore(quickOpen, scrollbar);
		return;
	}
	if (quickOpen.parentElement !== host) {
		host.appendChild(quickOpen);
	}
}

/**
 * A folding group of the toolbar (Open Tabs, Designs, Pull requests), headed like "Previous agents
 * (N)" in {@link AgentLineageDock}: a pane header with a chevron, the title in capitals, the count.
 * Folding lasts while the window is open, as it does for Previous agents.
 */
class DockGroup extends Disposable {

	/** The group's rows go here; folding hides it. */
	readonly body: HTMLElement;
	private readonly head: HTMLButtonElement;
	private open = true;
	private count: number | undefined;

	constructor(section: HTMLElement, private readonly title: string) {
		super();
		// The lineage divider's class: the same header as Previous agents (agentSubagents.css).
		this.head = append(section, $('button.volt-agent-lineage-divider.volt-agent-dock-group-head')) as HTMLButtonElement;
		this.head.type = 'button';
		this.body = append(section, $('.volt-agent-dock-group-body'));
		this._register(addDisposableListener(this.head, 'click', () => {
			this.open = !this.open;
			this.render();
		}));
		this.render();
	}

	/** Undefined drops the count from the title. */
	setCount(count: number | undefined): void {
		if (count === this.count) {
			return;
		}
		this.count = count;
		this.render();
	}

	private render(): void {
		this.head.setAttribute('aria-expanded', String(this.open));
		this.head.replaceChildren(renderIcon(this.open ? Codicon.chevronDown : Codicon.chevronRight));
		append(this.head, $('span.label')).textContent = this.count === undefined
			? this.title
			: localize('voltAgent.dock.groupTitle', "{0} ({1})", this.title, this.count);
		this.body.classList.toggle('hidden', !this.open);
	}
}

function createStrokeIcon(owner: HTMLElement, pathD: string, strokeWidth = '1.5'): SVGElement {
	const svg = owner.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'svg');
	svg.setAttribute('viewBox', '0 0 24 24');
	svg.setAttribute('width', '16');
	svg.setAttribute('height', '16');
	svg.setAttribute('fill', 'none');
	svg.setAttribute('aria-hidden', 'true');
	const path = owner.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'path');
	path.setAttribute('d', pathD);
	path.setAttribute('fill', 'none');
	path.setAttribute('stroke', 'currentColor');
	path.setAttribute('stroke-width', strokeWidth);
	path.setAttribute('stroke-linecap', 'round');
	path.setAttribute('stroke-linejoin', 'round');
	svg.appendChild(path);
	return svg;
}

/**
 * Agent-layout sidebar chrome: a left toggle for the agent list, a right
 * panel button, and a right dock that collapses to an icon rail.
 */
class AgentViewSidebarsContribution extends Disposable {
	static readonly ID = 'workbench.contrib.voltAgentViewSidebars';

	private readonly quickOpen: HTMLElement;
	/** Title bar buttons, left to right: IDE, Quick Open Actions, bottom panel, right panel. */
	private readonly titlebarToggles: HTMLElement;
	private readonly quickOpenToggle: HTMLButtonElement;
	private readonly panelToggle: HTMLButtonElement;
	private readonly rightToggle: HTMLButtonElement;
	private readonly filesToggle: HTMLButtonElement;
	private readonly chevron: HTMLButtonElement;
	private readonly chevronLabel: HTMLElement;
	private readonly tabsSection: HTMLElement;
	/** The rows under the rail; they move into the popup while it is open. */
	private readonly body: HTMLElement;
	/** Without room for the toolbar beside the chat, the title bar button opens it here instead. */
	private readonly popup: HTMLElement;
	private readonly popupListeners = this._register(new DisposableStore());
	private readonly tabList: HTMLElement;
	/** "On <project>" over Files, Terminal and Browser; clicking it folds them. */
	private readonly workspaceHeading: HTMLButtonElement;
	private readonly workspaceLabel: HTMLElement;
	private workspaceOpen = true;
	/** The checked-out branch, under Changes in the Pull requests group. */
	private readonly branchLabel: HTMLElement;
	private readonly branchRow: HTMLElement;
	private readonly branchWatch = this._register(new DisposableStore());
	/** The repository the branch row shows: the chat's worktree when Source Control has it open, else the project's. */
	private branchRepository: ISCMRepository | undefined;
	/** The checkout the branch row shows and switches: the chat's worktree, else the window's folder. */
	private branchRoot: URI | undefined;
	/** The chat the branch row follows: in its own worktree, the row shows that worktree's branch, as the composer does. */
	private branchSessionId: string | undefined;
	/** That chat's worktree when the row was last pointed at a checkout. */
	private branchWorktreePath: string | undefined;
	/** Source Control's name for the repository's branch; a worktree without one uses its chat's stored branch. */
	private repositoryBranch: string | undefined;
	private readonly statsTimer = this._register(new MutableDisposable());
	private statsGen = 0;
	private readonly changesAdd: HTMLElement;
	private readonly changesDel: HTMLElement;
	/** "Pull requests (N)": the chat's pull request with its checks and Merge (Cursor's row), then its others. */
	private readonly pullRequestsGroup: DockGroup;
	/** The chat's pull request, or "All pull requests" without one: the title opens the right sidebar's list. */
	private readonly pullRequestControl: AgentPullRequestDockControl;
	private readonly pullRequests: IAgentPullRequestService | undefined;
	/** The chat whose changes the Changes row counts. */
	private changesSessionId: string | undefined;
	/** The agents of the chat on screen: running, previous, and its parent in a subagent's chat. */
	private readonly lineage: AgentLineageDock;
	/** The collapsed toolbar's agents button: how many are live, and a click opens the list. */
	private readonly agentsRail: HTMLButtonElement;
	private readonly agentsBadge: HTMLElement;
	private readonly tabListeners = this._register(new DisposableStore());
	private readonly tabsGroup: DockGroup;
	/** The chat's design canvases: each opens beside the chat. */
	private readonly designsSection: HTMLElement;
	private readonly designsGroup: DockGroup;
	private readonly designList: HTMLElement;
	private readonly designListeners = this._register(new DisposableStore());
	private readonly canvases: IVoltCanvasService | undefined;
	/** The Scratch board the chat was started from (or drew on): a group like Designs, its row opens it beside the chat. */
	private readonly scratchSection: HTMLElement;
	private readonly scratchGroup: DockGroup;
	private readonly scratchList: HTMLElement;
	private readonly scratchRow: HTMLButtonElement;
	private readonly scratchRowLabel: HTMLElement;
	private readonly scratchLinks: IScratchSessionLinks | undefined;
	private readonly scratchBoards: IScratchBoardService | undefined;
	private scratchBoardId: string | undefined;
	private designSession: string | undefined;
	private designKeys = '';
	/** Editors currently painted in Open Tabs. Unchanged focus events must not rebuild those rows. */
	private tabKeys = '';
	private editorObserver: MutationObserver | undefined;
	/** Watches the chat column the actions sit in; opening tools beside the chat narrows it. */
	private readonly chatResize: ResizeObserver;
	private observedChat: HTMLElement | undefined;
	private windowNarrow = false;
	/** Last {@link usesPopup}; the button's label and the popup follow its changes. */
	private popupMode = false;
	/** The user's choice while the space is narrow. Cleared whenever narrow flips. */
	private narrowOverride: boolean | undefined;
	private placeScheduled = false;
	private dockApplied = false;
	private collapsed = false;
	/** Expanded in a chat with no room beside it: a card over the transcript, the chat keeps its width. */
	private overlay = false;
	private readonly overlayListeners = this._register(new DisposableStore());
	/** The chat holding the actions, which carries their state as classes (see syncQuickOpenHost). */
	private quickOpenEditor: HTMLElement | undefined;
	// has-turns moves the actions between the chat column and the transcript.
	private readonly quickOpenEditorWatch = new MutationObserver(() => this.schedulePlace());

	constructor(
		@IWorkbenchLayoutService private readonly layoutService: IWorkbenchLayoutService,
		@IStorageService private readonly storageService: IStorageService,
		@ICommandService private readonly commandService: ICommandService,
		@IEditorService private readonly editorService: IEditorService,
		@IEditorGroupsService private readonly editorGroupsService: IEditorGroupsService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IAgentSessionChangesService private readonly changesService: IAgentSessionChangesService,
		@ISCMService private readonly scmService: ISCMService,
		@IAgentHistoryService private readonly history: IAgentHistoryService,
	) {
		super();
		const root = layoutService.mainContainer;
		this.titlebarToggles = $('.volt-agent-titlebar-toggles');
		this._register(toDisposable(() => this.titlebarToggles.remove()));

		const ideButton = append(this.titlebarToggles, $('button.volt-agent-switch-to-ide.volt-titlebar-control')) as HTMLButtonElement;
		ideButton.type = 'button';
		append(ideButton, $('span')).textContent = localize('voltAgent.ide', "IDE");
		ideButton.appendChild(createStrokeIcon(ideButton, ARROW_UP_RIGHT_PATH, '1.5'));
		const ideLabel = localize('voltAgent.switchToIde', "Switch to IDE Layout");
		ideButton.setAttribute('aria-label', ideLabel);
		setAgentTooltip(ideButton, ideLabel);
		this._register(addDisposableListener(ideButton, 'click', () => {
			void this.commandService.executeCommand(SET_IDE_LAYOUT_MODE_COMMAND_ID);
		}));

		this.quickOpenToggle = append(this.titlebarToggles, $('button.volt-agent-titlebar-toggle.volt-agent-quick-open-visibility.volt-titlebar-control')) as HTMLButtonElement;
		this.quickOpenToggle.type = 'button';
		this.quickOpenToggle.appendChild(createStrokeIcon(this.quickOpenToggle, QUICK_OPEN_ICON_PATH, '1.5'));
		this._register(addDisposableListener(this.quickOpenToggle, 'click', () => {
			if (this.usesPopup()) {
				this.setPopupOpen(!this.popupOpen);
				return;
			}
			this.storageService.store(QUICK_OPEN_HIDDEN_KEY, !this.quickOpenHidden, StorageScope.PROFILE, StorageTarget.USER);
			this.syncQuickOpenVisibility();
		}));

		this.panelToggle = append(this.titlebarToggles, $('button.volt-agent-titlebar-toggle.volt-agent-bottom-panel-toggle.volt-titlebar-control')) as HTMLButtonElement;
		this.panelToggle.type = 'button';
		this._register(addDisposableListener(this.panelToggle, 'click', () => {
			// Toggle Terminal only closes a panel that has focus, and clicking this button takes it.
			if (this.layoutService.isVisible(Parts.PANEL_PART)) {
				this.layoutService.setPartHidden(true, Parts.PANEL_PART);
			} else {
				void this.commandService.executeCommand(TOGGLE_TERMINAL_COMMAND_ID);
			}
		}));
		this._register(layoutService.onDidChangePartVisibility(() => this.syncPanelToggle()));
		this.syncPanelToggle();

		// The files sidebar's own toggle, beside the right panel's: each opens on its own.
		this.filesToggle = append(this.titlebarToggles, $('button.volt-agent-titlebar-toggle.volt-agent-files-panel-toggle.volt-titlebar-control')) as HTMLButtonElement;
		this.filesToggle.type = 'button';
		this.filesToggle.appendChild(createSurfaceStrokeIcon(this.filesToggle.ownerDocument, EXPLORER_ICON_SHAPES));
		const filesLabel = localize('voltAgent.filesSidebar.show', "Show Files Sidebar");
		this.filesToggle.setAttribute('aria-label', filesLabel);
		setAgentTooltip(this.filesToggle, filesLabel);
		this._register(addDisposableListener(this.filesToggle, 'click', () => void this.commandService.executeCommand(SHOW_AGENT_FILES_COMMAND_ID)));

		this.rightToggle = append(this.titlebarToggles, $('button.volt-agent-titlebar-toggle.volt-agent-right-panel-toggle.volt-titlebar-control')) as HTMLButtonElement;
		this.rightToggle.type = 'button';
		this._register(addDisposableListener(root, AGENT_TOOLS_VISIBILITY_EVENT, () => this.syncRightToggle()));
		this.syncRightToggle();
		this._register(addDisposableListener(this.rightToggle, 'click', () => openAgentToolsPanel()));

		this.quickOpen = $('.volt-agent-quick-open-actions.expanded');
		this.quickOpen.setAttribute('aria-label', localize('voltAgent.chatSideToolbar', "Chat Side Toolbar"));
		this.chevron = append(this.quickOpen, $('button.volt-agent-quick-open-toggle')) as HTMLButtonElement;
		this.chevron.type = 'button';
		this.chevronLabel = append(this.chevron, $('span.volt-agent-dock-label'));
		const chevronIcon = createStrokeIcon(this.chevron, CHEVRON_RIGHT_PATH, '1');
		chevronIcon.setAttribute('viewBox', '4 5 16 14');
		chevronIcon.setAttribute('width', '16');
		chevronIcon.setAttribute('height', '16');
		this.chevron.appendChild(chevronIcon);

		const rail = append(this.quickOpen, $('.volt-agent-quick-open-rail'));
		// First on the rail while agents run: the collapsed toolbar still says how many.
		this.agentsRail = append(rail, $('button.volt-agent-rail-btn.volt-agent-rail-agents.hidden')) as HTMLButtonElement;
		this.agentsRail.type = 'button';
		append(this.agentsRail, $('span.volt-agent-dock-label'));
		this.agentsRail.appendChild(createModeIcon('multitask'));
		this.agentsBadge = append(this.agentsRail, $('span.volt-agent-rail-badge'));
		this._register(addDisposableListener(this.agentsRail, 'click', () => this.revealAgents()));
		const body = this.body = append(this.quickOpen, $('.volt-agent-quick-open-body'));
		// The toolbar sits inside the chat's scrollable, whose wheel listener scrolls the chat and cancels the
		// event. A body taller than its room keeps the wheel so it scrolls itself.
		this._register(addDisposableListener(body, 'wheel', e => {
			if (!e.ctrlKey && body.scrollHeight > body.clientHeight + 1) {
				e.stopPropagation();
			}
		}, { passive: true }));
		this.popup = $('.volt-agent-quick-open-actions.expanded.volt-agent-quick-open-popup.hidden');
		this.popup.setAttribute('aria-label', localize('voltAgent.chatSideToolbar', "Chat Side Toolbar"));
		this._register(toDisposable(() => this.popup.remove()));
		// A row ran its action: the popup has done its job. Group headers only fold their rows, so it stays.
		this._register(addDisposableListener(this.popup, 'click', e => {
			const target = e.target as HTMLElement | null;
			if (target?.closest('button, [role="button"]') && !target.closest('.volt-agent-lineage-divider')) {
				this.setPopupOpen(false);
			}
		}));
		this.tabsSection = append(body, $('.volt-agent-dock-section.volt-agent-dock-tabs.hidden'));
		this.tabsGroup = this._register(new DockGroup(this.tabsSection, localize('voltAgent.dock.openTabs', "Open Tabs")));
		this.tabList = append(this.tabsGroup.body, $('.volt-agent-dock-tab-list'));
		this.designsSection = append(body, $('.volt-agent-dock-section.volt-agent-dock-designs.hidden'));
		this.designsGroup = this._register(new DockGroup(this.designsSection, localize('voltAgent.dock.designs', "Designs")));
		this.designList = append(this.designsGroup.body, $('.volt-agent-dock-tab-list'));
		this.canvases = instantiationService.invokeFunction(accessor => accessor.getIfExists(IVoltCanvasService));
		if (this.canvases) {
			this._register(this.canvases.onDidChange(change => {
				// A new canvas, or one renamed.
				if (change.kind === 'doc' && (!change.doc.chat || change.doc.chat === this.designSession)) {
					this.designKeys = '';
					this.renderDesigns();
				}
			}));
		}
		// The Scratch board this chat came from (or drew on), grouped like its designs.
		this.scratchSection = append(body, $('.volt-agent-dock-section.volt-agent-dock-scratch.hidden'));
		this.scratchGroup = this._register(new DockGroup(this.scratchSection, localize('voltAgent.dock.scratchGroup', "Scratch")));
		this.scratchList = append(this.scratchGroup.body, $('.volt-agent-dock-tab-list'));
		const scratchRow = append(this.scratchList, $('button.volt-agent-dock-row')) as HTMLButtonElement;
		scratchRow.type = 'button';
		const scratchRowIcon = createSurfaceStrokeIcon(scratchRow.ownerDocument, SCRATCH_ICON_SHAPES);
		scratchRowIcon.classList.add('volt-agent-stroke-icon');
		scratchRow.appendChild(scratchRowIcon);
		this.scratchRowLabel = append(scratchRow, $('span.volt-agent-dock-row-label'));
		this.scratchRow = scratchRow;
		this._register(addDisposableListener(scratchRow, 'click', () => this.openScratch()));
		this.scratchLinks = instantiationService.invokeFunction(accessor => accessor.getIfExists(IScratchSessionLinks));
		this.scratchBoards = instantiationService.invokeFunction(accessor => accessor.getIfExists(IScratchBoardService));
		if (this.scratchLinks) {
			this._register(this.scratchLinks.onDidChange(() => this.syncScratch()));
		}
		if (this.scratchBoards) {
			// Renamed or deleted boards.
			this._register(this.scratchBoards.onDidChangeIndex(() => this.syncScratch()));
		}

		// Sections like Cursor's project menu: the project's tools, then git, then the agents.
		const [changes, browser, terminal, files] = this.dockActions();
		const workspaceSection = append(body, $('.volt-agent-dock-section.volt-agent-dock-workspace'));
		// The same pane header as Pull requests and Previous agents: chevron, then the title.
		this.workspaceHeading = append(workspaceSection, $('button.volt-agent-lineage-divider.volt-agent-dock-group-head')) as HTMLButtonElement;
		this.workspaceHeading.type = 'button';
		this.workspaceLabel = $('span.label');
		const workspace = append(workspaceSection, $('.volt-agent-dock-actions.volt-agent-dock-group-body'));
		const syncWorkspaceFold = () => {
			this.workspaceHeading.setAttribute('aria-expanded', String(this.workspaceOpen));
			this.workspaceHeading.replaceChildren(renderIcon(this.workspaceOpen ? Codicon.chevronDown : Codicon.chevronRight), this.workspaceLabel);
			workspace.classList.toggle('hidden', !this.workspaceOpen);
		};
		this._register(addDisposableListener(this.workspaceHeading, 'click', () => {
			this.workspaceOpen = !this.workspaceOpen;
			syncWorkspaceFold();
		}));
		syncWorkspaceFold();
		this.createActionRow(workspace, files);
		this.createActionRow(workspace, terminal);
		this.createActionRow(workspace, browser);

		// Commit, Push & PR stays on the composer; the toolbar keeps the branch, the changes and the pull requests.
		this.pullRequests = instantiationService.invokeFunction(accessor => accessor.getIfExists(IAgentPullRequestService));
		this.pullRequestsGroup = this._register(new DockGroup(append(body, $('.volt-agent-dock-section.volt-agent-dock-pull-requests')), localize('voltAgent.dock.pullRequests', "Pull requests")));
		// Changes lead the Pull requests group: what the next pull request would carry, then the branch it goes from.
		const git = append(this.pullRequestsGroup.body, $('.volt-agent-dock-actions'));
		const changesLabel = this.createActionRow(git, changes);
		this.changesAdd = append(changesLabel.parentElement!, $('span.volt-agent-dock-stat.add'));
		this.changesDel = append(changesLabel.parentElement!, $('span.volt-agent-dock-stat.del'));
		// The branch dropdown under the row, as the new chat's Branch pill opens it; git.checkout is the fallback without a repository.
		this.branchLabel = this.createActionRow(git, {
			id: 'branch',
			label: '',
			icon: Codicon.gitBranch,
			command: 'git.checkout',
			run: row => {
				const repository = this.branchRepository;
				const root = this.branchRoot ?? repository?.provider.rootUri;
				if (root) {
					instantiationService.invokeFunction(showAgentBranchMenu, { anchor: row, root, repository });
				} else {
					void this.commandService.executeCommand('git.checkout');
				}
			},
		});
		this.branchRow = this.branchLabel.parentElement!;
		// The chat's pull request: its title opens the Pull Requests tab of the right sidebar, its list first.
		this.pullRequestControl = this._register(instantiationService.createInstance(AgentPullRequestDockControl, this.pullRequestsGroup.body, this.pullRequests, {
			openCommandId: SHOW_PULL_REQUESTS_COMMAND_ID,
			emptyLabel: localize('voltAgent.dock.allPullRequests', "All pull requests"),
		}));
		const syncPullRequestsCount = () => this.pullRequestsGroup.setCount(this.pullRequestControl.linkCount || undefined);
		this._register(this.pullRequestControl.onDidRender(syncPullRequestsCount));
		syncPullRequestsCount();
		this._register(scmService.onDidAddRepository(() => this.watchBranch()));
		this._register(scmService.onDidRemoveRepository(() => this.watchBranch()));
		// A worktree's branch is stored on its chat and follows renames and checkouts (agentWorktreeBranch.ts).
		this._register(this.history.onDidChange(() => this.onDidChangeHistory()));
		this.watchBranch();
		for (const action of this.dockActions()) {
			this.createRailButton(rail, action);
		}
		this._register(changesService.onDidChange(sessionId => {
			if (!sessionId || sessionId === this.changesSessionId) {
				this.renderChangesStats();
			}
		}));
		this.lineage = this._register(instantiationService.createInstance(AgentLineageDock));
		// Agents come first, at the top right of the chat: what runs in parallel is what the user checks most.
		// Finished agents go last, under the tools and git.
		body.prepend(this.lineage.element);
		body.append(this.lineage.previousElement);
		this._register(this.lineage.onDidChangeSummary(summary => this.syncAgentsRail(summary)));
		this._register(CommandsRegistry.registerCommand(SHOW_AGENTS_IN_SIDE_TOOLBAR_COMMAND_ID, () => this.revealAgents()));

		this.chatResize = new ResizeObserver(() => {
			this.syncDockToWindow();
			this.layoutOverlay();
		});
		this._register(toDisposable(() => this.chatResize.disconnect()));
		this._register(toDisposable(() => this.quickOpenEditorWatch.disconnect()));
		this.placeQuickOpen(root);
		this.updateWorkspaceHeading();
		this.renderTabs();
		this.syncLineage();
		this.windowNarrow = this.isWindowNarrow();
		this.syncDockToWindow();
		this.syncQuickOpenVisibility();

		this._register(addDisposableListener(this.chevron, 'click', () => this.toggleDock()));
		this._register(layoutService.onDidLayoutMainContainer(() => {
			this.mountRightToggle();
			this.syncDockToWindow();
		}));
		const syncDock = () => {
			this.schedulePlace();
			this.renderTabs();
			this.syncLineage();
		};
		this._register(editorService.onDidEditorsChange(syncDock));
		this._register(editorService.onDidActiveEditorChange(syncDock));
		this._register(editorService.onDidVisibleEditorsChange(syncDock));
		this._register(onDidChangeAgentToolEditors(syncDock));
		this.observeEditorPart();
		this._register(workspaceContextService.onDidChangeWorkspaceFolders(() => {
			this.updateWorkspaceHeading();
			this.watchBranch();
		}));
		this._register(workspaceContextService.onDidChangeWorkspaceName(() => this.updateWorkspaceHeading()));
	}

	/** The rail's agents button: shown while agents work, with their count (amber when one waits on the user). */
	private syncAgentsRail(summary: ISubagentCounts): void {
		const live = summary.multitask + summary.subagents;
		this.agentsRail.classList.toggle('hidden', live === 0);
		this.agentsRail.classList.toggle('waiting', summary.waiting > 0);
		this.agentsBadge.textContent = live > 99 ? '99+' : String(live);
		const label = summary.waiting
			? localize('voltAgent.dock.agentsWaiting', "Agents: {0} running, {1} need you", live - summary.waiting, summary.waiting)
			: localize('voltAgent.dock.agentsRunning', "Agents: {0} running", live);
		this.agentsRail.setAttribute('aria-label', label);
		const tip = this.agentsRail.querySelector('.volt-agent-dock-label');
		if (tip) {
			tip.textContent = label;
		}
	}

	/**
	 * Shows the agents list: the toolbar expands beside the chat, or opens as a popup under its
	 * title bar button when it has no room there (narrow, hidden by the user, tools open beside the chat).
	 */
	private revealAgents(): void {
		const inline = !this.usesPopup() && !this.quickOpenHidden && !!this.quickOpenEditor;
		if (!inline) {
			this.setPopupOpen(true);
			return;
		}
		if (this.collapsed) {
			this.toggleDock();
		}
		this.lineage.element.scrollIntoView({ block: 'nearest' });
	}

	/** Watch the editor part once it exists. Observing the whole workbench during startup would run on every node. */
	private observeEditorPart(): void {
		const attach = (): boolean => {
			if (this.editorObserver) {
				return true;
			}
			const editorPart = this.layoutService.getContainer(mainWindow, Parts.EDITOR_PART);
			if (!isHTMLElement(editorPart)) {
				return false;
			}
			const observer = new MutationObserver(mutations => this.onEditorMutation(mutations));
			observer.observe(editorPart, { childList: true, subtree: true });
			this.editorObserver = observer;
			this._register(toDisposable(() => observer.disconnect()));
			return true;
		};
		if (attach()) {
			return;
		}
		const listener = this.layoutService.onDidLayoutMainContainer(() => {
			if (attach()) {
				listener.dispose();
			}
		});
		this._register(listener);
	}

	private dockActions(): IDockAction[] {
		return [
			{ id: 'changes', label: localize('voltAgent.dock.changes', "Changes"), iconPath: CHANGES_ICON_PATH, command: OPEN_AGENT_CHANGES_COMMAND_ID },
			{ id: 'browser', label: localize('voltAgent.dock.browser', "Browser"), icon: Codicon.globe, command: OPEN_BROWSER_COMMAND_ID },
			{ id: 'terminal', label: localize('voltAgent.dock.terminal', "Terminal"), icon: Codicon.terminal, command: 'workbench.action.terminal.toggleTerminal' },
			{ id: 'files', label: localize('voltAgent.dock.explorer', "Explorer"), iconPath: EXPLORER_ICON_SHAPES, command: SHOW_AGENT_FILES_COMMAND_ID },
		];
	}

	private appendActionIcon(parent: HTMLElement, action: IDockAction): void {
		if (action.iconPath) {
			const icon = createSurfaceStrokeIcon(parent.ownerDocument, action.iconPath);
			icon.classList.add('volt-agent-stroke-icon');
			parent.appendChild(icon);
			return;
		}
		if (action.icon) {
			parent.appendChild(renderIcon(action.icon));
		}
	}

	/** Returns the row's label. */
	private createActionRow(parent: HTMLElement, action: IDockAction): HTMLElement {
		const row = append(parent, $('button.volt-agent-dock-row')) as HTMLButtonElement;
		row.type = 'button';
		this.appendActionIcon(row, action);
		const label = append(row, $('span.volt-agent-dock-row-label'));
		label.textContent = action.label;
		this._register(addDisposableListener(row, 'click', e => {
			if (action.run) {
				EventHelper.stop(e, true);
				action.run(row);
				return;
			}
			void this.commandService.executeCommand(action.command, ...(action.args?.() ?? []));
		}));
		return label;
	}

	/**
	 * The branch of the checkout the chat works in, the one the composer's branch pill shows: its
	 * own worktree's, else the project's. The row hides when there is no branch to show.
	 */
	private watchBranch(): void {
		this.branchWatch.clear();
		const repositories = [...this.scmService.repositories];
		const worktreePath = this.branchSessionId ? this.history.get(this.branchSessionId)?.worktreePath : undefined;
		this.branchWorktreePath = worktreePath;
		const worktree = worktreePath ? URI.file(worktreePath) : undefined;
		const folder = this.workspaceContextService.getWorkspace().folders[0]?.uri;
		this.branchRoot = worktree ?? folder;
		// A worktree counts only as its own repository (Source Control rarely has one open); the
		// project's folder takes its own repository or the one it sits in, never an unrelated one.
		const repository = worktree
			? repositories.find(candidate => !!candidate.provider.rootUri && isEqual(candidate.provider.rootUri, worktree))
			: folder ? repositories.find(candidate => !!candidate.provider.rootUri && isEqual(candidate.provider.rootUri, folder)) ?? this.scmService.getRepository(folder) : repositories[0];
		this.branchRepository = repository;
		// The diff counts follow the working tree.
		if (repository) {
			this.branchWatch.add(repository.provider.onDidChangeResources(() => this.renderChangesStats()));
		}
		this.renderChangesStats();
		this.branchWatch.add(autorun(reader => {
			const name = repository?.provider.historyProvider.read(reader)?.historyItemRef.read(reader)?.name;
			this.repositoryBranch = name;
			this.syncBranchLabel();
		}));
	}

	/** A chat's first send makes its worktree: the row moves to it. Otherwise the stored branch may have changed. */
	private onDidChangeHistory(): void {
		const worktreePath = this.branchSessionId ? this.history.get(this.branchSessionId)?.worktreePath : undefined;
		if (worktreePath !== this.branchWorktreePath) {
			this.watchBranch();
			return;
		}
		this.syncBranchLabel();
	}

	private syncBranchLabel(): void {
		const meta = this.branchSessionId ? this.history.get(this.branchSessionId) : undefined;
		const name = this.repositoryBranch ?? (meta?.worktreePath ? meta.worktreeBranch : undefined);
		this.branchLabel.textContent = name ?? '';
		this.branchRow.style.display = name ? '' : 'none';
	}

	/**
	 * allow-any-unicode-next-line
	 * "+12 −3" on the Changes row: the working tree's diff, as Cursor shows it, or the chat's own
	 * changes when git has no answer. Debounced; SCM fires a burst per save.
	 */
	private renderChangesStats(): void {
		this.statsTimer.value = disposableTimeout(() => void this.refreshChangesStats(), 300);
	}

	private async refreshChangesStats(): Promise<void> {
		const gen = ++this.statsGen;
		let additions = 0;
		let deletions = 0;
		const stat = await this.commandService.executeCommand<{ insertions: number; deletions: number }>('git.api.getWorkingTreeShortStat', this.workspaceContextService.getWorkspace().folders.map(folder => folder.uri)).catch(() => undefined);
		if (gen !== this.statsGen) {
			return;
		}
		if (stat) {
			additions = stat.insertions;
			deletions = stat.deletions;
		} else if (this.changesSessionId) {
			const session = this.changesService.getStats(this.changesSessionId, 'uncommitted');
			additions = session.additions;
			deletions = session.deletions;
		}
		this.changesAdd.textContent = additions > 0 ? `+${additions}` : '';
		this.changesDel.textContent = deletions > 0 ? `\u2212${deletions}` : '';
	}

	private createRailButton(parent: HTMLElement, action: IDockAction): void {
		const button = append(parent, $('button.volt-agent-rail-btn')) as HTMLButtonElement;
		button.type = 'button';
		button.setAttribute('aria-label', action.label);
		const label = append(button, $('span.volt-agent-dock-label'));
		label.textContent = action.label;
		this.appendActionIcon(button, action);
		this._register(addDisposableListener(button, 'click', () => {
			void this.commandService.executeCommand(action.command);
		}));
	}

	private onEditorMutation(mutations: MutationRecord[]): void {
		for (const mutation of mutations) {
			if (mutation.target === this.quickOpen || this.quickOpen.contains(mutation.target)) {
				continue;
			}
			const nodes = [...mutation.addedNodes, ...mutation.removedNodes];
			for (const node of nodes) {
				if (!isHTMLElement(node)) {
					continue;
				}
				if (node.classList.contains('volt-agent-editor') || node.classList.contains('volt-agent-thread') || node.classList.contains('volt-agent-turn') || node.querySelector('.volt-agent-editor, .volt-agent-thread, .volt-agent-turn')) {
					this.schedulePlace();
					return;
				}
			}
		}
	}

	private schedulePlace(): void {
		if (this.placeScheduled) {
			return;
		}
		this.placeScheduled = true;
		// Before the next paint. A frame delay is the startup layout shift.
		queueMicrotask(() => {
			this.placeScheduled = false;
			this.placeQuickOpen(this.layoutService.mainContainer);
		});
	}

	private placeQuickOpen(root: HTMLElement): void {
		this.mountRightToggle();
		const editor = this.layoutService.getContainer(mainWindow, Parts.EDITOR_PART);
		const host = agentQuickOpenActionsHost(isHTMLElement(editor) ? editor : undefined, root);
		mountAgentQuickOpenActions(host, this.quickOpen);
		this.observeChatColumn();
		// Floating or beside the transcript changes whether a narrow column collapses them.
		this.syncDockToWindow();
		this.syncQuickOpenHost();
	}

	/**
	 * Puts the actions' state on the chat holding them (`has-quick-open`, `quick-open-expanded`,
	 * `-collapsed`, `-user-hidden`) and on the title bar toggle (`available` while a chat holds them).
	 * These stand in for `.volt-agent-editor:has(.volt-agent-quick-open-actions…)` rules: a :has() on
	 * the chat or the workbench restyles all of it whenever a list or the transcript adds a node.
	 */
	private syncQuickOpenHost(): void {
		const editor = this.quickOpen.closest<HTMLElement>('.volt-agent-editor') ?? undefined;
		if (editor !== this.quickOpenEditor) {
			this.quickOpenEditor?.classList.remove('has-quick-open', 'quick-open-expanded', 'quick-open-collapsed', 'quick-open-user-hidden');
			this.quickOpenEditorWatch.disconnect();
			this.quickOpenEditor = editor;
			// Follow-up and has-turns come and go with the chat's first message.
			if (editor) {
				this.quickOpenEditorWatch.observe(editor, { attributes: true, attributeFilter: ['class', 'data-session-id'] });
			}
		}
		if (editor) {
			// toggle(…, true), not add(): add() rewrites the attribute even when the class is there, which
			// would wake the class watch above again, forever.
			editor.classList.toggle('has-quick-open', true);
			// Over the transcript the card takes no column: the chat keeps the rail's reserve.
			editor.classList.toggle('quick-open-expanded', this.quickOpen.classList.contains('expanded') && !this.overlay);
			editor.classList.toggle('quick-open-collapsed', this.quickOpen.classList.contains('collapsed') || this.overlay);
			editor.classList.toggle('quick-open-user-hidden', this.quickOpen.classList.contains('user-hidden'));
		}
		this.quickOpenToggle.classList.toggle('available', !!editor);
		this.syncLineage();
	}

	private mountRightToggle(): void {
		const right = this.layoutService.mainContainer.querySelector('.part.titlebar > .titlebar-container > .titlebar-right');
		if (isHTMLElement(right) && this.titlebarToggles.parentElement !== right) {
			right.prepend(this.titlebarToggles);
		}
	}

	/** Narrow window, a chat column squeezed by a dragged split, or tools open beside the chat (they shrink it to its rail). */
	private isWindowNarrow(): boolean {
		// A new chat's actions float over empty space beside the centered composer, so they stay expanded.
		if (this.quickOpen.parentElement?.classList.contains('volt-agent-editor-main')) {
			return false;
		}
		if (this.hasSurfaces()) {
			return true;
		}
		return quickOpenNarrowForSpace(
			this.layoutService.mainContainerDimension?.width ?? 0,
			this.observedChat?.clientWidth ?? 0,
		);
	}

	private observeChatColumn(): void {
		const chat = this.quickOpen.closest('.volt-agent-editor-main');
		const next = isHTMLElement(chat) ? chat : undefined;
		if (next === this.observedChat) {
			return;
		}
		if (this.observedChat) {
			this.chatResize.unobserve(this.observedChat);
		}
		this.observedChat = next;
		if (next) {
			this.chatResize.observe(next);
		}
		this.syncDockToWindow();
	}

	private syncDockToWindow(): void {
		const narrow = this.isWindowNarrow();
		if (narrow !== this.windowNarrow) {
			this.windowNarrow = narrow;
			this.narrowOverride = undefined;
			if (!narrow) {
				this.setPopupOpen(false);
			}
			this.syncQuickOpenVisibility();
		}
		const popup = this.usesPopup();
		if (popup !== this.popupMode) {
			this.popupMode = popup;
			if (!popup) {
				this.setPopupOpen(false);
			}
			this.syncQuickOpenVisibility();
		}
		const collapsed = typeof this.narrowOverride === 'boolean'
			? this.narrowOverride
			: narrow || isAgentRightDockCollapsed(this.storageService);
		if (this.dockApplied && collapsed === this.collapsed && (!collapsed && narrow && !popup) === this.overlay) {
			return;
		}
		this.dockApplied = true;
		this.applyDock(collapsed);
	}

	private toggleDock(): void {
		const collapsed = !this.collapsed;
		if (this.windowNarrow) {
			this.narrowOverride = collapsed;
			this.applyDock(collapsed);
			return;
		}
		this.narrowOverride = undefined;
		this.storageService.store(AGENT_RIGHT_DOCK_COLLAPSED_KEY, collapsed, StorageScope.PROFILE, StorageTarget.USER);
		this.applyDock(collapsed);
	}

	/** Tools (the right panel or the files sidebar) are open beside the chat: the toolbar shrinks to its rail. */
	private hasSurfaces(): boolean {
		return !!this.quickOpenEditor?.classList.contains('has-surfaces');
	}

	/**
	 * The title bar button opens the toolbar as a popup only when the chat column has no room even for the rail.
	 * Tools open beside the chat always leave the rail: they shrink the toolbar, never hide it.
	 */
	private usesPopup(): boolean {
		if (this.hasSurfaces()) {
			return false;
		}
		const chatWidth = this.observedChat?.clientWidth ?? 0;
		return chatWidth > 0 && chatWidth <= QUICK_OPEN_POPUP_CHAT_WIDTH;
	}

	private get popupOpen(): boolean {
		return !this.popup.classList.contains('hidden');
	}

	/** Opens the toolbar under its title bar button, as a menu: the chat has no room for it beside the transcript. */
	private setPopupOpen(open: boolean): void {
		if (open === this.popupOpen) {
			return;
		}
		this.popupListeners.clear();
		this.quickOpenToggle.setAttribute('aria-expanded', String(open));
		this.quickOpenToggle.classList.toggle('popup-open', open);
		if (!open) {
			this.popup.classList.add('hidden');
			this.quickOpen.appendChild(this.body);
			return;
		}
		const container = this.layoutService.mainContainer;
		container.appendChild(this.popup);
		this.popup.appendChild(this.body);
		const anchor = this.quickOpenToggle.getBoundingClientRect();
		const bounds = container.getBoundingClientRect();
		this.popup.style.top = `${anchor.bottom - bounds.top + 6}px`;
		this.popup.style.right = `${Math.max(8, bounds.right - anchor.right)}px`;
		this.popup.classList.remove('hidden');
		const doc = container.ownerDocument;
		this.popupListeners.add(addDisposableListener(doc, 'mousedown', e => {
			const target = e.target as Node | null;
			if (target && !this.popup.contains(target) && !this.quickOpenToggle.contains(target)) {
				this.setPopupOpen(false);
			}
		}, true));
		this.popupListeners.add(addDisposableListener(doc, 'keydown', e => {
			if (e.key === 'Escape') {
				this.setPopupOpen(false);
				this.quickOpenToggle.focus();
			}
		}, true));
		this.popupListeners.add(this.layoutService.onDidLayoutMainContainer(() => this.setPopupOpen(false)));
	}

	private applyDock(collapsed: boolean): void {
		this.collapsed = collapsed;
		// The title bar popup has the rows while the chat is too narrow even for the rail.
		this.overlay = !collapsed && this.windowNarrow && !this.popupMode;
		this.quickOpen.classList.toggle('collapsed', collapsed);
		this.quickOpen.classList.toggle('expanded', !collapsed);
		this.quickOpen.classList.toggle('overlay', this.overlay);
		this.syncOverlay();
		this.syncQuickOpenHost();
		const label = collapsed
			? localize('voltAgent.dock.expand', "Expand")
			: localize('voltAgent.dock.collapse', "Collapse");
		this.chevronLabel.textContent = label;
		this.chevron.setAttribute('aria-label', label);
		this.chevron.setAttribute('aria-expanded', String(!collapsed));
	}

	/**
	 * The expanded toolbar where the chat has no room for its column: it opens over the transcript
	 * instead of pushing it, and closes like a popover (a click outside, Escape, or a row's action).
	 */
	private syncOverlay(): void {
		this.overlayListeners.clear();
		if (!this.overlay) {
			this.body.style.removeProperty('width');
			this.body.style.removeProperty('max-height');
			return;
		}
		this.layoutOverlay();
		const close = () => {
			if (this.overlay) {
				this.narrowOverride = true;
				this.applyDock(true);
			}
		};
		const doc = this.quickOpen.ownerDocument;
		this.overlayListeners.add(addDisposableListener(doc, 'mousedown', e => {
			const target = e.target as Node | null;
			// Menus a row opened (the branch list) live outside the card.
			if (target && !this.quickOpen.contains(target) && !(isHTMLElement(target) && target.closest('.context-view, .monaco-menu-container, .volt-menu'))) {
				close();
			}
		}, true));
		this.overlayListeners.add(addDisposableListener(doc, 'keydown', e => {
			if (e.key === 'Escape') {
				close();
			}
		}, true));
		// A row ran its action; group headers only fold their rows, so the card stays.
		this.overlayListeners.add(addDisposableListener(this.body, 'click', e => {
			const target = e.target as HTMLElement | null;
			if (target?.closest('button, [role="button"]') && !target.closest('.volt-agent-lineage-divider, .volt-agent-dock-group-head')) {
				close();
			}
		}));
	}

	/** The card fits the transcript it covers. */
	private layoutOverlay(): void {
		const scroller = this.quickOpen.parentElement;
		if (!this.overlay || !scroller) {
			return;
		}
		this.body.style.width = `${Math.max(160, Math.min(228, scroller.clientWidth - 24))}px`;
		this.body.style.maxHeight = `${Math.max(120, scroller.clientHeight - 24)}px`;
	}

	private syncRightToggle(): void {
		const open = !!this.layoutService.mainContainer.querySelector('.volt-agent-tools-area:not(.hidden):not(.floating)');
		// Hidden while the panel is open (agentViewSidebars.css).
		this.rightToggle.classList.toggle('tools-open', open);
		this.filesToggle.classList.toggle('tools-open', open);
		const label = localize('voltAgent.tools.openPanel', "Open Right Panel");
		this.rightToggle.setAttribute('aria-label', label);
		this.rightToggle.setAttribute('aria-expanded', String(open));
		setAgentTooltip(this.rightToggle, label);
		this.rightToggle.replaceChildren(createPrimarySidebarToggleIcon(this.rightToggle, open ? 'open' : 'closed'));
	}

	private get quickOpenHidden(): boolean {
		return this.storageService.getBoolean(QUICK_OPEN_HIDDEN_KEY, StorageScope.PROFILE, false);
	}

	/** Hidden takes the whole list away, rail included; collapsed only narrows it. */
	private syncQuickOpenVisibility(): void {
		// No room beside the chat: the toolbar leaves the column and opens from the title bar button.
		const popup = this.usesPopup();
		const hidden = this.quickOpenHidden || popup;
		this.quickOpen.classList.toggle('user-hidden', hidden);
		this.syncQuickOpenHost();
		const label = popup
			? localize('voltAgent.chatSideToolbar.open', "Chat Side Toolbar")
			: hidden
				? localize('voltAgent.chatSideToolbar.show', "Show Chat Side Toolbar")
				: localize('voltAgent.chatSideToolbar.hide', "Hide Chat Side Toolbar");
		this.quickOpenToggle.setAttribute('aria-label', label);
		if (popup) {
			this.quickOpenToggle.removeAttribute('aria-pressed');
			this.quickOpenToggle.setAttribute('aria-haspopup', 'true');
			this.quickOpenToggle.setAttribute('aria-expanded', String(this.popupOpen));
		} else {
			this.quickOpenToggle.setAttribute('aria-pressed', String(!hidden));
			this.quickOpenToggle.removeAttribute('aria-haspopup');
			this.quickOpenToggle.removeAttribute('aria-expanded');
		}
		setAgentTooltip(this.quickOpenToggle, label);
	}

	/** The right panel's glyph turned a quarter, so its bar sits at the bottom. */
	private syncPanelToggle(): void {
		const open = this.layoutService.isVisible(Parts.PANEL_PART);
		const label = open
			? localize('voltAgent.panel.close', "Close Bottom Panel")
			: localize('voltAgent.panel.open', "Open Bottom Panel");
		this.panelToggle.setAttribute('aria-label', label);
		this.panelToggle.setAttribute('aria-expanded', String(open));
		setAgentTooltip(this.panelToggle, label);
		this.panelToggle.replaceChildren(createPrimarySidebarToggleIcon(this.panelToggle, open ? 'open' : 'closed'));
	}

	private updateWorkspaceHeading(): void {
		const name = this.workspaceContextService.getWorkspace().folders[0]?.name
			?? localize('voltAgent.dock.workspaceFallback', "this window");
		this.workspaceLabel.textContent = localize('voltAgent.dock.onWorkspace', "On {0}", name);
	}

	private renderTabs(): void {
		const tabs = this.collectOpenTabs();
		const keys = tabs.map(editor => dockTabKey(editor)).join('\n');
		// A class, not display: the divider rule skips hidden sections (agentSubagents.css).
		this.tabsSection.classList.toggle('hidden', !tabs.length);
		this.tabsGroup.setCount(tabs.length);
		// Focusing a row fires an editor event. Rebuilding here removes the button before mouseup, so the click never lands.
		if (keys === this.tabKeys && this.tabList.childElementCount === tabs.length) {
			const rows = this.tabList.querySelectorAll('.volt-agent-dock-row');
			for (let index = 0; index < tabs.length; index++) {
				const label = rows[index]?.querySelector('.volt-agent-dock-row-label');
				const name = tabs[index].getName();
				if (label && label.textContent !== name) {
					label.textContent = name;
				}
			}
			return;
		}
		this.tabKeys = keys;
		this.tabListeners.clear();
		this.tabList.replaceChildren();
		for (const editor of tabs) {
			const row = append(this.tabList, $('button.volt-agent-dock-row')) as HTMLButtonElement;
			row.type = 'button';
			if (editor instanceof AgentChangesEditorInput) {
				// allow-any-unicode-next-line
				// Same ± as the Changes row under "Pull requests".
				const icon = createStrokeIcon(row, CHANGES_ICON_PATH, '0.5');
				icon.classList.add('volt-agent-stroke-icon');
				row.appendChild(icon);
			} else {
				row.appendChild(renderIcon(this.iconFor(editor)));
			}
			append(row, $('span.volt-agent-dock-row-label')).textContent = editor.getName();
			// A span, not a button: a button cannot sit inside the row's button. Shown on hover (agentViewSidebars.css).
			const close = append(row, $('span.volt-agent-dock-tab-close'));
			close.setAttribute('role', 'button');
			close.setAttribute('aria-label', localize('voltAgent.dock.closeTab', "Close {0}", editor.getName()));
			close.appendChild(renderIcon(Codicon.close));
			this.tabListeners.add(editor.onDidChangeLabel(() => this.renderTabs()));
			// Stops the row's pointerdown, which would open the tab first.
			this.tabListeners.add(addDisposableListener(close, 'pointerdown', event => {
				event.stopPropagation();
				event.preventDefault();
			}));
			this.tabListeners.add(addDisposableListener(close, 'click', event => {
				event.stopPropagation();
				event.preventDefault();
				this.closeTab(editor);
			}));
			// Middle click closes, like an editor tab.
			this.tabListeners.add(addDisposableListener(row, 'auxclick', event => {
				if (event.button === 1) {
					event.preventDefault();
					this.closeTab(editor);
				}
			}));
			// pointerdown runs before the row can be replaced. A mouse click is ignored so it does not open twice.
			this.tabListeners.add(addDisposableListener(row, 'pointerdown', event => {
				if (event.button !== 0) {
					return;
				}
				revealAgentToolEditor(editor);
			}));
			this.tabListeners.add(addDisposableListener(row, 'click', event => {
				if (event.detail !== 0) {
					return;
				}
				revealAgentToolEditor(editor);
			}));
		}
	}

	/** The canvases this chat made, newest first: a row opens one beside the chat. */
	private renderDesigns(): void {
		const sessionId = this.designSession;
		const canvases = this.canvases;
		if (!sessionId || !canvases) {
			this.designsSection.classList.add('hidden');
			return;
		}
		void canvases.listFor(sessionId).then(docs => {
			if (sessionId !== this.designSession) {
				return;
			}
			const keys = docs.map(doc => `${doc.id}\u0001${doc.title}`).join('\n');
			this.designsSection.classList.toggle('hidden', !docs.length);
			this.designsGroup.setCount(docs.length);
			if (keys === this.designKeys) {
				return;
			}
			this.designKeys = keys;
			this.designListeners.clear();
			this.designList.replaceChildren();
			for (const doc of docs) {
				const row = append(this.designList, $('button.volt-agent-dock-row')) as HTMLButtonElement;
				row.type = 'button';
				row.appendChild(renderIcon(Codicon.symbolColor));
				append(row, $('span.volt-agent-dock-row-label')).textContent = doc.title;
				setAgentTooltip(row, localize('voltAgent.dock.openDesign', "Open {0} beside the chat", doc.title));
				this.designListeners.add(addDisposableListener(row, 'click', () => {
					void this.commandService.executeCommand(OPEN_CANVAS_COMMAND_ID, doc.id);
				}));
			}
		});
	}

	/** Shows the way back to the chat's Scratch board while it has one (and the board is still there). */
	private syncScratch(): void {
		const sessionId = this.designSession;
		const boardId = sessionId ? this.scratchLinks?.boardFor(sessionId) : undefined;
		const board = boardId ? this.scratchBoards?.getBoard(boardId) : undefined;
		this.scratchBoardId = board?.id;
		this.scratchSection.classList.toggle('hidden', !board);
		if (!board) {
			return;
		}
		const title = boardDisplayTitle(board);
		this.scratchGroup.setCount(1);
		this.scratchRowLabel.textContent = title;
		setAgentTooltip(this.scratchRow, localize('voltAgent.dock.openScratch', "Open {0} beside the chat", title));
	}

	/** Opens the board beside the chat (like a design), on this chat's drawing. */
	private openScratch(): void {
		const boardId = this.scratchBoardId;
		const sessionId = this.designSession;
		if (boardId && sessionId) {
			void this.commandService.executeCommand(OPEN_SCRATCH_BOARD_BESIDE_COMMAND_ID, sessionId, boardId);
		} else if (boardId) {
			void this.commandService.executeCommand(OPEN_SCRATCH_BOARD_COMMAND_ID, boardId);
		}
	}

	/** Close the tab in whichever group shows it: a chat's tools area, else the main editor part. */
	private closeTab(editor: EditorInput): void {
		if (closeAgentToolEditor(editor)) {
			return;
		}
		const group = this.editorGroupsService.mainPart.groups.find(candidate => candidate.contains(editor));
		void group?.closeEditor(editor);
	}

	/** The lineage follows the chat in the main panel. */
	private syncLineage(): void {
		// Agent chats live in their own editor part: the chat the dock sits in says which one it is.
		const host = this.quickOpen.closest<HTMLElement>('.volt-agent-editor')?.dataset.sessionId;
		const active = this.editorService.activeEditor;
		const sessionId = host ?? (active instanceof AgentEditorInput ? active.sessionId : undefined);
		this.lineage.setSession(sessionId);
		this.pullRequestControl.setSession(sessionId);
		if (sessionId !== this.designSession) {
			this.designSession = sessionId;
			this.renderDesigns();
		}
		this.syncScratch();
		if (sessionId !== this.changesSessionId) {
			this.changesSessionId = sessionId;
			this.renderChangesStats();
		}
		if (sessionId !== this.branchSessionId) {
			this.branchSessionId = sessionId;
			this.watchBranch();
		}
	}

	/** Only the right pane's tabs. Main panel pages (Customize, Scheduled Tasks, other chats) are reached from the sidebar. */
	private collectOpenTabs(): EditorInput[] {
		return shownAgentToolEditors();
	}

	private iconFor(editor: EditorInput): ThemeIcon {
		if (editor instanceof VoltBrowserEditorInput) {
			return Codicon.globe;
		}
		if (editor.typeId === 'workbench.input.voltAgentPullRequest') {
			return Codicon.gitPullRequest;
		}
		if (editor.typeId === 'workbench.input.voltCanvas') {
			return Codicon.symbolColor;
		}
		return Codicon.file;
	}
}

registerWorkbenchContribution2(AgentViewSidebarsContribution.ID, AgentViewSidebarsContribution, WorkbenchPhase.BlockRestore);
