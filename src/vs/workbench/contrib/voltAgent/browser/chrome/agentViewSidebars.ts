/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import '../media/agentViewSidebars.css';
import { $, addDisposableListener, append, isHTMLElement } from '../../../../../base/browser/dom.js';
import { mainWindow } from '../../../../../base/browser/window.js';
import { renderIcon } from '../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { Disposable, DisposableStore, MutableDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { disposableTimeout } from '../../../../../base/common/async.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { localize } from '../../../../../nls.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
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
import { OPEN_BROWSER_COMMAND_ID, VoltBrowserEditorInput } from '../preview/browserEditorInput.js';
import { AgentChangesEditorInput, OPEN_AGENT_CHANGES_COMMAND_ID } from '../review/agentChangesEditor.js';
import { createPrimarySidebarToggleIcon } from '../../../../browser/parts/titlebar/sidebarToggleIcon.js';
import { SHOW_PULL_REQUESTS_COMMAND_ID } from '../pullRequests/agentPullRequestCommands.js';
import { AgentGitActionsControl } from '../pullRequests/agentGitActionsControl.js';
import { AgentPullRequestDockControl } from '../pullRequests/agentPullRequestDockControl.js';
import { IAgentPullRequestService } from '../pullRequests/agentPullRequestService.js';
import { setAgentTooltip } from './agentTooltip.js';
import { closeAgentToolEditor, onDidChangeAgentToolEditors, openAgentToolsPanel, revealAgentToolEditor, SHOW_AGENT_FILES_COMMAND_ID, shownAgentToolEditors } from '../workspace/agentSurfaceHost.js';
import { CHANGES_ICON_PATH, createSurfaceStrokeIcon, FILES_ICON_SHAPES, type SvgIconShapes } from '../workspace/agentSurfaceMenu.js';
import { AGENT_TOOLS_VISIBILITY_EVENT } from '../../../../browser/parts/titlebar/layoutModeStartup.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { AgentLineageDock } from './agentLineageDock.js';
import { IAgentSessionChangesService } from '../review/agentSessionChangesService.js';
import { autorun } from '../../../../../base/common/observable.js';
import { ISCMRepository, ISCMService } from '../../../scm/common/scm.js';
import { isEqual } from '../../../../../base/common/resources.js';

/** Chevrons point right. Collapsed state rotates this 180deg. */
const CHEVRON_RIGHT_PATH = 'M6 7L11 12L6 17M13 7L18 12L13 17';
/** A bar over three lines: the Quick Open Actions list. Drawn at 16px, so a 1.5 stroke is 1px. */
const QUICK_OPEN_ICON_PATH = 'M3.75 12H20.25M3.75 15.75H20.25M3.75 19.5H20.25M5.625 4.5H18.375C19.4105 4.5 20.25 5.33947 20.25 6.375C20.25 7.41053 19.4105 8.25 18.375 8.25H5.625C4.58947 8.25 3.75 7.41053 3.75 6.375C3.75 5.33947 4.58947 4.5 5.625 4.5Z';
/** The user hid Quick Open Actions with the title bar button. */
const QUICK_OPEN_HIDDEN_KEY = 'volt.agent.quickOpenActions.hidden';
const TOGGLE_TERMINAL_COMMAND_ID = 'workbench.action.terminal.toggleTerminal';
/** An arrow out to the top right, after the "IDE" label. */
const ARROW_UP_RIGHT_PATH = 'M7 7h10v10M7 17 17 7';
/** Expanded Quick Open Actions are 228px. Below this window width they collapse. */
export const QUICK_OPEN_NARROW_WINDOW_WIDTH = 1100;

/** Below this chat column width the actions leave too little room for the conversation. */
export const QUICK_OPEN_NARROW_CHAT_WIDTH = 900;

/** Open Tabs lists every editor in these groups except the agent chat, without repeating the same tab. */
export function dockOpenTabs(groups: readonly { readonly editors: readonly EditorInput[] }[], isChat: (editor: EditorInput) => boolean): EditorInput[] {
	const tabs: EditorInput[] = [];
	const seen = new Set<EditorInput>();
	for (const group of groups) {
		for (const editor of group.editors) {
			if (isChat(editor) || seen.has(editor)) {
				continue;
			}
			seen.add(editor);
			tabs.push(editor);
		}
	}
	return tabs;
}

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
	private readonly chevron: HTMLButtonElement;
	private readonly chevronLabel: HTMLElement;
	private readonly tabsSection: HTMLElement;
	private readonly tabList: HTMLElement;
	/** "On <project>" over Files, Terminal and Browser. */
	private readonly workspaceHeading: HTMLElement;
	/** The checked-out branch, first row of the git group. */
	private readonly branchLabel: HTMLElement;
	private readonly branchRow: HTMLElement;
	private readonly branchWatch = this._register(new DisposableStore());
	/** The project's repository: the one at the window's folder, not an agent worktree. */
	private branchRepository: ISCMRepository | undefined;
	private readonly statsTimer = this._register(new MutableDisposable());
	private statsGen = 0;
	private readonly changesAdd: HTMLElement;
	private readonly changesDel: HTMLElement;
	/** Commit, Push & PR (T3 Code's git actions), in place of a plain Commit & push row. */
	private readonly gitControl: AgentGitActionsControl;
	/** The chat's pull request with its checks and Merge (Cursor's row), or "Pull requests": the title opens the right sidebar's list. */
	private readonly pullRequestControl: AgentPullRequestDockControl;
	private readonly pullRequests: IAgentPullRequestService | undefined;
	/** The chat whose changes the Changes row counts. */
	private changesSessionId: string | undefined;
	/** The agents of the chat on screen: running, previous, and its parent in a subagent's chat. */
	private readonly lineage: AgentLineageDock;
	private readonly tabListeners = this._register(new DisposableStore());
	/** Editors currently painted in Open Tabs. Unchanged focus events must not rebuild those rows. */
	private tabKeys = '';
	private editorObserver: MutationObserver | undefined;
	/** Watches the chat column the actions sit in; opening tools beside the chat narrows it. */
	private readonly chatResize: ResizeObserver;
	private observedChat: HTMLElement | undefined;
	private windowNarrow = false;
	/** The user's choice while the space is narrow. Cleared whenever narrow flips. */
	private narrowOverride: boolean | undefined;
	private placeScheduled = false;
	private dockApplied = false;
	private collapsed = false;
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
			this.storageService.store(QUICK_OPEN_HIDDEN_KEY, !this.quickOpenHidden, StorageScope.PROFILE, StorageTarget.USER);
			this.syncQuickOpenVisibility();
		}));

		this.panelToggle = append(this.titlebarToggles, $('button.volt-agent-titlebar-toggle.volt-agent-bottom-panel-toggle.volt-titlebar-control')) as HTMLButtonElement;
		this.panelToggle.type = 'button';
		this._register(addDisposableListener(this.panelToggle, 'click', () => {
			void this.commandService.executeCommand(TOGGLE_TERMINAL_COMMAND_ID);
		}));
		this._register(layoutService.onDidChangePartVisibility(() => this.syncPanelToggle()));
		this.syncPanelToggle();

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
		const body = append(this.quickOpen, $('.volt-agent-quick-open-body'));
		this.tabsSection = append(body, $('.volt-agent-dock-section.volt-agent-dock-tabs.hidden'));
		const tabsHeading = append(this.tabsSection, $('.volt-agent-dock-heading'));
		tabsHeading.textContent = localize('voltAgent.dock.openTabs', "Open Tabs");
		this.tabList = append(this.tabsSection, $('.volt-agent-dock-tab-list'));

		// Sections like Cursor's project menu: the project's tools, then git, then the agents.
		const [changes, browser, terminal, files] = this.dockActions();
		const workspaceSection = append(body, $('.volt-agent-dock-section.volt-agent-dock-workspace'));
		this.workspaceHeading = append(workspaceSection, $('.volt-agent-dock-heading'));
		const workspace = append(workspaceSection, $('.volt-agent-dock-actions'));
		this.createActionRow(workspace, files);
		this.createActionRow(workspace, terminal);
		this.createActionRow(workspace, browser);

		const git = append(append(body, $('.volt-agent-dock-section.volt-agent-dock-git')), $('.volt-agent-dock-actions'));
		// The project's repository goes along, or git first asks which repository (agent worktrees are repositories too).
		this.branchLabel = this.createActionRow(git, { id: 'branch', label: '', icon: Codicon.gitBranch, command: 'git.checkout', args: () => this.branchRepository?.provider.rootUri ? [this.branchRepository.provider.rootUri] : [] });
		this.branchRow = this.branchLabel.parentElement!;
		this.pullRequests = instantiationService.invokeFunction(accessor => accessor.getIfExists(IAgentPullRequestService));
		// The chat's pull request: its title opens the Pull Requests tab of the right sidebar, its list first.
		this.pullRequestControl = this._register(instantiationService.createInstance(AgentPullRequestDockControl, git, this.pullRequests, {
			openCommandId: SHOW_PULL_REQUESTS_COMMAND_ID,
			emptyLabel: localize('voltAgent.dock.pullRequests', "Pull requests"),
		}));
		// Commit, Push & PR runs the next step; its menu has each step and Source Control.
		this.gitControl = this._register(instantiationService.createInstance(AgentGitActionsControl, git, { look: 'dock', target: () => this.gitTarget() }));
		const changesLabel = this.createActionRow(git, changes);
		this.changesAdd = append(changesLabel.parentElement!, $('span.volt-agent-dock-stat.add'));
		this.changesDel = append(changesLabel.parentElement!, $('span.volt-agent-dock-stat.del'));
		this._register(scmService.onDidAddRepository(() => this.watchBranch()));
		this._register(scmService.onDidRemoveRepository(() => this.watchBranch()));
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
		body.appendChild(this.lineage.element);

		this.chatResize = new ResizeObserver(() => this.syncDockToWindow());
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
			{ id: 'files', label: localize('voltAgent.dock.files', "Files"), iconPath: FILES_ICON_SHAPES, command: SHOW_AGENT_FILES_COMMAND_ID },
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
		this._register(addDisposableListener(row, 'click', () => {
			void this.commandService.executeCommand(action.command, ...(action.args?.() ?? []));
		}));
		return label;
	}

	/** The project repository's branch; the row hides without a repository. */
	private watchBranch(): void {
		this.branchWatch.clear();
		const repositories = [...this.scmService.repositories];
		const folder = this.workspaceContextService.getWorkspace().folders[0]?.uri;
		const repository = repositories.find(candidate => !!folder && !!candidate.provider.rootUri && isEqual(candidate.provider.rootUri, folder)) ?? repositories[0];
		this.branchRepository = repository;
		// The diff counts follow the working tree.
		if (repository) {
			this.branchWatch.add(repository.provider.onDidChangeResources(() => this.renderChangesStats()));
		}
		this.renderChangesStats();
		this.branchWatch.add(autorun(reader => {
			const name = repository?.provider.historyProvider.read(reader)?.historyItemRef.read(reader)?.name;
			this.branchLabel.textContent = name ?? '';
			this.branchRow.style.display = name ? '' : 'none';
		}));
	}

	/**
	 * "+12 −3" on the Changes row: the working tree's diff, as Cursor shows it, or the chat's own
	 * changes when git has no answer. Debounced; SCM fires a burst per save.
	 */
	private renderChangesStats(): void {
		this.statsTimer.value = disposableTimeout(() => {
			void this.refreshChangesStats();
			void this.gitControl.refresh();
		}, 300);
	}

	/** The chat on screen and the folder its agent works in (its worktree), else the window's folder. */
	private gitTarget(): { sessionId?: string; folder?: string } {
		const sessionId = this.changesSessionId;
		const folder = (sessionId ? this.pullRequests?.folderFor(sessionId) : undefined)
			?? this.branchRepository?.provider.rootUri?.fsPath
			?? this.workspaceContextService.getWorkspace().folders[0]?.uri.fsPath;
		return { ...(sessionId ? { sessionId } : {}), ...(folder ? { folder } : {}) };
	}

	private async refreshChangesStats(): Promise<void> {
		const gen = ++this.statsGen;
		let additions = 0;
		let deletions = 0;
		const stat = await this.commandService.executeCommand<{ insertions: number; deletions: number }>('git.api.getWorkingTreeShortStat').catch(() => undefined);
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
			editor.classList.toggle('quick-open-expanded', this.quickOpen.classList.contains('expanded'));
			editor.classList.toggle('quick-open-collapsed', this.quickOpen.classList.contains('collapsed'));
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

	/** Narrow window, or a chat column squeezed by the tools panel or a dragged split. */
	private isWindowNarrow(): boolean {
		// A new chat's actions float over empty space beside the centered composer, so they stay expanded.
		if (this.quickOpen.parentElement?.classList.contains('volt-agent-editor-main')) {
			return false;
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
		}
		const collapsed = typeof this.narrowOverride === 'boolean'
			? this.narrowOverride
			: narrow || isAgentRightDockCollapsed(this.storageService);
		if (this.dockApplied && collapsed === this.collapsed) {
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

	private applyDock(collapsed: boolean): void {
		this.collapsed = collapsed;
		this.quickOpen.classList.toggle('collapsed', collapsed);
		this.quickOpen.classList.toggle('expanded', !collapsed);
		this.syncQuickOpenHost();
		const label = collapsed
			? localize('voltAgent.dock.expand', "Expand")
			: localize('voltAgent.dock.collapse', "Collapse");
		this.chevronLabel.textContent = label;
		this.chevron.setAttribute('aria-label', label);
		this.chevron.setAttribute('aria-expanded', String(!collapsed));
	}

	private syncRightToggle(): void {
		const open = !!this.layoutService.mainContainer.querySelector('.volt-agent-tools-area:not(.hidden):not(.floating)');
		// Hidden while the panel is open (agentViewSidebars.css).
		this.rightToggle.classList.toggle('tools-open', open);
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
		const hidden = this.quickOpenHidden;
		this.quickOpen.classList.toggle('user-hidden', hidden);
		this.syncQuickOpenHost();
		const label = hidden
			? localize('voltAgent.chatSideToolbar.show', "Show Chat Side Toolbar")
			: localize('voltAgent.chatSideToolbar.hide', "Hide Chat Side Toolbar");
		this.quickOpenToggle.setAttribute('aria-label', label);
		this.quickOpenToggle.setAttribute('aria-pressed', String(!hidden));
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
		this.workspaceHeading.textContent = localize('voltAgent.dock.onWorkspace', "On {0}", name);
	}

	private renderTabs(): void {
		const tabs = this.collectOpenTabs();
		const keys = tabs.map(editor => dockTabKey(editor)).join('\n');
		// A class, not display: the divider rule skips hidden sections (agentSubagents.css).
		this.tabsSection.classList.toggle('hidden', !tabs.length);
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
				// Same ± as the Changes row under "On this window".
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
		if (sessionId !== this.changesSessionId) {
			this.changesSessionId = sessionId;
			this.renderChangesStats();
		}
	}

	private collectOpenTabs(): EditorInput[] {
		return dockOpenTabs(
			[{ editors: shownAgentToolEditors() }, ...this.editorGroupsService.mainPart.groups],
			editor => editor instanceof AgentEditorInput,
		);
	}

	private iconFor(editor: EditorInput): ThemeIcon {
		if (editor instanceof VoltBrowserEditorInput) {
			return Codicon.globe;
		}
		if (editor.typeId === 'workbench.input.voltAgentPullRequest') {
			return Codicon.gitPullRequest;
		}
		return Codicon.file;
	}
}

registerWorkbenchContribution2(AgentViewSidebarsContribution.ID, AgentViewSidebarsContribution, WorkbenchPhase.BlockRestore);
