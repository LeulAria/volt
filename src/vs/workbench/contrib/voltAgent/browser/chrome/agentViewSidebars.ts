/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import '../media/agentViewSidebars.css';
import { $, addDisposableListener, append, isHTMLElement } from '../../../../../base/browser/dom.js';
import { mainWindow } from '../../../../../base/browser/window.js';
import { renderIcon } from '../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
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
	AGENT_LEFT_SIDEBAR_HIDDEN_KEY,
	AGENT_RIGHT_DOCK_COLLAPSED_KEY,
	AGENT_RIGHT_DOCK_COLLAPSED_WIDTH,
	AGENT_RIGHT_DOCK_EXPANDED_WIDTH,
	getLayoutMode,
	isAgentRightDockCollapsed,
} from '../../../../browser/parts/titlebar/layoutModeSwitch.js';
import { applyAgentStatusbarShift } from '../../../../browser/parts/titlebar/agentLayoutChrome.js';
import { AgentEditorInput } from '../editor/agentEditorInput.js';
import { OPEN_BROWSER_COMMAND_ID, VoltBrowserEditorInput } from '../preview/browserEditorInput.js';
import { AgentChangesEditorInput, OPEN_AGENT_CHANGES_COMMAND_ID } from '../review/agentChangesEditor.js';

/** Chevrons point right. Collapsed state rotates this 180deg. */
const CHEVRON_RIGHT_PATH = 'M6 7L11 12L6 17M13 7L18 12L13 17';
const CHANGES_ICON_PATH = 'M12 3v14m7-7H5m14 11H5';
/** Expanded Quick Open Actions are 228px. Below this window width they collapse. */
export const QUICK_OPEN_NARROW_WINDOW_WIDTH = 1100;

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
	readonly iconPath?: string;
	readonly command: string;
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

	private readonly rightButton: HTMLButtonElement;
	private readonly dock: HTMLElement;
	private readonly chevron: HTMLButtonElement;
	private readonly chevronLabel: HTMLElement;
	private readonly tabsSection: HTMLElement;
	private readonly tabList: HTMLElement;
	private readonly workspaceHeading: HTMLElement;
	private readonly tabListeners = this._register(new DisposableStore());
	private collapsed = false;

	constructor(
		@IWorkbenchLayoutService private readonly layoutService: IWorkbenchLayoutService,
		@IStorageService private readonly storageService: IStorageService,
		@ICommandService private readonly commandService: ICommandService,
		@IEditorService private readonly editorService: IEditorService,
		@IEditorGroupsService private readonly editorGroupsService: IEditorGroupsService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
	) {
		super();
		const root = layoutService.mainContainer;

		this.quickOpen = $('.volt-agent-quick-open-actions.expanded');
		this.quickOpen.setAttribute('aria-label', localize('voltAgent.quickOpenActions', "Quick Open Actions"));
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
		this.tabsSection = append(body, $('.volt-agent-dock-section.volt-agent-dock-tabs'));
		const tabsHeading = append(this.tabsSection, $('.volt-agent-dock-heading'));
		tabsHeading.textContent = localize('voltAgent.dock.openTabs', "Open Tabs");
		this.tabList = append(this.tabsSection, $('.volt-agent-dock-tab-list'));

		const workspace = append(body, $('.volt-agent-dock-section'));
		this.workspaceHeading = append(workspace, $('.volt-agent-dock-heading'));
		const actions = append(workspace, $('.volt-agent-dock-actions'));
		for (const action of this.dockActions()) {
			this.createActionRow(actions, action);
			this.createRailButton(rail, action);
		}

		this.placeQuickOpen(root);
		this.updateWorkspaceHeading();
		this.renderTabs();
		this.windowNarrow = this.isWindowNarrow();
		this.syncDockToWindow();

		this._register(addDisposableListener(this.chevron, 'click', () => this.toggleDock()));
		this._register(layoutService.onDidLayoutMainContainer(() => this.syncDockToWindow()));
		const syncDock = () => {
			this.schedulePlace();
			this.renderTabs();
		};
		this._register(editorService.onDidEditorsChange(syncDock));
		this._register(editorService.onDidActiveEditorChange(syncDock));
		this._register(editorService.onDidVisibleEditorsChange(syncDock));
		const editorPart = this.layoutService.getContainer(mainWindow, Parts.EDITOR_PART);
		const observeTarget = isHTMLElement(editorPart) ? editorPart : root;
		const observer = new MutationObserver(mutations => this.onEditorMutation(mutations));
		observer.observe(observeTarget, { childList: true, subtree: true });
		this._register(toDisposable(() => observer.disconnect()));
		this._register(workspaceContextService.onDidChangeWorkspaceFolders(() => this.updateWorkspaceHeading()));
		this._register(workspaceContextService.onDidChangeWorkspaceName(() => this.updateWorkspaceHeading()));
	}

	private dockActions(): IDockAction[] {
		return [
			{ id: 'changes', label: localize('voltAgent.dock.changes', "Changes"), iconPath: CHANGES_ICON_PATH, command: OPEN_AGENT_CHANGES_COMMAND_ID },
			{ id: 'browser', label: localize('voltAgent.dock.browser', "Browser"), icon: Codicon.globe, command: OPEN_BROWSER_COMMAND_ID },
			{ id: 'terminal', label: localize('voltAgent.dock.terminal', "Terminal"), icon: Codicon.terminal, command: 'workbench.action.terminal.toggleTerminal' },
			{ id: 'files', label: localize('voltAgent.dock.files', "Files"), icon: Codicon.file, command: 'workbench.action.quickOpen' },
		];
	}

	private appendActionIcon(parent: HTMLElement, action: IDockAction): void {
		if (action.iconPath) {
			const icon = createStrokeIcon(parent, action.iconPath, '0.5');
			icon.classList.add('volt-agent-stroke-icon');
			parent.appendChild(icon);
			return;
		}
		if (action.icon) {
			parent.appendChild(renderIcon(action.icon));
		}
	}

	private createActionRow(parent: HTMLElement, action: IDockAction): void {
		const row = append(parent, $('button.volt-agent-dock-row')) as HTMLButtonElement;
		row.type = 'button';
		this.appendActionIcon(row, action);
		append(row, $('span')).textContent = action.label;
		this._register(addDisposableListener(row, 'click', () => {
			void this.commandService.executeCommand(action.command);
		}));
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
		mainWindow.requestAnimationFrame(() => {
			this.placeScheduled = false;
			this.placeQuickOpen(this.layoutService.mainContainer);
		});
	}

	private placeQuickOpen(root: HTMLElement): void {
		const editor = this.layoutService.getContainer(mainWindow, Parts.EDITOR_PART);
		const host = agentQuickOpenActionsHost(isHTMLElement(editor) ? editor : undefined, root);
		mountAgentQuickOpenActions(host, this.quickOpen);
	}

	private mount(root: HTMLElement): void {
		const chrome = root.querySelector('.volt-agent-chrome');
		const controls = chrome?.querySelector('.volt-agent-chrome-controls');
		if (isHTMLElement(controls)) {
			prepend(controls, this.leftButton);
		} else if (isHTMLElement(chrome)) {
			chrome.appendChild(this.leftButton);
		} else {
			root.appendChild(this.leftButton);
		}

		this.placeQuickOpen(root);
	}

	private toggleLeft(): void {
		if (getLayoutMode(this.layoutService) !== 'agent') {
			return;
		}
		const hide = this.layoutService.isVisible(Parts.AUXILIARYBAR_PART);
		this.storageService.store(AGENT_LEFT_SIDEBAR_HIDDEN_KEY, hide, StorageScope.PROFILE, StorageTarget.USER);
		this.layoutService.setPartHidden(hide, Parts.AUXILIARYBAR_PART);
		const width = hide ? 0 : this.layoutService.getSize(Parts.AUXILIARYBAR_PART).width;
		applyAgentStatusbarShift(this.layoutService.mainContainer, width, this.layoutService.getSize(Parts.TITLEBAR_PART).height);
		this.syncLeftButton();
	}

	private syncLeftButton(): void {
		const open = this.layoutService.isVisible(Parts.AUXILIARYBAR_PART);
		const label = open
			? localize('voltAgent.dock.hideLeft', "Hide Sidebar")
			: localize('voltAgent.dock.showLeft', "Show Sidebar");
		this.leftButton.setAttribute('aria-label', label);
		this.leftButton.setAttribute('aria-pressed', String(open));
	}

	private isWindowNarrow(): boolean {
		const width = this.layoutService.mainContainerDimension?.width ?? 0;
		return width > 0 && width <= QUICK_OPEN_NARROW_WINDOW_WIDTH;
	}

	private syncDockToWindow(): void {
		const narrow = this.isWindowNarrow();
		if (narrow !== this.windowNarrow) {
			this.windowNarrow = narrow;
			this.narrowOverride = undefined;
		}
		const collapsed = quickOpenCollapsedForWidth(
			this.layoutService.mainContainerDimension?.width ?? 0,
			isAgentRightDockCollapsed(this.storageService),
			this.narrowOverride,
		);
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
		const label = collapsed
			? localize('voltAgent.dock.expand', "Expand")
			: localize('voltAgent.dock.collapse', "Collapse");
		this.chevronLabel.textContent = label;
		this.chevron.setAttribute('aria-label', label);
		this.chevron.setAttribute('aria-expanded', String(!collapsed));
	}

	private updateWorkspaceHeading(): void {
		const name = this.workspaceContextService.getWorkspace().folders[0]?.name
			?? localize('voltAgent.dock.workspaceFallback', "this window");
		this.workspaceHeading.textContent = localize('voltAgent.dock.onWorkspace', "On {0}", name);
	}

	private renderTabs(): void {
		this.tabListeners.clear();
		this.tabList.replaceChildren();
		const tabs = this.collectOpenTabs();
		this.tabsSection.style.display = tabs.length ? '' : 'none';
		for (const editor of tabs) {
			const row = append(this.tabList, $('button.volt-agent-dock-row')) as HTMLButtonElement;
			row.type = 'button';
			row.appendChild(renderIcon(this.iconFor(editor)));
			append(row, $('span')).textContent = editor.getName();
			this.tabListeners.add(addDisposableListener(row, 'click', () => {
				void this.editorService.openEditor(editor, { pinned: true, revealIfOpened: true });
			}));
		}
	}

	private collectOpenTabs(): EditorInput[] {
		const tabs: EditorInput[] = [];
		for (const group of this.editorGroupsService.mainPart.groups) {
			for (const editor of group.editors) {
				if (!(editor instanceof AgentEditorInput)) {
					tabs.push(editor);
				}
			}
		}
		return tabs;
	}

	private iconFor(editor: EditorInput): ThemeIcon {
		if (editor instanceof VoltBrowserEditorInput) {
			return Codicon.globe;
		}
		if (editor instanceof AgentChangesEditorInput) {
			return Codicon.diff;
		}
		return Codicon.file;
	}
}

registerWorkbenchContribution2(AgentViewSidebarsContribution.ID, AgentViewSidebarsContribution, WorkbenchPhase.AfterRestored);
