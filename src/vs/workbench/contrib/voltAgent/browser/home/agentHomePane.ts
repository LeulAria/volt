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
import { IObjectTreeElement, ITreeNode, ITreeRenderer } from '../../../../../base/browser/ui/tree/tree.js';
import { disposableTimeout } from '../../../../../base/common/async.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { Disposable, DisposableStore, MutableDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { basename } from '../../../../../base/common/resources.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { URI } from '../../../../../base/common/uri.js';
import { localize } from '../../../../../nls.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IFileDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../../platform/keybinding/common/keybinding.js';
import { ILabelService } from '../../../../../platform/label/common/label.js';
import { WorkbenchObjectTree } from '../../../../../platform/list/browser/listService.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { IHostService } from '../../../../services/host/browser/host.js';
import { IAgentHistoryService, IAgentSessionMeta } from '../../../../services/voltRuntime/common/history/agentHistory.js';
import { IRecentFolder, IRecentWorkspace, IWorkspacesService, isRecentFolder, isRecentWorkspace } from '../../../../../platform/workspaces/common/workspaces.js';
import { NEW_AGENT_COMMAND_ID, OPEN_AGENT_COMMAND_ID, OPEN_AGENT_CUSTOMIZE_COMMAND_ID } from '../editor/agentEditorInput.js';
import { createHomeNewChatIcon, createHomeSearchIcon } from './agentHomeIcons.js';
import { AgentHomeElement, IAgentHomeFolder, IAgentHomeNode, buildAgentHomeTree, compactSessionAge, homeFolderKey } from './agentHomeModel.js';

const PROJECTS_KEY = 'volt.agent.projects';
const PENDING_SWITCH_TIMEOUT = 15000;
const ROW_HEIGHT = 28;

interface IStoredProject {
	readonly uri: string;
	readonly name: string;
}

const identityProvider: IIdentityProvider<AgentHomeElement> = {
	getId(element) {
		switch (element.type) {
			case 'newChat': return 'newChat';
			case 'action': return `action:${element.id}`;
			case 'section': return `section:${element.key}`;
			case 'folder': return `folder:${homeFolderKey(element.folder)}`;
			case 'session': return `session:${element.folderKey}:${element.session.id}`;
		}
	}
};

interface IHomeTemplate {
	readonly container: HTMLElement;
	readonly icon: HTMLElement;
	readonly name: HTMLElement;
	readonly meta: HTMLElement;
	readonly keybinding: HTMLElement;
	readonly add: HTMLButtonElement;
	readonly elementDisposables: DisposableStore;
}

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
		const name = append(container, $('span.name'));
		const meta = append(container, $('span.meta'));
		const keybinding = append(container, $('span.keybinding'));
		const add = append(container, $('button.add')) as HTMLButtonElement;
		add.appendChild(renderIcon(Codicon.add));
		return { container, icon, name, meta, keybinding, add, elementDisposables: new DisposableStore() };
	}

	renderElement(node: ITreeNode<AgentHomeElement, void>, _index: number, template: IHomeTemplate): void {
		template.elementDisposables.clear();
		template.icon.replaceChildren();
		template.name.textContent = '';
		template.meta.textContent = '';
		template.keybinding.textContent = '';
		template.add.classList.add('hidden');
		template.container.classList.remove('is-new', 'is-action', 'is-section', 'is-folder', 'is-session', 'is-nested', 'current', 'pending');
		template.container.classList.toggle('is-nested', node.depth > 1);

		const element = node.element;
		switch (element.type) {
			case 'newChat':
				template.container.classList.add('is-new');
				template.icon.appendChild(createHomeNewChatIcon());
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
				this.renderFolder(element.folder, template);
				break;
			case 'session':
				this.renderSession(element.session, template);
				break;
		}
	}

	private renderAction(id: string, template: IHomeTemplate): void {
		template.container.classList.add('is-action');
		const spec = actionSpec(id);
		template.icon.appendChild(id === 'search' ? createHomeSearchIcon() : renderIcon(spec.icon));
		template.name.textContent = spec.label;
	}

	private renderSection(element: Extract<AgentHomeElement, { type: 'section' }>, template: IHomeTemplate): void {
		template.container.classList.add('is-section');
		template.name.textContent = element.key === 'projects'
			? localize('voltAgent.home.projects', "Projects")
			: localize('voltAgent.home.workspaces', "Workspaces");
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

	private renderFolder(folder: IAgentHomeFolder, template: IHomeTemplate): void {
		template.container.classList.add('is-folder');
		template.container.classList.toggle('current', folder.current);
		template.container.classList.toggle('pending', this.host.isPending(folder.uri));
		template.icon.appendChild(renderIcon(Codicon.folder));
		template.name.textContent = folder.name;
	}

	private renderSession(session: IAgentSessionMeta, template: IHomeTemplate): void {
		template.container.classList.add('is-session');
		template.icon.appendChild(renderIcon(Codicon.commentDiscussion));
		template.name.textContent = session.title || localize('voltAgent.home.untitled', "New Agent");
		template.meta.textContent = compactSessionAge(session.updatedAt || session.createdAt, Date.now());
	}

	disposeElement(_node: ITreeNode<AgentHomeElement, void>, _index: number, template: IHomeTemplate): void {
		template.elementDisposables.clear();
	}

	disposeTemplate(template: IHomeTemplate): void {
		template.elementDisposables.dispose();
	}
}

class AgentHomeAccessibilityProvider implements IListAccessibilityProvider<AgentHomeElement> {
	getWidgetAriaLabel(): string {
		return localize('voltAgent.home.list', "Agent Home");
	}

	getAriaLabel(element: AgentHomeElement): string {
		switch (element.type) {
			case 'newChat': return localize('voltAgent.home.newChat', "New Chat");
			case 'action': return actionSpec(element.id).label;
			case 'section': return element.key === 'projects'
				? localize('voltAgent.home.projects', "Projects")
				: localize('voltAgent.home.workspaces', "Workspaces");
			case 'folder': return element.folder.name;
			case 'session': return element.session.title || localize('voltAgent.home.untitled', "New Agent");
		}
	}
}

function actionSpec(id: string): { readonly label: string; readonly icon: ThemeIcon } {
	switch (id) {
		case 'search':
			return { label: localize('voltAgent.home.search', "Search"), icon: Codicon.search };
		case 'automations':
			return { label: localize('voltAgent.home.automations', "Automations"), icon: Codicon.settingsGear };
		case 'customize':
			return { label: localize('voltAgent.home.customize', "Customize"), icon: Codicon.extensions };
		case 'newProject':
			return { label: localize('voltAgent.home.newProject', "New Project"), icon: Codicon.folderOpened };
		default:
			return { label: id, icon: Codicon.circleOutline };
	}
}

export class AgentHomePane extends Disposable {

	readonly element: HTMLElement;
	private readonly treeContainer: HTMLElement;
	private readonly tree: WorkbenchObjectTree<AgentHomeElement>;
	private readonly pending = new Set<string>();
	private readonly pendingSwitch = this._register(new MutableDisposable());
	private refreshSeq = 0;

	constructor(
		parent: HTMLElement,
		@ICommandService private readonly commandService: ICommandService,
		@IFileDialogService private readonly fileDialogService: IFileDialogService,
		@IHostService private readonly hostService: IHostService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IKeybindingService keybindingService: IKeybindingService,
		@ILabelService private readonly labelService: ILabelService,
		@IStorageService private readonly storageService: IStorageService,
		@IWorkspaceContextService private readonly workspaceService: IWorkspaceContextService,
		@IWorkspacesService private readonly workspacesService: IWorkspacesService,
		@IAgentHistoryService private readonly history: IAgentHistoryService,
	) {
		super();
		this.element = append(parent, $('.volt-agent-home'));
		this.keepSingleHome(parent);
		this.treeContainer = append(this.element, $('.volt-agent-home-tree'));

		this.tree = this._register(instantiationService.createInstance(
			WorkbenchObjectTree<AgentHomeElement>,
			'AgentHome',
			this.treeContainer,
			new AgentHomeDelegate(),
			[new AgentHomeRenderer(this, keybindingService)],
			{
				accessibilityProvider: new AgentHomeAccessibilityProvider(),
				keyboardNavigationLabelProvider: {
					getKeyboardNavigationLabel: (element: AgentHomeElement) => {
						switch (element.type) {
							case 'newChat': return localize('voltAgent.home.newChat', "New Chat");
							case 'action': return actionSpec(element.id).label;
							case 'section': return element.key;
							case 'folder': return element.folder.name;
							case 'session': return element.session.title;
						}
					}
				},
				identityProvider,
				multipleSelectionSupport: false,
				hideTwistiesOfChildlessElements: true,
				renderIndentGuides: RenderIndentGuides.None,
				expandOnlyOnTwistieClick: false,
				collapseByDefault: (element: AgentHomeElement) => element.type === 'folder' && !element.folder.current,
				paddingBottom: ROW_HEIGHT,
				setRowLineHeight: false,
				horizontalScrolling: false,
				transformOptimization: false,
			}
		));

		this._register(this.tree.onDidOpen(e => {
			const element = e.element;
			if (!element || this.isFolderExpandClick(element, e.browserEvent)) {
				return;
			}
			void this.activate(element).finally(() => {
				if (element.type === 'newChat' || element.type === 'action') {
					this.tree.setSelection([]);
					this.tree.setFocus([]);
				}
			});
		}));

		this._register(this.workspacesService.onDidChangeRecentlyOpened(() => void this.refresh()));
		this._register(this.workspaceService.onDidChangeWorkspaceFolders(() => void this.refresh()));
		this._register(this.workspaceService.onDidChangeWorkbenchState(() => void this.refresh()));
		this._register(this.history.onDidChange(() => void this.refresh()));

		const observer = new ResizeObserver(() => this.layout());
		observer.observe(this.treeContainer);
		this._register(toDisposable(() => observer.disconnect()));
		void this.refresh();
	}

	focus(): void {
		this.tree.domFocus();
	}

	isPending(uri: URI): boolean {
		return this.pending.has(uri.toString());
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
		const projects = this.readProjects().filter(project => project.uri !== folder.toString());
		projects.unshift({ uri: folder.toString(), name: basename(folder) });
		this.storageService.store(PROJECTS_KEY, JSON.stringify(projects.slice(0, 50)), StorageScope.APPLICATION, StorageTarget.USER);
		await this.refresh();
		await this.openFolder({ uri: folder, name: basename(folder), current: false, workspace: false });
	}

	/**
	 * A single click anywhere on a folder that has chats toggles it open or
	 * closed. Switching into that folder stays on double-click and keyboard.
	 */
	private isFolderExpandClick(element: AgentHomeElement, browserEvent: UIEvent | undefined): boolean {
		if (element.type !== 'folder' || !isMouseEvent(browserEvent) || browserEvent.detail === 2) {
			return false;
		}
		return this.tree.getNode(element).collapsible;
	}

	private async activate(element: AgentHomeElement): Promise<void> {
		switch (element.type) {
			case 'newChat':
				await this.commandService.executeCommand(NEW_AGENT_COMMAND_ID);
				return;
			case 'action':
				await this.runAction(element.id);
				return;
			case 'folder':
				await this.openFolder(element.folder);
				return;
			case 'session':
				await this.commandService.executeCommand(OPEN_AGENT_COMMAND_ID, element.session.id);
				return;
		}
	}

	private async runAction(id: string): Promise<void> {
		switch (id) {
			case 'search':
				await this.commandService.executeCommand('workbench.action.showCommands');
				return;
			case 'automations':
			case 'customize':
				await this.commandService.executeCommand(OPEN_AGENT_CUSTOMIZE_COMMAND_ID);
				return;
			case 'newProject':
				await this.addProject();
		}
	}

	private currentKeys(): Set<string> {
		const workspace = this.workspaceService.getWorkspace();
		const keys = new Set(workspace.folders.map(folder => folder.uri.toString()));
		if (workspace.configuration) {
			keys.add(workspace.configuration.toString());
		}
		return keys;
	}

	private async openFolder(folder: IAgentHomeFolder): Promise<void> {
		if (folder.current) {
			return;
		}
		this.pending.add(folder.uri.toString());
		this.pendingSwitch.value = disposableTimeout(() => {
			this.pending.delete(folder.uri.toString());
			void this.refresh();
		}, PENDING_SWITCH_TIMEOUT);
		void this.refresh();
		const openable = folder.workspace
			? { workspaceUri: folder.uri }
			: { folderUri: folder.uri };
		await this.hostService.openWindow([openable], { parkAndSwitch: true });
	}

	private async refresh(): Promise<void> {
		const seq = ++this.refreshSeq;
		const current = this.currentKeys();
		const projects = this.readProjects().map(project => ({
			uri: URI.parse(project.uri),
			name: project.name,
			current: current.has(project.uri),
			workspace: false,
		}));
		const recents = await this.workspacesService.getRecentlyOpened();
		if (seq !== this.refreshSeq) {
			return;
		}
		const projectKeys = new Set(projects.map(project => project.uri.toString()));
		const workspaces: IAgentHomeFolder[] = [];
		for (const recent of recents.workspaces) {
			const folder = this.toFolder(recent, current);
			if (!folder || projectKeys.has(folder.uri.toString())) {
				continue;
			}
			workspaces.push(folder);
		}
		const tree = buildAgentHomeTree(projects, workspaces, this.history.list({ includeArchived: false }));
		this.tree.setChildren(null, tree.map(toTreeElement));
		this.tree.rerender();
		this.expandHomeSections();
		this.layout();
	}

	private expandHomeSections(): void {
		for (const node of this.tree.getNode(null).children) {
			if (node.element?.type === 'section' && node.collapsible) {
				this.tree.expand(node.element);
			}
			for (const child of node.children) {
				if (child.element?.type === 'folder' && child.element.folder.current && child.collapsible) {
					this.tree.expand(child.element);
				}
			}
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
				name: recent.label || this.labelService.getUriBasenameLabel(recent.workspace.configPath),
				current: current.has(recent.workspace.configPath.toString()),
				workspace: true,
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

	private readProjects(): IStoredProject[] {
		try {
			const raw = this.storageService.get(PROJECTS_KEY, StorageScope.APPLICATION, '[]');
			const parsed = JSON.parse(raw) as IStoredProject[];
			return Array.isArray(parsed) ? parsed.filter(item => item?.uri && item.name) : [];
		} catch {
			return [];
		}
	}
}

function toTreeElement(node: IAgentHomeNode): IObjectTreeElement<AgentHomeElement> {
	const children = node.children?.map(toTreeElement);
	const collapsible = (node.element.type === 'section' || node.element.type === 'folder') && !!children?.length;
	return {
		element: node.element,
		collapsible,
		collapsed: node.collapsed,
		children,
	};
}
