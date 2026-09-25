/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import '../media/agentViewSidebars.css';
import { $, addDisposableListener, append, isHTMLElement, prepend } from '../../../../../base/browser/dom.js';
import { mainWindow } from '../../../../../base/browser/window.js';
import { renderIcon } from '../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { Disposable, DisposableStore } from '../../../../../base/common/lifecycle.js';
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
import { AgentEditorInput } from '../editor/agentEditorInput.js';
import { OPEN_BROWSER_COMMAND_ID, VoltBrowserEditorInput } from '../preview/browserEditorInput.js';
import { AgentChangesEditorInput, OPEN_AGENT_CHANGES_COMMAND_ID } from '../review/agentChangesEditor.js';

const PANEL_ICON_PATH = 'M15 4.5v15m4.875 0H4.125A1.125 1.125 0 0 1 3 18.375V5.625C3 5.004 3.504 4.5 4.125 4.5h15.75c.621 0 1.125.504 1.125 1.125v12.75c0 .621-.504 1.125-1.125 1.125';
const CHEVRON_ICON_PATH = 'm5.36 19l5.763-5.763a1.74 1.74 0 0 0 0-2.474L5.36 5m7 14l5.763-5.763a1.74 1.74 0 0 0 0-2.474L12.36 5';

interface IDockAction {
	readonly id: string;
	readonly label: string;
	readonly icon: ThemeIcon;
	readonly command: string;
}

/** Put the dock on the open chat when it exists, otherwise keep it on the editor part. */
export function agentRightDockHost(editorPart: HTMLElement | undefined, fallback: HTMLElement): HTMLElement {
	const chat = editorPart?.querySelector('.volt-agent-editor');
	return isHTMLElement(chat) ? chat : editorPart ?? fallback;
}

function createStrokeIcon(owner: HTMLElement, pathD: string): SVGElement {
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
	path.setAttribute('stroke-width', '1.5');
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

	private readonly leftButton: HTMLButtonElement;
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
		this.leftButton = this.createToggle(root, 'left');
		this.rightButton = this.createToggle(root, 'right');
		this.rightButton.setAttribute('aria-label', localize('voltAgent.dock.right', "Right Sidebar"));

		this.dock = $('.volt-agent-right-dock.expanded');
		this.dock.appendChild(this.rightButton);
		const hover = append(this.dock, $('.volt-agent-right-dock-hover'));
		this.chevron = append(hover, $('button.volt-agent-dock-chevron')) as HTMLButtonElement;
		this.chevron.type = 'button';
		this.chevronLabel = append(this.chevron, $('span.volt-agent-dock-label'));
		this.chevron.appendChild(createStrokeIcon(this.chevron, CHEVRON_ICON_PATH));

		const rail = append(this.dock, $('.volt-agent-right-rail'));
		const body = append(this.dock, $('.volt-agent-right-dock-body'));
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

		this.mount(root);
		this.updateWorkspaceHeading();
		this.renderTabs();
		this.applyDock(isAgentRightDockCollapsed(storageService));
		this.syncLeftButton();

		this._register(addDisposableListener(this.leftButton, 'click', () => this.toggleLeft()));
		this._register(addDisposableListener(this.chevron, 'click', () => this.toggleDock()));
		this._register(layoutService.onDidChangePartVisibility(() => this.syncLeftButton()));
		const syncDock = () => {
			this.placeDock(this.layoutService.mainContainer);
			this.renderTabs();
			mainWindow.requestAnimationFrame(() => this.placeDock(this.layoutService.mainContainer));
		};
		this._register(editorService.onDidEditorsChange(syncDock));
		this._register(editorService.onDidActiveEditorChange(syncDock));
		this._register(editorService.onDidVisibleEditorsChange(syncDock));
		this._register(workspaceContextService.onDidChangeWorkspaceFolders(() => this.updateWorkspaceHeading()));
		this._register(workspaceContextService.onDidChangeWorkspaceName(() => this.updateWorkspaceHeading()));
	}

	private dockActions(): IDockAction[] {
		return [
			{ id: 'changes', label: localize('voltAgent.dock.changes', "Changes"), icon: Codicon.diff, command: OPEN_AGENT_CHANGES_COMMAND_ID },
			{ id: 'browser', label: localize('voltAgent.dock.browser', "Browser"), icon: Codicon.globe, command: OPEN_BROWSER_COMMAND_ID },
			{ id: 'terminal', label: localize('voltAgent.dock.terminal', "Terminal"), icon: Codicon.terminal, command: 'workbench.action.terminal.toggleTerminal' },
			{ id: 'files', label: localize('voltAgent.dock.files', "Files"), icon: Codicon.file, command: 'workbench.action.quickOpen' },
		];
	}

	private createToggle(owner: HTMLElement, side: 'left' | 'right'): HTMLButtonElement {
		const button = $('button.volt-agent-sidebar-toggle') as HTMLButtonElement;
		button.classList.add(side);
		button.type = 'button';
		button.appendChild(createStrokeIcon(owner, PANEL_ICON_PATH));
		return button;
	}

	private createActionRow(parent: HTMLElement, action: IDockAction): void {
		const row = append(parent, $('button.volt-agent-dock-row')) as HTMLButtonElement;
		row.type = 'button';
		row.appendChild(renderIcon(action.icon));
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
		button.appendChild(renderIcon(action.icon));
		this._register(addDisposableListener(button, 'click', () => {
			void this.commandService.executeCommand(action.command);
		}));
	}

	private placeDock(root: HTMLElement): void {
		const editor = this.layoutService.getContainer(mainWindow, Parts.EDITOR_PART);
		const host = agentRightDockHost(isHTMLElement(editor) ? editor : undefined, root);
		if (this.dock.parentElement !== host) {
			host.appendChild(this.dock);
		}
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

		this.placeDock(root);
	}

	private toggleLeft(): void {
		if (getLayoutMode(this.layoutService) !== 'agent') {
			return;
		}
		const hide = this.layoutService.isVisible(Parts.AUXILIARYBAR_PART);
		this.storageService.store(AGENT_LEFT_SIDEBAR_HIDDEN_KEY, hide, StorageScope.PROFILE, StorageTarget.USER);
		this.layoutService.setPartHidden(hide, Parts.AUXILIARYBAR_PART);
		if (hide) {
			this.layoutService.mainContainer.style.setProperty('--volt-agent-sidebar-width', '0px');
		}
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

	private toggleDock(): void {
		const collapsed = !this.collapsed;
		this.storageService.store(AGENT_RIGHT_DOCK_COLLAPSED_KEY, collapsed, StorageScope.PROFILE, StorageTarget.USER);
		this.applyDock(collapsed);
	}

	private applyDock(collapsed: boolean): void {
		this.collapsed = collapsed;
		const agent = getLayoutMode(this.layoutService) === 'agent';
		const root = this.layoutService.mainContainer;
		this.dock.classList.toggle('collapsed', collapsed);
		this.dock.classList.toggle('expanded', !collapsed);
		const label = collapsed
			? localize('voltAgent.dock.expand', "Expand")
			: localize('voltAgent.dock.collapse', "Collapse");
		this.chevronLabel.textContent = label;
		this.chevron.setAttribute('aria-label', label);
		this.chevron.setAttribute('aria-expanded', String(!collapsed));
		if (agent) {
			root.style.setProperty('--volt-agent-right-dock-width', `${collapsed ? AGENT_RIGHT_DOCK_COLLAPSED_WIDTH : AGENT_RIGHT_DOCK_EXPANDED_WIDTH}px`);
			root.classList.toggle('volt-agent-right-collapsed', collapsed);
		} else {
			root.style.removeProperty('--volt-agent-right-dock-width');
			root.classList.remove('volt-agent-right-collapsed');
		}
		this.layoutService.layout();
		if (agent && !this.layoutService.isVisible(Parts.AUXILIARYBAR_PART)) {
			root.style.setProperty('--volt-agent-sidebar-width', '0px');
		}
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
