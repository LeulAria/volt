/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import '../media/agentSidebarRail.css';
import { $, addDisposableListener, append, getWindow, isHTMLElement, scheduleAtNextAnimationFrame } from '../../../../../base/browser/dom.js';
import { mainWindow } from '../../../../../base/browser/window.js';
import { renderIcon } from '../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { Emitter } from '../../../../../base/common/event.js';
import { Disposable, DisposableStore, MutableDisposable } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IContextViewService } from '../../../../../platform/contextview/browser/contextView.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../../platform/keybinding/common/keybinding.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { IWorkbenchContribution } from '../../../../common/contributions.js';
import { IEditorGroupsService } from '../../../../services/editor/common/editorGroupsService.js';
import { IWorkbenchLayoutService, Parts } from '../../../../services/layout/browser/layoutService.js';
import { IAgentHistoryService } from '../../../../services/voltRuntime/common/history/agentHistory.js';
import { IVoltSessionContextService } from '../../../../services/voltRuntime/common/sessionContext.js';
import { getLayoutMode, onDidChangeLayoutMode } from '../../../../browser/parts/titlebar/layoutModeSwitch.js';
import { AGENT_SIDEBAR_RAIL_CLASS, AGENT_SIDEBAR_RAIL_EVENT, AGENT_SIDEBAR_RAIL_KEY, AGENT_SIDEBAR_RAIL_WIDTH } from '../../../../browser/parts/titlebar/layoutModeStartup.js';
import { AuxiliaryBarPart } from '../../../../browser/parts/auxiliarybar/auxiliaryBarPart.js';
import { setAgentTooltip } from '../chrome/agentTooltip.js';
import { NEW_AGENT_COMMAND_ID } from '../editor/agentEditorInput.js';
import { createHomeNewChatIcon, createHomeSearchIcon } from '../home/agentHomeIcons.js';
import { IVoltMenuItem, showVoltMenu } from '../ui/menu/voltMenu.js';
import { IAgentWorkspaceService } from '../workspace/agentWorkspace.js';
import { activateAgentProject, startAgentChat } from '../workspace/agentPanels.js';
import { IAgentThreadAttentionService } from '../attention/agentThreadAttention.js';
import { IVoltProjectIconService, createProjectIcon } from './agentProjectIconService.js';
import { showProjectIconPicker } from './agentProjectIconPicker.js';
import { collectSidebarProjects, IAgentSidebarProject } from './agentSidebarProjects.js';

export const TOGGLE_AGENT_SIDEBAR_RAIL_COMMAND_ID = 'volt.agent.toggleSidebarRail';

/** Width the full list comes back at; kept apart from the layout's own size, which the rail overwrites. */
const LIST_WIDTH_KEY = 'volt.agent.sidebar.listWidth';
/** Rail project tiles. */
const PROJECT_ICON_SIZE = 26;

const railEmitter = new Emitter<boolean>();
/** The rail turned on or off (any window part that draws sidebar controls follows it). */
export const onDidChangeAgentSidebarRail = railEmitter.event;

let railToggle: ((on?: boolean) => void) | undefined;

/** Turns the rail on, off, or over; a no-op until the agent layout is up. */
export function toggleAgentSidebarRail(on?: boolean): void {
	railToggle?.(on);
}

/**
 * The agent list folded to an icon rail: New Chat and Search, each project as its icon or monogram
 * with a badge for chats that finished out of sight, then Expand and Settings. The rail lives in
 * the list's own part (no layer over the window); the part's class swaps its content.
 */
export class AgentSidebarRailContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.voltAgentSidebarRail';

	private readonly rail: HTMLElement;
	private readonly projectsEl: HTMLElement;
	private readonly projectStore = this._register(new DisposableStore());
	private readonly renderFrame = this._register(new MutableDisposable());
	private on: boolean;
	/** The footer button that folds the list into the rail, and opens it out again. */
	private readonly collapseButton: HTMLButtonElement;
	private readonly footerResize: ResizeObserver;
	private observedFooter: HTMLElement | undefined;

	constructor(
		@IWorkbenchLayoutService private readonly layoutService: IWorkbenchLayoutService,
		@IStorageService private readonly storageService: IStorageService,
		@ICommandService private readonly commandService: ICommandService,
		@IContextViewService private readonly contextViewService: IContextViewService,
		@IKeybindingService private readonly keybindingService: IKeybindingService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IVoltSessionContextService private readonly sessionContext: IVoltSessionContextService,
		@IAgentHistoryService private readonly history: IAgentHistoryService,
		@IAgentWorkspaceService private readonly agentWorkspace: IAgentWorkspaceService,
		@IEditorGroupsService private readonly editorGroupsService: IEditorGroupsService,
		@IAgentThreadAttentionService private readonly attention: IAgentThreadAttentionService,
		@IVoltProjectIconService private readonly projectIcons: IVoltProjectIconService,
	) {
		super();
		this.on = this.storageService.getBoolean(AGENT_SIDEBAR_RAIL_KEY, StorageScope.PROFILE, false);

		this.rail = $('.volt-agent-sidebar-rail');
		this.rail.setAttribute('role', 'toolbar');
		this.rail.setAttribute('aria-orientation', 'vertical');
		this.rail.setAttribute('aria-label', localize('voltAgent.rail', "Agent Sidebar"));
		this._register({ dispose: () => this.rail.remove() });

		const top = append(this.rail, $('.volt-rail-group.volt-rail-top'));
		this.button(top, 'new-chat', localize('voltAgent.rail.newChat', "New Chat"), createHomeNewChatIcon(),
			() => void this.commandService.executeCommand(NEW_AGENT_COMMAND_ID), this.keybindingService.lookupKeybinding(NEW_AGENT_COMMAND_ID)?.getLabel() ?? undefined);
		this.button(top, 'search', localize('voltAgent.rail.search', "Search"), createHomeSearchIcon(),
			() => void this.commandService.executeCommand('workbench.action.showCommands'));
		append(this.rail, $('.volt-rail-sep'));
		this.projectsEl = append(this.rail, $('.volt-rail-group.volt-rail-projects'));
		this.projectsEl.setAttribute('role', 'group');
		this.projectsEl.setAttribute('aria-label', localize('voltAgent.rail.projects', "Projects"));
		// Settings, Usage and Update stay in the list's own footer, which stacks under the rail.
		this.collapseButton = $('button.volt-agent-home-settings.volt-agent-home-rail-toggle') as HTMLButtonElement;
		this.collapseButton.type = 'button';
		this._register(addDisposableListener(this.collapseButton, 'click', e => {
			e.preventDefault();
			e.stopPropagation();
			this.collapseButton.blur();
			this.setRail(!this.on);
		}));
		this.footerResize = new ResizeObserver(() => this.measureFooter());
		this._register({ dispose: () => this.footerResize.disconnect() });

		railToggle = on => this.setRail(on ?? !this.on);
		this._register({ dispose: () => railToggle = undefined });

		// The list (and its footer) is built after this runs, and again on a workspace switch.
		void this.layoutService.whenRestored.then(() => this.mount());
		this._register(this.history.onDidChange(() => {
			this.mount();
			this.scheduleRender();
		}));
		this._register(this.attention.onDidChange(() => this.scheduleRender()));
		this._register(this.projectIcons.onDidChange(() => this.scheduleRender()));
		this._register(this.sessionContext.onDidChangeProjects(() => this.scheduleRender()));
		this._register(this.sessionContext.onDidChangeActiveProject(() => this.scheduleRender()));
		this._register(onDidChangeLayoutMode(() => this.sync()));
		this._register(this.layoutService.onDidChangePartVisibility(() => this.mount()));
		this._register(this.layoutService.onDidLayoutMainContainer(() => this.mount()));
		this.sync();
	}

	private get agentLayout(): boolean {
		return getLayoutMode(this.layoutService) === 'agent';
	}

	private setRail(on: boolean): void {
		if (on === this.on) {
			return;
		}
		const root = this.layoutService.mainContainer;
		// Leaving the full list: keep its width for when it opens again.
		if (on && !root.classList.contains(AGENT_SIDEBAR_RAIL_CLASS) && this.layoutService.isVisible(Parts.AUXILIARYBAR_PART)) {
			const width = this.layoutService.getSize(Parts.AUXILIARYBAR_PART).width;
			if (width >= AuxiliaryBarPart.AGENT_MIN_WIDTH) {
				this.storageService.store(LIST_WIDTH_KEY, width, StorageScope.PROFILE, StorageTarget.MACHINE);
			}
		}
		this.on = on;
		this.storageService.store(AGENT_SIDEBAR_RAIL_KEY, on, StorageScope.PROFILE, StorageTarget.USER);
		this.sync();
		railEmitter.fire(on);
		// Folding the list in from the rail opens it if it was hidden; folding out keeps it where it is.
		if (this.agentLayout && !this.layoutService.isVisible(Parts.AUXILIARYBAR_PART)) {
			this.layoutService.setPartHidden(false, Parts.AUXILIARYBAR_PART);
		}
	}

	private sync(): void {
		const root = this.layoutService.mainContainer;
		const rail = this.on && this.agentLayout;
		const changed = root.classList.contains(AGENT_SIDEBAR_RAIL_CLASS) !== rail;
		root.classList.toggle(AGENT_SIDEBAR_RAIL_CLASS, rail);
		this.syncToggle(rail);
		this.mount();
		if (rail) {
			this.scheduleRender();
		}
		if (changed) {
			const width = rail ? AGENT_SIDEBAR_RAIL_WIDTH : this.storageService.getNumber(LIST_WIDTH_KEY, StorageScope.PROFILE, AuxiliaryBarPart.AGENT_DEFAULT_WIDTH);
			root.dispatchEvent(new CustomEvent(AGENT_SIDEBAR_RAIL_EVENT, { detail: { width } }));
		}
	}

	/** The rail sits in the list's part; the fold button in the list's footer (both are rebuilt with them). */
	private mount(): void {
		const part = this.layoutService.getContainer(mainWindow, Parts.AUXILIARYBAR_PART);
		if (isHTMLElement(part) && this.rail.parentElement !== part) {
			part.appendChild(this.rail);
		}
		const footer = part?.querySelector('.volt-agent-home-footer');
		if (isHTMLElement(footer) && this.collapseButton.parentElement !== footer) {
			footer.appendChild(this.collapseButton);
		}
		if (isHTMLElement(footer) && footer !== this.observedFooter) {
			if (this.observedFooter) {
				this.footerResize.unobserve(this.observedFooter);
			}
			this.observedFooter = footer;
			this.footerResize.observe(footer);
		}
	}

	/** The project list ends where the stacked footer begins. */
	private measureFooter(): void {
		const height = this.observedFooter?.offsetHeight ?? 0;
		this.rail.style.setProperty('--volt-rail-footer-height', `${height}px`);
	}

	private syncToggle(rail: boolean): void {
		const label = rail
			? localize('voltAgent.rail.expand', "Expand Sidebar")
			: localize('voltAgent.rail.collapse', "Collapse to Icons");
		this.collapseButton.replaceChildren(renderIcon(rail ? Codicon.layoutSidebarLeft : Codicon.layoutSidebarLeftDock));
		this.collapseButton.setAttribute('aria-label', label);
		setAgentTooltip(this.collapseButton, label, this.keybindingService.lookupKeybinding(TOGGLE_AGENT_SIDEBAR_RAIL_COMMAND_ID)?.getLabel() ?? undefined, undefined, rail ? 'end' : undefined);
	}

	private scheduleRender(): void {
		if (!this.layoutService.mainContainer.classList.contains(AGENT_SIDEBAR_RAIL_CLASS) || this.renderFrame.value) {
			return;
		}
		this.renderFrame.value = scheduleAtNextAnimationFrame(getWindow(this.rail), () => {
			this.renderFrame.clear();
			this.renderProjects();
		});
	}

	private renderProjects(): void {
		this.projectStore.clear();
		this.projectsEl.replaceChildren();
		for (const project of collectSidebarProjects(this.sessionContext, this.history, this.attention)) {
			const tile = append(this.projectsEl, $('button.volt-rail-button.volt-rail-project')) as HTMLButtonElement;
			tile.type = 'button';
			tile.classList.toggle('current', project.current);
			tile.classList.toggle('working', project.working);
			tile.appendChild(createProjectIcon(this.projectIcons.get(project.root), project.name, PROJECT_ICON_SIZE));
			if (project.unread > 0) {
				append(tile, $('span.volt-rail-badge.unread')).textContent = project.unread > 9 ? '9+' : String(project.unread);
			} else if (project.attention) {
				append(tile, $('span.volt-rail-badge.attention'));
			}
			const label = project.unread > 0
				? localize('voltAgent.rail.projectUnread', "{0} · {1} unread", project.name, project.unread)
				: project.name;
			tile.setAttribute('aria-label', label);
			setAgentTooltip(tile, label, undefined, undefined, 'end');
			this.projectStore.add(addDisposableListener(tile, 'click', e => {
				e.preventDefault();
				tile.blur();
				void this.openProject(project);
			}));
			this.projectStore.add(addDisposableListener(tile, 'contextmenu', e => {
				e.preventDefault();
				e.stopPropagation();
				this.showProjectMenu(tile, project);
			}));
		}
	}

	/** Its latest chat, or a new one, like a double-click on its row in the full list. */
	private async openProject(project: IAgentSidebarProject): Promise<void> {
		await activateAgentProject(this.sessionContext, this.agentWorkspace, this.history, this.editorGroupsService, this.instantiationService, project.root, project.name);
	}

	private showProjectMenu(anchor: HTMLElement, project: IAgentSidebarProject): void {
		type Pick = 'open' | 'new' | 'icon' | 'expand';
		const item = (id: Pick, label: string, icon: typeof Codicon.add): IVoltMenuItem<Pick> => ({ id, label, icon, data: id });
		// The menu opens beside the rail, its top level with the tile, not over the rail itself.
		const tile = anchor.getBoundingClientRect();
		const point = append(anchor.ownerDocument.body, $('span.volt-rail-menu-anchor'));
		point.style.cssText = `position:fixed;left:${tile.right + 6}px;top:${tile.top}px;width:1px;height:1px;`;
		showVoltMenu<Pick>(this.contextViewService, {
			anchor: point,
			align: 'left',
			gap: 0,
			onHide: () => point.remove(),
			width: 220,
			ariaLabel: project.name,
			sections: [
				{ id: 'chats', title: project.name, items: [item('open', localize('voltAgent.rail.openProject', "Open Latest Chat"), Codicon.commentDiscussion), item('new', localize('voltAgent.rail.newChatIn', "New Chat"), Codicon.add)] },
				{ id: 'look', items: [item('icon', localize('voltAgent.rail.changeIcon', "Change Icon…"), Codicon.symbolColor), item('expand', localize('voltAgent.rail.expand', "Expand Sidebar"), Codicon.layoutSidebarLeft)] },
			],
			onPick: picked => {
				switch (picked.data) {
					case 'open': return this.openProject(project);
					case 'new': return startAgentChat(this.sessionContext, this.agentWorkspace, this.history, this.editorGroupsService, this.instantiationService, { kind: 'folder', root: project.root, name: project.name });
					case 'icon': return showProjectIconPicker(this.instantiationService, project.root, project.name);
					case 'expand': return this.setRail(false);
				}
			},
		});
	}

	private button(parent: HTMLElement, id: string, label: string, icon: Element, run: () => void, shortcut?: string): HTMLButtonElement {
		const button = append(parent, $(`button.volt-rail-button.volt-rail-${id}`)) as HTMLButtonElement;
		button.type = 'button';
		button.setAttribute('aria-label', label);
		button.appendChild(icon);
		setAgentTooltip(button, label, shortcut, undefined, 'end');
		this._register(addDisposableListener(button, 'click', e => {
			e.preventDefault();
			button.blur();
			run();
		}));
		return button;
	}
}
