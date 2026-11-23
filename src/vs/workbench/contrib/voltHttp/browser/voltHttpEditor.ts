/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/voltHttp.css';
import { $, addDisposableListener, append, clearNode, Dimension, EventType } from '../../../../base/browser/dom.js';
import { renderIcon } from '../../../../base/browser/ui/iconLabel/iconLabels.js';
import { Orientation, Sash, SashState } from '../../../../base/browser/ui/sash/sash.js';
import { Separator, toAction } from '../../../../base/common/actions.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Emitter } from '../../../../base/common/event.js';
import { isMacintosh } from '../../../../base/common/platform.js';
import { DisposableStore, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { basename } from '../../../../base/common/resources.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { CodeEditorWidget } from '../../../../editor/browser/widget/codeEditor/codeEditorWidget.js';
import { ILanguageService } from '../../../../editor/common/languages/language.js';
import { IModelService } from '../../../../editor/common/services/model.js';
import { localize } from '../../../../nls.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { IContextViewService } from '../../../../platform/contextview/browser/contextView.js';
import { IDialogService, IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { EditorPane } from '../../../browser/parts/editor/editorPane.js';
import { IEditorOpenContext, IEditorSerializer, IUntypedEditorInput } from '../../../common/editor.js';
import { EditorInput } from '../../../common/editor/editorInput.js';
import { IEditorGroup } from '../../../services/editor/common/editorGroupsService.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IHttpRequestSpec } from '../../../services/voltRuntime/common/ide/httpFile.js';
import { createVoltButton, voltButtonClasses } from '../../voltAgent/browser/chrome/voltButton.js';
import { IVoltMenuSection, showVoltMenu } from '../../voltAgent/browser/ui/menu/voltMenu.js';
import { openInAgentTools } from '../../voltAgent/browser/workspace/agentSurfaceHost.js';
import { IVoltFeatureService } from '../../voltCustomize/common/voltFeatures.js';
import { HTTP_SNIPPET_TARGETS, httpSnippet, HttpSnippetTarget } from '../common/httpCodegen.js';
import { cloneHttp, emptyHttpRequest, findHttpItem, findHttpItemByPath, httpItemPath, httpRequestFromSpec, httpRequestLabel, IHttpFolder, IHttpItem, IHttpRequest, newHttpId, newHttpRequest } from '../common/httpCollection.js';
import { HTTP_PROTOCOLS, HttpProtocol, httpRequestBadge, httpRequestBadgeKey } from '../common/httpProtocols.js';
import { HTTP_ADD_TO_CHAT_COMMAND_ID, HTTP_CLIENT_FEATURE_ID } from '../common/voltHttp.js';
import { IVoltHttpSessions } from './voltHttpSessions.js';
import { httpDraftKey, IHttpEnvironmentEntry, IVoltHttpCollections } from './voltHttpCollections.js';
import { HttpCollectionPage, HttpEnvironmentPage, IHttpCollectionTabState, IHttpEnvironmentTabState, IHttpPageHost } from './voltHttpPages.js';
import { currentHttpRequest, HttpRequestView, IHttpRequestHost, IHttpRequestTabState, isHttpRequestDirty } from './voltHttpRequestView.js';
import { IHttpExchange, IVoltHttpService } from './voltHttpService.js';
import { HTTP_TOOLS, renderHttpToolIcon, HttpSidebar, HttpSidebarView, IHttpSidebarHost } from './voltHttpSidebar.js';
import { HttpToolKind, IHttpToolFiles, IHttpToolPage, IHttpToolPageHost, IHttpToolTabState } from './voltHttpToolPages.js';
import { IVoltHttpAutomations } from './voltHttpAutomations.js';
import { HttpAutomationPage } from './voltHttpAutomationPage.js';
import { IVoltHttpPerformance } from './voltHttpPerformance.js';
import { HttpPerformancePage } from './voltHttpPerformancePage.js';
import { IVoltHttpSecurity } from './voltHttpSecurity.js';
import { HttpSecurityPage } from './voltHttpSecurityPage.js';
import { HttpCookiesView } from './voltHttpCookiesView.js';
import { httpTestTargetsOf } from './voltHttpBulkTests.js';
import { HttpBulkTestsView } from './voltHttpBulkTestsView.js';
import { createHttpCheckIcon, createHttpCopyIcon, createHttpProtocolIcon, createHttpRequestIcon, createHttpSnippetIcon } from './voltHttpIcons.js';
import { createHttpDropdown, createHttpIconButton, HTTP_MENU_CLASS, showHttpActionMenu, HttpVariableLookup } from './voltHttpWidgets.js';
import { setAgentTooltip } from '../../voltAgent/browser/chrome/agentTooltip.js';

export const VOLT_HTTP_EDITOR_ID = 'workbench.editor.voltHttpRequest';
export const VOLT_HTTP_INPUT_ID = 'workbench.input.voltHttpRequest';

export type HttpClientTab =
	| { readonly kind: 'request'; readonly state: IHttpRequestTabState }
	| { readonly kind: 'collection'; readonly state: IHttpCollectionTabState }
	| { readonly kind: 'environment'; readonly state: IHttpEnvironmentTabState }
	| { readonly kind: 'tool'; readonly tool: HttpToolKind; readonly state: IHttpToolTabState };

/** What something outside the client asks it to show (a CodeLens, the sidebar view, an agent's send). */
export type HttpClientCommand =
	| { readonly type: 'openRequest'; readonly collection: URI; readonly id?: string; readonly path?: readonly string[]; readonly line?: number; readonly name?: string; readonly send?: boolean; readonly exchange?: IHttpExchange }
	| { readonly type: 'openUntitled'; readonly request?: IHttpRequest; readonly exchange?: IHttpExchange; readonly send?: boolean }
	| { readonly type: 'openExchange'; readonly exchange: IHttpExchange }
	| { readonly type: 'openCollection'; readonly collection: URI; readonly folderId?: string; readonly run?: boolean }
	| { readonly type: 'import' };

interface ISavedTab {
	readonly kind: HttpClientTab['kind'];
	readonly collection?: string;
	readonly id?: string;
	/** The item's names from the collection down: finds it again after a restart, when ids are new. */
	readonly path?: readonly string[];
	/** A request's unsaved edits (or the whole of one saved nowhere yet). */
	readonly draft?: IHttpRequest;
	readonly entryId?: string;
	readonly name?: string;
	/** An automation, performance test or security scan: which, and its file. */
	readonly tool?: HttpToolKind;
	readonly uri?: string;
}

interface ISavedClient {
	readonly root?: string;
	readonly instance?: string;
	readonly tabs: readonly ISavedTab[];
	readonly active: number;
	readonly sidebar: HttpSidebarView;
	readonly sidebarWidth: number;
	readonly sidebarHidden: boolean;
	readonly ratio: number;
}

function requestTabState(collection: URI | undefined, id: string, untitled?: IHttpRequest): IHttpRequestTabState {
	return { collection, id, ...(untitled ? { untitled } : {}), responseTab: 'body', scriptTab: 'test', pretty: true, wrap: true };
}

function collectionTabState(collection: URI, folderId?: string): IHttpCollectionTabState {
	return { collection, ...(folderId ? { folderId } : {}), tab: 'overview', scriptTab: 'preRequest', results: [], iterations: 1, delayMs: 0, stopOnFailure: false };
}

function tabKey(tab: HttpClientTab): string {
	switch (tab.kind) {
		case 'request': return httpDraftKey(tab.state.collection, tab.state.id);
		case 'collection': return `collection:${tab.state.collection.toString()}#${tab.state.folderId ?? ''}`;
		case 'environment': return `environment:${tab.state.entryId}`;
		case 'tool': return `tool:${tab.state.uri.toString()}`;
	}
}

/**
 * A Volt Client tab: its open request tabs and layout, for one project. Opening the client again
 * makes another one, as a terminal or browser tab does, each with tabs of its own; two projects
 * never share environment or history, while the collections themselves (and unsaved edits to a
 * request) live in `IVoltHttpCollections`, one per file, and show the same in every client that
 * has them open.
 */
export class VoltHttpClientInput extends EditorInput {

	static readonly TypeID = VOLT_HTTP_INPUT_ID;

	readonly resource: URI;
	readonly tabs: HttpClientTab[] = [];
	active = -1;
	sidebar: HttpSidebarView = 'collections';
	sidebarWidth = 260;
	sidebarHidden = false;
	requestRatio = 0.5;
	/** Tabs read from storage, resolved against the collections once they are loaded. */
	restore: readonly ISavedTab[] | undefined;
	restoreActive = 0;
	/** Set by the pane: saving the tabs reads their unsaved edits and name paths from it. */
	collections: IVoltHttpCollections | undefined;
	private readonly queue: HttpClientCommand[] = [];
	private readonly _onDidRequest = this._register(new Emitter<void>());
	readonly onDidRequest = this._onDidRequest.event;

	/** When the user last had this client in front: an agent's send or a CodeLens goes to the latest. */
	shownAt = 0;

	constructor(readonly root: URI | undefined, readonly instance: string = generateUuid().slice(0, 8)) {
		super();
		// Each client its own resource: a tab strip takes two editors with one resource for the same tab.
		this.resource = URI.from({ scheme: 'volt-http', path: '/client', query: root?.toString() ?? '', fragment: instance });
	}

	override get typeId(): string { return VoltHttpClientInput.TypeID; }
	override get editorId(): string { return VOLT_HTTP_EDITOR_ID; }

	override getName(): string {
		return localize('voltHttp.clientName', "Volt Client");
	}

	override getDescription(): string | undefined {
		return this.root ? basename(this.root) : undefined;
	}

	override getIcon(): ThemeIcon {
		return Codicon.plug;
	}

	override matches(other: EditorInput | IUntypedEditorInput): boolean {
		return other instanceof VoltHttpClientInput ? other.instance === this.instance : super.matches(other);
	}

	/** Asks the client to do something; it happens now when the client is on screen, else when it next shows. */
	request(command: HttpClientCommand): void {
		this.queue.push(command);
		this._onDidRequest.fire();
	}

	takeCommands(): HttpClientCommand[] {
		return this.queue.splice(0, this.queue.length);
	}
}

export class VoltHttpClientInputSerializer implements IEditorSerializer {
	canSerialize(): boolean {
		return true;
	}

	serialize(input: EditorInput): string | undefined {
		if (!(input instanceof VoltHttpClientInput)) {
			return undefined;
		}
		const saved: ISavedClient = {
			...(input.root ? { root: input.root.toString() } : {}),
			instance: input.instance,
			tabs: input.restore ?? input.tabs.map(tab => savedTab(tab, input.collections)),
			active: input.restore ? input.restoreActive : input.active,
			sidebar: input.sidebar,
			sidebarWidth: input.sidebarWidth,
			sidebarHidden: input.sidebarHidden,
			ratio: input.requestRatio,
		};
		return JSON.stringify(saved);
	}

	deserialize(instantiationService: IInstantiationService, raw: string): EditorInput | undefined {
		// A tab saved in a chat's tools comes back when that chat is shown: not while the HTTP client is off.
		if (instantiationService.invokeFunction(accessor => accessor.getIfExists(IVoltFeatureService))?.isEnabled(HTTP_CLIENT_FEATURE_ID) === false) {
			return undefined;
		}
		try {
			const data = JSON.parse(raw) as Partial<ISavedClient> & { draft?: { method?: string; url?: string; name?: string }; source?: { uri: string; line: number } };
			const input = new VoltHttpClientInput(data.root ? URI.parse(data.root) : undefined, typeof data.instance === 'string' && data.instance ? data.instance : undefined);
			if (Array.isArray(data.tabs)) {
				input.restore = data.tabs;
				input.restoreActive = typeof data.active === 'number' ? data.active : 0;
				input.sidebar = data.sidebar ?? 'collections';
				input.sidebarWidth = typeof data.sidebarWidth === 'number' ? data.sidebarWidth : 260;
				input.sidebarHidden = !!data.sidebarHidden;
				input.requestRatio = typeof data.ratio === 'number' ? data.ratio : 0.5;
			} else if (data.source) {
				// A request tab of the client before it had collections: its request, by line.
				input.request({ type: 'openRequest', collection: URI.parse(data.source.uri), line: data.source.line });
			} else if (data.draft?.url) {
				const request = emptyHttpRequest(data.draft.name ?? '', 'none');
				request.method = data.draft.method ?? 'GET';
				request.url = data.draft.url;
				input.request({ type: 'openUntitled', request });
			}
			return input;
		} catch {
			return undefined;
		}
	}
}

function savedTab(tab: HttpClientTab, collections: IVoltHttpCollections | undefined): ISavedTab {
	switch (tab.kind) {
		case 'request': {
			const state = tab.state;
			const entry = state.collection ? collections?.get(state.collection) : undefined;
			const draft = collections?.draftOf(httpDraftKey(state.collection, state.id)) ?? (state.collection ? undefined : state.untitled);
			return { kind: 'request', ...(state.collection ? { collection: state.collection.toString() } : {}), id: state.id, ...(entry ? { path: httpItemPath(entry.collection, state.id) } : {}), ...(draft ? { draft } : {}) };
		}
		case 'collection': {
			const entry = collections?.get(tab.state.collection);
			return { kind: 'collection', collection: tab.state.collection.toString(), ...(tab.state.folderId ? { id: tab.state.folderId, ...(entry ? { path: httpItemPath(entry.collection, tab.state.folderId) } : {}) } : {}) };
		}
		case 'environment':
			return { kind: 'environment', entryId: tab.state.entryId, name: tab.state.name };
		case 'tool':
			return { kind: 'tool', tool: tab.tool, uri: tab.state.uri.toString() };
	}
}

const NARROW_WIDTH = 640;
const MIN_SIDEBAR = 180;
const MAX_SIDEBAR = 480;

/**
 * The HTTP client, laid out like Postman: Collections, Environments and History on the left; on
 * the right a strip of open tabs with the environment picker, and under it the request (or a
 * collection's or environment's page) in front. Below 640px the left side folds away behind its
 * toggle and opens over the content.
 */
export class VoltHttpClientEditor extends EditorPane {

	static readonly ID = VOLT_HTTP_EDITOR_ID;

	private root!: HTMLElement;
	private sideHost!: HTMLElement;
	private main!: HTMLElement;
	private strip!: HTMLElement;
	private tabList!: HTMLElement;
	private stripActions!: HTMLElement;
	private content!: HTMLElement;
	private modalHost!: HTMLElement;
	private sash!: Sash;
	private sidebar: HttpSidebar | undefined;
	private readonly inputStore = this._register(new DisposableStore());
	private readonly viewStore = this._register(new DisposableStore());
	private readonly stripStore = this._register(new DisposableStore());
	private readonly modal = this._register(new MutableDisposable<DisposableStore>());
	private readonly menu = this._register(new MutableDisposable());
	private requestView: HttpRequestView | undefined;
	private page: HttpCollectionPage | HttpEnvironmentPage | IHttpToolPage | undefined;
	/** The tab being dragged in the strip, and whether it was dropped on the strip (a reorder). */
	private dragged: { tab: HttpClientTab; dropped: boolean } | undefined;
	/** The tools whose files were listed for a restored tab's name. */
	private readonly toolNamesAsked = new Set<HttpToolKind>();
	private dimension: Dimension | undefined;
	private narrow = false;
	/** The variables of the tab in front, for colouring `{{names}}`. */
	private variables: ReadonlyMap<string, { readonly value: string; readonly source: string }> | undefined;
	/** The variables in reach of the tab in front, and the way to give one a new value (a field's hover card). */
	private readonly variableLookup: HttpVariableLookup = Object.assign(() => this.variables, {
		update: async (name: string, value: string) => {
			const input = this.client;
			const active = input?.tabs[input.active];
			const collection = active?.kind === 'request' || active?.kind === 'collection' ? active.state.collection : undefined;
			const done = await this.collections.setVariable(input?.root, collection, name, value);
			await this.loadVariables();
			return done;
		},
	});
	private variablesFor = 0;
	/** The snippet language picked last, offered first the next time. */
	private snippetTarget: HttpSnippetTarget = 'curl';

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IContextViewService private readonly contextViewService: IContextViewService,
		@ICommandService private readonly commandService: ICommandService,
		@IVoltHttpSessions private readonly sessions: IVoltHttpSessions,
		@IModelService private readonly modelService: IModelService,
		@ILanguageService private readonly languageService: ILanguageService,
		@IClipboardService private readonly clipboardService: IClipboardService,
		@IDialogService private readonly dialogService: IDialogService,
		@IFileDialogService private readonly fileDialogService: IFileDialogService,
		@IFileService private readonly fileService: IFileService,
		@INotificationService private readonly notificationService: INotificationService,
		@IEditorService private readonly editorService: IEditorService,
		@IVoltHttpCollections private readonly collections: IVoltHttpCollections,
		@IVoltHttpService private readonly http: IVoltHttpService,
		@IVoltHttpAutomations private readonly automations: IVoltHttpAutomations,
		@IVoltHttpPerformance private readonly performance: IVoltHttpPerformance,
		@IVoltHttpSecurity private readonly security: IVoltHttpSecurity,
	) {
		super(VoltHttpClientEditor.ID, group, telemetryService, themeService, storageService);
	}

	private toolFiles(kind: HttpToolKind): IHttpToolFiles {
		return kind === 'automation' ? this.automations : kind === 'performance' ? this.performance : this.security;
	}

	/** The chat this client sits beside, when it is in a chat's tools. */
	private get chatId(): string | undefined {
		return this.root.closest<HTMLElement>('.volt-agent-tools-part')?.dataset.sessionId;
	}

	private get client(): VoltHttpClientInput | undefined {
		return this.input instanceof VoltHttpClientInput ? this.input : undefined;
	}

	protected override createEditor(parent: HTMLElement): void {
		this.root = append(parent, $('.volt-http-editor.volt-http-client'));
		this.sideHost = append(this.root, $('.volt-http-side-host'));
		this.main = append(this.root, $('.volt-http-main'));
		this.strip = append(this.main, $('.volt-http-strip'));
		const toggle = createHttpIconButton(this.strip, Codicon.layoutSidebarLeft, localize('voltHttp.toggleSidebar', "Collections, Environments and History"), () => this.toggleSidebar());
		toggle.classList.add('volt-http-side-toggle');
		this.tabList = append(this.strip, $('.volt-http-strip-tabs'));
		this.tabList.setAttribute('role', 'tablist');
		// Beside the tabs, not among them: it stays in reach however many are open.
		const add = createHttpIconButton(this.strip, Codicon.add, localize('voltHttp.newTab', "New"), button => this.showKindMenu(button));
		add.classList.add('volt-http-strip-add');
		this.stripActions = append(this.strip, $('.volt-http-strip-actions'));
		this.content = append(this.main, $('.volt-http-content'));
		this.modalHost = append(this.root, $('.volt-http-modal-host'));
		this.sash = this._register(new Sash(this.root, { getVerticalSashLeft: () => this.sideHost.offsetWidth }, { orientation: Orientation.VERTICAL }));
		let startWidth = 0;
		this._register(this.sash.onDidStart(() => startWidth = this.sideHost.offsetWidth));
		this._register(this.sash.onDidChange(event => {
			const client = this.client;
			if (client && !this.narrow) {
				client.sidebarWidth = Math.max(MIN_SIDEBAR, Math.min(MAX_SIDEBAR, startWidth + event.currentX - event.startX));
				this.layoutParts();
			}
		}));
		this._register(this.sash.onDidReset(() => {
			if (this.client) {
				this.client.sidebarWidth = 260;
				this.layoutParts();
			}
		}));
		// A file dropped anywhere on the client is imported.
		this._register(addDisposableListener(this.root, EventType.DRAG_OVER, (event: DragEvent) => {
			if (event.dataTransfer?.types.includes('Files')) {
				event.preventDefault();
			}
		}));
		this._register(addDisposableListener(this.root, EventType.DROP, (event: DragEvent) => {
			const file = event.dataTransfer?.files[0];
			if (file) {
				event.preventDefault();
				void file.text().then(text => this.importText(text, file.name));
			}
		}));
		this._register(this.http.onDidChangeEnvironment(() => {
			this.renderStripActions();
			void this.loadVariables();
		}));
		this._register(this.collections.onDidChangeEnvironments(() => {
			this.renderStripActions();
			void this.loadVariables();
		}));
		this._register(this.collections.onDidChange(() => {
			this.renderTabStrip();
			void this.loadVariables();
		}));
		this._register(this.collections.onDidChangeDraft(() => this.renderTabStrip()));
		for (const tool of HTTP_TOOLS) {
			// A renamed or deleted file: its tab's label follows.
			this._register(this.toolFiles(tool.kind).onDidChange(() => this.renderTabStrip()));
		}
		// The strip itself takes a dragged tab dropped after the last one.
		this._register(addDisposableListener(this.tabList, EventType.DRAG_OVER, (event: DragEvent) => {
			if (this.dragged) {
				event.preventDefault();
			}
		}));
		this._register(addDisposableListener(this.tabList, EventType.DROP, (event: DragEvent) => {
			const dragged = this.dragged;
			const input = this.client;
			if (!dragged || !input || event.defaultPrevented) {
				return;
			}
			event.preventDefault();
			dragged.dropped = true;
			this.moveTab(dragged.tab, input.tabs.length);
		}));
	}

	override async setInput(input: VoltHttpClientInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);
		input.collections = this.collections;
		input.shownAt = Date.now();
		this.inputStore.clear();
		this.viewStore.clear();
		this.requestView = undefined;
		this.page = undefined;
		clearNode(this.sideHost);
		const host: IHttpSidebarHost = {
			root: input.root,
			openRequest: (collection, id) => this.openRequest(collection, id),
			openFolder: (collection, id) => this.openCollection(collection, id),
			openCollection: collection => this.openCollection(collection),
			openEnvironment: entry => this.openEnvironment(entry),
			openExchange: exchange => this.openExchange(exchange),
			newRequest: protocol => this.openUntitled(undefined, undefined, protocol),
			showImport: () => this.showImport(),
			exportCollection: collection => void this.exportCollection(collection),
			run: (collection, folderId) => this.openCollection(collection, folderId, true),
			generateTests: (collection, itemId) => this.showGenerateTests(collection, itemId),
			revealFile: uri => this.revealFile(uri),
			closeTabsOf: (collection, id) => this.closeTabsOf(collection, id),
			sidebarViewChanged: view => input.sidebar = view,
			toolFiles: kind => this.toolFiles(kind),
			openTool: (kind, uri) => this.openTool(kind, uri),
			closeToolTab: uri => {
				const tab = input.tabs.find(item => item.kind === 'tool' && item.state.uri.toString() === uri.toString());
				if (tab) {
					this.removeTab(tab);
				}
			},
		};
		this.sidebar = this.inputStore.add(this.instantiationService.createInstance(HttpSidebar, this.sideHost, host));
		if (input.sidebar !== 'collections') {
			this.sidebar.show(input.sidebar);
		}
		this.inputStore.add(input.onDidRequest(() => void this.runCommands()));
		this.renderStripActions();
		this.layoutParts();
		await this.restoreTabs(input);
		if (token.isCancellationRequested || this.input !== input) {
			return;
		}
		this.renderTabStrip();
		this.showActive();
		await this.runCommands();
	}

	override clearInput(): void {
		this.inputStore.clear();
		this.viewStore.clear();
		this.modal.clear();
		this.requestView = undefined;
		this.page = undefined;
		this.sidebar = undefined;
		super.clearInput();
	}

	/** Tabs read from storage find their requests again: by id while the window lives, by name path after a restart. */
	private async restoreTabs(input: VoltHttpClientInput): Promise<void> {
		const saved = input.restore;
		if (!saved) {
			return;
		}
		await this.collections.collections(input.root);
		if (!input.restore) {
			return;
		}
		input.restore = undefined;
		const itemOf = async (tab: ISavedTab): Promise<{ uri: URI; item: IHttpItem | undefined } | undefined> => {
			if (!tab.collection) {
				return undefined;
			}
			const uri = URI.parse(tab.collection);
			const entry = await this.collections.load(uri);
			if (!entry) {
				return undefined;
			}
			return { uri, item: (tab.id ? findHttpItem(entry.collection, tab.id)?.item : undefined) ?? (tab.path ? findHttpItemByPath(entry.collection, tab.path) : undefined) };
		};
		for (const tab of saved) {
			if (tab.kind === 'request') {
				if (!tab.collection) {
					if (tab.draft) {
						const request = { ...tab.draft, id: tab.id ?? newHttpId() };
						input.tabs.push({ kind: 'request', state: requestTabState(undefined, request.id, request) });
					}
					continue;
				}
				const found = await itemOf(tab);
				if (found?.item?.kind === 'request') {
					input.tabs.push({ kind: 'request', state: requestTabState(found.uri, found.item.id) });
					if (tab.draft) {
						this.collections.setDraft(httpDraftKey(found.uri, found.item.id), { ...tab.draft, id: found.item.id });
					}
				}
			} else if (tab.kind === 'collection') {
				const found = await itemOf(tab);
				if (found && (!tab.id || found.item?.kind === 'folder')) {
					input.tabs.push({ kind: 'collection', state: collectionTabState(found.uri, found.item?.id) });
				}
			} else if (tab.kind === 'tool') {
				if (tab.tool && tab.uri && await this.fileService.exists(URI.parse(tab.uri))) {
					input.tabs.push({ kind: 'tool', tool: tab.tool, state: { uri: URI.parse(tab.uri), memory: {} } });
				}
			} else if (tab.entryId) {
				input.tabs.push({ kind: 'environment', state: { entryId: tab.entryId, name: tab.name ?? '' } });
			}
		}
		input.active = Math.min(input.restoreActive, input.tabs.length - 1);
	}

	private async runCommands(): Promise<void> {
		const input = this.client;
		if (!input) {
			return;
		}
		for (const command of input.takeCommands()) {
			switch (command.type) {
				case 'openRequest': {
					const entry = await this.collections.load(command.collection);
					if (this.input !== input) {
						return;
					}
					const requests = entry?.collection.items.filter((item): item is IHttpRequest => item.kind === 'request') ?? [];
					const byPath = command.path && entry ? findHttpItemByPath(entry.collection, command.path) : undefined;
					const id = command.id ?? (byPath?.kind === 'request' ? byPath.id : undefined) ?? (command.line !== undefined ? requests.find(item => item.line === command.line)?.id : undefined) ?? (command.name ? requests.find(item => item.name === command.name)?.id : undefined);
					if (id) {
						this.openRequest(command.collection, id, command.exchange);
						if (command.send) {
							void this.requestView?.send();
						}
					}
					break;
				}
				case 'openUntitled':
					this.openUntitled(command.request, command.exchange);
					if (command.send) {
						void this.requestView?.send();
					}
					break;
				case 'openExchange': this.openExchange(command.exchange); break;
				case 'openCollection':
					await this.collections.load(command.collection);
					if (this.input !== input) {
						return;
					}
					this.openCollection(command.collection, command.folderId, command.run);
					break;
				case 'import': this.showImport(); break;
			}
		}
	}

	// --- Tabs --------------------------------------------------------------------------------------

	private activate(tab: HttpClientTab): void {
		const input = this.client;
		if (!input) {
			return;
		}
		const key = tabKey(tab);
		let index = input.tabs.findIndex(item => tabKey(item) === key);
		const added = index < 0;
		if (added) {
			input.tabs.push(tab);
			index = input.tabs.length - 1;
		}
		const changed = input.active !== index || (!this.requestView && !this.page);
		input.active = index;
		if (added) {
			this.renderTabStrip();
		} else {
			// Its element stays (a press on it may be the start of a drag): only the marks move.
			this.markActiveTab();
		}
		if (changed) {
			this.showActive();
		}
		if (this.narrow && this.root.classList.contains('side-open')) {
			// Beside a chat the sidebar lies over the content: it steps aside for what was opened.
			this.root.classList.remove('side-open');
			this.layoutParts();
		}
	}

	private openRequest(collection: URI, id: string, exchange?: IHttpExchange): void {
		this.activate({ kind: 'request', state: requestTabState(collection, id) });
		if (exchange) {
			this.requestView?.showExchange(exchange);
		}
	}

	private openUntitled(request?: IHttpRequest, exchange?: IHttpExchange, protocol: HttpProtocol = 'http'): void {
		const untitled = request ? { ...cloneHttp(request), id: newHttpId() } : newHttpRequest(protocol, '', 'none');
		this.activate({ kind: 'request', state: requestTabState(undefined, untitled.id, untitled) });
		if (exchange) {
			this.requestView?.showExchange(exchange);
		}
		this.requestView?.focus();
	}

	private openCollection(collection: URI, folderId?: string, run = false): void {
		this.activate({ kind: 'collection', state: collectionTabState(collection, folderId) });
		const tab = this.client?.tabs[this.client.active];
		if (run && tab?.kind === 'collection') {
			tab.state.tab = 'runs';
			this.showActive();
			if (this.page instanceof HttpCollectionPage) {
				void this.page.run();
			}
		}
	}

	private openTool(kind: HttpToolKind, uri: URI): void {
		this.activate({ kind: 'tool', tool: kind, state: { uri, memory: {} } });
	}

	private openEnvironment(entry: IHttpEnvironmentEntry): void {
		this.activate({ kind: 'environment', state: { entryId: entry.id, name: entry.environment.name } });
	}

	/** A history entry: its request's tab when the request still exists, else a new request made from what was sent. */
	private openExchange(exchange: IHttpExchange): void {
		const source = exchange.request;
		if (source) {
			const uri = URI.parse(source.collection);
			const entry = this.collections.get(uri);
			if (entry && findHttpItem(entry.collection, source.id)?.item.kind === 'request') {
				this.openRequest(uri, source.id, exchange);
				return;
			}
		}
		const spec: IHttpRequestSpec = { ...(exchange.name ? { name: exchange.name } : {}), method: exchange.method, ...(exchange.protocol ? { protocol: exchange.protocol } : {}), url: exchange.url, headers: exchange.headers, ...(exchange.body !== undefined ? { body: exchange.body } : {}), line: 0 };
		this.openUntitled(httpRequestFromSpec(spec), exchange);
	}

	private closeTabsOf(collection: URI, id: string | undefined): void {
		const input = this.client;
		if (!input) {
			return;
		}
		const uri = collection.toString();
		const doomed = input.tabs.filter(tab => (tab.kind === 'request' || tab.kind === 'collection') && tab.state.collection?.toString() === uri && (!id || (tab.kind === 'request' ? tab.state.id === id : tab.state.folderId === id)));
		for (const tab of doomed) {
			this.removeTab(tab);
		}
	}

	private removeTab(tab: HttpClientTab): void {
		const input = this.client;
		if (!input) {
			return;
		}
		const index = input.tabs.indexOf(tab);
		if (index < 0) {
			return;
		}
		if (tab.kind === 'request') {
			tab.state.sending?.cancel();
			this.sessions.drop(httpDraftKey(tab.state.collection, tab.state.id));
			this.collections.setDraft(httpDraftKey(tab.state.collection, tab.state.id), undefined);
		} else if (tab.kind === 'collection') {
			tab.state.running?.cancel();
		}
		const wasActive = input.active === index;
		input.tabs.splice(index, 1);
		if (input.active > index || input.active >= input.tabs.length) {
			input.active = Math.max(-1, Math.min(input.active - 1, input.tabs.length - 1));
			if (input.active < 0 && input.tabs.length) {
				input.active = 0;
			}
		}
		this.renderTabStrip();
		if (wasActive) {
			this.showActive();
		}
	}

	/** Closing a request with unsaved edits asks first, as Postman does. */
	private async closeTab(tab: HttpClientTab): Promise<void> {
		if (tab.kind === 'request' && isHttpRequestDirty(this.collections, tab.state)) {
			const request = currentHttpRequest(this.collections, tab.state);
			const { result } = await this.dialogService.prompt<'save' | 'discard'>({
				message: localize('voltHttp.closeDirty', "Save the changes to \"{0}\"?", request ? httpRequestLabel(request) : ''),
				detail: localize('voltHttp.closeDirtyDetail', "Your changes are lost if you do not save them."),
				buttons: [
					{ label: localize('voltHttp.save', "Save"), run: () => 'save' as const },
					{ label: localize('voltHttp.dontSave', "Don't Save"), run: () => 'discard' as const },
				],
				cancelButton: true,
			});
			if (!result) {
				return;
			}
			if (result === 'save') {
				if (!tab.state.collection) {
					// Nowhere to save it yet: bring it in front and ask where.
					this.activate(tab);
					void this.requestView?.save();
					return;
				}
				this.activate(tab);
				await this.requestView?.save();
			}
		}
		this.removeTab(tab);
	}

	private renderTabStrip(): void {
		this.stripStore.clear();
		clearNode(this.tabList);
		const input = this.client;
		if (!input) {
			return;
		}
		input.tabs.forEach((tab, index) => {
			const el = append(this.tabList, $('.volt-http-open-tab'));
			el.setAttribute('role', 'tab');
			el.setAttribute('aria-selected', String(index === input.active));
			el.classList.toggle('active', index === input.active);
			el.tabIndex = 0;
			el.draggable = true;
			let label: string;
			let dirty = false;
			if (tab.kind === 'request') {
				const request = currentHttpRequest(this.collections, tab.state);
				const method = append(el, $('span.volt-http-row-method'));
				method.textContent = request ? httpRequestBadge(request) : '';
				method.dataset.method = request ? httpRequestBadgeKey(request) : '';
				label = request ? httpRequestLabel(request) : localize('voltHttp.tabGone', "Deleted request");
				dirty = isHttpRequestDirty(this.collections, tab.state);
				el.classList.toggle('gone', !request);
			} else if (tab.kind === 'collection') {
				const entry = this.collections.get(tab.state.collection);
				const folder = tab.state.folderId && entry ? findHttpItem(entry.collection, tab.state.folderId)?.item : undefined;
				append(el, $('span.volt-http-open-tab-icon')).appendChild(renderIcon(tab.state.folderId ? Codicon.folder : entry?.collection.format === 'http' ? Codicon.file : Codicon.library));
				label = folder?.name ?? (entry?.collection.format === 'postman' ? entry.collection.name : basename(tab.state.collection));
			} else if (tab.kind === 'tool') {
				const tool = HTTP_TOOLS.find(item => item.kind === tab.tool)!;
				append(el, $('span.volt-http-open-tab-icon')).appendChild(renderHttpToolIcon(tool.icon));
				const named = this.toolFiles(tab.tool).nameOf(tab.state.uri);
				label = named ?? basename(tab.state.uri).replace(/\.volt-[a-z]+\.json$/i, '');
				// A restored tab whose file nobody has read yet shows its file name: list the tool's files once, for their names.
				if (named === undefined && !this.toolNamesAsked.has(tab.tool)) {
					this.toolNamesAsked.add(tab.tool);
					void this.toolFiles(tab.tool).list(this.client?.root).then(() => this.renderTabStrip(), () => undefined);
				}
			} else {
				append(el, $('span.volt-http-open-tab-icon')).appendChild(renderIcon(Codicon.symbolVariable));
				label = tab.state.name || localize('voltHttp.environment', "Environment");
			}
			append(el, $('span.volt-http-open-tab-label')).textContent = label;
			setAgentTooltip(el, label);
			const close = append(el, $('button.volt-http-open-tab-close')) as HTMLButtonElement;
			close.type = 'button';
			close.draggable = false;
			setAgentTooltip(close, localize('voltHttp.closeTab', "Close"));
			close.setAttribute('aria-label', localize('voltHttp.closeTab', "Close"));
			close.classList.toggle('dirty', dirty);
			close.appendChild(renderIcon(Codicon.close));
			append(close, $('span.volt-http-dirty-dot'));
			close.addEventListener('mousedown', event => event.stopPropagation());
			close.addEventListener('click', event => {
				event.stopPropagation();
				void this.closeTab(tab);
			});
			// On the press, as VS Code's tabs: a click whose press and release land on different
			// elements (the strip was redrawn in between) would never arrive.
			el.addEventListener('mousedown', event => {
				if (event.button === 0) {
					this.activate(tab);
				}
			});
			el.addEventListener('auxclick', event => {
				if (event.button === 1) {
					event.preventDefault();
					void this.closeTab(tab);
				}
			});
			el.addEventListener('keydown', event => {
				if (event.key === 'Enter' || event.key === ' ') {
					event.preventDefault();
					this.activate(tab);
				}
			});
			el.addEventListener('contextmenu', event => {
				event.preventDefault();
				this.menu.value = showHttpActionMenu(this.contextViewService, { x: event.clientX, y: event.clientY }, this.root, [
					toAction({ id: 'close', label: localize('voltHttp.closeTab', "Close"), run: () => void this.closeTab(tab) }),
					toAction({ id: 'closeOthers', label: localize('voltHttp.closeOthers', "Close Others"), run: async () => { for (const other of [...input.tabs]) { if (other !== tab) { await this.closeTab(other); } } } }),
					toAction({ id: 'closeAll', label: localize('voltHttp.closeAll', "Close All"), run: async () => { for (const other of [...input.tabs]) { await this.closeTab(other); } } }),
					new Separator(),
					toAction({ id: 'moveOut', label: localize('voltHttp.moveToNewClient', "Move to a New Volt Client Tab"), run: () => this.tearOut(tab) }),
				], localize('voltHttp.tabActions', "Tab actions"));
			});
			this.wireTabDrag(el, tab);
			if (index === input.active) {
				el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
			}
		});
		this.selectInSidebar();
	}

	/** The marks of the tab in front, on the tabs as they stand (no element is replaced). */
	private markActiveTab(): void {
		const input = this.client;
		if (!input) {
			return;
		}
		const tabs = this.tabList.children;
		if (tabs.length !== input.tabs.length) {
			this.renderTabStrip();
			return;
		}
		for (let index = 0; index < tabs.length; index++) {
			const el = tabs[index] as HTMLElement;
			el.classList.toggle('active', index === input.active);
			el.setAttribute('aria-selected', String(index === input.active));
			if (index === input.active) {
				el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
			}
		}
		this.selectInSidebar();
	}

	private selectInSidebar(): void {
		const active = this.client?.tabs[this.client.active];
		const inCollection = active?.kind === 'request' || active?.kind === 'collection' ? active : undefined;
		this.sidebar?.select(inCollection?.state.collection, inCollection?.kind === 'request' ? inCollection.state.id : inCollection?.kind === 'collection' ? inCollection.state.folderId : undefined);
		this.sidebar?.selectTool(active?.kind === 'tool' ? active.state.uri : undefined);
	}

	/**
	 * A tab is dragged along the strip to reorder it, or out of the client (onto the panel's own
	 * tabs, or anywhere beside it) to open it in a Volt Client tab of its own.
	 */
	private wireTabDrag(el: HTMLElement, tab: HttpClientTab): void {
		const clear = () => el.classList.remove('drop-before', 'drop-after');
		el.addEventListener('dragstart', event => {
			this.dragged = { tab, dropped: false };
			event.dataTransfer?.setData('application/x-volt-http-tab', tabKey(tab));
			if (event.dataTransfer) {
				event.dataTransfer.effectAllowed = 'move';
			}
			el.classList.add('dragging');
		});
		el.addEventListener('dragover', event => {
			if (!this.dragged || this.dragged.tab === tab) {
				return;
			}
			event.preventDefault();
			const rect = el.getBoundingClientRect();
			const before = event.clientX < rect.left + rect.width / 2;
			el.classList.toggle('drop-before', before);
			el.classList.toggle('drop-after', !before);
		});
		el.addEventListener('dragleave', clear);
		el.addEventListener('drop', event => {
			const dragged = this.dragged;
			const input = this.client;
			clear();
			if (!dragged || !input || dragged.tab === tab) {
				return;
			}
			event.preventDefault();
			dragged.dropped = true;
			const rect = el.getBoundingClientRect();
			const at = input.tabs.indexOf(tab) + (event.clientX < rect.left + rect.width / 2 ? 0 : 1);
			this.moveTab(dragged.tab, at);
		});
		el.addEventListener('dragend', event => {
			const dragged = this.dragged;
			this.dragged = undefined;
			el.classList.remove('dragging');
			if (!dragged || dragged.dropped) {
				return;
			}
			// Let go outside the client: the tab leaves it for a client of its own.
			const rect = this.root.getBoundingClientRect();
			const view = this.root.ownerDocument.defaultView;
			const inWindow = !!view && event.clientX >= 0 && event.clientY >= 0 && event.clientX <= view.innerWidth && event.clientY <= view.innerHeight;
			const outside = event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom;
			if (inWindow && outside && (event.clientX !== 0 || event.clientY !== 0)) {
				this.tearOut(dragged.tab);
			}
		});
	}

	/** Puts `tab` before the tab now at `at` (the end when `at` is the count). */
	private moveTab(tab: HttpClientTab, at: number): void {
		const input = this.client;
		if (!input) {
			return;
		}
		const from = input.tabs.indexOf(tab);
		if (from < 0) {
			return;
		}
		const front = input.tabs[input.active];
		input.tabs.splice(from, 1);
		input.tabs.splice(at > from ? at - 1 : at, 0, tab);
		input.active = front ? input.tabs.indexOf(front) : input.active;
		this.renderTabStrip();
	}

	/** Opens `tab` in a new Volt Client tab of the panel and takes it out of this one: its unsaved edits, response and connection go with it. */
	private tearOut(tab: HttpClientTab): void {
		const input = this.client;
		if (!input) {
			return;
		}
		const index = input.tabs.indexOf(tab);
		if (index < 0) {
			return;
		}
		const fresh = new VoltHttpClientInput(input.root);
		fresh.tabs.push(tab);
		fresh.active = 0;
		fresh.sidebar = input.sidebar;
		fresh.sidebarWidth = input.sidebarWidth;
		fresh.sidebarHidden = input.sidebarHidden;
		fresh.requestRatio = input.requestRatio;
		const wasActive = input.active === index;
		input.tabs.splice(index, 1);
		if (input.active > index || input.active >= input.tabs.length) {
			input.active = Math.max(input.tabs.length ? 0 : -1, Math.min(input.active - 1, input.tabs.length - 1));
		}
		this.renderTabStrip();
		if (wasActive) {
			this.showActive();
		}
		const inTools = openInAgentTools(fresh, this.chatId, { pinned: true });
		if (!inTools) {
			void this.editorService.openEditor(fresh, { pinned: true });
		}
	}

	/** What the strip's + starts: a request of any kind (HTTP, GraphQL, WebSocket and the rest), or a test of the API. */
	private showKindMenu(anchor: HTMLElement): void {
		type New = { readonly request: HttpProtocol } | { readonly tool: HttpToolKind };
		const pick = (value: New) => value;
		this.menu.value = showVoltMenu<New>(this.contextViewService, {
			anchor,
			className: HTTP_MENU_CLASS,
			align: 'left',
			// Wide enough that every kind's hint shows whole.
			width: 340,
			maxListHeight: 760,
			ariaLabel: localize('voltHttp.newTab', "New"),
			sections: [
				{ id: 'kinds', title: localize('voltHttp.newRequestKind', "New request"), items: HTTP_PROTOCOLS.map(item => ({ id: item.id, label: item.label, subtitle: item.hint, icon: () => createHttpProtocolIcon(item.id), data: pick({ request: item.id }) })) },
				{ id: 'tools', title: localize('voltHttp.newTestKind', "New test"), items: HTTP_TOOLS.map(tool => ({ id: `tool-${tool.kind}`, label: tool.one, subtitle: tool.hint, icon: tool.icon, data: pick({ tool: tool.kind }) })) },
			],
			onPick: item => {
				const picked = item.data;
				if ('tool' in picked) {
					void this.sidebar?.newTool(picked.tool);
				} else {
					this.openUntitled(undefined, undefined, picked.request);
				}
			},
		});
	}

	/** The environment picker at the right of the strip: what `{{variables}}` resolve with. */
	private renderStripActions(): void {
		const input = this.client;
		clearNode(this.stripActions);
		if (!input) {
			return;
		}
		const host = append(this.stripActions, $('.volt-http-env'));
		const store = new DisposableStore();
		this.inputStore.add(store);
		void this.collections.environments(input.root).then(entries => {
			if (!host.isConnected) {
				store.dispose();
				return;
			}
			const names = [...new Set(entries.filter(entry => !entry.globals && !entry.shared).map(entry => entry.environment.name))];
			const current = this.http.environmentOf(input.root);
			createHttpDropdown<string>(host, this.contextViewService, {
				options: [{ id: '', label: localize('voltHttp.noEnv', "No Environment") }, ...names.map(name => ({ id: name, label: name }))],
				value: current && names.includes(current) ? current : '',
				ariaLabel: localize('voltHttp.env', "Environment"),
				leadingIcon: Codicon.symbolVariable,
				align: 'right',
				onChange: value => this.http.setEnvironment(value || undefined, input.root),
			}, store);
		});
	}

	private async loadVariables(): Promise<void> {
		const input = this.client;
		if (!input) {
			return;
		}
		const active = input.tabs[input.active];
		const collection = active?.kind === 'request' || active?.kind === 'collection' ? active.state.collection : undefined;
		const ticket = ++this.variablesFor;
		const variables = await this.collections.variablesFor(input.root, collection);
		if (ticket === this.variablesFor) {
			this.variables = variables;
			this.requestView?.refreshVariableColours();
		}
	}

	private showActive(): void {
		try {
			this.viewStore.clear();
		} catch (err) {
			// A view that fails while it is taken down must not keep the next one from showing.
			console.error(err);
		}
		this.requestView = undefined;
		this.page = undefined;
		clearNode(this.content);
		const input = this.client;
		if (!input) {
			return;
		}
		const tab = input.tabs[input.active];
		void this.loadVariables();
		if (!tab) {
			this.renderLaunchpad();
			return;
		}
		const pageHost: IHttpPageHost = {
			root: input.root,
			variables: this.variableLookup,
			tabChanged: () => this.renderTabStrip(),
			openRequest: (collection, id, exchange) => this.openRequest(collection, id, exchange),
			exportCollection: collection => void this.exportCollection(collection),
			revealFile: uri => this.revealFile(uri),
		};
		if (tab.kind === 'request') {
			const host: IHttpRequestHost = {
				root: input.root,
				variables: this.variableLookup,
				tabChanged: () => this.renderTabStrip(),
				saveAs: (request, anchor) => this.showSaveAs(tab.state, request, anchor),
				addToChat: (label, value) => this.addToChat(label, value),
				showSnippet: spec => this.showSnippet(spec),
				showCookies: domain => this.showCookies(domain),
				openCollection: collection => this.openCollection(collection),
				openFolder: (collection, id) => this.openCollection(collection, id),
				get requestRatio() { return input.requestRatio; },
				set requestRatio(value: number) { input.requestRatio = Math.max(0.15, Math.min(0.85, value)); },
			};
			this.requestView = this.viewStore.add(this.instantiationService.createInstance(HttpRequestView, this.content, tab.state, host));
		} else if (tab.kind === 'collection') {
			this.page = this.viewStore.add(this.instantiationService.createInstance(HttpCollectionPage, this.content, tab.state, pageHost));
		} else if (tab.kind === 'tool') {
			const toolHost: IHttpToolPageHost = {
				root: input.root,
				variables: this.variableLookup,
				tabChanged: () => this.renderTabStrip(),
				openRequest: (collection, id, exchange) => this.openRequest(collection, id, exchange),
				addToChat: (label, value) => this.addToChat(label, value),
				revealFile: uri => this.revealFile(uri),
			};
			const page: IHttpToolPage = tab.tool === 'automation'
				? this.instantiationService.createInstance(HttpAutomationPage, this.content, tab.state, toolHost)
				: tab.tool === 'performance'
					? this.instantiationService.createInstance(HttpPerformancePage, this.content, tab.state, toolHost)
					: this.instantiationService.createInstance(HttpSecurityPage, this.content, tab.state, toolHost);
			this.page = this.viewStore.add(page);
		} else {
			this.page = this.viewStore.add(this.instantiationService.createInstance(HttpEnvironmentPage, this.content, tab.state, pageHost));
		}
		this.layoutParts();
	}

	private addToChat(label: string, value: string): void {
		void this.commandService.executeCommand(HTTP_ADD_TO_CHAT_COMMAND_ID, { label, value, chatId: this.chatId });
	}

	/**
	 * No tab open. Laid out like VS Code's welcome page: a quiet title, a short Start list of
	 * links, and the shortcuts worth knowing, in one left-aligned column in the middle.
	 */
	private renderLaunchpad(): void {
		const pad = append(this.content, $('.volt-http-launchpad'));
		const column = append(pad, $('.volt-http-launchpad-column'));

		const head = append(column, $('.volt-http-launchpad-head'));
		append(head, $('.volt-http-launchpad-icon')).appendChild(createHttpRequestIcon(22));
		const titles = append(head, $('.volt-http-launchpad-titles'));
		append(titles, $('.volt-http-launchpad-title')).textContent = localize('voltHttp.launchTitle', "Volt Client");
		append(titles, $('.volt-http-launchpad-text')).textContent = localize('voltHttp.launchText', "Requests are files in this project, shared with its agents.");

		// One button per kind of request, as Postman's launch row: its mark over its name.
		append(column, $('.volt-http-launchpad-label')).textContent = localize('voltHttp.launchKinds', "New request");
		const kinds = append(column, $('.volt-http-launchpad-kinds'));
		for (const item of HTTP_PROTOCOLS) {
			const button = append(kinds, $('button.volt-http-launchpad-kind')) as HTMLButtonElement;
			button.type = 'button';
			setAgentTooltip(button, `${item.label}: ${item.hint}`);
			button.dataset.method = item.id;
			append(button, $('span.volt-http-launchpad-kind-icon')).appendChild(createHttpProtocolIcon(item.id, 20));
			append(button, $('span.volt-http-launchpad-kind-label')).textContent = item.id === 'sse' ? 'SSE' : item.id === 'ai' ? 'AI' : item.label;
			button.addEventListener('click', () => this.openUntitled(undefined, undefined, item.id));
		}

		// The tests beside requests: a flow of requests, load, and a security scan.
		append(column, $('.volt-http-launchpad-label')).textContent = localize('voltHttp.launchTests', "Test");
		const tools = append(column, $('.volt-http-launchpad-links'));
		for (const tool of HTTP_TOOLS) {
			const button = append(tools, $('button.volt-http-launchpad-link')) as HTMLButtonElement;
			button.type = 'button';
			append(button, $('span.volt-http-launchpad-link-icon')).appendChild(renderHttpToolIcon(tool.icon));
			append(button, $('span.volt-http-launchpad-link-label')).textContent = localize('voltHttp.launchNewTool', "New {0}", tool.one);
			append(button, $('span.volt-http-launchpad-link-hint')).textContent = tool.hint.charAt(0).toLowerCase() + tool.hint.slice(1);
			button.addEventListener('click', () => void this.sidebar?.newTool(tool.kind));
		}

		append(column, $('.volt-http-launchpad-label')).textContent = localize('voltHttp.launchStart', "Start");
		const start = append(column, $('.volt-http-launchpad-links'));
		const link = (icon: () => Element, label: string, hint: string, run: () => void) => {
			const button = append(start, $('button.volt-http-launchpad-link')) as HTMLButtonElement;
			button.type = 'button';
			append(button, $('span.volt-http-launchpad-link-icon')).appendChild(icon());
			append(button, $('span.volt-http-launchpad-link-label')).textContent = label;
			append(button, $('span.volt-http-launchpad-link-hint')).textContent = hint;
			button.addEventListener('click', run);
		};
		link(() => renderIcon(Codicon.library), localize('voltHttp.launchNewCollection', "New Collection"), localize('voltHttp.launchNewCollectionHint', "folders, auth, variables, tests"), () => void this.sidebar?.newCollection('postman'));
		link(() => renderIcon(Codicon.file), localize('voltHttp.launchNewHttp', "New .http File"), localize('voltHttp.launchNewHttpHint', "plain text requests"), () => void this.sidebar?.newCollection('http'));
		link(() => renderIcon(Codicon.cloudDownload), localize('voltHttp.launchImport', "Import"), localize('voltHttp.launchImportHint', "Postman, OpenAPI, HAR, .http, or drop a file"), () => this.showImport());

		append(column, $('.volt-http-launchpad-label')).textContent = localize('voltHttp.launchShortcuts', "Shortcuts");
		const keys = append(column, $('.volt-http-launchpad-keys'));
		const modifier = isMacintosh ? '\u2318' : 'Ctrl';
		const shortcut = (label: string, ...caps: string[]) => {
			const row = append(keys, $('.volt-http-launchpad-key-row'));
			append(row, $('span')).textContent = label;
			const group = append(row, $('span.volt-http-launchpad-caps'));
			for (const cap of caps) {
				append(group, $('kbd')).textContent = cap;
			}
		};
		shortcut(localize('voltHttp.launchSend', "Send the request"), modifier, '\u21B5');
		shortcut(localize('voltHttp.launchSave', "Save to its file"), modifier, 'S');
		shortcut(localize('voltHttp.launchRename', "Rename in the sidebar"), 'F2');
	}

	// --- Dialogs -----------------------------------------------------------------------------------

	private showModal(title: string, build: (body: HTMLElement, footer: HTMLElement, store: DisposableStore, close: () => void, headTools: HTMLElement) => void, wide = false): void {
		const store = new DisposableStore();
		this.modal.value = store;
		clearNode(this.modalHost);
		this.modalHost.classList.add('shown');
		const close = () => {
			if (this.modal.value === store) {
				this.modal.clear();
			}
		};
		store.add({ dispose: () => { clearNode(this.modalHost); this.modalHost.classList.remove('shown'); } });
		const card = append(this.modalHost, $('.volt-http-modal'));
		card.classList.toggle('wide', wide);
		card.setAttribute('role', 'dialog');
		card.setAttribute('aria-label', title);
		const head = append(card, $('.volt-http-modal-head'));
		append(head, $('span.volt-http-modal-title')).textContent = title;
		// Between the title and the close button: a dialog's own controls (the snippet's language).
		const headTools = append(head, $('.volt-http-modal-tools'));
		createHttpIconButton(head, Codicon.close, localize('voltHttp.closeDialog', "Close"), close);
		const body = append(card, $('.volt-http-modal-body'));
		const footer = append(card, $('.volt-http-modal-foot'));
		store.add(addDisposableListener(this.modalHost, EventType.MOUSE_DOWN, (event: MouseEvent) => {
			if (event.target === this.modalHost) {
				close();
			}
		}));
		store.add(addDisposableListener(this.modalHost, EventType.KEY_DOWN, (event: KeyboardEvent) => {
			if (event.key === 'Escape') {
				event.stopPropagation();
				close();
			}
		}));
		build(body, footer, store, close, headTools);
	}

	/** "Generate tests" for many requests: every collection listed, with the named collection's, folder's or request's ticked. */
	private showGenerateTests(collection?: URI, itemId?: string): void {
		const entry = collection ? this.collections.get(collection) : undefined;
		const preselect = entry ? httpTestTargetsOf(entry, itemId) : undefined;
		this.showModal(localize('voltHttp.aiTitle', "Generate tests"), (body, footer, store, close) => {
			store.add(this.instantiationService.createInstance(HttpBulkTestsView, body, footer, { root: this.client?.root, ...(preselect ? { preselect } : {}), close }));
		}, true);
	}

	/** The project's cookie jar: what responses set and requests send back. */
	private showCookies(domain?: string): void {
		this.showModal(localize('voltHttp.cookiesTitle', "Cookies"), (body, footer, store, close) => {
			store.add(this.instantiationService.createInstance(HttpCookiesView, body, footer, { root: this.client?.root, close, ...(domain ? { domain } : {}) }));
		}, true);
	}

	private showImport(): void {
		this.showModal(localize('voltHttp.import', "Import"), (body, footer, store, close) => {
			append(body, $('.volt-http-note')).textContent = localize('voltHttp.importHelp', "Paste or drop a Postman collection or environment, an OpenAPI or Swagger document (JSON or YAML), a HAR file, .http requests or a cURL command. It is written into this project as a file.");
			const area = append(body, $('textarea.volt-http-import')) as HTMLTextAreaElement;
			area.spellcheck = false;
			area.placeholder = localize('voltHttp.importPlaceholder', "Paste here, or drop a file");
			area.setAttribute('aria-label', localize('voltHttp.import', "Import"));
			let fileName: string | undefined;
			const status = append(body, $('.volt-http-import-status'));
			const read = async (file: File) => {
				fileName = file.name;
				area.value = await file.text();
				status.textContent = file.name;
			};
			store.add(addDisposableListener(area, EventType.DROP, (event: DragEvent) => {
				const file = event.dataTransfer?.files[0];
				if (file) {
					event.preventDefault();
					event.stopPropagation();
					void read(file);
				}
			}));
			const choose = store.add(createVoltButton(footer, 'secondary'));
			choose.label = localize('voltHttp.chooseFile', "Choose File");
			store.add(choose.onDidClick(async () => {
				const picked = await this.fileDialogService.showOpenDialog({ canSelectFiles: true, canSelectFolders: false, canSelectMany: false, title: localize('voltHttp.import', "Import"), filters: [{ name: localize('voltHttp.importFiles', "Collections and API descriptions"), extensions: ['json', 'yaml', 'yml', 'http', 'rest', 'har', 'txt'] }] });
				if (picked?.[0]) {
					fileName = basename(picked[0]);
					area.value = (await this.fileService.readFile(picked[0])).value.toString();
					status.textContent = fileName;
				}
			}));
			append(footer, $('.volt-http-spacer'));
			const cancel = store.add(createVoltButton(footer, 'ghost'));
			cancel.label = localize('voltHttp.cancelDialog', "Cancel");
			store.add(cancel.onDidClick(close));
			const run = store.add(createVoltButton(footer, 'primary'));
			run.label = localize('voltHttp.import', "Import");
			store.add(run.onDidClick(async () => {
				if (!area.value.trim()) {
					area.focus();
					return;
				}
				if (await this.importText(area.value, fileName, status)) {
					close();
				}
			}));
			setTimeout(() => area.focus(), 0);
		});
	}

	private async importText(text: string, fileName?: string, status?: HTMLElement): Promise<boolean> {
		const input = this.client;
		if (!input) {
			return false;
		}
		try {
			const result = await this.collections.importText(input.root, text, fileName);
			if (result.kind === 'unknown') {
				if (status) {
					status.textContent = result.message;
					status.classList.add('error');
				} else {
					this.notificationService.warn(result.message);
				}
				return false;
			}
			if (result.kind === 'request' && result.request) {
				this.openUntitled(result.request);
			} else if (result.kind === 'collection' && result.uri) {
				this.sidebar?.show('collections');
				await this.collections.load(result.uri);
				this.openCollection(result.uri);
			} else if (result.kind === 'environment' && result.uri) {
				this.sidebar?.show('environments');
				const entry = (await this.collections.environments(input.root)).find(item => item.uri.toString() === result.uri!.toString());
				if (entry) {
					this.openEnvironment(entry);
				}
			}
			this.notificationService.info(result.message);
			return true;
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			if (status) {
				status.textContent = message;
				status.classList.add('error');
			} else {
				this.notificationService.error(message);
			}
			return false;
		}
	}

	private async exportCollection(collection: URI): Promise<void> {
		const entry = this.collections.get(collection);
		if (!entry) {
			return;
		}
		this.showModal(localize('voltHttp.export', "Export"), (body, footer, store, close) => {
			let format: 'postman' | 'http' = entry.collection.format === 'postman' ? 'postman' : 'http';
			append(body, $('.volt-http-note')).textContent = localize('voltHttp.exportHelp', "Save \"{0}\" as a file for Postman, or as an .http file for REST Client and JetBrains IDEs.", entry.collection.format === 'postman' ? entry.collection.name : basename(collection));
			const row = append(body, $('.volt-http-field'));
			append(row, $('label')).textContent = localize('voltHttp.factFormat', "Format");
			createHttpDropdown<'postman' | 'http'>(append(row, $('.volt-http-field-wrap')), this.contextViewService, {
				options: [
					{ id: 'postman', label: localize('voltHttp.formatPostman', "Postman collection v2.1"), description: localize('voltHttp.exportPostmanDesc', "Folders, auth, variables and scripts, importable in Postman") },
					{ id: 'http', label: localize('voltHttp.formatHttp', ".http file"), description: localize('voltHttp.exportHttpDesc', "Plain text requests; folders become part of each request's name") },
				],
				value: format,
				ariaLabel: localize('voltHttp.factFormat', "Format"),
				align: 'left',
				width: 340,
				onChange: value => format = value,
			}, store);
			const copy = store.add(createVoltButton(footer, 'secondary'));
			copy.label = localize('voltHttp.copyExport', "Copy");
			store.add(copy.onDidClick(async () => {
				await this.clipboardService.writeText(this.collections.exportText(collection, format));
				close();
			}));
			append(footer, $('.volt-http-spacer'));
			const cancel = store.add(createVoltButton(footer, 'ghost'));
			cancel.label = localize('voltHttp.cancelDialog', "Cancel");
			store.add(cancel.onDidClick(close));
			const save = store.add(createVoltButton(footer, 'primary'));
			save.label = localize('voltHttp.saveExport', "Save As");
			store.add(save.onDidClick(async () => {
				const stem = basename(collection).replace(/\.(?:postman_collection\.json|http|rest)$/i, '');
				const folder = this.client?.root ?? await this.fileDialogService.defaultFilePath();
				const target = await this.fileDialogService.showSaveDialog({ title: localize('voltHttp.export', "Export"), defaultUri: URI.joinPath(folder, `${stem}${format === 'postman' ? '.postman_collection.json' : '.http'}`) });
				if (target) {
					await this.fileService.writeFile(target, VSBuffer.fromString(this.collections.exportText(collection, format)));
					close();
				}
			}));
		});
	}

	private showSnippet(spec: IHttpRequestSpec): void {
		this.showModal(localize('voltHttp.codeSnippet', "Code Snippet"), (body, footer, store, close, headTools) => {
			let target: HttpSnippetTarget = this.snippetTarget;
			body.classList.add('snippet');
			const host = append(body, $('.volt-http-code.snippet'));
			const editor = store.add(this.instantiationService.createInstance(CodeEditorWidget, host, {
				minimap: { enabled: false }, scrollBeyondLastLine: false, lineNumbers: 'on', lineNumbersMinChars: 3, glyphMargin: false, folding: false, wordWrap: 'on', renderLineHighlight: 'none', overviewRulerLanes: 0, hideCursorInOverviewRuler: true, fontSize: 12, padding: { top: 10, bottom: 10 }, automaticLayout: true, readOnly: true, domReadOnly: true,
				scrollbar: { verticalScrollbarSize: 8, horizontalScrollbarSize: 8 },
			}, { isSimpleWidget: false }));
			const show = () => {
				const language = HTTP_SNIPPET_TARGETS.find(item => item.id === target)?.language ?? 'plaintext';
				const model = this.modelService.createModel(httpSnippet(target, spec), this.languageService.createById(this.languageService.isRegisteredLanguageId(language) ? language : 'plaintext'), undefined);
				const old = editor.getModel();
				editor.setModel(model);
				old?.dispose();
			};
			store.add({ dispose: () => editor.getModel()?.dispose() });
			createHttpDropdown<HttpSnippetTarget>(append(headTools, $('.volt-http-snippet-language')), this.contextViewService, {
				options: HTTP_SNIPPET_TARGETS.map(item => ({ id: item.id, label: item.label, icon: () => createHttpSnippetIcon(item.id) })),
				value: target,
				ariaLabel: localize('voltHttp.snippetLanguage', "Language"),
				align: 'right',
				width: 280,
				searchFrom: 8,
				onChange: value => {
					target = this.snippetTarget = value;
					show();
				},
			}, store);
			show();
			append(footer, $('.volt-http-spacer'));
			const done = store.add(createVoltButton(footer, 'ghost'));
			done.label = localize('voltHttp.closeDialog', "Close");
			store.add(done.onDidClick(close));
			// Copy answers the click itself: its icon turns into a check for a moment.
			const copy = append(footer, $('button.volt-http-copy')) as HTMLButtonElement;
			copy.type = 'button';
			copy.classList.add(...voltButtonClasses('secondary'));
			const icon = append(copy, $('span.volt-http-copy-icon'));
			icon.appendChild(createHttpCopyIcon());
			const label = append(copy, $('span'));
			label.textContent = localize('voltHttp.copySnippet', "Copy");
			let reset: ReturnType<typeof setTimeout> | undefined;
			store.add({ dispose: () => clearTimeout(reset) });
			copy.addEventListener('click', async () => {
				await this.clipboardService.writeText(editor.getValue());
				clearTimeout(reset);
				copy.classList.add('copied');
				icon.replaceChildren(createHttpCheckIcon());
				label.textContent = localize('voltHttp.copied', "Copied");
				reset = setTimeout(() => {
					copy.classList.remove('copied');
					icon.replaceChildren(createHttpCopyIcon());
					label.textContent = localize('voltHttp.copySnippet', "Copy");
				}, 1600);
			});
		}, true);
	}

	/** Where to keep a request saved nowhere yet: a collection, or one of its folders. */
	private showSaveAs(state: IHttpRequestTabState, request: IHttpRequest, anchor: HTMLElement): void {
		const input = this.client;
		if (!input) {
			return;
		}
		type Target = { uri: URI; parentId: string | undefined } | 'new-postman' | 'new-http';
		const saveInto = async (uri: URI, parentId: string | undefined) => {
			try {
				const oldKey = httpDraftKey(undefined, state.id);
				const named = { ...cloneHttp(request), name: request.name.trim() || httpRequestLabel(request) };
				const id = await this.collections.addItem(uri, parentId, named);
				this.collections.setDraft(oldKey, undefined);
				state.collection = uri;
				state.id = id;
				state.untitled = undefined;
				this.renderTabStrip();
				this.showActive();
			} catch (err) {
				this.notificationService.error(err instanceof Error ? err.message : String(err));
			}
		};
		void this.collections.collections(input.root).then(entries => {
			const sections: IVoltMenuSection<Target>[] = entries.filter(entry => !entry.error).map(entry => {
				const items: { id: string; label: string; icon: ThemeIcon; data: Target }[] = [{ id: entry.uri.toString(), label: entry.collection.format === 'postman' ? entry.collection.name : basename(entry.uri), icon: entry.collection.format === 'postman' ? Codicon.library : Codicon.file, data: { uri: entry.uri, parentId: undefined } }];
				const walk = (folders: readonly IHttpItem[], prefix: string) => {
					for (const item of folders) {
						if (item.kind === 'folder') {
							const folder: IHttpFolder = item;
							items.push({ id: `${entry.uri.toString()}#${folder.id}`, label: `${prefix}${folder.name}`, icon: Codicon.folder, data: { uri: entry.uri, parentId: folder.id } });
							walk(folder.items, `${prefix}${folder.name} / `);
						}
					}
				};
				walk(entry.collection.items, '');
				return { id: entry.uri.toString(), items };
			});
			sections.push({
				id: 'new', items: [
					{ id: 'new-postman', label: localize('voltHttp.saveNewCollection', "New Collection"), icon: Codicon.add, data: 'new-postman' },
					{ id: 'new-http', label: localize('voltHttp.saveNewHttp', "New .http File"), icon: Codicon.add, data: 'new-http' },
				],
			});
			this.menu.value = showVoltMenu<Target>(this.contextViewService, {
				anchor,
				className: HTTP_MENU_CLASS,
				align: 'right',
				width: 320,
				ariaLabel: localize('voltHttp.saveTo', "Save to"),
				heading: { title: localize('voltHttp.saveTo', "Save to") },
				sections,
				onPick: async item => {
					const target = item.data;
					if (target === 'new-postman' || target === 'new-http') {
						try {
							const uri = await this.collections.createCollection(input.root, target === 'new-postman' ? localize('voltHttp.newCollectionName', "New Collection") : 'requests', target === 'new-postman' ? 'postman' : 'http');
							await saveInto(uri, undefined);
						} catch (err) {
							this.notificationService.error(err instanceof Error ? err.message : String(err));
						}
					} else {
						await saveInto(target.uri, target.parentId);
					}
				},
			});
		});
	}

	private revealFile(uri: URI): void {
		void this.editorService.openEditor({ resource: uri, options: { pinned: true } });
	}

	// --- Layout ------------------------------------------------------------------------------------

	private toggleSidebar(): void {
		const input = this.client;
		if (!input) {
			return;
		}
		if (this.narrow) {
			this.root.classList.toggle('side-open');
		} else {
			input.sidebarHidden = !input.sidebarHidden;
		}
		this.layoutParts();
	}

	override layout(dimension: Dimension): void {
		this.dimension = dimension;
		this.layoutParts();
	}

	private layoutParts(): void {
		const dimension = this.dimension;
		const input = this.client;
		if (!dimension || !input) {
			return;
		}
		this.root.style.height = `${dimension.height}px`;
		this.root.style.width = `${dimension.width}px`;
		const narrow = dimension.width < NARROW_WIDTH;
		if (narrow !== this.narrow) {
			this.narrow = narrow;
			this.root.classList.remove('side-open');
		}
		this.root.classList.toggle('narrow', narrow);
		this.root.classList.toggle('compact', dimension.width < 460);
		const overlay = narrow && this.root.classList.contains('side-open');
		const shown = narrow ? overlay : !input.sidebarHidden;
		this.root.classList.toggle('side-hidden', !shown);
		const sideWidth = shown ? (narrow ? Math.min(320, dimension.width - 48) : Math.min(input.sidebarWidth, Math.max(MIN_SIDEBAR, dimension.width - 360))) : 0;
		this.sideHost.style.width = `${sideWidth}px`;
		if (shown) {
			this.sidebar?.layout(sideWidth, narrow ? dimension.height - this.strip.offsetHeight - 1 : dimension.height);
		}
		const mainWidth = narrow ? dimension.width : dimension.width - sideWidth;
		this.main.style.width = `${mainWidth}px`;
		const contentHeight = Math.max(0, dimension.height - this.strip.offsetHeight);
		this.content.style.height = `${contentHeight}px`;
		this.requestView?.layout(mainWidth, contentHeight);
		this.page?.layout(mainWidth, contentHeight);
		if (shown && !narrow) {
			this.sash.state = SashState.Enabled;
			this.sash.layout();
		} else {
			this.sash.state = SashState.Disabled;
		}
	}

	override focus(): void {
		super.focus();
		if (this.client) {
			this.client.shownAt = Date.now();
		}
		this.requestView?.focus();
	}
}
