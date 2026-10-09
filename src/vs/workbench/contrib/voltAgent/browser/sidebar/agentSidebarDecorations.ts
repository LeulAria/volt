/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import '../media/agentSidebarDecorations.css';
import { $, addDisposableListener, getWindow, isHTMLElement, scheduleAtNextAnimationFrame } from '../../../../../base/browser/dom.js';
import { mainWindow } from '../../../../../base/browser/window.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { Disposable, MutableDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IContextViewService } from '../../../../../platform/contextview/browser/contextView.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IWorkbenchContribution } from '../../../../common/contributions.js';
import { IWorkbenchLayoutService, Parts } from '../../../../services/layout/browser/layoutService.js';
import { IAgentHistoryService } from '../../../../services/voltRuntime/common/history/agentHistory.js';
import { IVoltSessionContextService } from '../../../../services/voltRuntime/common/sessionContext.js';
import { showVoltMenu } from '../ui/menu/voltMenu.js';
import { IAgentThreadAttentionService } from '../attention/agentThreadAttention.js';
import { AGENT_COMPACT_LIST_SETTING, setAgentHomeDensityHost } from '../home/agentHomeDensity.js';
import { createProjectIcon, IVoltProjectIconService } from './agentProjectIconService.js';
import { showProjectIconPicker } from './agentProjectIconPicker.js';
import { collectSidebarProjects, IAgentSidebarProject, projectForLabel } from './agentSidebarProjects.js';
import { toggleAgentSidebarRail } from './agentSidebarRail.js';

/** Root class for the dense thread list (agentSidebarDecorations.css). */
const COMPACT_CLASS = 'volt-agent-home-compact';

/**
 * Dresses the agent list's project rows from outside the list: the chosen project icon in place
 * of the folder glyph, a dot on a folded project with unread chats, and a right-click menu to
 * change the icon. Rows are recycled by the list, so every pass sets or clears each mark.
 *
 * The rows carry no project id, so a row is matched by its label (the repository or folder name).
 * A `data-project-key` / `data-session-id` on the rows would make this exact (reported as a seam).
 */
export class AgentSidebarDecorationsContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.voltAgentSidebarDecorations';

	private readonly treeWatch = this._register(new MutableDisposable());
	private readonly frame = this._register(new MutableDisposable());
	private watchedTree: HTMLElement | undefined;
	private projects: IAgentSidebarProject[] = [];
	private projectsStale = true;
	private compact = false;

	constructor(
		@IWorkbenchLayoutService private readonly layoutService: IWorkbenchLayoutService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IContextViewService private readonly contextViewService: IContextViewService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IVoltSessionContextService private readonly sessionContext: IVoltSessionContextService,
		@IAgentHistoryService private readonly history: IAgentHistoryService,
		@IAgentThreadAttentionService private readonly attention: IAgentThreadAttentionService,
		@IVoltProjectIconService private readonly projectIcons: IVoltProjectIconService,
	) {
		super();
		this.syncCompact();
		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(AGENT_COMPACT_LIST_SETTING)) {
				this.syncCompact();
			}
		}));
		const self = this;
		setAgentHomeDensityHost({
			get compact() {
				return self.compact;
			},
			setCompact: compact => {
				// The class follows at once; the settings file catches up.
				self.compact = compact;
				self.layoutService.mainContainer.classList.toggle(COMPACT_CLASS, compact);
				void configurationService.updateValue(AGENT_COMPACT_LIST_SETTING, compact);
			},
		});
		this._register(toDisposable(() => setAgentHomeDensityHost(undefined)));

		const refresh = () => this.schedule(true);
		this._register(this.history.onDidChange(refresh));
		this._register(this.attention.onDidChange(refresh));
		this._register(this.projectIcons.onDidChange(refresh));
		this._register(this.sessionContext.onDidChangeProjects(refresh));
		this._register(this.layoutService.onDidChangePartVisibility(refresh));
		this._register(this.layoutService.onDidLayoutMainContainer(() => this.schedule(false)));
		this.schedule(true);
	}

	private syncCompact(): void {
		this.compact = this.configurationService.getValue<boolean>(AGENT_COMPACT_LIST_SETTING) === true;
		this.layoutService.mainContainer.classList.toggle(COMPACT_CLASS, this.compact);
	}

	/** Batches row changes into one pass per frame; `data` re-reads projects and their chats first. */
	private schedule(data: boolean): void {
		if (data) {
			this.projectsStale = true;
		}
		if (this.frame.value) {
			return;
		}
		this.frame.value = scheduleAtNextAnimationFrame(getWindow(this.layoutService.mainContainer), () => {
			this.frame.clear();
			this.watchTree();
			this.decorate();
		});
	}

	/** The list is rebuilt when the window switches workspace; follow whichever one is mounted. */
	private watchTree(): void {
		const part = this.layoutService.getContainer(mainWindow, Parts.AUXILIARYBAR_PART);
		const tree = part?.querySelector('.volt-agent-home-tree');
		if (!isHTMLElement(tree) || tree === this.watchedTree) {
			return;
		}
		this.watchedTree = tree;
		// Text and child changes cover a row being recycled for another element (its name is rewritten).
		const observer = new MutationObserver(records => {
			if (records.some(record => !this.isOwnMutation(record))) {
				this.schedule(false);
			}
		});
		observer.observe(tree, { childList: true, subtree: true, characterData: true });
		const menu = addDisposableListener(tree, 'contextmenu', e => this.onContextMenu(e));
		this.treeWatch.value = toDisposable(() => {
			observer.disconnect();
			menu.dispose();
		});
	}

	/** Our own icon going in or out of a glyph must not wake the observer again. */
	private isOwnMutation(record: MutationRecord): boolean {
		const own = (node: Node) => isHTMLElement(node) && node.classList.contains('volt-project-icon');
		return record.type === 'childList'
			&& [...record.addedNodes, ...record.removedNodes].every(own)
			&& record.addedNodes.length + record.removedNodes.length > 0;
	}

	private currentProjects(): IAgentSidebarProject[] {
		if (this.projectsStale) {
			this.projects = collectSidebarProjects(this.sessionContext, this.history, this.attention);
			this.projectsStale = false;
		}
		return this.projects;
	}

	private decorate(): void {
		const tree = this.watchedTree;
		if (!tree?.isConnected) {
			return;
		}
		const projects = this.currentProjects();
		for (const row of tree.querySelectorAll<HTMLElement>('.volt-agent-home-row')) {
			if (!row.classList.contains('is-folder')) {
				this.clearRow(row);
				continue;
			}
			const project = this.projectOf(row, projects);
			const icon = project ? this.projectIcons.get(project.root) : undefined;
			row.classList.toggle('volt-project-unread', !!project && project.unread > 0);
			row.classList.toggle('volt-project-attention', !!project && project.attention && project.unread === 0);
			const glyph = row.querySelector<HTMLElement>(':scope > .icon > .glyph');
			const existing = glyph?.querySelector<HTMLElement>(':scope > .volt-project-icon');
			if (!project || !icon || !glyph) {
				row.classList.toggle('has-project-icon', false);
				existing?.remove();
				continue;
			}
			const key = `${project.root.toString()}|${JSON.stringify(icon)}`;
			if (existing?.dataset.key !== key) {
				existing?.remove();
				const element = createProjectIcon(icon, project.name, 16);
				element.dataset.key = key;
				glyph.appendChild(element);
			}
			row.classList.toggle('has-project-icon', true);
		}
	}

	private clearRow(row: HTMLElement): void {
		if (row.classList.contains('has-project-icon') || row.classList.contains('volt-project-unread') || row.classList.contains('volt-project-attention')) {
			row.classList.remove('has-project-icon', 'volt-project-unread', 'volt-project-attention');
			row.querySelector(':scope > .icon > .glyph > .volt-project-icon')?.remove();
		}
	}

	private projectOf(row: HTMLElement, projects: readonly IAgentSidebarProject[]): IAgentSidebarProject | undefined {
		const key = row.dataset.projectKey ?? row.closest<HTMLElement>('.monaco-list-row')?.dataset.projectKey;
		if (key) {
			return projects.find(project => project.root.toString() === key);
		}
		const label = row.closest<HTMLElement>('.monaco-list-row')?.getAttribute('aria-label') ?? row.querySelector('.name')?.textContent ?? '';
		return projectForLabel(projects, label);
	}

	/** Right-click on a project row: change its icon, or fold the list into the rail. */
	private onContextMenu(e: MouseEvent): void {
		const target = e.target;
		const row = isHTMLElement(target) ? target.closest<HTMLElement>('.volt-agent-home-row.is-folder') : null;
		const project = row ? this.projectOf(row, this.currentProjects()) : undefined;
		if (!row || !project) {
			return;
		}
		e.preventDefault();
		e.stopPropagation();
		type Pick = 'icon' | 'reset' | 'rail';
		const hasIcon = !!this.projectIcons.get(project.root);
		const anchor = $('span');
		anchor.style.position = 'fixed';
		anchor.style.left = `${e.clientX}px`;
		anchor.style.top = `${e.clientY}px`;
		anchor.style.width = '1px';
		anchor.style.height = '1px';
		row.ownerDocument.body.appendChild(anchor);
		showVoltMenu<Pick>(this.contextViewService, {
			anchor,
			align: 'left',
			gap: 2,
			width: 220,
			ariaLabel: project.name,
			sections: [
				{
					id: 'icon', title: project.name, items: [
						{ id: 'icon', label: localize('voltAgent.sidebar.changeIcon', "Change Icon…"), icon: Codicon.symbolColor, data: 'icon' },
						...(hasIcon ? [{ id: 'reset', label: localize('voltAgent.sidebar.resetIcon', "Use Default Icon"), icon: Codicon.discard, data: 'reset' as const }] : []),
					]
				},
				{ id: 'rail', items: [{ id: 'rail', label: localize('voltAgent.sidebar.collapseToRail', "Collapse Sidebar to Icons"), icon: Codicon.layoutSidebarLeftDock, data: 'rail' }] },
			],
			onPick: picked => {
				switch (picked.data) {
					case 'icon': return showProjectIconPicker(this.instantiationService, project.root, project.name);
					case 'reset': return this.projectIcons.set(project.root, undefined);
					case 'rail': return toggleAgentSidebarRail(true);
				}
			},
			onHide: () => anchor.remove(),
		});
	}
}
