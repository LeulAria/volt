/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import '../media/agentHomePane.css';
import { $, addDisposableListener, append, isMouseEvent } from '../../../../../base/browser/dom.js';
import { renderIcon } from '../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { IIdentityProvider, IListVirtualDelegate } from '../../../../../base/browser/ui/list/list.js';
import { IListAccessibilityProvider } from '../../../../../base/browser/ui/list/listWidget.js';
import { RenderIndentGuides } from '../../../../../base/browser/ui/tree/abstractTree.js';
import { IObjectTreeElement, ITreeNode, ITreeRenderer, ObjectTreeElementCollapseState } from '../../../../../base/browser/ui/tree/tree.js';
import { RunOnceScheduler } from '../../../../../base/common/async.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { Disposable, DisposableStore, IDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { basename } from '../../../../../base/common/resources.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { localize } from '../../../../../nls.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IContextViewService } from '../../../../../platform/contextview/browser/contextView.js';
import { IFileDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../../platform/keybinding/common/keybinding.js';
import { ILabelService } from '../../../../../platform/label/common/label.js';
import { WorkbenchObjectTree } from '../../../../../platform/list/browser/listService.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { IEditorGroupsService } from '../../../../services/editor/common/editorGroupsService.js';
import { IAgentHistoryService, IAgentSessionMeta } from '../../../../services/voltRuntime/common/history/agentHistory.js';
import { IVoltSessionContextService, uriFromStoredRoot } from '../../../../services/voltRuntime/common/sessionContext.js';
import { IRecentFolder, IRecentWorkspace, IWorkspacesService, isRecentFolder, isRecentWorkspace } from '../../../../../platform/workspaces/common/workspaces.js';
import { NEW_AGENT_COMMAND_ID, OPEN_AGENT_COMMAND_ID, OPEN_AGENT_CUSTOMIZE_COMMAND_ID } from '../editor/agentEditorInput.js';
import { createHomeFilterIcon, createHomeFolderIcon, createHomeFoldersIcon, createHomeNewChatIcon, createHomeNewProjectIcon, createHomeSearchIcon } from './agentHomeIcons.js';
import { activateAgentProject, startAgentChat } from '../workspace/agentPanels.js';
import { AgentChatStart } from '../workspace/agentShell.js';
import { IAgentWorkspaceService } from '../workspace/agentWorkspace.js';
import { AgentTooltip, IAgentTooltipRow, setAgentTooltip } from '../chrome/agentTooltip.js';
import {
	AGENT_HOME_VIEW_STORAGE_KEY,
	anyHomeFilterActive,
	defaultAgentHomeViewState,
	IAgentHomeViewState,
	reviveAgentHomeViewState,
	serializeAgentHomeViewState,
	sessionFolders,
	sessionPrimaryStatus,
} from './agentHomeFilter.js';
import { showAgentHomeFilterMenu } from './agentHomeFilterMenu.js';
import {
	AGENT_HOME_GROUP_EXPAND_ALL,
	AgentHomeActionId,
	AgentHomeElement,
	agentHomeAddStart,
	agentHomeGroupLabel,
	agentHomeSectionLabel,
	buildAgentHomeTree,
	folderPath,
	IAgentHomeFolder,
	IAgentHomeNode,
	IAgentHomeProject,
	IAgentHomeSessionContext,
	sessionMetaParts,
} from './agentHomeModel.js';
import { AgentRepoResolver, dominantRepoOwner, IAgentRepoInfo, repoDisplayName, repoInitials } from './agentRepoInfo.js';
import { agentSessionHoverRows, agentSessionStatusNote } from './agentSessionHover.js';

const ROW_HEIGHT = 28;
/** How long the pointer rests on an agent tab before its details card opens. */
const SESSION_HOVER_DELAY_MS = 500;

const identityProvider: IIdentityProvider<AgentHomeElement> = {
	getId(element) {
		switch (element.type) {
			case 'newChat': return 'newChat';
			case 'action': return `action:${element.id}`;
			case 'section': return `section:${element.key}`;
			case 'folder': return `folder:${element.project.key}`;
			case 'bucket': return `bucket:${element.id}`;
			case 'group': return `group:${element.id}`;
			case 'session': return `session:${element.folderKey}:${element.session.id}`;
			case 'more': return `more:${element.groupKey}`;
			case 'empty': return `empty:${element.key}`;
			default: {
				const unexpected: never = element;
				return unexpected;
			}
		}
	}
};

interface IHomeTemplate {
	readonly container: HTMLElement;
	readonly icon: HTMLElement;
	readonly twist: HTMLElement;
	readonly glyph: HTMLElement;
	readonly name: HTMLElement;
	readonly actions: HTMLElement;
	readonly pin: HTMLButtonElement;
	readonly archive: HTMLButtonElement;
	readonly meta: HTMLElement;
	readonly keybinding: HTMLElement;
	readonly filter: HTMLButtonElement;
	readonly add: HTMLButtonElement;
	readonly elementDisposables: DisposableStore;
}

const ROW_STATE_CLASSES = [
	'is-new', 'is-action', 'is-section', 'is-folder', 'is-bucket', 'is-group', 'is-session', 'is-more', 'is-empty',
	'is-nested', 'is-flat', 'is-collapsible', 'current', 'unread', 'archived', 'pinned',
	'status-needsAttention', 'status-working', 'status-draft', 'status-done',
];

class AgentHomeDelegate implements IListVirtualDelegate<AgentHomeElement> {
	getHeight(): number {
		return ROW_HEIGHT;
	}

	getTemplateId(): string {
		return AgentHomeRenderer.ID;
	}
}

class AgentHomeRenderer implements ITreeRenderer<AgentHomeElement, void, IHomeTemplate> {
	static readonly ID = 'agentHome';
	readonly templateId = AgentHomeRenderer.ID;

	constructor(
		private readonly host: AgentHomePane,
		private readonly keybindingService: IKeybindingService,
	) { }

	renderTemplate(container: HTMLElement): IHomeTemplate {
		container.classList.add('volt-agent-home-row');
		const icon = append(container, $('span.icon'));
		const twist = append(icon, $('span.twist'));
		twist.appendChild(renderIcon(Codicon.chevronDown));
		const glyph = append(icon, $('span.glyph'));
		const name = append(container, $('span.name'));
		const actions = append(container, $('span.actions'));
		const pin = append(actions, $('button.row-action')) as HTMLButtonElement;
		pin.tabIndex = -1;
		const archive = append(actions, $('button.row-action')) as HTMLButtonElement;
		archive.tabIndex = -1;
		const meta = append(container, $('span.meta'));
		const keybinding = append(container, $('span.keybinding'));
		const filter = append(container, $('button.volt-agent-home-filter.hidden')) as HTMLButtonElement;
		filter.appendChild(createHomeFilterIcon());
		filter.tabIndex = -1;
		filter.setAttribute('aria-label', localize('voltAgent.home.filter', "Filter and sort"));
		setAgentTooltip(filter, localize('voltAgent.home.filter', "Filter and sort"));
		const add = append(container, $('button.add')) as HTMLButtonElement;
		add.appendChild(renderIcon(Codicon.add));
		add.tabIndex = -1;
		return { container, icon, twist, glyph, name, actions, pin, archive, meta, keybinding, filter, add, elementDisposables: new DisposableStore() };
	}

	renderElement(node: ITreeNode<AgentHomeElement, void>, _index: number, template: IHomeTemplate): void {
		template.elementDisposables.clear();
		template.glyph.replaceChildren();
		template.name.textContent = '';
		template.meta.textContent = '';
		template.keybinding.textContent = '';
		template.filter.classList.add('hidden');
		template.filter.classList.remove('active');
		template.add.classList.add('hidden');
		template.container.classList.remove(...ROW_STATE_CLASSES);
		template.container.style.setProperty('--volt-home-level', String(rowLevel(node.element)));
		template.container.classList.toggle('collapsed', !!node.collapsed);

		const element = node.element;
		// Group headers: collapsed left / expanded down. Folder rows keep collapsed right.
		const collapsedChevron = (element.type === 'bucket' || element.type === 'group')
			? Codicon.chevronLeft
			: Codicon.chevronRight;
		template.twist.replaceChildren(renderIcon(node.collapsed ? collapsedChevron : Codicon.chevronDown));
		switch (element.type) {
			case 'newChat':
				template.container.classList.add('is-new');
				template.glyph.appendChild(createHomeNewChatIcon());
				template.name.textContent = localize('voltAgent.home.newChat', "New Chat");
				template.keybinding.textContent = this.keybindingService.lookupKeybinding(NEW_AGENT_COMMAND_ID)?.getLabel() ?? '';
				break;
			case 'action':
				this.renderAction(element.id, template);
				break;
			case 'section':
				this.renderSection(element, template);
				break;
			case 'folder':
				this.renderFolder(element.project, node.collapsible, template);
				break;
			case 'bucket':
				this.renderBucket(element, template);
				break;
			case 'group':
				this.renderGroup(element, template);
				break;
			case 'session':
				this.renderSession(element, template);
				break;
			case 'more':
				template.container.classList.add('is-more');
				template.container.classList.toggle('is-nested', element.nested);
				template.name.textContent = localize('voltAgent.home.showMore', "Show more");
				break;
			case 'empty':
				template.container.classList.add('is-empty');
				template.name.textContent = element.filtered
					? localize('voltAgent.home.noMatches', "No agents match these filters")
					: localize('voltAgent.home.noAgents', "No agents yet");
				break;
			default: {
				const unexpected: never = element;
				return unexpected;
			}
		}
	}

	private renderAction(id: AgentHomeActionId, template: IHomeTemplate): void {
		template.container.classList.add('is-action');
		const spec = actionSpec(id);
		switch (id) {
			case 'search':
				template.glyph.appendChild(createHomeSearchIcon());
				break;
			case 'newProject':
				template.glyph.appendChild(createHomeNewProjectIcon());
				break;
			case 'automations':
			case 'customize':
				template.glyph.appendChild(renderIcon(spec.icon));
				break;
			default: {
				const unexpected: never = id;
				return unexpected;
			}
		}
		template.name.textContent = spec.label;
	}

	/** The filter control on a header row. Only one header carries it. */
	private renderFilter(template: IHomeTemplate): void {
		template.filter.classList.remove('hidden');
		template.filter.classList.toggle('active', anyHomeFilterActive(this.host.view));
		template.elementDisposables.add(addDisposableListener(template.filter, 'click', e => {
			e.preventDefault();
			e.stopPropagation();
			this.host.openFilterMenu(template.filter);
			template.filter.blur();
		}));
	}

	private renderSection(element: Extract<AgentHomeElement, { type: 'section' }>, template: IHomeTemplate): void {
		template.container.classList.add('is-section');
		template.name.textContent = agentHomeSectionLabel(element.key);
		if (element.filter) {
			this.renderFilter(template);
		}
		if (element.add) {
			template.add.classList.remove('hidden');
			template.add.title = localize('voltAgent.home.newProject', "New Project");
			template.elementDisposables.add(addDisposableListener(template.add, 'click', e => {
				e.preventDefault();
				e.stopPropagation();
				void this.host.addProject();
			}));
		}
	}

	private renderFolder(project: IAgentHomeProject, collapsible: boolean, template: IHomeTemplate): void {
		template.container.classList.add('is-folder');
		template.container.classList.toggle('current', project.current);
		template.container.classList.toggle('is-collapsible', collapsible);
		template.glyph.appendChild(project.multi ? createHomeFoldersIcon() : createHomeFolderIcon());
		template.name.textContent = project.label;
		this.renderAdd(template, { type: 'folder', project });
	}

	/** Pinned, Today, Needs Attention, This Mac, ...: a VS Code style group header over agent tabs. */
	private renderBucket(element: Extract<AgentHomeElement, { type: 'bucket' }>, template: IHomeTemplate): void {
		template.container.classList.add('is-group', 'is-collapsible');
		template.name.textContent = element.label;
		if (element.filter) {
			this.renderFilter(template);
		}
		this.renderAdd(template, element);
	}

	/** + on project rows (hover-only via CSS) and group headers (always visible); start rules live in {@link agentHomeAddStart}. */
	private renderAdd(template: IHomeTemplate, element: AgentHomeElement): void {
		const start = agentHomeAddStart(element);
		if (!start) {
			return;
		}
		template.add.classList.remove('hidden');
		template.add.title = start.kind === 'folder'
			? localize('voltAgent.home.newChatInProject', "New chat in {0}", start.name)
			: localize('voltAgent.home.newChat', "New Chat");
		template.elementDisposables.add(addDisposableListener(template.add, 'click', e => {
			e.preventDefault();
			e.stopPropagation();
			void this.host.startChat(start);
		}));
	}

	private renderGroup(element: Extract<AgentHomeElement, { type: 'group' }>, template: IHomeTemplate): void {
		template.container.classList.add('is-group', 'is-collapsible');
		template.name.textContent = agentHomeGroupLabel(element.id);
	}

	private renderSession(element: Extract<AgentHomeElement, { type: 'session' }>, template: IHomeTemplate): void {
		const session = element.session;
		const status = sessionPrimaryStatus(session);
		const context = this.host.sessionContext(session);
		template.container.classList.add('is-session', `status-${status}`, element.nested ? 'is-nested' : 'is-flat');
		template.container.classList.toggle('unread', !!session.unread);
		template.container.classList.toggle('archived', !!session.archived);
		template.container.classList.toggle('pinned', !!session.pinned);

		// Under a project a dot is enough; in a flat list the project's initials say where the tab lives.
		if (element.nested || !context.initials) {
			append(template.glyph, $('span.volt-agent-home-dot'));
		} else {
			append(template.glyph, $('span.volt-agent-home-initials')).textContent = context.initials;
		}
		template.name.textContent = session.title || localize('voltAgent.home.untitled', "New Agent");
		template.meta.textContent = sessionMetaParts(session, context, this.host.view, Date.now()).join(' · ');

		this.renderRowAction(template, template.pin, session.pinned ? Codicon.pinned : Codicon.pin,
			session.pinned ? localize('voltAgent.home.unpin', "Unpin") : localize('voltAgent.home.pin', "Pin"),
			() => this.host.togglePin(session));
		this.renderRowAction(template, template.archive, Codicon.archive,
			session.archived ? localize('voltAgent.home.unarchive', "Unarchive") : localize('voltAgent.home.archive', "Archive"),
			() => this.host.toggleArchive(session));
		template.elementDisposables.add(this.host.bindSessionHover(template.container, session));
	}

	private renderRowAction(template: IHomeTemplate, button: HTMLButtonElement, icon: ThemeIcon, label: string, run: () => void): void {
		button.replaceChildren(renderIcon(icon));
		button.setAttribute('aria-label', label);
		template.elementDisposables.add(addDisposableListener(button, 'mousedown', e => e.stopPropagation()));
		template.elementDisposables.add(addDisposableListener(button, 'click', e => {
			e.preventDefault();
			e.stopPropagation();
			run();
		}));
	}

	disposeElement(_node: ITreeNode<AgentHomeElement, void>, _index: number, template: IHomeTemplate): void {
		template.elementDisposables.clear();
	}

	disposeTemplate(template: IHomeTemplate): void {
		template.elementDisposables.dispose();
	}
}

/** Headers sit flush; agent tabs under a project or time/status group step in once (~12px). */
function rowLevel(element: AgentHomeElement): number {
	switch (element.type) {
		case 'session':
		case 'more':
			return 1;
		case 'newChat':
		case 'action':
		case 'section':
		case 'folder':
		case 'bucket':
		case 'group':
		case 'empty':
			return 0;
		default: {
			const unexpected: never = element;
			return unexpected;
		}
	}
}

function elementLabel(element: AgentHomeElement): string {
	switch (element.type) {
		case 'newChat': return localize('voltAgent.home.newChat', "New Chat");
		case 'action': return actionSpec(element.id).label;
		case 'section': return agentHomeSectionLabel(element.key);
		case 'folder': return element.project.label;
		case 'bucket': return element.label;
		case 'group': return agentHomeGroupLabel(element.id);
		case 'session': return element.session.title || localize('voltAgent.home.untitled', "New Agent");
		case 'more': return localize('voltAgent.home.showMore', "Show more");
		case 'empty': return element.filtered
			? localize('voltAgent.home.noMatches', "No agents match these filters")
			: localize('voltAgent.home.noAgents', "No agents yet");
		default: {
			const unexpected: never = element;
			return unexpected;
		}
	}
}

class AgentHomeAccessibilityProvider implements IListAccessibilityProvider<AgentHomeElement> {
	getWidgetAriaLabel(): string {
		return localize('voltAgent.home.list', "Agent Home");
	}

	getAriaLabel(element: AgentHomeElement): string {
		return elementLabel(element);
	}
}

function actionSpec(id: AgentHomeActionId): { readonly label: string; readonly icon: ThemeIcon } {
	switch (id) {
		case 'search':
			return { label: localize('voltAgent.home.search', "Search"), icon: Codicon.search };
		case 'automations':
			return { label: localize('voltAgent.home.automations', "Automations"), icon: Codicon.settingsGear };
		case 'customize':
			return { label: localize('voltAgent.home.customize', "Customize"), icon: Codicon.extensions };
		case 'newProject':
			return { label: localize('voltAgent.home.newProjectRow', "New project"), icon: Codicon.newFolder };
		default: {
			const unexpected: never = id;
			return unexpected;
		}
	}
}

function sameRepo(a: IAgentRepoInfo | undefined, b: IAgentRepoInfo | undefined): boolean {
	return a?.id === b?.id && a?.name === b?.name && a?.owner === b?.owner && a?.branch === b?.branch && a?.root.toString() === b?.root.toString();
}

export class AgentHomePane extends Disposable {

	readonly element: HTMLElement;
	private readonly nav: HTMLElement;
	private readonly treeContainer: HTMLElement;
	private readonly tree: WorkbenchObjectTree<AgentHomeElement>;
	private readonly hover = this._register(new AgentTooltip());
	private readonly repoResolver: AgentRepoResolver;
	/** Repository facts by folder path; filled in the background and applied on the next refresh. */
	private readonly repos = new Map<string, IAgentRepoInfo>();
	/** Rows revealed by "More", per group. */
	private readonly limits = new Map<string, number>();
	private readonly repoRefresh = this._register(new RunOnceScheduler(() => void this.refresh(), 50));
	private refreshSeq = 0;
	private viewState: IAgentHomeViewState;

	constructor(
		parent: HTMLElement,
		@ICommandService private readonly commandService: ICommandService,
		@IContextViewService private readonly contextViewService: IContextViewService,
		@IFileDialogService private readonly fileDialogService: IFileDialogService,
		@IFileService fileService: IFileService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IKeybindingService keybindingService: IKeybindingService,
		@ILabelService private readonly labelService: ILabelService,
		@IWorkspaceContextService private readonly workspaceService: IWorkspaceContextService,
		@IWorkspacesService private readonly workspacesService: IWorkspacesService,
		@IAgentHistoryService private readonly history: IAgentHistoryService,
		@IVoltSessionContextService private readonly voltSessionContext: IVoltSessionContextService,
		@IAgentWorkspaceService private readonly agentWorkspace: IAgentWorkspaceService,
		@IEditorGroupsService private readonly editorGroupsService: IEditorGroupsService,
		@IStorageService private readonly storageService: IStorageService,
	) {
		super();
		this.repoResolver = new AgentRepoResolver(fileService);
		this.viewState = this.readViewState();
		this.element = append(parent, $('.volt-agent-home'));
		this.keepSingleHome(parent);

		this.nav = append(this.element, $('.volt-agent-home-nav'));
		this.installNav(keybindingService);
		this.treeContainer = append(this.element, $('.volt-agent-home-tree'));

		this.tree = this._register(this.instantiationService.createInstance(
			WorkbenchObjectTree<AgentHomeElement>,
			'AgentHome',
			this.treeContainer,
			new AgentHomeDelegate(),
			[new AgentHomeRenderer(this, keybindingService)],
			{
				accessibilityProvider: new AgentHomeAccessibilityProvider(),
				keyboardNavigationLabelProvider: {
					getKeyboardNavigationLabel: (element: AgentHomeElement) => elementLabel(element),
				},
				identityProvider,
				multipleSelectionSupport: false,
				hideTwistiesOfChildlessElements: false,
				renderIndentGuides: RenderIndentGuides.None,
				expandOnlyOnTwistieClick: false,
				// Every node carries its own default collapse state; see toTreeElement.
				paddingBottom: ROW_HEIGHT,
				setRowLineHeight: false,
				horizontalScrolling: false,
				transformOptimization: false,
				// Sticky group headers cover the rows underneath with the sidebar plate.
				stickyScrollBackdrop: true,
			}
		));

		this._register(this.tree.onDidOpen(e => {
			const element = e.element;
			if (!element) {
				return;
			}
			if (this.isExpandToggleClick(element, e.browserEvent)) {
				return;
			}
			void this.activate(element).finally(() => {
				if (element.type === 'newChat' || element.type === 'action' || element.type === 'more' || element.type === 'empty') {
					this.tree.setSelection([]);
					this.tree.setFocus([]);
				}
			});
		}));

		this._register(this.workspacesService.onDidChangeRecentlyOpened(() => void this.refresh()));
		this._register(this.workspaceService.onDidChangeWorkspaceFolders(() => void this.refresh()));
		this._register(this.workspaceService.onDidChangeWorkbenchState(() => void this.refresh()));
		this._register(this.history.onDidChange(() => void this.refresh()));
		this._register(this.voltSessionContext.onDidChangeProjects(() => void this.refresh()));
		this._register(this.voltSessionContext.onDidChangeActiveProject(() => void this.refresh()));

		const observer = new ResizeObserver(() => this.layout());
		observer.observe(this.treeContainer);
		this._register(toDisposable(() => observer.disconnect()));
		void this.refresh();
	}

	/**
	 * Top actions stay outside the virtualized tree so they pin while chats scroll.
	 * Padding lives on `.volt-agent-home-nav`. The block has no fill and no fade.
	 */
	private installNav(keybindingService: IKeybindingService): void {
		const shortcut = keybindingService.lookupKeybinding(NEW_AGENT_COMMAND_ID)?.getLabel() ?? '';
		const rows: Array<{ readonly element: AgentHomeElement; readonly label: string }> = [
			{ element: { type: 'newChat' }, label: localize('voltAgent.home.newChat', "New Chat") },
			{ element: { type: 'action', id: 'search' }, label: actionSpec('search').label },
			{ element: { type: 'action', id: 'automations' }, label: actionSpec('automations').label },
			{ element: { type: 'action', id: 'customize' }, label: actionSpec('customize').label },
			{ element: { type: 'action', id: 'newProject' }, label: actionSpec('newProject').label },
		];
		for (const row of rows) {
			const button = append(this.nav, $('button.volt-agent-home-nav-row')) as HTMLButtonElement;
			button.type = 'button';
			button.setAttribute('aria-label', row.label);
			const container = append(button, $('.volt-agent-home-row'));
			const icon = append(container, $('span.icon'));
			append(icon, $('span.twist'));
			const glyph = append(icon, $('span.glyph'));
			append(container, $('span.name')).textContent = row.label;
			const keybinding = append(container, $('span.keybinding'));
			if (row.element.type === 'newChat') {
				container.classList.add('is-new');
				glyph.appendChild(createHomeNewChatIcon());
				keybinding.textContent = shortcut;
			} else {
				container.classList.add('is-action');
				switch (row.element.id) {
					case 'search':
						glyph.appendChild(createHomeSearchIcon());
						break;
					case 'newProject':
						glyph.appendChild(createHomeNewProjectIcon());
						break;
					case 'automations':
					case 'customize':
						glyph.appendChild(renderIcon(actionSpec(row.element.id).icon));
						break;
					default: {
						const unexpected: never = row.element.id;
						return unexpected;
					}
				}
			}
			this._register(addDisposableListener(button, 'click', e => {
				e.preventDefault();
				e.stopPropagation();
				void this.activate(row.element);
				button.blur();
			}));
		}
	}

	get view(): IAgentHomeViewState {
		return this.viewState;
	}

	focus(): void {
		this.tree.domFocus();
	}

	async addProject(): Promise<void> {
		const picked = await this.fileDialogService.showOpenDialog({
			canSelectFiles: false,
			canSelectFolders: true,
			canSelectMany: false,
			title: localize('voltAgent.home.newProject', "New Project"),
			openLabel: localize('voltAgent.home.addProject', "Add"),
		});
		const folder = picked?.[0];
		if (!folder) {
			return;
		}
		await this.openFolder({ uri: folder, name: basename(folder), current: false, workspace: false });
	}

	async startChat(start: AgentChatStart): Promise<void> {
		await startAgentChat(
			this.voltSessionContext,
			this.agentWorkspace,
			this.history,
			this.editorGroupsService,
			this.instantiationService,
			start,
		);
	}

	setView(next: IAgentHomeViewState): void {
		this.viewState = next;
		this.storageService.store(AGENT_HOME_VIEW_STORAGE_KEY, JSON.stringify(serializeAgentHomeViewState(next)), StorageScope.PROFILE, StorageTarget.USER);
		this.syncFilterButton();
		void this.refresh();
	}

	/** Folds every group; the Repositories / Workspaces header stays open so its rows remain. */
	collapseAll(): void {
		for (const node of this.tree.getNode(null).children) {
			if (node.element?.type === 'section') {
				for (const child of node.children) {
					this.collapseRecursive(child);
				}
				continue;
			}
			this.collapseRecursive(node);
		}
	}

	markAllAsRead(): void {
		void this.history.markAllRead();
	}

	togglePin(session: IAgentSessionMeta): void {
		void this.history.setPinned(session.id, !session.pinned);
	}

	toggleArchive(session: IAgentSessionMeta): void {
		this.hover.hide();
		void this.history.setArchived(session.id, !session.archived);
	}

	openFilterMenu(anchor: HTMLElement): void {
		const pane = this;
		showAgentHomeFilterMenu(this.contextViewService, anchor, {
			get view() {
				return pane.view;
			},
			setView: next => pane.setView(next),
			collapseAll: () => pane.collapseAll(),
			markAllAsRead: () => pane.markAllAsRead(),
		});
	}

	/** Where a session lives, as far as the row can tell: repository or folder name, branch, initials. */
	sessionContext(session: IAgentSessionMeta): IAgentHomeSessionContext & { readonly initials: string } {
		const primary = sessionFolders(session)[0];
		const repo = primary ? this.repos.get(primary) : undefined;
		const folderName = primary ? basename(uriFromStoredRoot(primary)) : undefined;
		const name = repo?.name || folderName || session.workspaceLabel;
		return {
			workspace: repo ? repoDisplayName(repo, dominantRepoOwner(this.repos.values())) : (folderName || session.workspaceLabel || undefined),
			branch: repo?.branch,
			initials: name ? repoInitials(name) : '',
		};
	}

	/** Details card beside an agent tab: title, last-run note, branch, and the folder on disk. */
	bindSessionHover(anchor: HTMLElement, session: IAgentSessionMeta): IDisposable {
		return this.hover.bind(anchor, () => this.sessionHoverRows(session), { placement: 'end', variant: 'card', delay: SESSION_HOVER_DELAY_MS });
	}

	private sessionHoverRows(session: IAgentSessionMeta): IAgentTooltipRow[] {
		const folders = sessionFolders(session).map(path => ({
			pathLabel: this.labelService.getUriLabel(uriFromStoredRoot(path)),
			repo: this.repos.get(path),
		}));
		return agentSessionHoverRows(
			session.title || localize('voltAgent.home.untitled', "New Agent"),
			agentSessionStatusNote(session),
			folders,
			session.workspaceLabel,
		);
	}

	showMore(groupKey: string): void {
		this.limits.set(groupKey, AGENT_HOME_GROUP_EXPAND_ALL);
		void this.refresh();
	}

	/**
	 * A single click anywhere on a collapsible folder/group/bucket toggles it.
	 * Switching into that folder stays on double-click and keyboard.
	 */
	private isExpandToggleClick(element: AgentHomeElement, browserEvent: UIEvent | undefined): boolean {
		if (!isMouseEvent(browserEvent) || browserEvent.detail === 2) {
			return false;
		}
		switch (element.type) {
			case 'folder':
			case 'bucket':
			case 'group':
			case 'section':
				return this.tree.getNode(element).collapsible;
			case 'newChat':
			case 'action':
			case 'session':
			case 'more':
			case 'empty':
				return false;
			default: {
				const unexpected: never = element;
				return unexpected;
			}
		}
	}

	private async activate(element: AgentHomeElement): Promise<void> {
		switch (element.type) {
			case 'newChat':
				await this.startChat({ kind: 'active' });
				return;
			case 'action':
				await this.runAction(element.id);
				return;
			case 'section':
			case 'bucket':
			case 'group':
			case 'empty':
				return;
			case 'folder':
				await this.openProject(element);
				return;
			case 'session':
				await this.commandService.executeCommand(OPEN_AGENT_COMMAND_ID, element.session.id);
				return;
			case 'more':
				this.showMore(element.groupKey);
				return;
			default: {
				const unexpected: never = element;
				return unexpected;
			}
		}
	}

	/** A single-folder row opens its folder; a multi-folder row opens its most recent agent tab. */
	private async openProject(element: Extract<AgentHomeElement, { type: 'folder' }>): Promise<void> {
		const folder = element.project.folder;
		if (folder && !folder.workspace) {
			await this.openFolder(folder);
			return;
		}
		const first = this.tree.getNode(element).children[0]?.element;
		if (first?.type === 'session') {
			await this.commandService.executeCommand(OPEN_AGENT_COMMAND_ID, first.session.id);
		}
	}

	private async runAction(id: AgentHomeActionId): Promise<void> {
		switch (id) {
			case 'search':
				await this.commandService.executeCommand('workbench.action.showCommands');
				return;
			case 'automations':
			case 'customize':
				await this.commandService.executeCommand(OPEN_AGENT_CUSTOMIZE_COMMAND_ID);
				return;
			case 'newProject':
				// Placeholder: behavior TBD. Keep a no-op so the row is clickable without throwing.
				return;
			default: {
				const unexpected: never = id;
				return unexpected;
			}
		}
	}

	private currentKeys(): Set<string> {
		const active = this.voltSessionContext.activeProject;
		if (active) {
			return new Set([active.root.toString()]);
		}
		const workspace = this.workspaceService.getWorkspace();
		const keys = new Set(workspace.folders.map(folder => folder.uri.toString()));
		if (workspace.configuration) {
			keys.add(workspace.configuration.toString());
		}
		return keys;
	}

	private async openFolder(folder: IAgentHomeFolder): Promise<void> {
		await activateAgentProject(
			this.voltSessionContext,
			this.agentWorkspace,
			this.history,
			this.editorGroupsService,
			this.instantiationService,
			folder.uri,
			folder.name,
		);
	}

	private async refresh(): Promise<void> {
		const seq = ++this.refreshSeq;
		const current = this.currentKeys();
		const projects = this.voltSessionContext.projects.map(project => ({
			uri: project.root,
			name: project.displayName,
			current: current.has(project.root.toString()),
			workspace: false,
		}));
		const recents = await this.workspacesService.getRecentlyOpened();
		if (seq !== this.refreshSeq) {
			return;
		}
		const projectKeys = new Set(projects.map(project => project.uri.toString()));
		const extras: IAgentHomeFolder[] = [];
		for (const recent of recents.workspaces) {
			const folder = this.toFolder(recent, current);
			if (!folder || projectKeys.has(folder.uri.toString())) {
				continue;
			}
			extras.push(folder);
		}
		const folders = [...projects, ...extras];
		const sessions = this.history.list({ includeArchived: this.viewState.archived === 'show' });
		this.resolveRepos(folders, sessions);
		const tree = buildAgentHomeTree(folders, sessions, this.viewState, { repos: this.repos, limits: this.limits });
		this.tree.setChildren(null, tree.map(toTreeElement));
		this.tree.rerender();
		this.expandHomeSections();
		this.syncFilterButton();
		this.layout();
	}

	/**
	 * Reads git facts for every folder the list can show. The resolver caches
	 * them, so a refresh only follows when a repository or branch changed.
	 */
	private resolveRepos(folders: readonly IAgentHomeFolder[], sessions: readonly IAgentSessionMeta[]): void {
		const paths = new Set<string>();
		for (const folder of folders) {
			if (!folder.workspace) {
				paths.add(folderPath(folder.uri));
			}
		}
		for (const session of sessions) {
			for (const path of sessionFolders(session)) {
				paths.add(path);
			}
		}
		for (const path of paths) {
			let uri;
			try {
				uri = uriFromStoredRoot(path);
			} catch {
				continue;
			}
			void this.repoResolver.resolve(uri).then(repo => {
				if (this._store.isDisposed || sameRepo(this.repos.get(path), repo)) {
					return;
				}
				if (repo) {
					this.repos.set(path, repo);
				} else {
					this.repos.delete(path);
				}
				this.repoRefresh.schedule();
			});
		}
	}

	private expandHomeSections(): void {
		for (const node of this.tree.getNode(null).children) {
			// Keep the project section open; folder expand/collapse is left to the user and preserved across refresh.
			if (node.element?.type === 'section' && node.collapsible) {
				this.tree.expand(node.element);
			}
		}
	}

	private collapseRecursive(node: ITreeNode<AgentHomeElement | null, void>): void {
		if (node.element && node.collapsible) {
			this.tree.collapse(node.element);
		}
		for (const child of node.children) {
			this.collapseRecursive(child);
		}
	}

	private syncFilterButton(): void {
		const active = anyHomeFilterActive(this.viewState);
		for (const button of this.treeContainer.querySelectorAll('.volt-agent-home-filter')) {
			button.classList.toggle('active', active);
		}
	}

	private readViewState(): IAgentHomeViewState {
		try {
			const raw = this.storageService.get(AGENT_HOME_VIEW_STORAGE_KEY, StorageScope.PROFILE);
			return raw ? reviveAgentHomeViewState(JSON.parse(raw)) : defaultAgentHomeViewState();
		} catch {
			return defaultAgentHomeViewState();
		}
	}

	/** A second pane would paint over the first after a workspace switch. */
	private keepSingleHome(parent: HTMLElement): void {
		for (const el of parent.querySelectorAll(':scope > .volt-agent-home')) {
			if (el !== this.element) {
				el.remove();
			}
		}
	}

	private toFolder(recent: IRecentFolder | IRecentWorkspace, current: Set<string>): IAgentHomeFolder | undefined {
		if (isRecentFolder(recent)) {
			return {
				uri: recent.folderUri,
				name: recent.label || this.labelService.getUriBasenameLabel(recent.folderUri),
				current: current.has(recent.folderUri.toString()),
				workspace: false,
			};
		}
		if (isRecentWorkspace(recent)) {
			return {
				uri: recent.workspace.configPath,
				name: recent.label || this.labelService.getUriBasenameLabel(recent.workspace.configPath).replace(/\.code-workspace$/, ''),
				current: current.has(recent.workspace.configPath.toString()),
				workspace: true,
				workspaceId: recent.workspace.id,
			};
		}
		return undefined;
	}

	layout(): void {
		const height = this.treeContainer.clientHeight;
		const width = this.treeContainer.clientWidth;
		if (height <= 0 || width <= 0) {
			return;
		}
		this.tree.layout(height, width);
	}
}

function toTreeElement(node: IAgentHomeNode): IObjectTreeElement<AgentHomeElement> {
	const children = node.children?.map(toTreeElement);
	const hasChildren = !!children?.length;
	let collapsible = false;
	switch (node.element.type) {
		case 'folder':
		case 'bucket':
		case 'group':
		case 'section':
			collapsible = hasChildren;
			break;
		case 'newChat':
		case 'action':
		case 'session':
		case 'more':
		case 'empty':
			collapsible = false;
			break;
		default: {
			const unexpected: never = node.element;
			return unexpected;
		}
	}
	// Preserve user expand/collapse across refresh; fall back to the model default on first insert.
	const collapsed = node.collapsed
		? ObjectTreeElementCollapseState.PreserveOrCollapsed
		: ObjectTreeElementCollapseState.PreserveOrExpanded;
	return {
		element: node.element,
		collapsible,
		collapsed,
		children,
	};
}
