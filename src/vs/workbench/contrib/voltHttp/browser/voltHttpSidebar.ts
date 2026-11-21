/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, append, clearNode, isHTMLElement } from '../../../../base/browser/dom.js';
import { IDragAndDropData } from '../../../../base/browser/dnd.js';
import { renderIcon } from '../../../../base/browser/ui/iconLabel/iconLabels.js';
import { IListRenderer, IListVirtualDelegate, ListDragOverEffectPosition, ListDragOverEffectType } from '../../../../base/browser/ui/list/list.js';
import { ElementsDragAndDropData, ListViewTargetSector } from '../../../../base/browser/ui/list/listView.js';
import { IObjectTreeElement, ITreeDragAndDrop, ITreeDragOverReaction, ITreeNode, ITreeRenderer } from '../../../../base/browser/ui/tree/tree.js';
import { IAction, Separator, toAction } from '../../../../base/common/actions.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { fromNow } from '../../../../base/common/date.js';
import { Disposable, DisposableStore, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { basename, relativePath } from '../../../../base/common/resources.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { IContextViewService } from '../../../../platform/contextview/browser/contextView.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { WorkbenchList, WorkbenchObjectTree } from '../../../../platform/list/browser/listService.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { setAgentTooltip } from '../../voltAgent/browser/chrome/agentTooltip.js';
import { showVoltMenu } from '../../voltAgent/browser/ui/menu/voltMenu.js';
import { HTTP_PROTOCOLS, HttpProtocol, httpProtocolInfo, httpRequestBadge, httpRequestBadgeKey } from '../common/httpProtocols.js';
import { emptyHttpFolder, emptyHttpRequest, findHttpItem, httpRequestLabel, httpRequestsOf, IHttpFolder, IHttpItem, IHttpRequest } from '../common/httpCollection.js';
import { IHttpCollectionEntry, IHttpEnvironmentEntry, IVoltHttpCollections } from './voltHttpCollections.js';
import { IHttpExchange, IVoltHttpService } from './voltHttpService.js';
import { createHttpAutomationIcon, createHttpProtocolIcon, createHttpSearchIcon, createHttpSecurityIcon } from './voltHttpIcons.js';
import { HttpToolKind, IHttpToolFileEntry, IHttpToolFiles } from './voltHttpToolPages.js';
import { createHttpIconButton, HTTP_MENU_CLASS, httpStatusClass, showHttpActionMenu } from './voltHttpWidgets.js';

export type HttpSidebarView = 'collections' | 'automations' | 'performance' | 'security' | 'environments' | 'history';

/** The sidebar groups that list a tool's files, and what each tool is called. */
/** A tool's icon: a codicon, or a drawn one made at the size asked for. */
export type HttpToolIcon = ThemeIcon | ((size?: number) => SVGElement);

export function renderHttpToolIcon(icon: HttpToolIcon, size?: number): HTMLElement | SVGElement {
	return typeof icon === 'function' ? icon(size) : renderIcon(icon);
}

export const HTTP_TOOLS: readonly { readonly kind: HttpToolKind; readonly view: HttpSidebarView; readonly icon: HttpToolIcon; readonly label: string; readonly one: string; readonly hint: string; readonly empty: string }[] = [
	{ kind: 'automation', view: 'automations', icon: createHttpAutomationIcon, label: localize('voltHttp.automations', "Automations"), one: localize('voltHttp.automation', "Automation"), hint: localize('voltHttp.automationHint', "Requests chained into an end-to-end test"), empty: localize('voltHttp.noAutomations', "No automations yet. An automation runs requests one after the other, passes values between them and checks each answer: an end-to-end test of your API.") },
	{ kind: 'performance', view: 'performance', icon: Codicon.dashboard, label: localize('voltHttp.performance', "Performance"), one: localize('voltHttp.performanceTest', "Performance Test"), hint: localize('voltHttp.performanceHint', "Load on a request, WebSocket or event stream"), empty: localize('voltHttp.noPerformance', "No performance tests yet. A performance test sends load to a request, a WebSocket or an event stream and measures throughput, latency and errors.") },
	{ kind: 'security', view: 'security', icon: createHttpSecurityIcon, label: localize('voltHttp.security', "Security"), one: localize('voltHttp.securityScan', "Security Scan"), hint: localize('voltHttp.securityHint', "Checks your API's endpoints for common weaknesses"), empty: localize('voltHttp.noSecurity', "No security scans yet. A scan checks the endpoints of your collections for common API weaknesses and reports what it finds.") },
];

function toolOfView(view: HttpSidebarView) {
	return HTTP_TOOLS.find(tool => tool.view === view);
}

export type HttpTreeNode =
	| { readonly kind: 'collection'; readonly entry: IHttpCollectionEntry }
	| { readonly kind: 'folder'; readonly entry: IHttpCollectionEntry; readonly folder: IHttpFolder }
	| { readonly kind: 'request'; readonly entry: IHttpCollectionEntry; readonly request: IHttpRequest };

/** What the sidebar asks the client to do: open tabs, show dialogs. */
export interface IHttpSidebarHost {
	readonly root: URI | undefined;
	openRequest(collection: URI, id: string): void;
	openFolder(collection: URI, id: string): void;
	openCollection(collection: URI): void;
	openEnvironment(entry: IHttpEnvironmentEntry): void;
	openExchange(exchange: IHttpExchange): void;
	newRequest(protocol?: HttpProtocol): void;
	showImport(): void;
	exportCollection(collection: URI): void;
	run(collection: URI, folderId: string | undefined): void;
	/** Opens "Generate tests" with the requests of a collection, a folder or one request ticked; every request without tests when none is named. */
	generateTests(collection?: URI, itemId?: string): void;
	revealFile(uri: URI): void;
	closeTabsOf(collection: URI, id: string | undefined): void;
	sidebarViewChanged(view: HttpSidebarView): void;
	/** A tool's files in the project (automations, performance tests, security scans). */
	toolFiles(kind: HttpToolKind): IHttpToolFiles;
	openTool(kind: HttpToolKind, uri: URI): void;
	closeToolTab(uri: URI): void;
}

const ROW_HEIGHT = 28;

function nodeId(node: HttpTreeNode): string {
	return node.kind === 'collection' ? node.entry.uri.toString() : `${node.entry.uri.toString()}#${node.kind === 'folder' ? node.folder.id : node.request.id}`;
}

interface ITreeTemplate {
	readonly row: HTMLElement;
	readonly icon: HTMLElement;
	readonly method: HTMLElement;
	readonly label: HTMLElement;
	readonly detail: HTMLElement;
	readonly actions: HTMLElement;
	readonly store: DisposableStore;
}

interface IRowTemplate {
	readonly row: HTMLElement;
	readonly lead: HTMLElement;
	readonly method: HTMLElement;
	readonly label: HTMLElement;
	readonly detail: HTMLElement;
	readonly actions: HTMLElement;
}

function rowTemplate(container: HTMLElement): IRowTemplate {
	const row = append(container, $('.volt-http-row'));
	return {
		row,
		lead: append(row, $('span.volt-http-row-icon')),
		method: append(row, $('span.volt-http-row-method')),
		label: append(row, $('span.volt-http-row-label')),
		detail: append(row, $('span.volt-http-row-detail')),
		actions: append(row, $('span.volt-http-row-actions')),
	};
}

/**
 * The client's left side, as in Postman: Collections (a tree of the project's collection files,
 * their folders and requests), Environments and History, with New and Import on top.
 */
export class HttpSidebar extends Disposable {

	readonly element: HTMLElement;
	private readonly tabsEl: HTMLElement;
	private readonly toolsEl: HTMLElement;
	private readonly listHost: HTMLElement;
	private readonly emptyEl: HTMLElement;
	private readonly viewStore = this._register(new DisposableStore());
	private readonly menu = this._register(new MutableDisposable());
	private tree: WorkbenchObjectTree<HttpTreeNode> | undefined;
	private envList: WorkbenchList<IHttpEnvironmentEntry> | undefined;
	private historyList: WorkbenchList<IHttpExchange> | undefined;
	private toolList: WorkbenchList<IHttpToolFileEntry> | undefined;
	private selectedTool: string | undefined;
	private view: HttpSidebarView = 'collections';
	private filter = '';
	private renaming: string | undefined;
	private readonly collapsed = new Set<string>();
	private readonly expandedFolders = new Set<string>();
	private selectedId: string | undefined;
	private width = 0;
	private height = 0;
	private refreshing = 0;

	constructor(
		parent: HTMLElement,
		private readonly host: IHttpSidebarHost,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IVoltHttpCollections private readonly collections: IVoltHttpCollections,
		@IVoltHttpService private readonly http: IVoltHttpService,
		@IContextViewService private readonly contextViewService: IContextViewService,
		@IDialogService private readonly dialogService: IDialogService,
		@INotificationService private readonly notificationService: INotificationService,
		@IQuickInputService private readonly quickInputService: IQuickInputService,
	) {
		super();
		this.element = append(parent, $('.volt-http-sidebar'));
		this.tabsEl = append(this.element, $('.volt-http-side-tabs'));
		this.toolsEl = append(this.element, $('.volt-http-side-tools'));
		this.listHost = append(this.element, $('.volt-http-side-list'));
		this.emptyEl = append(this.element, $('.volt-http-side-empty'));
		this._register(collections.onDidChange(() => this.view === 'collections' && void this.refresh()));
		this._register(collections.onDidChangeEnvironments(() => this.view === 'environments' && void this.refresh()));
		this._register(http.onDidChangeEnvironment(() => this.view === 'environments' && void this.refresh()));
		this._register(http.onDidChangeHistory(() => this.view === 'history' && void this.refresh()));
		for (const tool of HTTP_TOOLS) {
			this._register(host.toolFiles(tool.kind).onDidChange(() => this.view === tool.view && void this.refresh()));
		}
		this.show(this.view);
	}

	get currentView(): HttpSidebarView {
		return this.view;
	}

	show(view: HttpSidebarView): void {
		this.view = view;
		this.filter = '';
		this.renderTabs();
		this.renderTools();
		this.buildList();
		void this.refresh();
	}

	/** Marks the row of the tab in front. */
	select(collection: URI | undefined, id: string | undefined): void {
		this.selectedId = collection ? (id ? `${collection.toString()}#${id}` : collection.toString()) : undefined;
		this.applySelection();
	}

	/** Marks the row of a tool's tab in front. */
	selectTool(uri: URI | undefined): void {
		this.selectedTool = uri?.toString();
		this.applyToolSelection();
	}

	private applyToolSelection(): void {
		const list = this.toolList;
		if (!list) {
			return;
		}
		let index = -1;
		for (let i = 0; i < list.length; i++) {
			if (list.element(i).uri.toString() === this.selectedTool) {
				index = i;
			}
		}
		list.setSelection(index >= 0 ? [index] : []);
	}

	private applySelection(): void {
		if (!this.tree || this.view !== 'collections') {
			return;
		}
		const node = this.selectedId ? this.nodes.get(this.selectedId) : undefined;
		try {
			this.tree.setSelection(node ? [node] : []);
		} catch { /* the row is filtered out or its folder is not built yet */ }
	}

	private renderTabs(): void {
		clearNode(this.tabsEl);
		this.tabsEl.setAttribute('role', 'tablist');
		const tabs: { id: HttpSidebarView; label: string; icon: HttpToolIcon }[] = [
			{ id: 'collections', label: localize('voltHttp.collections', "Collections"), icon: Codicon.library },
			...HTTP_TOOLS.map(tool => ({ id: tool.view, label: tool.label, icon: tool.icon })),
			{ id: 'environments', label: localize('voltHttp.environments', "Environments"), icon: Codicon.symbolVariable },
			{ id: 'history', label: localize('voltHttp.history', "History"), icon: Codicon.history },
		];
		for (const tab of tabs) {
			const button = append(this.tabsEl, $('button.volt-http-side-tab')) as HTMLButtonElement;
			button.type = 'button';
			// Icons only, named by Volt's tooltip: six names never fit a sidebar, and a cut name reads worse than none.
			button.setAttribute('aria-label', tab.label);
			setAgentTooltip(button, tab.label);
			button.dataset.view = tab.id;
			button.setAttribute('role', 'tab');
			button.setAttribute('aria-selected', String(tab.id === this.view));
			button.classList.toggle('active', tab.id === this.view);
			button.appendChild(renderHttpToolIcon(tab.icon, 15));
			button.addEventListener('click', () => {
				if (this.view !== tab.id) {
					this.show(tab.id);
					this.host.sidebarViewChanged(tab.id);
				}
			});
		}
	}

	private renderTools(): void {
		clearNode(this.toolsEl);
		const search = append(this.toolsEl, $('.volt-http-side-search'));
		search.appendChild(createHttpSearchIcon());
		const input = append(search, $('input')) as HTMLInputElement;
		input.type = 'text';
		input.spellcheck = false;
		const tool = toolOfView(this.view);
		input.placeholder = tool ? localize('voltHttp.filterTool', "Filter {0}", tool.label.toLowerCase()) : this.view === 'collections' ? localize('voltHttp.filterCollections', "Filter requests") : this.view === 'environments' ? localize('voltHttp.filterEnvironments', "Filter environments") : localize('voltHttp.filterHistory', "Filter history");
		input.setAttribute('aria-label', input.placeholder);
		input.addEventListener('input', () => {
			this.filter = input.value.trim().toLowerCase();
			void this.refresh();
		});
		if (this.view === 'history') {
			createHttpIconButton(this.toolsEl, Codicon.clearAll, localize('voltHttp.clearHistory', "Clear History"), () => this.http.clearHistory(this.host.root));
			return;
		}
		if (tool) {
			createHttpIconButton(this.toolsEl, Codicon.add, localize('voltHttp.newTool', "New {0}", tool.one), () => void this.newTool(tool.kind));
			return;
		}
		createHttpIconButton(this.toolsEl, Codicon.add, localize('voltHttp.new', "New"), button => this.showNewMenu(button));
		createHttpIconButton(this.toolsEl, Codicon.cloudDownload, localize('voltHttp.import', "Import"), () => this.host.showImport());
		if (this.view === 'collections') {
			createHttpIconButton(this.toolsEl, Codicon.beaker, localize('voltHttp.generateTestsFor', "Generate Tests for Requests"), () => this.host.generateTests());
		}
	}

	private showNewMenu(anchor: HTMLElement): void {
		type New = { readonly request: HttpProtocol } | { readonly tool: HttpToolKind } | 'postman' | 'http' | 'environment' | 'import';
		const pick = (value: New) => value;
		this.menu.value = showVoltMenu<New>(this.contextViewService, {
			anchor,
			className: HTTP_MENU_CLASS,
			align: 'right',
			width: 300,
			maxListHeight: 760,
			ariaLabel: localize('voltHttp.new', "New"),
			sections: [
				{ id: 'requests', title: localize('voltHttp.newRequestSection', "Request"), items: HTTP_PROTOCOLS.map(item => ({ id: `request-${item.id}`, label: item.label, icon: () => createHttpProtocolIcon(item.id), data: pick({ request: item.id }) })) },
				{
					// Each on two lines: what it is under its name, so nothing is cut short.
					id: 'files', title: localize('voltHttp.newFileSection', "Save to"), items: [
						{ id: 'postman', label: localize('voltHttp.newCollection', "Collection"), subtitle: localize('voltHttp.newCollectionDesc', "Postman file: folders, auth, scripts"), icon: Codicon.library, data: pick('postman') },
						{ id: 'http', label: localize('voltHttp.newHttpFile', ".http File"), subtitle: localize('voltHttp.newHttpFileDesc', "Plain text requests, one after another"), icon: Codicon.file, data: pick('http') },
						{ id: 'environment', label: localize('voltHttp.newEnvironment', "Environment"), subtitle: localize('voltHttp.newEnvironmentDesc', "Variables for {{names}} in requests"), icon: Codicon.symbolVariable, data: pick('environment') },
					],
				},
				{ id: 'tools', title: localize('voltHttp.newTestSection', "Test"), items: HTTP_TOOLS.map(tool => ({ id: `tool-${tool.kind}`, label: tool.one, subtitle: tool.hint, icon: tool.icon, data: pick({ tool: tool.kind }) })) },
				{ id: 'import', items: [{ id: 'import', label: localize('voltHttp.import', "Import"), subtitle: localize('voltHttp.importDesc', "Postman, OpenAPI, HAR, .http or cURL"), icon: Codicon.cloudDownload, data: pick('import') }] },
			],
			onPick: item => {
				const picked = item.data;
				if (typeof picked === 'object') {
					if ('tool' in picked) {
						void this.newTool(picked.tool);
					} else {
						this.host.newRequest(picked.request);
					}
					return;
				}
				switch (picked) {
					case 'postman': void this.newCollection('postman'); break;
					case 'http': void this.newCollection('http'); break;
					case 'environment': void this.newEnvironment(); break;
					case 'import': this.host.showImport(); break;
				}
			},
		});
	}

	private async guard(run: () => Promise<unknown>): Promise<void> {
		try {
			await run();
		} catch (err) {
			this.notificationService.error(err instanceof Error ? err.message : String(err));
		}
	}

	async newCollection(format: 'postman' | 'http'): Promise<void> {
		await this.guard(async () => {
			const uri = await this.collections.createCollection(this.host.root, format === 'postman' ? localize('voltHttp.newCollectionName', "New Collection") : 'requests', format);
			if (this.view !== 'collections') {
				this.show('collections');
			} else {
				await this.refresh();
			}
			if (format === 'postman') {
				this.startRename(uri.toString());
			}
			this.host.openCollection(uri);
		});
	}

	/** A new automation, performance test or security scan: written to the project and opened. */
	async newTool(kind: HttpToolKind): Promise<void> {
		const tool = HTTP_TOOLS.find(item => item.kind === kind)!;
		await this.guard(async () => {
			const uri = await this.host.toolFiles(kind).create(this.host.root);
			if (this.view !== tool.view) {
				this.show(tool.view);
				this.host.sidebarViewChanged(tool.view);
			} else {
				await this.refresh();
			}
			this.host.openTool(kind, uri);
		});
	}

	async newEnvironment(): Promise<void> {
		await this.guard(async () => {
			const entry = await this.collections.createEnvironment(this.host.root, localize('voltHttp.newEnvironmentName', "New Environment"));
			if (this.view !== 'environments') {
				this.show('environments');
			}
			this.host.openEnvironment(entry);
		});
	}

	// --- Lists -----------------------------------------------------------------------------------

	private readonly nodes = new Map<string, HttpTreeNode>();

	private buildList(): void {
		this.viewStore.clear();
		clearNode(this.listHost);
		this.tree = undefined;
		this.envList = undefined;
		this.historyList = undefined;
		this.toolList = undefined;
		const tool = toolOfView(this.view);
		if (tool) {
			this.buildToolList(tool.kind);
		} else if (this.view === 'collections') {
			this.buildTree();
		} else if (this.view === 'environments') {
			this.buildEnvironments();
		} else {
			this.buildHistory();
		}
		this.layout(this.width, this.height);
	}

	private buildTree(): void {
		const delegate: IListVirtualDelegate<HttpTreeNode> = { getHeight: () => ROW_HEIGHT, getTemplateId: () => 'node' };
		const renderer: ITreeRenderer<HttpTreeNode, void, ITreeTemplate> = {
			templateId: 'node',
			renderTemplate: container => {
				const row = append(container, $('.volt-http-row.tree'));
				return {
					row,
					icon: append(row, $('span.volt-http-row-icon')),
					method: append(row, $('span.volt-http-row-method')),
					label: append(row, $('span.volt-http-row-label')),
					detail: append(row, $('span.volt-http-row-detail')),
					actions: append(row, $('span.volt-http-row-actions')),
					store: new DisposableStore(),
				};
			},
			renderElement: (treeNode: ITreeNode<HttpTreeNode, void>, _index: number, template: ITreeTemplate) => this.renderNode(treeNode.element, template),
			disposeElement: (_node, _index, template) => template.store.clear(),
			disposeTemplate: template => template.store.dispose(),
		};
		const tree = this.tree = this.viewStore.add(this.instantiationService.createInstance(WorkbenchObjectTree<HttpTreeNode>, 'VoltHttpCollections', this.listHost, delegate, [renderer], {
			accessibilityProvider: {
				getAriaLabel: node => node.kind === 'collection' ? node.entry.collection.name : node.kind === 'folder' ? node.folder.name : `${node.request.method} ${httpRequestLabel(node.request)}`,
				getWidgetAriaLabel: () => localize('voltHttp.collectionsAria', "Collections"),
			},
			identityProvider: { getId: nodeId },
			dnd: this.dragAndDrop(),
			multipleSelectionSupport: false,
			keyboardNavigationLabelProvider: { getKeyboardNavigationLabel: node => node.kind === 'collection' ? node.entry.collection.name : node.kind === 'folder' ? node.folder.name : httpRequestLabel(node.request) },
		}));
		this.viewStore.add(tree.onDidOpen(event => {
			const node = event.element;
			if (!node || this.renaming) {
				return;
			}
			// A folder or collection row opens and closes on a click; its own page is in its menu (and the request's breadcrumbs).
			if (node.kind === 'request') {
				this.host.openRequest(node.entry.uri, node.request.id);
			}
		}));
		this.viewStore.add(tree.onDidChangeCollapseState(event => {
			const node = event.node.element;
			if (!node || this.refreshing || this.filter) {
				return;
			}
			const id = nodeId(node);
			if (node.kind === 'collection') {
				if (event.node.collapsed) { this.collapsed.add(id); } else { this.collapsed.delete(id); }
			} else if (node.kind === 'folder') {
				if (event.node.collapsed) { this.expandedFolders.delete(id); } else { this.expandedFolders.add(id); }
			}
		}));
		this.viewStore.add(tree.onContextMenu(event => {
			if (event.element) {
				this.menu.value = showHttpActionMenu(this.contextViewService, isHTMLElement(event.anchor) ? event.anchor : { x: event.anchor.posx, y: event.anchor.posy }, this.element, this.actionsFor(event.element!), localize('voltHttp.moreActions', "More Actions"));
			}
		}));
		this.viewStore.add(tree.onKeyDown(event => {
			const [node] = tree.getFocus();
			if (!node || this.renaming) {
				return;
			}
			if (event.key === 'F2' || (event.key === 'Enter' && event.shiftKey)) {
				event.preventDefault();
				this.startRename(nodeId(node));
			} else if ((event.key === 'Delete' || (event.key === 'Backspace' && event.metaKey)) && node.kind !== 'collection') {
				event.preventDefault();
				void this.remove(node);
			}
		}));
	}

	private renderNode(node: HttpTreeNode, template: ITreeTemplate): void {
		template.store.clear();
		clearNode(template.icon);
		clearNode(template.actions);
		clearNode(template.label);
		const id = nodeId(node);
		template.row.classList.toggle('collection', node.kind === 'collection');
		let name: string;
		if (node.kind === 'request') {
			template.icon.classList.add('none');
			template.method.textContent = httpRequestBadge(node.request);
			template.method.dataset.method = httpRequestBadgeKey(node.request);
			name = node.request.name;
			template.detail.textContent = '';
			template.row.classList.toggle('unsaved', !!this.collections.draftOf(`${node.entry.uri.toString()}#${node.request.id}`));
		} else {
			template.icon.classList.remove('none');
			template.row.classList.remove('unsaved');
			template.method.textContent = '';
			template.method.removeAttribute('data-method');
			if (node.kind === 'folder') {
				template.icon.appendChild(renderIcon(Codicon.folder));
				name = node.folder.name;
				template.detail.textContent = '';
			} else {
				template.icon.appendChild(renderIcon(node.entry.error ? Codicon.warning : node.entry.collection.format === 'postman' ? Codicon.library : Codicon.file));
				name = node.entry.collection.format === 'postman' ? node.entry.collection.name : this.fileLabel(node.entry.uri);
				template.detail.textContent = node.entry.error ? localize('voltHttp.unreadable', "unreadable") : node.entry.collection.format === 'postman' ? '' : '';
				setAgentTooltip(template.row, node.entry.error ? `${node.entry.uri.fsPath}\n${node.entry.error}` : node.entry.uri.fsPath);
			}
		}
		if (node.kind !== 'collection') {
			setAgentTooltip(template.row, '');
		}
		if (this.renaming === id && !(node.kind === 'collection' && node.entry.collection.format === 'http')) {
			this.renderRename(node, template, name);
			return;
		}
		template.label.textContent = node.kind === 'request' ? httpRequestLabel(node.request) : name;
		if (node.kind !== 'request' && !node.entry.error) {
			createHttpIconButton(template.actions, Codicon.add, localize('voltHttp.addRequest', "Add Request"), () => void this.addRequest(node));
		}
		createHttpIconButton(template.actions, Codicon.ellipsis, localize('voltHttp.moreActions', "More Actions"), button => {
			this.menu.value = showHttpActionMenu(this.contextViewService, button, this.element, this.actionsFor(node), localize('voltHttp.moreActions', "More Actions"));
		});
	}

	private fileLabel(uri: URI): string {
		const root = this.host.root;
		return (root && relativePath(root, uri)) || basename(uri);
	}

	private renderRename(node: HttpTreeNode, template: ITreeTemplate, name: string): void {
		const input = append(template.label, $('input.volt-http-rename')) as HTMLInputElement;
		input.type = 'text';
		input.value = name;
		input.spellcheck = false;
		input.setAttribute('aria-label', localize('voltHttp.rename', "Rename"));
		let done = false;
		const finish = (commit: boolean) => {
			if (done) {
				return;
			}
			done = true;
			this.renaming = undefined;
			const next = input.value.trim();
			if (commit && next && next !== name) {
				void this.guard(() => node.kind === 'collection'
					? this.collections.updateCollection(node.entry.uri, collection => collection.name = next)
					: this.collections.updateItem(node.entry.uri, node.kind === 'folder' ? node.folder.id : node.request.id, item => item.name = next));
			} else {
				void this.refresh();
			}
		};
		for (const type of ['mousedown', 'click', 'dblclick', 'keyup', 'keypress'] as const) {
			input.addEventListener(type, event => event.stopPropagation());
		}
		input.addEventListener('keydown', event => {
			event.stopPropagation();
			if (event.key === 'Enter') {
				event.preventDefault();
				finish(true);
			} else if (event.key === 'Escape') {
				event.preventDefault();
				finish(false);
			}
		});
		input.addEventListener('blur', () => finish(true));
		setTimeout(() => {
			if (!done) {
				input.focus();
				input.select();
			}
		}, 0);
	}

	startRename(id: string): void {
		this.renaming = id;
		void this.refresh().then(() => {
			const node = this.nodes.get(id);
			if (node && this.tree) {
				try {
					this.tree.reveal(node);
				} catch { /* collapsed away */ }
			}
		});
	}

	private actionsFor(node: HttpTreeNode): IAction[] {
		const uri = node.entry.uri;
		const postman = node.entry.collection.format === 'postman';
		const id = nodeId(node);
		const actions: IAction[] = [];
		const add = (actionId: string, label: string, run: () => unknown) => actions.push(toAction({ id: actionId, label, run: () => { void this.guard(async () => { await run(); }); } }));
		if (node.entry.error) {
			add('reveal', localize('voltHttp.openFile', "Open File"), () => this.host.revealFile(uri));
			return actions;
		}
		if (node.kind === 'request') {
			add('open', localize('voltHttp.openRequest', "Open"), () => this.host.openRequest(uri, node.request.id));
			actions.push(new Separator());
			add('rename', localize('voltHttp.rename', "Rename"), () => this.startRename(id));
			add('duplicate', localize('voltHttp.duplicate', "Duplicate"), () => this.collections.duplicateItem(uri, node.request.id));
			if (!httpProtocolInfo(node.request.protocol).stream) {
				actions.push(new Separator());
				add('generateTests', localize('voltHttp.generateTestsMenu', "Generate Tests"), () => this.host.generateTests(uri, node.request.id));
			}
			actions.push(new Separator());
			add('reveal', localize('voltHttp.openFile', "Open File"), () => this.host.revealFile(uri));
			add('delete', localize('voltHttp.delete', "Delete"), () => this.remove(node));
			return actions;
		}
		add('open', node.kind === 'folder' ? localize('voltHttp.openFolder', "Open Folder Settings") : localize('voltHttp.openCollectionPage', "Open Collection Settings"), () => node.kind === 'folder' ? this.host.openFolder(uri, node.folder.id) : this.host.openCollection(uri));
		add('addRequest', localize('voltHttp.addRequest', "Add Request"), () => this.addRequest(node));
		if (postman) {
			add('addFolder', localize('voltHttp.addFolder', "Add Folder"), () => this.addFolder(node));
		}
		add('run', node.kind === 'folder' ? localize('voltHttp.runFolder', "Run Folder") : localize('voltHttp.runCollection', "Run Collection"), () => this.host.run(uri, node.kind === 'folder' ? node.folder.id : undefined));
		add('generateTests', localize('voltHttp.generateTestsMenu', "Generate Tests"), () => this.host.generateTests(uri, node.kind === 'folder' ? node.folder.id : undefined));
		actions.push(new Separator());
		if (node.kind === 'folder' || postman) {
			add('rename', localize('voltHttp.rename', "Rename"), () => this.startRename(id));
		}
		if (node.kind === 'folder') {
			add('duplicate', localize('voltHttp.duplicate', "Duplicate"), () => this.collections.duplicateItem(uri, node.folder.id));
			actions.push(new Separator());
			add('delete', localize('voltHttp.delete', "Delete"), () => this.remove(node));
		} else {
			add('export', localize('voltHttp.export', "Export"), () => this.host.exportCollection(uri));
			add('reveal', localize('voltHttp.openFile', "Open File"), () => this.host.revealFile(uri));
			actions.push(new Separator());
			add('delete', localize('voltHttp.deleteCollection', "Delete Collection"), () => this.removeCollection(node.entry));
		}
		return actions;
	}

	private async addRequest(node: HttpTreeNode): Promise<void> {
		await this.guard(async () => {
			const parent = node.kind === 'folder' ? node.folder.id : node.kind === 'request' ? findHttpItem(node.entry.collection, node.request.id)?.ancestors.at(-1)?.id : undefined;
			const request = emptyHttpRequest(localize('voltHttp.newRequestName', "New Request"), node.entry.collection.format === 'postman' ? 'inherit' : 'none');
			const id = await this.collections.addItem(node.entry.uri, parent, request);
			this.expand(node);
			await this.refresh();
			this.host.openRequest(node.entry.uri, id);
			this.startRename(`${node.entry.uri.toString()}#${id}`);
		});
	}

	private async addFolder(node: HttpTreeNode): Promise<void> {
		await this.guard(async () => {
			const id = await this.collections.addItem(node.entry.uri, node.kind === 'folder' ? node.folder.id : undefined, emptyHttpFolder(localize('voltHttp.newFolderName', "New Folder")));
			this.expand(node);
			this.startRename(`${node.entry.uri.toString()}#${id}`);
		});
	}

	private expand(node: HttpTreeNode): void {
		const id = nodeId(node);
		if (node.kind === 'collection') {
			this.collapsed.delete(id);
		} else if (node.kind === 'folder') {
			this.expandedFolders.add(id);
		}
	}

	private async remove(node: HttpTreeNode): Promise<void> {
		if (node.kind === 'collection') {
			return;
		}
		const item: IHttpItem = node.kind === 'folder' ? node.folder : node.request;
		const count = item.kind === 'folder' ? httpRequestsOf(item.items).length : 0;
		const { confirmed } = await this.dialogService.confirm({
			message: item.kind === 'folder' ? localize('voltHttp.deleteFolderConfirm', "Delete the folder \"{0}\"?", item.name) : localize('voltHttp.deleteRequestConfirm', "Delete the request \"{0}\"?", httpRequestLabel(item)),
			detail: item.kind === 'folder' && count ? localize('voltHttp.deleteFolderDetail', "Its {0} requests are removed from {1}.", count, basename(node.entry.uri)) : localize('voltHttp.deleteDetail', "It is removed from {0}.", basename(node.entry.uri)),
			primaryButton: localize('voltHttp.delete', "Delete"),
		});
		if (confirmed) {
			await this.guard(async () => {
				this.host.closeTabsOf(node.entry.uri, item.id);
				await this.collections.removeItem(node.entry.uri, item.id);
			});
		}
	}

	private async removeCollection(entry: IHttpCollectionEntry): Promise<void> {
		const { confirmed } = await this.dialogService.confirm({
			message: localize('voltHttp.deleteCollectionConfirm', "Delete \"{0}\"?", entry.collection.format === 'postman' ? entry.collection.name : basename(entry.uri)),
			detail: localize('voltHttp.deleteCollectionDetail', "The file {0} is moved to the trash.", this.fileLabel(entry.uri)),
			primaryButton: localize('voltHttp.delete', "Delete"),
		});
		if (confirmed) {
			await this.guard(async () => {
				this.host.closeTabsOf(entry.uri, undefined);
				await this.collections.deleteCollection(entry.uri);
			});
		}
	}

	private dragAndDrop(): ITreeDragAndDrop<HttpTreeNode> {
		const dragged = (data: IDragAndDropData): HttpTreeNode | undefined => data instanceof ElementsDragAndDropData ? (data.elements as HttpTreeNode[])[0] : undefined;
		const target = (source: HttpTreeNode, over: HttpTreeNode | undefined, sector: ListViewTargetSector | undefined): { uri: URI; parentId: string | undefined; index: number | undefined; position: ListDragOverEffectPosition } | undefined => {
			if (!over || source.kind === 'collection' || over.entry.error || nodeId(source) === nodeId(over)) {
				return undefined;
			}
			const item: IHttpItem = source.kind === 'folder' ? source.folder : source.request;
			if (over.entry.collection.format === 'http' && item.kind === 'folder') {
				return undefined;
			}
			const top = sector === ListViewTargetSector.TOP || sector === ListViewTargetSector.CENTER_TOP;
			if (over.kind === 'collection') {
				return { uri: over.entry.uri, parentId: undefined, index: undefined, position: ListDragOverEffectPosition.Over };
			}
			if (over.kind === 'folder' && sector !== ListViewTargetSector.TOP && sector !== ListViewTargetSector.BOTTOM) {
				// Not into itself or a folder inside it.
				if (item.kind === 'folder' && (item.id === over.folder.id || findHttpItem({ ...over.entry.collection, items: item.items }, over.folder.id))) {
					return undefined;
				}
				return { uri: over.entry.uri, parentId: over.folder.id, index: undefined, position: ListDragOverEffectPosition.Over };
			}
			const overItem: IHttpItem = over.kind === 'folder' ? over.folder : over.request;
			const found = findHttpItem(over.entry.collection, overItem.id);
			if (!found || (item.kind === 'folder' && found.ancestors.some(folder => folder.id === item.id))) {
				return undefined;
			}
			const parentId = found.ancestors.at(-1)?.id;
			if (over.entry.collection.format === 'http' && parentId) {
				return undefined;
			}
			return { uri: over.entry.uri, parentId, index: found.index + (top ? 0 : 1), position: top ? ListDragOverEffectPosition.Before : ListDragOverEffectPosition.After };
		};
		return {
			getDragURI: node => node.kind === 'collection' || this.renaming ? null : `volt-http-item:${nodeId(node)}`,
			getDragLabel: nodes => nodes[0]?.kind === 'folder' ? nodes[0].folder.name : nodes[0]?.kind === 'request' ? httpRequestLabel(nodes[0].request) : undefined,
			onDragStart: () => { },
			onDragOver: (data, over, _index, sector): boolean | ITreeDragOverReaction => {
				const source = dragged(data);
				const to = source && target(source, over, sector);
				return to ? { accept: true, effect: { type: ListDragOverEffectType.Move, position: to.position }, autoExpand: true } : false;
			},
			drop: (data, over, _index, sector) => {
				const source = dragged(data);
				const to = source && target(source, over, sector);
				if (!source || !to || source.kind === 'collection') {
					return;
				}
				if (to.parentId) {
					this.expandedFolders.add(`${to.uri.toString()}#${to.parentId}`);
				}
				void this.guard(() => this.collections.moveItem(source.entry.uri, source.kind === 'folder' ? source.folder.id : source.request.id, to.uri, to.parentId, to.index));
			},
			dispose: () => { },
		};
	}

	private buildEnvironments(): void {
		const renderer: IListRenderer<IHttpEnvironmentEntry, IRowTemplate> = {
			templateId: 'row',
			renderTemplate: rowTemplate,
			renderElement: (entry, _index, template) => {
				clearNode(template.lead);
				clearNode(template.actions);
				const active = !entry.globals && !entry.shared && this.http.environmentOf(this.host.root) === entry.environment.name;
				template.lead.appendChild(renderIcon(entry.globals ? Codicon.globe : active ? Codicon.passFilled : Codicon.circleLargeOutline));
				template.lead.classList.toggle('active', active);
				template.method.textContent = '';
				template.label.textContent = entry.environment.name;
				template.detail.textContent = entry.globals ? localize('voltHttp.globals', "globals") : entry.environment.format === 'http-client' ? basename(entry.uri) : '';
				setAgentTooltip(template.row, entry.uri.fsPath);
				if (!entry.globals && !entry.shared) {
					createHttpIconButton(template.actions, active ? Codicon.circleSlash : Codicon.check, active ? localize('voltHttp.envDeactivate', "Stop Using") : localize('voltHttp.envActivate', "Use This Environment"), () => this.http.setEnvironment(active ? undefined : entry.environment.name, this.host.root));
				}
			},
			disposeTemplate: () => { },
		};
		const list = this.envList = this.viewStore.add(this.instantiationService.createInstance(WorkbenchList<IHttpEnvironmentEntry>, 'VoltHttpEnvironments', this.listHost, { getHeight: () => ROW_HEIGHT, getTemplateId: () => 'row' }, [renderer], {
			accessibilityProvider: { getAriaLabel: entry => entry.environment.name, getWidgetAriaLabel: () => localize('voltHttp.environments', "Environments") },
			multipleSelectionSupport: false,
		}));
		this.viewStore.add(list.onDidOpen(event => event.element && this.host.openEnvironment(event.element)));
		this.viewStore.add(list.onContextMenu(event => {
			const entry = event.element;
			if (!entry) {
				return;
			}
			const active = this.http.environmentOf(this.host.root) === entry.environment.name;
			this.menu.value = showHttpActionMenu(this.contextViewService, isHTMLElement(event.anchor) ? event.anchor : { x: event.anchor.posx, y: event.anchor.posy }, this.element, [
				toAction({ id: 'open', label: localize('voltHttp.edit', "Edit"), run: () => this.host.openEnvironment(entry) }),
				...(!entry.globals && !entry.shared ? [toAction({ id: 'use', label: active ? localize('voltHttp.envDeactivate', "Stop Using") : localize('voltHttp.envActivate', "Use This Environment"), run: () => this.http.setEnvironment(active ? undefined : entry.environment.name, this.host.root) })] : []),
				toAction({ id: 'duplicate', label: localize('voltHttp.duplicate', "Duplicate"), run: () => void this.guard(() => this.collections.createEnvironment(this.host.root, `${entry.environment.name} Copy`, entry.environment.variables)) }),
				toAction({ id: 'reveal', label: localize('voltHttp.openFile', "Open File"), run: () => this.host.revealFile(entry.uri) }),
				new Separator(),
				toAction({
					id: 'delete', label: localize('voltHttp.delete', "Delete"), run: async () => {
						const { confirmed } = await this.dialogService.confirm({ message: localize('voltHttp.deleteEnvConfirm', "Delete the environment \"{0}\"?", entry.environment.name), primaryButton: localize('voltHttp.delete', "Delete") });
						if (confirmed) {
							await this.guard(() => this.collections.deleteEnvironment(entry));
						}
					},
				}),
			], localize('voltHttp.moreActions', "More Actions"));
		}));
	}

	/** A tool's files as rows: open on click, the rest in the row's menu. */
	private buildToolList(kind: HttpToolKind): void {
		const tool = HTTP_TOOLS.find(item => item.kind === kind)!;
		const files = this.host.toolFiles(kind);
		const actionsOf = (entry: IHttpToolFileEntry): IAction[] => [
			toAction({ id: 'open', label: localize('voltHttp.open', "Open"), run: () => this.host.openTool(kind, entry.uri) }),
			toAction({
				id: 'rename', label: localize('voltHttp.rename', "Rename"), run: async () => {
					const name = await this.quickInputService.input({ value: entry.name, prompt: localize('voltHttp.renameTool', "Name of the {0}", tool.one.toLowerCase()) });
					if (name?.trim() && name.trim() !== entry.name) {
						await this.guard(() => files.rename(entry.uri, name.trim()));
					}
				},
			}),
			toAction({ id: 'duplicate', label: localize('voltHttp.duplicate', "Duplicate"), run: () => void this.guard(() => files.duplicate(entry.uri)) }),
			toAction({ id: 'reveal', label: localize('voltHttp.openFile', "Open File"), run: () => this.host.revealFile(entry.uri) }),
			new Separator(),
			toAction({
				id: 'delete', label: localize('voltHttp.delete', "Delete"), run: async () => {
					const { confirmed } = await this.dialogService.confirm({ message: localize('voltHttp.deleteToolConfirm', "Delete \"{0}\"?", entry.name), detail: localize('voltHttp.deleteToolDetail', "Its file is removed from the project."), primaryButton: localize('voltHttp.delete', "Delete") });
					if (confirmed) {
						this.host.closeToolTab(entry.uri);
						await this.guard(() => files.remove(entry.uri));
					}
				},
			}),
		];
		const renderer: IListRenderer<IHttpToolFileEntry, IRowTemplate> = {
			templateId: 'row',
			renderTemplate: rowTemplate,
			renderElement: (entry, _index, template) => {
				clearNode(template.lead);
				clearNode(template.actions);
				template.lead.className = 'volt-http-row-icon';
				if (entry.running) {
					append(template.lead, $('span.volt-http-spinner')).appendChild(renderIcon(Codicon.loading));
				} else {
					template.lead.appendChild(renderHttpToolIcon(tool.icon));
				}
				template.method.textContent = '';
				template.label.textContent = entry.name;
				template.detail.textContent = entry.detail ?? '';
				setAgentTooltip(template.row, entry.uri.fsPath);
				createHttpIconButton(template.actions, Codicon.ellipsis, localize('voltHttp.moreActions', "More Actions"), button => {
					this.menu.value = showHttpActionMenu(this.contextViewService, button, this.element, actionsOf(entry), localize('voltHttp.moreActions', "More Actions"));
				});
			},
			disposeTemplate: () => { },
		};
		const list = this.toolList = this.viewStore.add(this.instantiationService.createInstance(WorkbenchList<IHttpToolFileEntry>, `VoltHttpTool.${kind}`, this.listHost, { getHeight: () => ROW_HEIGHT, getTemplateId: () => 'row' }, [renderer], {
			accessibilityProvider: { getAriaLabel: entry => `${entry.name} ${entry.detail ?? ''}`, getWidgetAriaLabel: () => tool.label },
			multipleSelectionSupport: false,
		}));
		this.viewStore.add(list.onDidOpen(event => event.element && this.host.openTool(kind, event.element.uri)));
		this.viewStore.add(list.onContextMenu(event => {
			if (event.element) {
				this.menu.value = showHttpActionMenu(this.contextViewService, isHTMLElement(event.anchor) ? event.anchor : { x: event.anchor.posx, y: event.anchor.posy }, this.element, actionsOf(event.element), localize('voltHttp.moreActions', "More Actions"));
			}
		}));
	}

	private buildHistory(): void {
		const renderer: IListRenderer<IHttpExchange, IRowTemplate> = {
			templateId: 'row',
			renderTemplate: rowTemplate,
			renderElement: (exchange, _index, template) => {
				clearNode(template.lead);
				clearNode(template.actions);
				const status = exchange.response?.status;
				template.lead.className = `volt-http-row-icon status ${httpStatusClass(status)}`;
				if (status) {
					template.lead.textContent = String(status);
				} else {
					template.lead.appendChild(renderIcon(Codicon.error));
				}
				template.method.textContent = httpRequestBadge(exchange);
				template.method.dataset.method = httpRequestBadgeKey(exchange);
				template.label.textContent = exchange.name ?? (exchange.url.replace(/^[a-z]+:\/\/[^/]+/i, '') || exchange.url);
				template.detail.textContent = fromNow(exchange.at, false);
				setAgentTooltip(template.row, `${exchange.method} ${exchange.url}${exchange.error ? `\n${exchange.error}` : ''}`);
				createHttpIconButton(template.actions, Codicon.close, localize('voltHttp.removeFromHistory', "Remove"), () => this.http.removeFromHistory(exchange.id));
			},
			disposeTemplate: () => { },
		};
		const list = this.historyList = this.viewStore.add(this.instantiationService.createInstance(WorkbenchList<IHttpExchange>, 'VoltHttpHistory', this.listHost, { getHeight: () => ROW_HEIGHT, getTemplateId: () => 'row' }, [renderer], {
			accessibilityProvider: { getAriaLabel: exchange => `${exchange.method} ${exchange.url} ${exchange.response?.status ?? exchange.error ?? ''}`, getWidgetAriaLabel: () => localize('voltHttp.historyAria', "HTTP history") },
			multipleSelectionSupport: false,
		}));
		this.viewStore.add(list.onDidOpen(event => event.element && this.host.openExchange(event.element)));
	}

	async refresh(): Promise<void> {
		const view = this.view;
		this.refreshing++;
		try {
			const tool = toolOfView(view);
			if (tool) {
				const entries = (await this.host.toolFiles(tool.kind).list(this.host.root)).filter(entry => !this.filter || entry.name.toLowerCase().includes(this.filter));
				if (this.view !== view || !this.toolList) {
					return;
				}
				this.toolList.splice(0, this.toolList.length, [...entries]);
				this.setEmpty(entries.length ? undefined : this.filter ? localize('voltHttp.noMatches', "Nothing matches the filter.") : tool.empty);
				this.applyToolSelection();
			} else if (view === 'collections') {
				const entries = await this.collections.collections(this.host.root);
				if (this.view !== view || !this.tree) {
					return;
				}
				this.nodes.clear();
				const filter = this.filter;
				const build = (entry: IHttpCollectionEntry, items: readonly IHttpItem[]): IObjectTreeElement<HttpTreeNode>[] => {
					const out: IObjectTreeElement<HttpTreeNode>[] = [];
					for (const item of items) {
						if (item.kind === 'request') {
							if (filter && !`${item.method} ${item.name} ${item.url}`.toLowerCase().includes(filter)) {
								continue;
							}
							const node: HttpTreeNode = { kind: 'request', entry, request: item };
							this.nodes.set(nodeId(node), node);
							out.push({ element: node });
						} else {
							const children = build(entry, item.items);
							if (filter && !children.length && !item.name.toLowerCase().includes(filter)) {
								continue;
							}
							const node: HttpTreeNode = { kind: 'folder', entry, folder: item };
							const id = nodeId(node);
							this.nodes.set(id, node);
							out.push({ element: node, children, collapsible: true, collapsed: filter ? false : !this.expandedFolders.has(id) });
						}
					}
					return out;
				};
				const children: IObjectTreeElement<HttpTreeNode>[] = [];
				for (const entry of entries) {
					const items = build(entry, entry.collection.items);
					if (filter && !items.length && !entry.collection.name.toLowerCase().includes(filter)) {
						continue;
					}
					const node: HttpTreeNode = { kind: 'collection', entry };
					const id = nodeId(node);
					this.nodes.set(id, node);
					children.push({ element: node, children: items, collapsible: true, collapsed: filter ? false : this.collapsed.has(id) });
				}
				this.tree.setChildren(null, children);
				this.setEmpty(children.length ? undefined : filter ? localize('voltHttp.noMatches', "Nothing matches the filter.") : localize('voltHttp.noCollections', "No collections in this project yet. Create one with +, or import a Postman collection, an OpenAPI file, a .http file or a cURL command."));
				this.applySelection();
			} else if (view === 'environments') {
				const entries = (await this.collections.environments(this.host.root)).filter(entry => !this.filter || entry.environment.name.toLowerCase().includes(this.filter));
				if (this.view !== view || !this.envList) {
					return;
				}
				this.envList.splice(0, this.envList.length, entries);
				this.setEmpty(entries.length ? undefined : localize('voltHttp.noEnvironments', "No environments yet. An environment is a set of variables, like {{baseUrl}}, to switch between local, staging and production."));
			} else if (this.historyList) {
				const items = this.http.historyOf(this.host.root).filter(item => !this.filter || `${item.method} ${item.url} ${item.name ?? ''}`.toLowerCase().includes(this.filter));
				this.historyList.splice(0, this.historyList.length, [...items]);
				this.setEmpty(items.length ? undefined : localize('voltHttp.noHistory', "Requests you or an agent send show up here."));
			}
		} finally {
			this.refreshing--;
		}
	}

	private setEmpty(text: string | undefined): void {
		this.emptyEl.textContent = text ?? '';
		this.emptyEl.classList.toggle('shown', !!text);
		this.listHost.classList.toggle('hidden', !!text);
	}

	layout(width: number, height: number): void {
		this.width = width;
		this.height = height;
		if (width <= 0 || height <= 0) {
			return;
		}
		this.element.style.width = `${width}px`;
		const listHeight = Math.max(0, height - this.tabsEl.offsetHeight - this.toolsEl.offsetHeight);
		this.listHost.style.height = `${listHeight}px`;
		this.tree?.layout(listHeight, width);
		this.envList?.layout(listHeight, width);
		this.historyList?.layout(listHeight, width);
		this.toolList?.layout(listHeight, width);
	}
}
