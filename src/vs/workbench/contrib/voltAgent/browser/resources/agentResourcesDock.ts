/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, EventHelper, getWindow, runWhenWindowIdle } from '../../../../../base/browser/dom.js';
import { renderIcon } from '../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { IListRenderer, IListVirtualDelegate } from '../../../../../base/browser/ui/list/list.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { Disposable, DisposableStore, MutableDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { localize } from '../../../../../nls.js';
import { CommandsRegistry, ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { WorkbenchList } from '../../../../../platform/list/browser/listService.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { AGENT_RESOURCE_GROUPS, IAgentResourceGroup } from '../../common/agentResources.js';
import { setAgentTooltip } from '../chrome/agentTooltip.js';
import { SHOW_AGENT_FILES_COMMAND_ID } from '../workspace/agentSurfaceHost.js';
import { createSurfaceStrokeIcon } from '../workspace/agentSurfaceMenu.js';
import { AgentResourceTree, openAgentResource } from './agentResourceTree.js';
import { agentResourcesSection, agentResourcesSectionFor, OPEN_AGENT_RESOURCES_COMMAND_ID } from './agentResourcesPage.js';
import { AgentResourceFilter, IAgentResource, IAgentResourcesService } from './agentResourcesService.js';

/** Opens the files sidebar filtered to a group (or every agent resource without one). */
export const SHOW_AGENT_RESOURCES_COMMAND_ID = 'volt.agent.showAgentResources';

CommandsRegistry.registerCommand(SHOW_AGENT_RESOURCES_COMMAND_ID, (accessor, filter?: AgentResourceFilter) => {
	accessor.get(IAgentResourcesService).setFilter(filter ?? 'all');
	return accessor.get(ICommandService).executeCommand(SHOW_AGENT_FILES_COMMAND_ID);
});

const ROW_HEIGHT = 26;
/** The card's tree scrolls past this. */
const CARD_TREE_MAX_HEIGHT = 320;
const CARD_WIDTH = 300;
/** Room to cross from the row to the card. */
const HIDE_DELAY_MS = 160;

interface IGroupRow {
	/** Undefined for the one row a project without agent files gets: it opens the page. */
	readonly group: IAgentResourceGroup | undefined;
	readonly items: readonly IAgentResource[];
	readonly issues: number;
}

class GroupDelegate implements IListVirtualDelegate<IGroupRow> {
	getHeight(): number {
		return ROW_HEIGHT;
	}

	getTemplateId(): string {
		return GroupRenderer.ID;
	}
}

interface IGroupTemplate {
	readonly row: HTMLElement;
	readonly icon: HTMLElement;
	readonly label: HTMLElement;
	readonly issues: HTMLElement;
	readonly count: HTMLElement;
	readonly store: DisposableStore;
}

class GroupRenderer implements IListRenderer<IGroupRow, IGroupTemplate> {
	static readonly ID = 'voltAgentResourceGroup';
	readonly templateId = GroupRenderer.ID;

	constructor(private readonly onHover: (row: HTMLElement, element: IGroupRow | undefined) => void) { }

	renderTemplate(container: HTMLElement): IGroupTemplate {
		const row = append(container, $('.volt-agent-resources-group-row'));
		const icon = append(row, $('span.volt-agent-resources-group-icon'));
		const label = append(row, $('span.volt-agent-resources-group-label'));
		const issues = append(row, $('span.volt-agent-resources-group-issues'));
		issues.appendChild(renderIcon(Codicon.warning));
		const count = append(row, $('span.volt-agent-resources-group-count'));
		return { row, icon, label, issues, count, store: new DisposableStore() };
	}

	renderElement(element: IGroupRow, _index: number, template: IGroupTemplate): void {
		template.store.clear();
		const icon = createSurfaceStrokeIcon(template.icon.ownerDocument, element.group?.icon ?? agentResourcesSection('overview').icon);
		icon.classList.add('volt-agent-stroke-icon');
		template.icon.replaceChildren(icon);
		template.label.textContent = element.group?.label ?? localize('agentResources.setUp', "Skills, MCP and Harness");
		template.count.textContent = element.group ? String(element.items.length) : '';
		template.issues.classList.toggle('hidden', !element.issues);
		template.issues.setAttribute('aria-label', element.issues === 1
			? localize('agentResources.oneIssue', "1 file needs attention")
			: localize('agentResources.issues', "{0} files need attention", element.issues));
		template.store.add(addDisposableListener(template.row, 'mouseenter', () => this.onHover(template.row, element)));
		template.store.add(addDisposableListener(template.row, 'mouseleave', () => this.onHover(template.row, undefined)));
	}

	disposeTemplate(template: IGroupTemplate): void {
		template.store.dispose();
	}
}

/**
 * The files of one group, beside the toolbar while its row is hovered: a title with the count, the
 * files as an Explorer tree, and a way to filter the files sidebar to them. The pointer can cross
 * into it; a file opens as a tab in the right panel.
 */
class AgentResourcesCard extends Disposable {

	readonly domNode: HTMLElement;
	private readonly title: HTMLElement;
	private readonly titleIcon: HTMLElement;
	private readonly titleCount: HTMLElement;
	private readonly treeHost: HTMLElement;
	private readonly tree: AgentResourceTree;
	private readonly showAll: HTMLButtonElement;
	private readonly hideTimer = this._register(new MutableDisposable());
	private group: IAgentResourceGroup | undefined;
	private anchor: HTMLElement | undefined;

	constructor(
		private readonly onShowInSidebar: (group: IAgentResourceGroup) => void,
		private readonly onManage: (group: IAgentResourceGroup) => void,
		@IInstantiationService instantiationService: IInstantiationService,
		@IEditorService editorService: IEditorService,
	) {
		super();
		this.domNode = $('.volt-agent-tooltip.card.beside.volt-agent-resources-card.hidden');
		this.domNode.setAttribute('role', 'dialog');
		this._register(toDisposable(() => this.domNode.remove()));
		const head = append(this.domNode, $('.volt-agent-resources-card-head'));
		this.titleIcon = append(head, $('span.volt-agent-resources-card-icon'));
		this.title = append(head, $('span.volt-agent-resources-card-title'));
		this.titleCount = append(head, $('span.volt-agent-resources-card-count'));
		this.treeHost = append(this.domNode, $('.volt-agent-resources-card-tree'));
		this.tree = this._register(instantiationService.createInstance(AgentResourceTree, this.treeHost, 'VoltAgentResourcesCard'));
		this._register(this.tree.onDidOpen(({ item, preserveFocus }) => {
			this.hide();
			openAgentResource(editorService, item, preserveFocus);
		}));
		this._register(this.tree.onDidChangeContentHeight(() => this.layoutTree()));
		const footer = append(this.domNode, $('.volt-agent-resources-card-footer-row'));
		this.showAll = append(footer, $('button.volt-agent-resources-card-footer')) as HTMLButtonElement;
		this.showAll.type = 'button';
		this.showAll.appendChild(renderIcon(Codicon.listFilter));
		append(this.showAll, $('span')).textContent = localize('agentResources.showInFiles', "Show in Files Sidebar");
		const manage = append(footer, $('button.volt-agent-resources-card-footer.manage')) as HTMLButtonElement;
		manage.type = 'button';
		manage.appendChild(renderIcon(Codicon.linkExternal));
		append(manage, $('span')).textContent = localize('agentResources.manageShort', "Manage");
		for (const [button, run] of [[this.showAll, this.onShowInSidebar], [manage, this.onManage]] as const) {
			this._register(addDisposableListener(button, 'click', () => {
				const group = this.group;
				this.hide();
				if (group) {
					run(group);
				}
			}));
		}
		this._register(addDisposableListener(this.domNode, 'mouseenter', () => this.hideTimer.clear()));
		this._register(addDisposableListener(this.domNode, 'mouseleave', () => this.scheduleHide()));
	}

	get visible(): boolean {
		return !this.domNode.classList.contains('hidden');
	}

	show(anchor: HTMLElement, group: IAgentResourceGroup, folder: URI, items: readonly IAgentResource[]): void {
		this.hideTimer.clear();
		const same = this.anchor === anchor && this.group === group && this.visible;
		this.anchor = anchor;
		this.group = group;
		const host = anchor.closest('.monaco-workbench') ?? anchor.ownerDocument.body;
		if (this.domNode.parentElement !== host) {
			host.appendChild(this.domNode);
		}
		const icon = createSurfaceStrokeIcon(this.domNode.ownerDocument, group.icon);
		this.titleIcon.replaceChildren(icon);
		this.title.textContent = group.label;
		this.titleCount.textContent = String(items.length);
		this.domNode.setAttribute('aria-label', group.label);
		this.tree.setResources(folder, items);
		this.domNode.classList.remove('hidden');
		this.layoutTree();
		if (!same) {
			this.place(anchor);
		}
	}

	/** Hides once the pointer has had time to reach the card. */
	scheduleHide(): void {
		const win = getWindow(this.domNode);
		const handle = win.setTimeout(() => this.hide(), HIDE_DELAY_MS);
		this.hideTimer.value = toDisposable(() => win.clearTimeout(handle));
	}

	hide(): void {
		this.hideTimer.clear();
		this.anchor = undefined;
		this.domNode.classList.add('hidden');
	}

	private layoutTree(): void {
		if (!this.visible) {
			return;
		}
		const height = Math.min(CARD_TREE_MAX_HEIGHT, this.tree.contentHeight);
		this.treeHost.style.height = `${height}px`;
		this.tree.layout(height, CARD_WIDTH - 2);
		if (this.anchor) {
			this.place(this.anchor);
		}
	}

	/** Beside the toolbar, toward the chat; across when there is no room. Kept in the window. */
	private place(anchor: HTMLElement): void {
		const win = getWindow(anchor);
		const rect = anchor.getBoundingClientRect();
		const width = this.domNode.offsetWidth;
		const height = this.domNode.offsetHeight;
		const gap = 6;
		const before = rect.left - width - gap;
		const left = before >= 8 ? before : Math.min(rect.right + gap, win.innerWidth - width - 8);
		const top = Math.max(8, Math.min(rect.top - 6, win.innerHeight - height - 8));
		this.domNode.style.left = `${Math.max(8, left)}px`;
		this.domNode.style.top = `${top}px`;
	}
}

/**
 * "Agent Resources (N)" in the chat's side toolbar: the files that configure agents in the chat's
 * folder, one row per group with its count. Hovering a row shows its files; clicking it filters the
 * files sidebar to them.
 */
export class AgentResourcesDock extends Disposable {

	readonly element: HTMLElement;
	private readonly head: HTMLButtonElement;
	private readonly headLabel: HTMLElement;
	private readonly manage: HTMLElement;
	private readonly listHost: HTMLElement;
	private readonly list: WorkbenchList<IGroupRow>;
	private readonly card: AgentResourcesCard;
	private open = true;
	private folder: URI | undefined;
	private readonly pendingLoad = this._register(new MutableDisposable());

	constructor(
		@IInstantiationService instantiationService: IInstantiationService,
		@IAgentResourcesService private readonly resources: IAgentResourcesService,
		@ICommandService private readonly commandService: ICommandService,
	) {
		super();
		this.element = $('.volt-agent-dock-section.volt-agent-dock-resources.hidden');
		this.element.setAttribute('role', 'region');
		this.element.setAttribute('aria-label', localize('agentResources.region', "Agent Resources"));
		// The same pane header as Pull requests and Previous agents.
		this.head = append(this.element, $('button.volt-agent-lineage-divider.volt-agent-dock-group-head')) as HTMLButtonElement;
		this.head.type = 'button';
		this.headLabel = $('span.label');
		// A span, not a button: it sits in the header's button. Shown on hover (agentResources.css).
		this.manage = $('span.volt-agent-resources-manage');
		this.manage.setAttribute('role', 'button');
		const manageLabel = localize('agentResources.manage', "Open Agent Resources");
		this.manage.setAttribute('aria-label', manageLabel);
		setAgentTooltip(this.manage, manageLabel);
		this.manage.appendChild(renderIcon(Codicon.linkExternal));
		this._register(addDisposableListener(this.manage, 'click', e => {
			EventHelper.stop(e, true);
			this.card.hide();
			void this.commandService.executeCommand(OPEN_AGENT_RESOURCES_COMMAND_ID, 'overview', this.folder);
		}));
		this._register(addDisposableListener(this.head, 'click', () => {
			this.open = !this.open;
			this.card.hide();
			this.render();
		}));
		this.listHost = append(this.element, $('.volt-agent-resources-list'));
		this.card = this._register(instantiationService.createInstance(AgentResourcesCard,
			(group: IAgentResourceGroup) => this.showInSidebar(group.id),
			(group: IAgentResourceGroup) => void this.commandService.executeCommand(OPEN_AGENT_RESOURCES_COMMAND_ID, agentResourcesSectionFor(group.id), this.folder)));
		const renderer = new GroupRenderer((row, element) => this.onHover(row, element));
		this.list = this._register(instantiationService.createInstance(WorkbenchList<IGroupRow>, 'VoltAgentResourceGroups', this.listHost, new GroupDelegate(), [renderer], {
			identityProvider: { getId: (row: IGroupRow) => row.group?.id ?? 'manage' },
			multipleSelectionSupport: false,
			horizontalScrolling: false,
			alwaysConsumeMouseWheel: false,
			accessibilityProvider: {
				getWidgetAriaLabel: () => localize('agentResources.groupsAria', "Agent Resources"),
				getAriaLabel: (row: IGroupRow) => row.group
					? localize('agentResources.groupAria', "{0}, {1} files", row.group.label, row.items.length)
					: localize('agentResources.manage', "Open Agent Resources"),
			},
		}));
		this._register(this.list.onDidOpen(e => {
			if (e.element) {
				this.card.hide();
				if (e.element.group) {
					this.showInSidebar(e.element.group.id);
				} else {
					void this.commandService.executeCommand(OPEN_AGENT_RESOURCES_COMMAND_ID, 'overview', this.folder);
				}
			}
		}));
		this._register(this.list.onDidBlur(() => this.list.setSelection([])));
		this._register(resources.onDidChange(folder => {
			if (this.folder && folder.toString() === this.folder.toString()) {
				this.render();
			}
		}));
		this.render();
	}

	setSession(sessionId: string | undefined): void {
		const folder = sessionId ? this.resources.folderForSession(sessionId) : undefined;
		if (folder?.toString() === this.folder?.toString()) {
			return;
		}
		this.folder = folder;
		this.card.hide();
		this.render();
		// The scan waits for an idle moment: switching chats or opening the window never waits on it.
		this.pendingLoad.value = folder && !this.resources.get(folder) ? runWhenWindowIdle(getWindow(this.element), () => {
			void this.resources.load(folder).then(() => {
				if (this.folder?.toString() === folder.toString()) {
					this.render();
				}
			});
		}, 2000) : undefined;
	}

	private showInSidebar(filter: AgentResourceFilter): void {
		void this.commandService.executeCommand(SHOW_AGENT_RESOURCES_COMMAND_ID, filter);
	}

	private onHover(row: HTMLElement, element: IGroupRow | undefined): void {
		if (!element?.group || !this.folder) {
			this.card.scheduleHide();
			return;
		}
		this.card.show(row, element.group, this.folder, element.items);
	}

	private render(): void {
		const items = this.folder ? this.resources.get(this.folder) ?? [] : [];
		// Only groups with files: the toolbar stays short in a project with little agent setup.
		const groupRows: IGroupRow[] = AGENT_RESOURCE_GROUPS
			.map(group => {
				const groupItems = items.filter(item => item.group === group.id);
				return { group, items: groupItems, issues: groupItems.filter(item => item.status.kind !== 'ok').length };
			})
			.filter(row => row.items.length > 0);
		// A project with none of its own still gets the section: global skills, MCP and the harness live behind it.
		const rows: IGroupRow[] = groupRows.length ? groupRows : [{ group: undefined, items: [], issues: 0 }];
		// A class, not display: the divider rule between sections skips hidden ones (agentSubagents.css).
		this.element.classList.toggle('hidden', !this.folder);
		this.head.setAttribute('aria-expanded', String(this.open));
		this.headLabel.textContent = items.length
			? localize('agentResources.title', "Agent Resources ({0})", items.length)
			: localize('agentResources.titleEmpty', "Agent Resources");
		this.head.replaceChildren(renderIcon(this.open ? Codicon.chevronDown : Codicon.chevronRight), this.headLabel, this.manage);
		const shown = this.open ? rows : [];
		const height = shown.length * ROW_HEIGHT;
		this.listHost.style.height = `${height}px`;
		this.listHost.style.display = height ? '' : 'none';
		this.list.layout(height);
		this.list.splice(0, this.list.length, shown);
	}
}
