/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, clearNode, EventType, getWindow } from '../../../../base/browser/dom.js';
import { renderIcon } from '../../../../base/browser/ui/iconLabel/iconLabels.js';
import { IListRenderer } from '../../../../base/browser/ui/list/list.js';
import { Orientation, Sash } from '../../../../base/browser/ui/sash/sash.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Disposable, DisposableStore, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { basename } from '../../../../base/common/resources.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { CodeEditorWidget } from '../../../../editor/browser/widget/codeEditor/codeEditorWidget.js';
import { IEditorOptions as ICodeEditorOptions } from '../../../../editor/common/config/editorOptions.js';
import { CodeLens } from '../../../../editor/common/languages.js';
import { ILanguageService } from '../../../../editor/common/languages/language.js';
import { ILanguageFeaturesService } from '../../../../editor/common/services/languageFeatures.js';
import { IModelService } from '../../../../editor/common/services/model.js';
import { localize } from '../../../../nls.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { IContextViewService } from '../../../../platform/contextview/browser/contextView.js';
import { IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IVoltHttpOAuth } from '../../../../platform/voltHttp/common/voltHttpOAuth.js';
import { WorkbenchList } from '../../../../platform/list/browser/listService.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IVoltGrpcServiceInfo } from '../../../../platform/voltHttp/common/voltHttpStreams.js';
import { HTTP_METHODS, IHttpRequestSpec } from '../../../services/voltRuntime/common/ide/httpFile.js';
import { createVoltButton, voltButtonClasses } from '../../voltAgent/browser/chrome/voltButton.js';
import { showVoltMenu } from '../../voltAgent/browser/ui/menu/voltMenu.js';
import { cloneHttp, convertHttpRequest, effectiveHttpAuth, emptyHttpAuth, findHttpItem, HttpBodyMode, httpAutoHeaders, httpPathVariablesFor, HttpRawLanguage, httpRequestLabel, httpUrlWithQuery, httpWireRequest, IHttpFolder, IHttpRequest } from '../common/httpCollection.js';
import { HTTP_AI_PROVIDERS, HTTP_MCP_TEMPLATES, HTTP_PROTOCOLS, httpAiAnswerOf, httpAiBodyOf, HttpAiProvider, httpAiPromptFromBody, httpGrpcTarget, httpGrpcUrl, httpMcpMessage, httpMcpMethodOf, HttpProtocol, httpProtocolInfo, IHttpAiPrompt, prettyGraphql } from '../common/httpProtocols.js';
import { syncHttpRequestUrl } from '../common/httpDotHttp.js';
import { httpScriptTestSites } from '../common/httpScriptRuntime.js';
import { curlToRequest } from '../common/httpImport.js';
import { httpDraftKey, IVoltHttpCollections } from './voltHttpCollections.js';
import { IHttpExchange, IHttpExchangeTest, IVoltHttpService } from './voltHttpService.js';
import { HttpBreaksPanel, HttpScriptBreakpoints, HttpTestDetail } from './voltHttpScriptDebug.js';
import { HttpAiEditPanel, IHttpAiEditState } from './voltHttpAiEdit.js';
import { httpResponseCookies } from './voltHttpCookiesView.js';
import { httpAuthTypeLabel, renderHttpAuthEditor } from './voltHttpPages.js';
import { HttpDocsEditor } from './voltHttpDocsEditor.js';
import { renderHttpRequestSettings } from './voltHttpSettingsView.js';
import { createHttpAgentIcon, createHttpChatIcon, createHttpChevronIcon, createHttpCopyIcon, createHttpProtocolIcon, createHttpRequestIcon, createHttpSaveIcon, createHttpSearchIcon } from './voltHttpIcons.js';
import { appendHttpTestScript, HttpTestGenerator } from './voltHttpAiTests.js';
import { IVoltHttpSessions } from './voltHttpSessions.js';
import { HttpMessageComposer, HttpStreamPane, IHttpComposerState } from './voltHttpStreamView.js';
import { detectHttpBodyLanguage, HttpPrettyLanguage, prettyHttpBody } from '../common/httpPretty.js';
import { createHttpDropdown, createHttpIconButton, createHttpVariableField, HTTP_MENU_CLASS, watchHttpOverflow, formatHttpBytes, formatHttpDuration, HttpKeyValueTable, httpStatusClass, HttpVariableLookup, IHttpVariableField, renderHttpReadOnlyTable, renderHttpTabs } from './voltHttpWidgets.js';
import { setAgentTooltip } from '../../voltAgent/browser/chrome/agentTooltip.js';

export type HttpRequestTab = 'params' | 'auth' | 'headers' | 'body' | 'settings' | 'scripts' | 'docs';
export type HttpResponseTab = 'answer' | 'body' | 'cookies' | 'headers' | 'tests';
type ResponseLanguage = HttpPrettyLanguage;

/** What an open request tab keeps while another tab is in front. */
export interface IHttpRequestTabState {
	collection: URI | undefined;
	/** The request's id in its collection, or an id of its own for one saved nowhere yet. */
	id: string;
	/** A request saved nowhere yet: what it started as (its edits are a draft like any other). */
	untitled?: IHttpRequest;
	/** The tab picked; the kind's first one until then. */
	requestTab?: HttpRequestTab;
	responseTab: HttpResponseTab;
	scriptTab: 'preRequest' | 'test';
	exchange?: IHttpExchange;
	sending?: CancellationTokenSource;
	responseLanguage?: ResponseLanguage;
	pretty: boolean;
	wrap: boolean;
	/** The message being written for a connection (WebSocket, Socket.IO, MQTT). */
	composer?: IHttpComposerState;
	/** What a gRPC server offers, once asked. */
	grpc?: { services?: readonly IVoltGrpcServiceInfo[]; error?: string };
	/** The tests are being written by a model: the generator shows above the results. */
	generating?: boolean;
	/** The tests run last from a play button or an editor link: their rows are marked once. */
	ranTests?: readonly string[];
	/** The one test run last on its own: Test Results says so until the next send or run. */
	ranOnly?: string;
	/** Breakpoints set in the Scripts editors' gutters (kept with the tab, not in the file). */
	breakpoints?: { preRequest: number[]; test: number[] };
	/** The recorded stop shown in the Scripts tab, and whether its panel was closed. */
	breakStop?: number;
	breaksClosed?: boolean;
	/** The test whose detail is open under Test Results. */
	testDetail?: string;
	/** The "Edit with AI" conversation about this request. */
	aiEdit?: IHttpAiEditState & { open: boolean };
}

export interface IHttpRequestHost {
	readonly root: URI | undefined;
	/** The tab's label or unsaved mark may have changed. */
	tabChanged(): void;
	/** Asks where to keep a request saved nowhere yet; resolves once it is in a collection. */
	saveAs(request: IHttpRequest, anchor: HTMLElement): void;
	showSnippet(spec: IHttpRequestSpec): void;
	/** Opens the project's cookie jar, at a domain when one is named. */
	showCookies(domain?: string): void;
	/** Puts a reference to the request into the chat beside the client. */
	addToChat(label: string, value: string): void;
	openCollection(collection: URI): void;
	openFolder(collection: URI, id: string): void;
	readonly variables: HttpVariableLookup;
	requestRatio: number;
}

const CODE_EDITOR_OPTIONS: ICodeEditorOptions = {
	minimap: { enabled: false },
	scrollBeyondLastLine: false,
	lineNumbers: 'on',
	lineNumbersMinChars: 3,
	glyphMargin: false,
	folding: true,
	wordWrap: 'on',
	renderLineHighlight: 'none',
	overviewRulerLanes: 0,
	hideCursorInOverviewRuler: true,
	scrollbar: { verticalScrollbarSize: 8, horizontalScrollbarSize: 8, alwaysConsumeMouseWheel: false },
	fontSize: 12,
	padding: { top: 6, bottom: 6 },
	automaticLayout: false,
	fixedOverflowWidgets: true,
};

/**
 * The links above the tests in a Scripts editor ("Run Test", "Run All Tests") are commands, and a
 * command carries only plain arguments: each editor keeps its runner here under a token of its own.
 */
const RUN_SCRIPT_TESTS_COMMAND_ID = '_voltHttp.runScriptTests';
const scriptTestRunners = new Map<string, (name: string | undefined) => void>();
let scriptTestRunnerSeq = 0;
CommandsRegistry.registerCommand(RUN_SCRIPT_TESTS_COMMAND_ID, (_accessor, token?: unknown, name?: unknown) => {
	scriptTestRunners.get(String(token))?.(typeof name === 'string' ? name : undefined);
}, 'internal');

const MIN_PANE_HEIGHT = 110;
const TEST_ROW_HEIGHT = 28;
/** The recorded stops' panel under a script editor. */
const BREAKS_PANEL_HEIGHT = 240;

/** Ready-made lines for the Scripts tab, as Postman's snippets. */
const SCRIPT_SNIPPETS: { readonly phase: 'preRequest' | 'test' | 'both'; readonly label: string; readonly code: string }[] = [
	{ phase: 'test', label: 'Status code is 200', code: 'pm.test("Status code is 200", () => {\n\tpm.response.to.have.status(200);\n});' },
	{ phase: 'test', label: 'Response time is under 500 ms', code: 'pm.test("Response time is under 500 ms", () => {\n\tpm.expect(pm.response.responseTime).to.be.below(500);\n});' },
	{ phase: 'test', label: 'Body has a JSON value', code: 'pm.test("Body has the value", () => {\n\tconst json = pm.response.json();\n\tpm.expect(json.id).to.exist;\n});' },
	{ phase: 'test', label: 'Header is present', code: 'pm.test("Content-Type is present", () => {\n\tpm.response.to.have.header("Content-Type");\n});' },
	{ phase: 'test', label: 'Save a value from the response', code: 'pm.environment.set("token", pm.response.json().token);' },
	{ phase: 'both', label: 'Set an environment variable', code: 'pm.environment.set("name", "value");' },
	{ phase: 'both', label: 'Set a collection variable', code: 'pm.collectionVariables.set("name", "value");' },
	{ phase: 'both', label: 'Read a variable', code: 'const value = pm.variables.get("name");' },
	{ phase: 'preRequest', label: 'Add a header', code: 'pm.request.headers.upsert({ key: "X-Request-Id", value: pm.variables.replaceIn("{{$guid}}") });' },
	{ phase: 'both', label: 'Log to the console', code: 'console.log("value", pm.variables.get("name"));' },
];

function signature(request: IHttpRequest): string {
	const { id: _id, extra: _extra, line: _line, ...rest } = request;
	return JSON.stringify(rest);
}

export function isHttpRequestDirty(collections: IVoltHttpCollections, state: IHttpRequestTabState): boolean {
	const draft = collections.draftOf(httpDraftKey(state.collection, state.id));
	if (!state.collection) {
		return !!draft && (!!draft.url || !!draft.name);
	}
	return !!draft;
}

/** The request a tab shows: its unsaved edits, else what its collection holds. */
export function currentHttpRequest(collections: IVoltHttpCollections, state: IHttpRequestTabState): IHttpRequest | undefined {
	const draft = collections.draftOf(httpDraftKey(state.collection, state.id));
	if (draft) {
		return draft;
	}
	if (!state.collection) {
		return state.untitled;
	}
	const item = collections.get(state.collection) ? findHttpItem(collections.get(state.collection)!.collection, state.id)?.item : undefined;
	return item?.kind === 'request' ? item : undefined;
}

/**
 * One request, laid out like Postman: its place and name with Save, the method and URL in one box
 * beside a split Send, the Params / Authorization / Headers / Body / Scripts / Docs tabs, a sash,
 * then the response (Body, Cookies, Headers, Test Results with status, time and size).
 */
export class HttpRequestView extends Disposable {

	readonly element: HTMLElement;
	private readonly head: HTMLElement;
	private readonly bar: HTMLElement;
	/** Under the URL bar: the "Edit with AI" conversation, while it is open. */
	private readonly aiHost: HTMLElement;
	private readonly aiPanel = this._register(new MutableDisposable<HttpAiEditPanel>());
	private readonly requestEl: HTMLElement;
	private readonly tabsEl: HTMLElement;
	private readonly tabBody: HTMLElement;
	private readonly responseEl: HTMLElement;
	private readonly sash: Sash;
	private readonly headStore = this._register(new DisposableStore());
	private readonly barStore = this._register(new DisposableStore());
	private readonly tabStore = this._register(new DisposableStore());
	private readonly responseStore = this._register(new DisposableStore());
	private readonly menu = this._register(new MutableDisposable());
	private readonly codeEditors = new Set<CodeEditorWidget>();
	private readonly tables: HttpKeyValueTable[] = [];
	private urlField: IHttpVariableField | undefined;
	private nameInput: HTMLInputElement | undefined;
	private saveButton: HTMLButtonElement | undefined;
	private sendLabel: ((sending: boolean) => void) | undefined;
	private ownChange = false;
	private width = 0;
	private height = 0;
	private testList: WorkbenchList<IHttpExchangeTest> | undefined;
	private breaksPanel: HttpBreaksPanel | undefined;
	private streamPane: HttpStreamPane | undefined;
	private composer: HttpMessageComposer | undefined;
	private docsEditor: HttpDocsEditor | undefined;
	private readonly key: string;
	private sentAt = 0;

	constructor(
		parent: HTMLElement,
		private readonly state: IHttpRequestTabState,
		private readonly host: IHttpRequestHost,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IContextViewService private readonly contextViewService: IContextViewService,
		@IModelService private readonly modelService: IModelService,
		@ILanguageService private readonly languageService: ILanguageService,
		@IClipboardService private readonly clipboardService: IClipboardService,
		@IFileDialogService private readonly fileDialogService: IFileDialogService,
		@IFileService private readonly fileService: IFileService,
		@INotificationService private readonly notificationService: INotificationService,
		@IVoltHttpCollections private readonly collections: IVoltHttpCollections,
		@IVoltHttpService private readonly http: IVoltHttpService,
		@IVoltHttpSessions private readonly sessions: IVoltHttpSessions,
		@ILanguageFeaturesService private readonly languageFeaturesService: ILanguageFeaturesService,
		@IOpenerService private readonly openerService: IOpenerService,
		@IVoltHttpOAuth private readonly oauth: IVoltHttpOAuth,
	) {
		super();
		this.key = httpDraftKey(state.collection, state.id);
		this.element = append(parent, $('.volt-http-request-view'));
		this.head = append(this.element, $('.volt-http-head'));
		this.bar = append(this.element, $('.volt-http-bar'));
		this.aiHost = append(this.element, $('.volt-http-ai-edit-host'));
		this.requestEl = append(this.element, $('.volt-http-request'));
		this.tabsEl = append(this.requestEl, $('.volt-http-tabs'));
		this.tabBody = append(this.requestEl, $('.volt-http-tab-body'));
		append(this.element, $('.volt-http-divider'));
		this.responseEl = append(this.element, $('.volt-http-response'));

		this.sash = this._register(new Sash(this.element, { getHorizontalSashTop: () => this.requestEl.offsetTop + this.requestEl.offsetHeight }, { orientation: Orientation.HORIZONTAL }));
		let startHeight = 0;
		this._register(this.sash.onDidStart(() => startHeight = this.requestEl.offsetHeight));
		this._register(this.sash.onDidChange(event => {
			const space = this.splitSpace();
			if (space > 0) {
				this.host.requestRatio = (startHeight + event.currentY - event.startY) / space;
				this.layoutSplit();
			}
		}));
		this._register(this.sash.onDidReset(() => {
			this.host.requestRatio = 0.5;
			this.layoutSplit();
		}));

		const key = httpDraftKey(state.collection, state.id);
		// Another client editing the same request, or its file changing on disk, shows here at once.
		this._register(this.collections.onDidChangeDraft(changed => {
			if (changed === key && !this.ownChange) {
				this.renderAll();
			}
		}));
		this._register(this.collections.onDidChange(uri => {
			if (uri && state.collection && uri.toString() === state.collection.toString()) {
				this.renderHead();
				if (!this.collections.draftOf(key)) {
					this.renderBar();
					this.renderTabs();
				}
			}
		}));
		this._register(this.sessions.onDidChange(changed => {
			if (changed === key) {
				this.sendLabel?.(false);
			}
		}));
		this._register(this.http.onDidChangeEnvironment(() => this.refreshVariables()));
		this._register(this.collections.onDidChangeEnvironments(() => this.refreshVariables()));
		this._register(addDisposableListener(this.element, EventType.KEY_DOWN, (event: KeyboardEvent) => {
			if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 's') {
				event.preventDefault();
				event.stopPropagation();
				void this.save();
			} else if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
				event.preventDefault();
				event.stopPropagation();
				void this.send();
			}
		}, true));
		this._register(toDisposable(() => this.testList = undefined));
		this.renderAll();
	}

	private get request(): IHttpRequest | undefined {
		return currentHttpRequest(this.collections, this.state);
	}

	private get protocol(): HttpProtocol {
		return this.request?.protocol ?? 'http';
	}

	private get context() {
		const breakpoints = this.state.breakpoints;
		return {
			...(this.state.collection ? { collection: this.state.collection } : {}),
			...(this.host.root ? { root: this.host.root } : {}),
			...(breakpoints && (breakpoints.preRequest.length || breakpoints.test.length) ? { breakpoints } : {}),
		};
	}

	private get saved(): IHttpRequest | undefined {
		if (!this.state.collection) {
			return undefined;
		}
		const entry = this.collections.get(this.state.collection);
		const item = entry ? findHttpItem(entry.collection, this.state.id)?.item : undefined;
		return item?.kind === 'request' ? item : undefined;
	}

	private get ancestors(): readonly IHttpFolder[] {
		const entry = this.state.collection ? this.collections.get(this.state.collection) : undefined;
		return entry ? findHttpItem(entry.collection, this.state.id)?.ancestors ?? [] : [];
	}

	/** Applies an edit: the result is the tab's draft, or no draft once it equals what is saved. */
	private change(mutate: (request: IHttpRequest) => void): void {
		const current = this.request;
		if (!current) {
			return;
		}
		const next = cloneHttp(current);
		mutate(next);
		const saved = this.saved;
		this.ownChange = true;
		try {
			this.collections.setDraft(httpDraftKey(this.state.collection, this.state.id), saved && signature(saved) === signature(next) ? undefined : next);
		} finally {
			this.ownChange = false;
		}
		this.renderTabStrip();
		this.updateSave();
		this.host.tabChanged();
	}

	private renderAll(): void {
		this.renderHead();
		this.renderBar();
		this.renderAiEdit();
		this.renderTabs();
		this.renderResponse();
		this.layoutSplit();
	}

	private toggleAiEdit(): void {
		const open = !this.state.aiEdit?.open;
		this.state.aiEdit = { turns: this.state.aiEdit?.turns ?? [], draft: this.state.aiEdit?.draft ?? '', open };
		this.renderHead();
		this.renderAiEdit();
		this.layoutSplit();
		this.aiPanel.value?.focus();
	}

	/**
	 * The "Edit with AI" conversation under the URL bar, made once while it is open (a redraw of the
	 * request around it keeps it, its typing and its running call).
	 */
	private renderAiEdit(): void {
		const state = this.state.aiEdit;
		if (!state?.open || !this.request) {
			this.aiPanel.clear();
			return;
		}
		if (this.aiPanel.value) {
			return;
		}
		this.aiPanel.value = this.instantiationService.createInstance(HttpAiEditPanel, this.aiHost, state, {
			root: this.host.root,
			request: () => this.request,
			apply: mutate => {
				this.change(mutate);
				// What the model changed shows at once: the name, the URL bar, the tabs and their dots.
				this.renderHead();
				this.renderBar();
				this.renderTabs();
				this.layoutSplit();
			},
			variables: () => [...(this.host.variables()?.keys() ?? [])],
			relayout: () => this.layoutSplit(),
			close: () => this.toggleAiEdit(),
		});
	}

	/** The variables in reach changed (the environment, the collection's): colours the `{{names}}` again. */
	refreshVariableColours(): void {
		this.refreshVariables();
	}

	private refreshVariables(): void {
		this.urlField?.refresh();
		for (const table of this.tables) {
			table.refreshVariables();
		}
	}

	// --- Head: where the request lives, its name, Save -------------------------------------------

	private renderHead(): void {
		this.headStore.clear();
		clearNode(this.head);
		const request = this.request;
		const crumbs = append(this.head, $('.volt-http-crumbs'));
		const info = httpProtocolInfo(request?.protocol);
		const kind = append(crumbs, $('button.volt-http-kind')) as HTMLButtonElement;
		kind.type = 'button';
		kind.dataset.method = info.id;
		setAgentTooltip(kind, localize('voltHttp.kindTitle', "{0} request. Click to change its kind.", info.label));
		kind.setAttribute('aria-haspopup', 'menu');
		kind.appendChild(createHttpProtocolIcon(info.id, 12));
		append(kind, $('span')).textContent = info.id === 'http' ? 'HTTP' : info.badge;
		kind.addEventListener('click', () => this.showKindMenu(kind));
		const entry = this.state.collection ? this.collections.get(this.state.collection) : undefined;
		if (entry && this.state.collection) {
			const uri = this.state.collection;
			const crumb = (label: string, title: string, open: () => void) => {
				const button = append(crumbs, $('button.volt-http-crumb')) as HTMLButtonElement;
				button.type = 'button';
				button.textContent = label;
				setAgentTooltip(button, title);
				button.addEventListener('click', open);
				append(crumbs, $('span.volt-http-crumb-sep')).textContent = '/';
			};
			crumb(entry.collection.format === 'postman' ? entry.collection.name : basename(uri), uri.fsPath, () => this.host.openCollection(uri));
			for (const folder of this.ancestors) {
				crumb(folder.name, folder.name, () => this.host.openFolder(uri, folder.id));
			}
		}
		const name = this.nameInput = append(crumbs, $('input.volt-http-name')) as HTMLInputElement;
		name.type = 'text';
		name.spellcheck = false;
		name.placeholder = localize('voltHttp.namePlaceholder', "Untitled request");
		name.setAttribute('aria-label', localize('voltHttp.name', "Request name"));
		name.value = request?.name ?? '';
		name.addEventListener('input', () => this.change(next => next.name = name.value));
		const actions = append(this.head, $('.volt-http-head-actions'));
		const agent = append(actions, $('button.volt-http-save.volt-http-ai-edit-toggle')) as HTMLButtonElement;
		agent.type = 'button';
		agent.classList.add(...voltButtonClasses('ghost'));
		agent.classList.toggle('active', !!this.state.aiEdit?.open);
		agent.setAttribute('aria-pressed', String(!!this.state.aiEdit?.open));
		// Icon only: the head keeps room for the request's name beside Add to Chat and Save.
		agent.classList.add('icon-only');
		setAgentTooltip(agent, localize('voltHttp.aiEditToggleTitle', "Edit with AI agent: describe the request or a change, and a model of your choice builds it"));
		agent.setAttribute('aria-label', localize('voltHttp.aiEditToggle', "Edit with AI"));
		agent.appendChild(createHttpAgentIcon());
		agent.addEventListener('click', () => this.toggleAiEdit());
		const chat = append(actions, $('button.volt-http-save.volt-http-add-chat')) as HTMLButtonElement;
		chat.type = 'button';
		chat.classList.add(...voltButtonClasses('ghost'));
		setAgentTooltip(chat, localize('voltHttp.addToChatTitle', "Add this request to the chat, so the agent can read, send and change it"));
		chat.appendChild(createHttpChatIcon());
		append(chat, $('span')).textContent = localize('voltHttp.addToChat', "Add to Chat");
		chat.addEventListener('click', () => this.addToChat());
		const save = this.saveButton = append(actions, $('button.volt-http-save')) as HTMLButtonElement;
		save.type = 'button';
		save.classList.add(...voltButtonClasses('ghost'));
		setAgentTooltip(save, localize('voltHttp.saveTitle', "Save (Cmd/Ctrl+S)"));
		save.appendChild(createHttpSaveIcon());
		append(save, $('span')).textContent = localize('voltHttp.save', "Save");
		save.addEventListener('click', () => void this.save());
		this.updateSave();
		if (!request) {
			clearNode(crumbs);
			append(crumbs, $('span.volt-http-gone')).textContent = localize('voltHttp.requestGone', "This request is no longer in its collection.");
		}
	}

	private showKindMenu(anchor: HTMLElement): void {
		const current = this.protocol;
		this.menu.value = showVoltMenu<HttpProtocol>(this.contextViewService, {
			anchor,
			className: HTTP_MENU_CLASS,
			align: 'left',
			width: 300,
			maxListHeight: 640,
			ariaLabel: localize('voltHttp.kind', "Kind of request"),
			sections: [{ id: 'kinds', items: HTTP_PROTOCOLS.map(item => ({ id: item.id, label: item.label, subtitle: item.hint, icon: () => createHttpProtocolIcon(item.id), checked: item.id === current, data: item.id })) }],
			onPick: item => {
				if (item.data === current) {
					return;
				}
				this.sessions.disconnect(this.key);
				this.state.exchange = undefined;
				this.state.grpc = undefined;
				this.change(next => convertHttpRequest(next, item.data));
				this.renderAll();
			},
		});
	}

	/** The request as the agent should know it: where it is saved, what it sends and what last came back. */
	private addToChat(): void {
		const request = this.request;
		if (request) {
			this.host.addToChat(httpRequestLabel(request), this.describe(true).join('\n'));
		}
	}

	/** The request in plain lines (secrets masked): for the chat (`forAgent`), or for a model writing its docs. */
	private describe(forAgent: boolean): string[] {
		const request = this.request;
		if (!request) {
			return [];
		}
		const info = httpProtocolInfo(request.protocol);
		const entry = this.state.collection ? this.collections.get(this.state.collection) : undefined;
		const wire = httpWireRequest(request, this.ancestors, entry?.collection).spec;
		const secret = /^(authorization|cookie|x-api-key|api-key|proxy-authorization)$/i;
		const lines = [
			`Volt Client request "${httpRequestLabel(request)}" (${info.label})`,
			...(this.state.collection ? [`Saved in: ${this.state.collection.fsPath}`, `Path in the collection: ${[...this.ancestors.map(folder => folder.name), request.name].join(' / ')}`] : ['Not saved in a collection yet.']),
			...(isHttpRequestDirty(this.collections, this.state) ? ['It has unsaved edits in the client; what follows is the edited request.'] : []),
			'',
			`${info.id === 'http' ? wire.method : info.badge} ${wire.url}`,
			...wire.headers.map(([key, value]) => `${key}: ${secret.test(key) ? '<set>' : value}`),
			...(wire.body ? ['', wire.body.length > 3000 ? `${wire.body.slice(0, 3000)}\n... (cut)` : wire.body] : []),
			...(request.messages?.length ? ['', 'Messages sent on connect:', ...request.messages.map(message => `${message.target ? `[${message.target}] ` : ''}${message.body}`)] : []),
		];
		const exchange = this.state.exchange;
		if (exchange?.response) {
			const body = exchange.response.body;
			lines.push('', `Last response: ${exchange.response.status} ${exchange.response.statusText} in ${exchange.response.durationMs} ms`, body.length > 3000 ? `${body.slice(0, 3000)}\n... (cut, ${body.length} characters in all)` : body);
			if (exchange.tests?.length) {
				lines.push('', 'Tests:', ...exchange.tests.map(test => `${test.passed ? 'PASS' : 'FAIL'} ${test.name}${test.error ? `: ${test.error}` : ''}`));
			}
		} else if (exchange?.error) {
			lines.push('', `Last send failed: ${exchange.error}`);
		}
		if (forAgent) {
			lines.push('', 'Work with it through the `ide http` capability (get, send, save_request, run) rather than curl.');
		}
		return lines;
	}

	private updateSave(): void {
		if (this.saveButton) {
			const dirty = isHttpRequestDirty(this.collections, this.state) || !this.state.collection;
			this.saveButton.classList.toggle('dirty', dirty);
		}
	}

	async save(): Promise<void> {
		const request = this.request;
		if (!request) {
			return;
		}
		if (!this.state.collection) {
			this.host.saveAs(request, this.saveButton ?? this.head);
			return;
		}
		const key = httpDraftKey(this.state.collection, this.state.id);
		if (!this.collections.draftOf(key)) {
			return;
		}
		try {
			await this.collections.updateItem(this.state.collection, this.state.id, item => {
				if (item.kind === 'request') {
					Object.assign(item, { ...cloneHttp(request), id: item.id, extra: item.extra, line: item.line });
				}
			});
			this.collections.setDraft(key, undefined);
			this.updateSave();
			this.host.tabChanged();
		} catch (err) {
			this.notificationService.error(err instanceof Error ? err.message : String(err));
		}
	}

	// --- URL bar -----------------------------------------------------------------------------------

	private renderBar(): void {
		this.barStore.clear();
		clearNode(this.bar);
		const request = this.request;
		if (!request) {
			return;
		}
		const protocol = request.protocol ?? 'http';
		const info = httpProtocolInfo(protocol);
		const group = append(this.bar, $('.volt-http-urlgroup'));
		const method = append(group, $('.volt-http-method'));
		if (protocol === 'http') {
			method.dataset.method = request.method;
			const methods = (HTTP_METHODS as readonly string[]).includes(request.method) ? HTTP_METHODS : [...HTTP_METHODS, request.method];
			createHttpDropdown<string>(method, this.contextViewService, {
				options: methods.map(id => ({ id, label: id })),
				value: request.method,
				ariaLabel: localize('voltHttp.method', "Method"),
				width: 112,
				searchFrom: 99,
				align: 'left',
				onChange: value => {
					method.dataset.method = value;
					this.change(next => next.method = value);
				},
			}, this.barStore);
		} else {
			// The kind stands where the method would: it is what goes on the wire.
			method.classList.add('fixed');
			method.dataset.method = protocol;
			method.appendChild(createHttpProtocolIcon(protocol, 13));
			append(method, $('span')).textContent = info.badge;
			setAgentTooltip(method, info.label);
		}
		const urlHost = append(group, $('.volt-http-url'));
		const grpc = protocol === 'grpc' ? httpGrpcTarget(request.url) : undefined;
		const field = this.urlField = createHttpVariableField(urlHost, {
			value: grpc ? grpc.address : request.url,
			placeholder: protocol === 'http' ? localize('voltHttp.urlPlaceholder', "Enter a URL or paste a cURL command") : info.urlPlaceholder,
			ariaLabel: localize('voltHttp.url', "URL"),
			variables: this.host.variables,
			onChange: value => {
				if (protocol === 'grpc') {
					this.state.grpc = undefined;
					this.change(next => {
						const target = httpGrpcTarget(next.url);
						next.url = httpGrpcUrl(value.trim(), target.service, target.method);
					});
					return;
				}
				this.change(next => syncHttpRequestUrl(next, value));
				if (this.activeTab() === 'params') {
					this.renderTabBody();
				}
			},
		}, this.barStore);
		this.barStore.add(addDisposableListener(field.input, EventType.KEY_DOWN, (event: KeyboardEvent) => {
			if (event.key === 'Enter') {
				event.preventDefault();
				void this.send();
			}
		}));
		if (protocol === 'http') {
			// A pasted cURL command becomes the request, as in Postman.
			this.barStore.add(addDisposableListener(field.input, EventType.PASTE, (event: ClipboardEvent) => {
				const text = event.clipboardData?.getData('text/plain') ?? '';
				if (!/^\s*curl\s/i.test(text)) {
					return;
				}
				const parsed = curlToRequest(text);
				if (!parsed) {
					return;
				}
				event.preventDefault();
				this.change(next => Object.assign(next, { ...parsed, id: next.id, name: next.name, description: next.description, scripts: next.scripts, extra: next.extra, line: next.line, auth: parsed.auth.type === 'none' ? next.auth : parsed.auth }));
				this.renderBar();
				this.renderTabs();
			}));
		}
		if (grpc) {
			const pick = append(group, $('button.volt-http-grpc-method')) as HTMLButtonElement;
			pick.type = 'button';
			pick.setAttribute('aria-haspopup', 'menu');
			setAgentTooltip(pick, localize('voltHttp.grpcMethodTitle', "The service and method to call"));
			const label = append(pick, $('span'));
			label.textContent = grpc.method ? `${grpc.service.split('.').pop()} / ${grpc.method}` : localize('voltHttp.grpcSelect', "Select a method");
			pick.classList.toggle('unset', !grpc.method);
			pick.appendChild(createHttpChevronIcon(12));
			pick.addEventListener('click', () => void this.showGrpcMethods(pick));
		}

		const split = append(this.bar, $('.volt-http-send'));
		const send = this.barStore.add(createVoltButton(split, 'primary', { supportIcons: true }));
		this.sendLabel = () => {
			const session = info.stream ? this.sessions.sessionOf(this.key) : undefined;
			const live = session && session.status !== 'closed';
			const busy = !!this.state.sending || !!live;
			send.label = this.state.sending || session?.status === 'connecting'
				? localize('voltHttp.cancel', "Cancel")
				: live
					? (protocol === 'grpc' ? localize('voltHttp.cancel', "Cancel") : localize('voltHttp.disconnect', "Disconnect"))
					: info.stream ? (protocol === 'grpc' ? localize('voltHttp.invoke', "Invoke") : localize('voltHttp.connect', "Connect")) : localize('voltHttp.send', "Send");
			split.classList.toggle('busy', busy);
			setAgentTooltip(send.element, live ? localize('voltHttp.disconnectTitle', "Close the connection") : protocol === 'grpc' ? localize('voltHttp.invokeTitle', "Call the method (Cmd/Ctrl+Enter)") : info.stream ? localize('voltHttp.connectTitle', "Connect (Cmd/Ctrl+Enter)") : localize('voltHttp.sendTitle', "Send (Cmd/Ctrl+Enter)"));
		};
		this.sendLabel(false);
		this.barStore.add(send.onDidClick(() => this.state.sending ? this.cancelSend() : void this.send()));
		const more = this.barStore.add(createVoltButton(split, 'primary', { title: localize('voltHttp.moreSend', "More actions") }));
		more.element.classList.add('volt-http-send-more');
		more.element.setAttribute('aria-haspopup', 'menu');
		more.element.setAttribute('aria-label', localize('voltHttp.moreSend', "More actions"));
		more.element.appendChild(createHttpChevronIcon(14));
		this.barStore.add(more.onDidClick(() => this.showSendMenu(more.element)));
	}

	/** The services a gRPC server offers, asked once per address (its .proto file, else reflection). */
	private async showGrpcMethods(anchor: HTMLElement): Promise<void> {
		const request = this.request;
		if (!request) {
			return;
		}
		if (!this.state.grpc?.services) {
			anchor.classList.add('loading');
			try {
				this.state.grpc = { services: await this.collections.describeGrpc(request, this.context) };
			} catch (err) {
				this.state.grpc = { error: err instanceof Error ? err.message : String(err) };
			}
			anchor.classList.remove('loading');
			if (!anchor.isConnected) {
				return;
			}
		}
		type Pick = { service: string; method: string; template: string } | 'refresh' | 'proto';
		const pickOf = (pick: Pick) => pick;
		const grpc = this.state.grpc;
		const current = httpGrpcTarget(request.url);
		this.menu.value = showVoltMenu<Pick>(this.contextViewService, {
			anchor,
			className: HTTP_MENU_CLASS,
			align: 'right',
			width: 340,
			ariaLabel: localize('voltHttp.grpcMethods', "Methods"),
			...(grpc.error ? { heading: { title: grpc.error } } : {}),
			sections: [
				...(grpc.services ?? []).map(service => ({
					id: service.name,
					title: service.name,
					items: service.methods.map(method => ({
						id: `${service.name}/${method.name}`,
						label: method.name,
						detail: method.clientStreaming && method.serverStreaming ? localize('voltHttp.grpcBidi', "both stream") : method.serverStreaming ? localize('voltHttp.grpcServerStream', "server streams") : method.clientStreaming ? localize('voltHttp.grpcClientStream', "client streams") : localize('voltHttp.grpcUnary', "unary"),
						checked: service.name === current.service && method.name === current.method,
						data: pickOf({ service: service.name, method: method.name, template: method.template }),
					})),
				})),
				{
					id: 'more', items: [
						{ id: 'refresh', label: localize('voltHttp.grpcRefresh', "Ask the Server Again"), icon: Codicon.refresh, data: pickOf('refresh') },
						{ id: 'proto', label: localize('voltHttp.grpcProto', "Use a .proto File"), icon: Codicon.file, data: pickOf('proto') },
					],
				},
			],
			onPick: item => {
				const picked = item.data;
				if (picked === 'refresh') {
					this.state.grpc = undefined;
					void this.showGrpcMethods(anchor);
				} else if (picked === 'proto') {
					this.state.requestTab = 'settings';
					this.renderTabs();
				} else {
					this.change(next => {
						next.url = httpGrpcUrl(httpGrpcTarget(next.url).address, picked.service, picked.method);
						// A message that is still the empty one starts from the method's shape.
						if (!next.body.raw.trim() || next.body.raw.trim() === '{}') {
							next.body.raw = picked.template;
						}
					});
					this.renderBar();
					this.renderTabs();
				}
			},
		});
	}

	private wireSpec(): IHttpRequestSpec | undefined {
		const request = this.request;
		if (!request) {
			return undefined;
		}
		const entry = this.state.collection ? this.collections.get(this.state.collection) : undefined;
		return httpWireRequest(request, this.ancestors, entry?.collection).spec;
	}

	private showSendMenu(anchor: HTMLElement): void {
		type Action = 'curl' | 'snippet' | 'clear' | 'revert' | 'mcp';
		const stream = httpProtocolInfo(this.protocol).stream;
		const items: { id: Action; label: string; icon: ThemeIcon }[] = [
			...(stream ? [] : [
				{ id: 'curl' as const, label: localize('voltHttp.copyCurl', "Copy as cURL"), icon: Codicon.terminal },
				{ id: 'snippet' as const, label: localize('voltHttp.codeSnippet', "Code Snippet"), icon: Codicon.code },
			]),
			...(stream && this.sessions.sessionOf(this.key)?.entries.length ? [{ id: 'clear' as const, label: localize('voltHttp.streamClear', "Clear messages"), icon: Codicon.clearAll }] : []),
			...(this.protocol === 'mcp' ? [{ id: 'mcp' as const, label: localize('voltHttp.mcpNewSession', "Start a New MCP Session"), icon: Codicon.debugRestart }] : []),
			...(this.state.exchange ? [{ id: 'clear' as const, label: localize('voltHttp.clearResponse', "Clear Response"), icon: Codicon.clearAll }] : []),
			...(this.state.collection && isHttpRequestDirty(this.collections, this.state) ? [{ id: 'revert' as const, label: localize('voltHttp.revert', "Discard Unsaved Changes"), icon: Codicon.discard }] : []),
		];
		this.menu.value = showVoltMenu<Action>(this.contextViewService, {
			anchor,
			className: HTTP_MENU_CLASS,
			align: 'right',
			ariaLabel: localize('voltHttp.moreSend', "More actions"),
			sections: [{ id: 'send', items: items.map(item => ({ ...item, data: item.id })) }],
			onPick: item => {
				const spec = this.wireSpec();
				switch (item.data) {
					case 'curl':
						if (spec) {
							void import('../common/httpCodegen.js').then(codegen => this.clipboardService.writeText(codegen.httpSnippet('curl', spec)));
						}
						break;
					case 'snippet':
						if (spec) {
							this.host.showSnippet(spec);
						}
						break;
					case 'clear':
						this.state.exchange = undefined;
						this.sessions.clear(this.key);
						this.renderResponse();
						break;
					case 'mcp':
						if (spec) {
							this.http.resetMcpSession(spec.url, this.host.root);
						}
						break;
					case 'revert':
						this.collections.setDraft(httpDraftKey(this.state.collection, this.state.id), undefined);
						this.host.tabChanged();
						break;
				}
			},
		});
	}

	// --- Request tabs ------------------------------------------------------------------------------

	private renderTabs(): void {
		this.renderTabStrip();
		this.renderTabBody();
	}

	/** The tabs a kind of request has, in order: what it sends first. */
	private tabsOf(protocol: HttpProtocol): HttpRequestTab[] {
		switch (protocol) {
			case 'graphql': case 'soap': case 'ai': case 'mcp': return ['docs', 'body', 'auth', 'headers', 'scripts'];
			case 'grpc': return ['docs', 'body', 'headers', 'auth', 'settings', 'scripts'];
			case 'ws': return ['docs', 'body', 'params', 'headers', 'auth', 'scripts'];
			case 'socketio': return ['docs', 'body', 'headers', 'auth', 'settings', 'scripts'];
			case 'mqtt': return ['docs', 'body', 'settings', 'auth', 'scripts'];
			case 'sse': return ['docs', 'params', 'headers', 'auth', 'scripts'];
			default: return ['docs', 'params', 'auth', 'headers', 'body', 'scripts', 'settings'];
		}
	}

	/** Docs stands first, as in Postman, but a request opens on what it sends: the tab after it. */
	private activeTab(): HttpRequestTab {
		const tabs = this.tabsOf(this.protocol);
		const picked = this.state.requestTab;
		return picked && tabs.includes(picked) ? picked : tabs[1] ?? tabs[0];
	}

	private renderTabStrip(): void {
		const request = this.request;
		if (!request) {
			clearNode(this.tabsEl);
			return;
		}
		const protocol = request.protocol ?? 'http';
		const headers = request.headers.filter(item => item.enabled && item.key).length;
		const bodyLabel: Record<HttpProtocol, string> = {
			http: localize('voltHttp.body', "Body"), graphql: localize('voltHttp.query', "Query"), soap: localize('voltHttp.envelope', "Envelope"), ai: localize('voltHttp.prompt', "Prompt"),
			mcp: localize('voltHttp.message', "Message"), grpc: localize('voltHttp.message', "Message"), ws: localize('voltHttp.message', "Message"), socketio: localize('voltHttp.message', "Message"), mqtt: localize('voltHttp.message', "Message"), sse: '',
		};
		const specs: Record<HttpRequestTab, { label: string; dot?: boolean; count?: number; icon?: ThemeIcon }> = {
			params: { label: localize('voltHttp.params', "Params"), dot: request.params.some(row => row.enabled && row.key) || request.pathVariables.length > 0 },
			auth: { label: localize('voltHttp.authorization', "Authorization"), dot: request.auth.type !== 'none' && request.auth.type !== 'inherit' },
			headers: { label: protocol === 'grpc' ? localize('voltHttp.metadata', "Metadata") : localize('voltHttp.headers', "Headers"), count: headers || undefined },
			body: { label: bodyLabel[protocol], dot: protocol === 'http' ? request.body.mode !== 'none' : !!request.messages?.length },
			settings: { label: protocol === 'grpc' ? localize('voltHttp.protoTab', "Proto") : localize('voltHttp.settings', "Settings"), dot: protocol === 'http' ? !!request.settings && Object.keys(request.settings).length > 0 : !!request.options && Object.values(request.options).some(Boolean) },
			scripts: { label: localize('voltHttp.scripts', "Scripts"), dot: !!request.scripts.preRequest.trim() || !!request.scripts.test.trim() },
			docs: { label: localize('voltHttp.docs', "Docs"), icon: Codicon.listFlat, dot: !!request.description.trim() },
		};
		renderHttpTabs<HttpRequestTab>(this.tabsEl, this.tabsOf(protocol).map(id => ({ id, ...specs[id] })), this.activeTab(), id => {
			this.state.requestTab = id;
			this.renderTabs();
		});
		if (protocol === 'http' || protocol === 'graphql' || protocol === 'soap') {
			// At the right of the tabs, as in Postman: the cookies kept for this project.
			const cookies = append(this.tabsEl, $('button.volt-http-link.volt-http-cookies-link')) as HTMLButtonElement;
			cookies.type = 'button';
			cookies.textContent = localize('voltHttp.cookiesLink', "Cookies");
			setAgentTooltip(cookies, localize('voltHttp.cookiesLinkTitle', "The cookies responses set, sent back to their domain"));
			cookies.addEventListener('click', () => {
				let domain: string | undefined;
				try {
					domain = new URL(this.wireSpec()?.url ?? '').hostname || undefined;
				} catch { /* a URL with variables in its host */ }
				this.host.showCookies(domain);
			});
		}
	}

	private section(title: string | undefined): HTMLElement {
		const section = append(this.tabBody, $('.volt-http-section'));
		if (title) {
			append(append(section, $('.volt-http-section-head')), $('span.volt-http-section-title')).textContent = title;
		}
		return section;
	}

	private table(parent: HTMLElement, options: ConstructorParameters<typeof HttpKeyValueTable>[1]): HttpKeyValueTable {
		const table = this.tabStore.add(new HttpKeyValueTable(parent, { variables: this.host.variables, ...options }));
		this.tables.push(table);
		return table;
	}

	private renderTabBody(): void {
		this.tabStore.clear();
		this.tables.length = 0;
		this.composer = undefined;
		this.docsEditor = undefined;
		clearNode(this.tabBody);
		const tab = this.activeTab();
		this.tabBody.className = `volt-http-tab-body ${tab}`;
		const request = this.request;
		if (!request) {
			return;
		}
		switch (tab) {
			case 'settings': this.renderSettings(request); break;
			case 'params': {
				this.table(this.section(localize('voltHttp.queryParams', "Query Params")), {
					rows: request.params,
					description: true,
					onChange: rows => {
						let url = '';
						this.change(next => {
							next.params = rows;
							next.url = url = httpUrlWithQuery(next.url, rows);
							next.pathVariables = httpPathVariablesFor(next.url, next.pathVariables);
						});
						if (this.urlField) {
							this.urlField.value = url;
						}
					},
				});
				if (request.pathVariables.length) {
					this.table(this.section(localize('voltHttp.pathVariables', "Path Variables")), {
						rows: request.pathVariables,
						fixedKeys: true,
						description: true,
						onChange: rows => this.change(next => next.pathVariables = next.pathVariables.map(row => ({ ...row, ...rows.find(item => item.key === row.key) }))),
					});
				}
				break;
			}
			case 'headers': this.renderHeaders(request); break;
			case 'body':
				if (request.protocol && request.protocol !== 'http') {
					this.renderProtocolBody(request, request.protocol);
				} else {
					this.renderBody(request);
				}
				break;
			case 'auth': this.renderAuth(request); break;
			case 'scripts': this.renderScripts(request); break;
			case 'docs':
				this.docsEditor = this.tabStore.add(this.instantiationService.createInstance(HttpDocsEditor, this.tabBody, {
					value: request.description,
					placeholder: localize('voltHttp.docsPlaceholder', "Document this request"),
					onChange: value => this.change(next => next.description = value),
					aiContext: () => this.describe(false).join('\n'),
				}));
				break;
		}
		this.layoutEditors();
	}

	private renderHeaders(request: IHttpRequest): void {
		const entry = this.state.collection ? this.collections.get(this.state.collection) : undefined;
		const auto = httpAutoHeaders(request, effectiveHttpAuth(request, this.ancestors, entry?.collection).auth);
		if (request.body.mode === 'formdata') {
			auto.push(['Content-Type', 'multipart/form-data; boundary=<set when sent>']);
		}
		const section = this.section(localize('voltHttp.headers', "Headers"));
		if (auto.length) {
			const note = append(section.querySelector('.volt-http-section-head') as HTMLElement, $('span.volt-http-auto-note'));
			note.textContent = localize('voltHttp.autoHeaders', "{0} added automatically: {1}", auto.length, auto.map(([key]) => key).join(', '));
			setAgentTooltip(note, auto.map(([key, value]) => `${key}: ${value}`).join('\n'));
		}
		this.table(section, { rows: request.headers, description: true, onChange: rows => this.change(next => next.headers = rows) });
	}

	private renderBody(request: IHttpRequest): void {
		const body = request.body;
		const modes = append(this.tabBody, $('.volt-http-modes'));
		modes.setAttribute('role', 'radiogroup');
		modes.setAttribute('aria-label', localize('voltHttp.bodyMode', "Body type"));
		const choices: { label: string; mode: HttpBodyMode }[] = [
			{ label: localize('voltHttp.bodyNone', "none"), mode: 'none' },
			{ label: 'form-data', mode: 'formdata' },
			{ label: 'x-www-form-urlencoded', mode: 'urlencoded' },
			{ label: 'raw', mode: 'raw' },
			{ label: 'binary', mode: 'binary' },
			{ label: 'GraphQL', mode: 'graphql' },
		];
		for (const { label, mode } of choices) {
			const checked = body.mode === mode;
			const radio = append(modes, $('button.volt-http-radio')) as HTMLButtonElement;
			radio.type = 'button';
			radio.setAttribute('role', 'radio');
			radio.setAttribute('aria-checked', String(checked));
			radio.classList.toggle('checked', checked);
			append(radio, $('span.volt-http-radio-dot'));
			append(radio, $('span')).textContent = label;
			radio.addEventListener('click', () => {
				if (!checked) {
					this.change(next => next.body.mode = mode);
					this.renderTabs();
				}
			});
			if (mode === 'raw' && checked) {
				createHttpDropdown<HttpRawLanguage>(append(modes, $('.volt-http-raw-format')), this.contextViewService, {
					options: [{ id: 'json', label: 'JSON' }, { id: 'text', label: localize('voltHttp.bodyText', "Text") }, { id: 'xml', label: 'XML' }, { id: 'html', label: 'HTML' }, { id: 'javascript', label: 'JavaScript' }],
					value: body.language,
					ariaLabel: localize('voltHttp.rawFormat', "Raw format"),
					width: 160,
					align: 'left',
					onChange: value => {
						this.change(next => next.body.language = value);
						this.renderTabs();
					},
				}, this.tabStore);
			}
		}
		if (body.mode === 'raw' && body.language === 'json') {
			const beautify = append(modes, $('button.volt-http-link.end')) as HTMLButtonElement;
			beautify.type = 'button';
			beautify.textContent = localize('voltHttp.beautifyLink', "Beautify");
			beautify.addEventListener('click', () => {
				const editor = [...this.codeEditors].find(item => item.getContainerDomNode().dataset.role === 'body');
				try {
					editor?.setValue(JSON.stringify(JSON.parse(editor.getValue()), null, 2));
				} catch { /* not valid JSON yet */ }
			});
		}
		switch (body.mode) {
			case 'none':
				append(this.tabBody, $('.volt-http-empty.center')).textContent = localize('voltHttp.noBody', "This request does not have a body");
				break;
			case 'formdata':
				this.table(this.section(undefined), {
					rows: body.formdata,
					description: true,
					pickFile: () => this.pickFile(),
					onChange: rows => this.change(next => next.body.formdata = rows),
				});
				break;
			case 'urlencoded':
				this.table(this.section(undefined), { rows: body.urlencoded, description: true, onChange: rows => this.change(next => next.body.urlencoded = rows) });
				break;
			case 'binary': {
				const row = append(this.tabBody, $('.volt-http-binary'));
				const field = createHttpVariableField(row, {
					value: body.binaryPath,
					placeholder: localize('voltHttp.binaryPlaceholder', "Path to the file to send (absolute, or relative to the collection)"),
					ariaLabel: localize('voltHttp.binaryFile', "File"),
					variables: this.host.variables,
					onChange: value => this.change(next => next.body.binaryPath = value),
				}, this.tabStore);
				const pick = this.tabStore.add(createVoltButton(row, 'secondary'));
				pick.label = localize('voltHttp.selectFile', "Select File");
				this.tabStore.add(pick.onDidClick(async () => {
					const path = await this.pickFile();
					if (path !== undefined) {
						field.value = path;
						this.change(next => next.body.binaryPath = path);
					}
				}));
				break;
			}
			case 'graphql': {
				const split = append(this.tabBody, $('.volt-http-graphql'));
				const queryPane = append(split, $('.volt-http-graphql-pane'));
				append(queryPane, $('.volt-http-sublabel')).textContent = localize('voltHttp.query', "Query");
				const query = this.createCodeEditor(append(queryPane, $('.volt-http-code')), body.graphqlQuery, 'graphql', false, this.tabStore);
				this.tabStore.add(query.onDidChangeModelContent(() => this.change(next => next.body.graphqlQuery = query.getValue())));
				const variablesPane = append(split, $('.volt-http-graphql-pane'));
				append(variablesPane, $('.volt-http-sublabel')).textContent = localize('voltHttp.variables', "GraphQL Variables");
				const variables = this.createCodeEditor(append(variablesPane, $('.volt-http-code')), body.graphqlVariables, 'json', false, this.tabStore);
				this.tabStore.add(variables.onDidChangeModelContent(() => this.change(next => next.body.graphqlVariables = variables.getValue())));
				break;
			}
			case 'raw': {
				const language = body.language === 'text' ? 'plaintext' : body.language;
				const editor = this.createCodeEditor(append(this.tabBody, $('.volt-http-code')), body.raw, language, false, this.tabStore);
				editor.getContainerDomNode().dataset.role = 'body';
				this.tabStore.add(editor.onDidChangeModelContent(() => this.change(next => next.body.raw = editor.getValue())));
				break;
			}
		}
	}

	private setOption(key: string, value: string): void {
		this.change(next => {
			const options = { ...next.options };
			if (value.trim()) {
				options[key] = value;
			} else {
				delete options[key];
			}
			if (Object.keys(options).length) {
				next.options = options;
			} else {
				delete next.options;
			}
		});
	}

	private optionField(parent: HTMLElement, key: string, label: string, placeholder: string, value: string, help?: string): IHttpVariableField {
		const row = append(parent, $('.volt-http-field'));
		append(row, $('label')).textContent = label;
		const wrap = append(row, $('.volt-http-field-wrap'));
		const field = createHttpVariableField(wrap, { value, placeholder, ariaLabel: label, variables: this.host.variables, onChange: next => this.setOption(key, next) }, this.tabStore);
		if (help) {
			append(wrap, $('.volt-http-field-help')).textContent = help;
		}
		return field;
	}

	/** What a kind needs beyond its URL and headers (kept as `# @directives` in an .http file). */
	private renderSettings(request: IHttpRequest): void {
		const options = request.options ?? {};
		if (!request.protocol || request.protocol === 'http') {
			// Plain HTTP: how the request is sent (redirects, certificates, cookies), as Postman's Settings.
			renderHttpRequestSettings(this.tabBody, {
				settings: request.settings,
				contextViewService: this.contextViewService,
				store: this.tabStore,
				onChange: mutate => {
					this.change(next => {
						const settings = { ...next.settings };
						mutate(settings);
						if (Object.keys(settings).length) {
							next.settings = settings;
						} else {
							delete next.settings;
						}
					});
				},
			});
			return;
		}
		const form = append(this.tabBody, $('.volt-http-form'));
		switch (request.protocol) {
			case 'grpc': {
				const field = this.optionField(form, 'proto', localize('voltHttp.protoFile', ".proto file"), localize('voltHttp.protoPlaceholder', "Path (absolute, or relative to the collection)"), options.proto ?? '', localize('voltHttp.protoHelp', "Leave it empty to ask the server's reflection service. Imports are read from beside the file."));
				const pick = this.tabStore.add(createVoltButton(field.element.parentElement!, 'secondary'));
				pick.element.classList.add('volt-button-small');
				pick.label = localize('voltHttp.selectFile', "Select File");
				this.tabStore.add(pick.onDidClick(async () => {
					const path = await this.pickFile();
					if (path !== undefined) {
						field.value = path;
						this.state.grpc = undefined;
						this.setOption('proto', path);
					}
				}));
				break;
			}
			case 'socketio':
				this.optionField(form, 'path', localize('voltHttp.enginePath', "Engine path"), '/socket.io', options.path ?? '', localize('voltHttp.enginePathHelp', "Where the server mounts Socket.IO. The namespace is the URL's own path."));
				this.optionField(form, 'auth', localize('voltHttp.connectAuth', "Connect payload"), '{ "token": "{{token}}" }', options.auth ?? '', localize('voltHttp.connectAuthHelp', "JSON sent as `auth` when the namespace connects."));
				break;
			case 'mqtt': {
				const row = append(form, $('.volt-http-field.top'));
				append(row, $('label')).textContent = localize('voltHttp.mqttSubscribe', "Subscribe to");
				const wrap = append(row, $('.volt-http-field-wrap'));
				const area = append(wrap, $('textarea.volt-http-textarea')) as HTMLTextAreaElement;
				area.rows = 3;
				area.spellcheck = false;
				area.placeholder = 'sensors/+/temperature\nalerts/#';
				area.setAttribute('aria-label', localize('voltHttp.mqttSubscribe', "Subscribe to"));
				area.value = options.subscribe ?? '';
				area.addEventListener('input', () => this.setOption('subscribe', area.value));
				append(wrap, $('.volt-http-field-help')).textContent = localize('voltHttp.mqttSubscribeHelp', "One topic filter per line, subscribed as soon as the broker accepts the connection. The name and password come from Authorization, Basic Auth.");
				this.optionField(form, 'clientId', localize('voltHttp.mqttClientId', "Client ID"), localize('voltHttp.mqttClientIdPlaceholder', "A random one when empty"), options.clientId ?? '');
				const qos = append(form, $('.volt-http-field'));
				append(qos, $('label')).textContent = 'QoS';
				createHttpDropdown<'0' | '1'>(append(qos, $('.volt-http-field-wrap')), this.contextViewService, {
					options: [{ id: '0', label: localize('voltHttp.qos0', "0, at most once") }, { id: '1', label: localize('voltHttp.qos1', "1, at least once") }],
					value: options.qos === '1' ? '1' : '0',
					ariaLabel: 'QoS',
					align: 'left',
					width: 200,
					onChange: value => this.setOption('qos', value === '1' ? '1' : ''),
				}, this.tabStore);
				break;
			}
		}
	}

	private renderProtocolBody(request: IHttpRequest, protocol: HttpProtocol): void {
		const body = request.body;
		const toolbar = () => append(this.tabBody, $('.volt-http-modes'));
		const link = (parent: HTMLElement, label: string, run: () => void, end = true) => {
			const button = append(parent, $(end ? 'button.volt-http-link.end' : 'button.volt-http-link')) as HTMLButtonElement;
			button.type = 'button';
			button.textContent = label;
			button.addEventListener('click', run);
			return button;
		};
		const rawEditor = (language: string) => {
			const editor = this.createCodeEditor(append(this.tabBody, $('.volt-http-code')), body.raw, language, false, this.tabStore);
			editor.getContainerDomNode().dataset.role = 'body';
			this.tabStore.add(editor.onDidChangeModelContent(() => this.change(next => next.body.raw = editor.getValue())));
			return editor;
		};
		const beautifyJson = (editor: CodeEditorWidget) => {
			try {
				editor.setValue(JSON.stringify(JSON.parse(editor.getValue()), null, 2));
			} catch { /* not valid JSON yet */ }
		};
		switch (protocol) {
			case 'graphql': {
				const bar = toolbar();
				append(bar, $('span.volt-http-sublabel.inline')).textContent = localize('voltHttp.graphqlHint', "Sent as a POST with the query, its variables and the operation's name");
				const split = append(this.tabBody, $('.volt-http-graphql'));
				const queryPane = append(split, $('.volt-http-graphql-pane'));
				append(queryPane, $('.volt-http-sublabel')).textContent = localize('voltHttp.query', "Query");
				const query = this.createCodeEditor(append(queryPane, $('.volt-http-code')), body.graphqlQuery, 'graphql', false, this.tabStore);
				this.tabStore.add(query.onDidChangeModelContent(() => this.change(next => next.body.graphqlQuery = query.getValue())));
				const variablesPane = append(split, $('.volt-http-graphql-pane'));
				append(variablesPane, $('.volt-http-sublabel')).textContent = localize('voltHttp.variables', "GraphQL Variables");
				const variables = this.createCodeEditor(append(variablesPane, $('.volt-http-code')), body.graphqlVariables, 'json', false, this.tabStore);
				this.tabStore.add(variables.onDidChangeModelContent(() => this.change(next => next.body.graphqlVariables = variables.getValue())));
				link(bar, localize('voltHttp.beautifyLink', "Beautify"), () => {
					query.setValue(prettyGraphql(query.getValue()));
					beautifyJson(variables);
				});
				break;
			}
			case 'soap': {
				const bar = toolbar();
				append(bar, $('span.volt-http-sublabel.inline')).textContent = localize('voltHttp.soapHint', "Sent as a POST of text/xml. Set the operation in the SOAPAction header.");
				rawEditor('xml');
				break;
			}
			case 'mcp': {
				const bar = toolbar();
				const method = httpMcpMethodOf(body.raw);
				const known = HTTP_MCP_TEMPLATES.some(item => item.method === method);
				createHttpDropdown<string>(append(bar, $('.volt-http-raw-format')), this.contextViewService, {
					options: [...HTTP_MCP_TEMPLATES.map(item => ({ id: item.method, label: item.method, description: item.label })), ...(known || !method ? [] : [{ id: method, label: method }])],
					value: method ?? 'tools/list',
					ariaLabel: localize('voltHttp.mcpMethod', "Method"),
					width: 280,
					align: 'left',
					onChange: value => {
						this.change(next => next.body.raw = httpMcpMessage(value));
						this.renderTabs();
					},
				}, this.tabStore);
				append(bar, $('span.volt-http-sublabel.inline')).textContent = localize('voltHttp.mcpHint', "The session is started and kept for you");
				const editor = rawEditor('json');
				link(bar, localize('voltHttp.beautifyLink', "Beautify"), () => beautifyJson(editor));
				break;
			}
			case 'grpc': {
				const bar = toolbar();
				const target = httpGrpcTarget(request.url);
				const described = this.state.grpc?.services?.find(service => service.name === target.service)?.methods.find(item => item.name === target.method);
				append(bar, $('span.volt-http-sublabel.inline')).textContent = target.method
					? localize('voltHttp.grpcMessageHint', "The request message as JSON, sent when the call opens")
					: localize('voltHttp.grpcPickHint', "Enter the server's address, then select a method beside it");
				const editor = rawEditor('json');
				if (described) {
					link(bar, localize('voltHttp.grpcExample', "Use Example"), () => editor.setValue(described.template));
				}
				link(bar, localize('voltHttp.beautifyLink', "Beautify"), () => beautifyJson(editor), !described);
				if (described?.clientStreaming) {
					// A client stream takes more messages while the call is open.
					const more = append(this.tabBody, $('.volt-http-composer-row.after'));
					append(more, $('span.volt-http-sublabel.inline')).textContent = localize('voltHttp.grpcStreamHint', "This method takes a stream: send more messages while the call is open, then end it.");
					append(more, $('.volt-http-spacer'));
					const sendMore = this.tabStore.add(createVoltButton(more, 'secondary'));
					sendMore.element.classList.add('volt-button-small');
					sendMore.label = localize('voltHttp.grpcSendMore', "Send Message");
					this.tabStore.add(sendMore.onDidClick(() => void this.sessions.send(this.key, { data: editor.getValue() }).catch(err => this.notificationService.warn(err instanceof Error ? err.message : String(err)))));
					const end = this.tabStore.add(createVoltButton(more, 'secondary'));
					end.element.classList.add('volt-button-small');
					end.label = localize('voltHttp.grpcEnd', "End Stream");
					this.tabStore.add(end.onDidClick(() => void this.sessions.send(this.key, { data: '', end: true }).catch(err => this.notificationService.warn(err instanceof Error ? err.message : String(err)))));
				}
				break;
			}
			case 'ai': this.renderAiBody(request); break;
			default: {
				const composer = this.composer = this.tabStore.add(this.instantiationService.createInstance(HttpMessageComposer, this.tabBody, {
					protocol,
					key: this.key,
					draft: this.state.composer ??= { target: '', body: '' },
					messages: request.messages ?? [],
					variables: this.host.variables,
					host: { createEditor: (host, value, language, readOnly, store) => this.createCodeEditor(host, value, language, readOnly, store), layoutEditors: () => this.layoutEditors() },
					onMessagesChange: messages => {
						this.change(next => next.messages = messages);
						this.renderTabStrip();
					},
					ensureConnected: () => this.ensureConnected(),
				}));
				composer.layout(this.width);
				break;
			}
		}
	}

	/** An AI request's form: the provider, the model and the prompt, kept as the provider's own JSON body. */
	private renderAiBody(request: IHttpRequest): void {
		const prompt = httpAiPromptFromBody(request.url, request.body.raw);
		const bar = append(this.tabBody, $('.volt-http-modes'));
		if (!prompt) {
			// A body the form cannot hold (several turns, tools): edited as it is.
			append(bar, $('span.volt-http-sublabel.inline')).textContent = localize('voltHttp.aiRaw', "This body has more than one prompt, so it is edited as JSON");
			const editor = this.createCodeEditor(append(this.tabBody, $('.volt-http-code')), request.body.raw, 'json', false, this.tabStore);
			this.tabStore.add(editor.onDidChangeModelContent(() => this.change(next => next.body.raw = editor.getValue())));
			return;
		}
		const apply = (mutate: (prompt: IHttpAiPrompt) => void) => {
			mutate(prompt);
			this.change(next => next.body.raw = httpAiBodyOf(prompt));
		};
		createHttpDropdown<HttpAiProvider>(append(bar, $('.volt-http-raw-format')), this.contextViewService, {
			options: HTTP_AI_PROVIDERS.map(item => ({ id: item.id, label: item.label, description: item.url })),
			value: prompt.provider,
			ariaLabel: localize('voltHttp.aiProvider', "Provider"),
			width: 320,
			align: 'left',
			onChange: value => {
				const provider = HTTP_AI_PROVIDERS.find(item => item.id === value)!;
				prompt.provider = value;
				prompt.model = provider.model;
				this.change(next => {
					// The provider decides where the request goes and how its key is sent.
					syncHttpRequestUrl(next, provider.url);
					next.body.raw = httpAiBodyOf(prompt);
					next.auth = value === 'anthropic'
						? { ...emptyHttpAuth('apikey'), keyName: 'x-api-key', keyValue: `{{${provider.keyVariable}}}`, keyIn: 'header' }
						: { ...emptyHttpAuth('bearer'), token: `{{${provider.keyVariable}}}` };
				});
				this.renderBar();
				this.renderTabs();
			},
		}, this.tabStore);
		append(bar, $('span.volt-http-sublabel.inline')).textContent = localize('voltHttp.aiKeyHint', "The key is under Authorization, read from an environment variable");
		const form = append(this.tabBody, $('.volt-http-form.ai'));
		const field = (label: string, build: (wrap: HTMLElement) => void, top = false) => {
			const row = append(form, $(top ? '.volt-http-field.top' : '.volt-http-field'));
			append(row, $('label')).textContent = label;
			build(append(row, $('.volt-http-field-wrap')));
		};
		field(localize('voltHttp.aiModelLabel', "Model"), wrap => {
			createHttpVariableField(wrap, { value: prompt.model, placeholder: localize('voltHttp.aiModelPlaceholder', "The provider's model id"), ariaLabel: localize('voltHttp.aiModelLabel', "Model"), variables: this.host.variables, onChange: value => apply(next => next.model = value) }, this.tabStore);
		});
		const area = (label: string, value: string, rows: number, placeholder: string, set: (prompt: IHttpAiPrompt, value: string) => void) => field(label, wrap => {
			const text = append(wrap, $('textarea.volt-http-textarea')) as HTMLTextAreaElement;
			text.rows = rows;
			text.placeholder = placeholder;
			text.setAttribute('aria-label', label);
			text.value = value;
			text.addEventListener('input', () => apply(next => set(next, text.value)));
		}, true);
		area(localize('voltHttp.aiSystem', "System"), prompt.system, 2, localize('voltHttp.aiSystemPlaceholder', "Optional: how the model should behave"), (next, value) => next.system = value);
		area(localize('voltHttp.aiPrompt', "Prompt"), prompt.prompt, 6, localize('voltHttp.aiPromptPlaceholder', "What to ask the model. {{variables}} work here."), (next, value) => next.prompt = value);
		field(localize('voltHttp.aiMaxTokens', "Max tokens"), wrap => {
			const input = append(wrap, $('input.volt-http-input.short')) as HTMLInputElement;
			input.type = 'number';
			input.min = '1';
			input.placeholder = prompt.provider === 'anthropic' ? '1024' : localize('voltHttp.aiMaxTokensDefault', "Provider default");
			input.setAttribute('aria-label', localize('voltHttp.aiMaxTokens', "Max tokens"));
			input.value = prompt.maxTokens !== undefined ? String(prompt.maxTokens) : '';
			input.addEventListener('input', () => apply(next => {
				const value = Number(input.value);
				next.maxTokens = input.value.trim() && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
			}));
		});
	}

	private async pickFile(): Promise<string | undefined> {
		const picked = await this.fileDialogService.showOpenDialog({ canSelectFiles: true, canSelectFolders: false, canSelectMany: false, title: localize('voltHttp.selectFile', "Select File") });
		return picked?.[0]?.fsPath;
	}

	private renderAuth(request: IHttpRequest): void {
		const entry = this.state.collection ? this.collections.get(this.state.collection) : undefined;
		const effective = effectiveHttpAuth(request, this.ancestors, entry?.collection);
		renderHttpAuthEditor(this.tabBody, {
			auth: request.auth,
			inheritable: entry?.collection.format === 'postman',
			inheritedHelp: effective.from ? localize('voltHttp.authInheritHelp', "This request uses {0} from \"{1}\".", httpAuthTypeLabel(effective.auth.type), effective.from) : localize('voltHttp.authInheritNone', "No folder or collection above this request sets an authorization, so none is sent."),
			openExternal: url => void this.openerService.open(url, { openExternal: true }),
			signIn: (url, callback) => this.oauth.signIn(url, callback),
			// A token is asked for like any request of this project, so it lands in History too.
			requestToken: async token => {
				const exchange = await this.http.send({ name: localize('voltHttp.tokenRequestName', "Token request"), method: 'POST', url: token.url, headers: token.headers, body: token.body, line: 0 }, { ...(this.host.root ? { root: this.host.root } : {}) });
				return exchange.response ? { status: exchange.response.status, body: exchange.response.body } : { error: exchange.error ?? localize('voltHttp.tokenRequestFailed', "The token request got no answer.") };
			},
			variables: this.host.variables,
			contextViewService: this.contextViewService,
			store: this.tabStore,
			onChange: (mutate, redraw) => {
				this.change(next => mutate(next.auth));
				if (redraw) {
					this.renderTabs();
				}
			},
		});
	}

	private renderScripts(request: IHttpRequest): void {
		const phase = this.state.scriptTab;
		const bar = append(this.tabBody, $('.volt-http-script-bar'));
		watchHttpOverflow(bar);
		const tabs = append(bar, $('.volt-http-subtabs'));
		renderHttpTabs<'preRequest' | 'test'>(tabs, [
			{ id: 'preRequest', label: localize('voltHttp.preRequest', "Pre-request"), dot: !!request.scripts.preRequest.trim() },
			{ id: 'test', label: localize('voltHttp.postResponse', "Post-response"), dot: !!request.scripts.test.trim() },
		], phase, id => {
			this.state.scriptTab = id;
			this.renderTabBody();
		});
		const editor = this.createCodeEditor(append(this.tabBody, $('.volt-http-code')), request.scripts[phase], 'javascript', false, this.tabStore);
		this.tabStore.add(editor.onDidChangeModelContent(() => this.change(next => next.scripts[phase] = editor.getValue())));
		this.renderBreakpoints(editor, phase);
		if (phase === 'test' && !httpProtocolInfo(request.protocol).stream) {
			this.addTestLenses(editor);
			const runAll = append(bar, $('button.volt-http-link.end.volt-http-run-link')) as HTMLButtonElement;
			runAll.type = 'button';
			runAll.appendChild(renderIcon(Codicon.runAll));
			append(runAll, $('span')).textContent = localize('voltHttp.runAllTests', "Run All Tests");
			setAgentTooltip(runAll, localize('voltHttp.runAllTestsTitle', "Run every test on the response in hand; sends the request first when there is none"));
			runAll.addEventListener('click', () => void this.runTests(undefined));
		}
		if (phase === 'test' && !httpProtocolInfo(request.protocol).stream) {
			const generate = append(bar, $('button.volt-http-link')) as HTMLButtonElement;
			generate.type = 'button';
			generate.textContent = localize('voltHttp.aiTitle', "Generate tests");
			setAgentTooltip(generate, localize('voltHttp.aiLinkTitle', "Have a model write the tests from the response"));
			generate.addEventListener('click', () => {
				this.state.responseTab = 'tests';
				this.state.generating = true;
				this.renderResponse();
			});
		}
		const snippets = append(bar, $(phase === 'test' && !httpProtocolInfo(request.protocol).stream ? 'button.volt-http-link' : 'button.volt-http-link.end')) as HTMLButtonElement;
		snippets.type = 'button';
		snippets.textContent = localize('voltHttp.snippets', "Snippets");
		snippets.addEventListener('click', () => {
			const items = SCRIPT_SNIPPETS.filter(snippet => snippet.phase === 'both' || snippet.phase === phase);
			this.menu.value = showVoltMenu<string>(this.contextViewService, {
				anchor: snippets,
				className: HTTP_MENU_CLASS,
				align: 'right',
				width: 280,
				ariaLabel: localize('voltHttp.snippets', "Snippets"),
				sections: [{ id: 'snippets', items: items.map((snippet, index) => ({ id: String(index), label: snippet.label, data: snippet.code })) }],
				onPick: item => {
					const current = editor.getValue();
					editor.setValue(current.trim() ? `${current.replace(/\s*$/, '')}\n\n${item.data}\n` : `${item.data}\n`);
					editor.focus();
				},
			});
		});
	}

	/**
	 * Breakpoints in a script editor's gutter, and under the editor the stops the last run recorded
	 * for this phase (the script does not pause: what was in reach at each marked line is kept).
	 */
	private renderBreakpoints(editor: CodeEditorWidget, phase: 'preRequest' | 'test'): void {
		const marks = this.tabStore.add(new HttpScriptBreakpoints(editor, this.state.breakpoints?.[phase] ?? [], lines => {
			(this.state.breakpoints ??= { preRequest: [], test: [] })[phase] = lines;
		}));
		const all = this.state.exchange?.breaks;
		if (!all || this.state.breaksClosed) {
			return;
		}
		const stops = all.filter(stop => (stop.phase ?? 'test') === phase);
		// Breakpoints set in the other phase only: nothing to show here.
		if (!stops.length && !this.state.breakpoints?.[phase].length) {
			return;
		}
		this.tabBody.classList.add('with-breaks');
		const host = append(this.tabBody, $('.volt-http-breaks-host'));
		this.breaksPanel = this.tabStore.add(this.instantiationService.createInstance(HttpBreaksPanel, host, stops, {
			selected: this.state.breakStop,
			onSelect: (stop, index) => {
				this.state.breakStop = index;
				marks.showStop(stop.line);
			},
			onClose: () => {
				this.state.breaksClosed = true;
				marks.showStop(undefined);
				this.renderTabBody();
			},
		}));
		this.tabStore.add(toDisposable(() => this.breaksPanel = undefined));
	}

	/** "Run All Tests" above the first line and "Run Test" above each test with a literal name, as the .http editor has "Send Request". */
	private addTestLenses(editor: CodeEditorWidget): void {
		const model = editor.getModel();
		if (!model) {
			return;
		}
		const token = String(++scriptTestRunnerSeq);
		scriptTestRunners.set(token, name => void this.runTests(name === undefined ? undefined : [name]));
		this.tabStore.add(toDisposable(() => scriptTestRunners.delete(token)));
		this.tabStore.add(this.languageFeaturesService.codeLensProvider.register({ scheme: model.uri.scheme, language: model.getLanguageId() }, {
			provideCodeLenses: candidate => {
				// The selector matches every script editor open: only this one's model gets these links.
				if (candidate !== model) {
					return undefined;
				}
				const sites = httpScriptTestSites(model.getValue());
				const lenses: CodeLens[] = [];
				const at = (line: number) => ({ startLineNumber: line, startColumn: 1, endLineNumber: line, endColumn: 1 });
				if (sites.length) {
					lenses.push({ range: at(1), command: { id: RUN_SCRIPT_TESTS_COMMAND_ID, title: `$(run-all) ${localize('voltHttp.runAllTests', "Run All Tests")}`, arguments: [token] } });
				}
				for (const site of sites) {
					lenses.push({ range: at(site.line), command: { id: RUN_SCRIPT_TESTS_COMMAND_ID, title: `$(play) ${localize('voltHttp.runTest', "Run Test")}`, tooltip: localize('voltHttp.runTestTitle', "Run \"{0}\" on the response in hand", site.name), arguments: [token, site.name] } });
				}
				return { lenses, dispose: () => { } };
			},
		}));
	}

	/**
	 * Runs the post-response tests on the response in hand, without sending again: all of them, or
	 * only the named ones (the other results stay). With no response yet, the request is sent, which
	 * runs every test.
	 */
	private async runTests(only: readonly string[] | undefined): Promise<void> {
		const request = this.request;
		if (!request) {
			return;
		}
		const exchange = this.state.exchange;
		if (!exchange?.response) {
			// Nothing to run them on yet: the request is sent, and of its tests only the asked ones run.
			await this.send(only);
			if (this.state.exchange?.response && !this._store.isDisposed) {
				this.state.ranTests = only ?? [];
				this.state.ranOnly = only?.length === 1 ? only[0] : undefined;
				this.state.responseTab = 'tests';
				this.renderResponse();
			}
			return;
		}
		try {
			this.state.exchange = await this.collections.retest(request, this.context, exchange, only);
		} catch (err) {
			this.notificationService.error(err instanceof Error ? err.message : String(err));
			return;
		}
		if (this._store.isDisposed) {
			return;
		}
		this.state.ranTests = only ?? (this.state.exchange.tests ?? []).map(test => test.name);
		this.state.ranOnly = only?.length === 1 ? only[0] : undefined;
		this.state.responseTab = 'tests';
		this.renderResponse();
	}

	private createCodeEditor(host: HTMLElement, value: string, language: string, readOnly: boolean, store: DisposableStore): CodeEditorWidget {
		const editor = store.add(this.instantiationService.createInstance(CodeEditorWidget, host, { ...CODE_EDITOR_OPTIONS, readOnly, domReadOnly: readOnly }, { isSimpleWidget: false }));
		const languageId = this.languageService.isRegisteredLanguageId(language) ? language : 'plaintext';
		editor.setModel(store.add(this.modelService.createModel(value, this.languageService.createById(languageId), undefined)));
		this.codeEditors.add(editor);
		store.add(toDisposable(() => this.codeEditors.delete(editor)));
		return editor;
	}

	// --- Sending -----------------------------------------------------------------------------------

	private cancelSend(): void {
		const pending = this.state.sending;
		if (!pending) {
			return;
		}
		pending.cancel();
		pending.dispose();
		this.state.sending = undefined;
		this.sendLabel?.(false);
		this.renderResponse();
	}

	/** A connection for the tab: made when there is none, left alone when there is. */
	private async ensureConnected(): Promise<boolean> {
		const session = this.sessions.sessionOf(this.key);
		if (session?.status === 'open') {
			return true;
		}
		if (session?.status !== 'connecting') {
			await this.connect();
		}
		// The connection opens (or fails) in its own time: wait for it, not for ever.
		return new Promise<boolean>(resolve => {
			const done = (result: boolean) => {
				listener.dispose();
				clearTimeout(timer);
				resolve(result);
			};
			const check = () => {
				const status = this.sessions.sessionOf(this.key)?.status;
				if (status === 'open') {
					done(true);
				} else if (status !== 'connecting') {
					done(false);
				}
			};
			const listener = this.sessions.onDidChange(changed => changed === this.key && check());
			const timer = setTimeout(() => done(false), 20_000);
			check();
		});
	}

	private async connect(): Promise<void> {
		const request = this.request;
		if (!request) {
			return;
		}
		await this.sessions.connect(this.key, request, this.context);
		this.sendLabel?.(false);
	}

	/** Sends the request. With `onlyTests`, of its post-response tests only those run. */
	async send(onlyTests?: readonly string[]): Promise<void> {
		const request = this.request;
		if (!request || !request.url.trim()) {
			this.urlField?.input.focus();
			return;
		}
		if (httpProtocolInfo(request.protocol).stream) {
			// A connection's button connects, and disconnects what it connected.
			const session = this.sessions.sessionOf(this.key);
			if (session && session.status !== 'closed') {
				this.sessions.disconnect(this.key);
			} else {
				await this.connect();
			}
			return;
		}
		this.state.sending?.cancel();
		const cancel = new CancellationTokenSource();
		this.state.sending = cancel;
		this.sentAt = Date.now();
		this.sendLabel?.(true);
		this.renderResponse();
		try {
			const exchange = await this.collections.send(request, { ...this.context, token: cancel.token, ...(onlyTests ? { onlyTests } : {}) });
			// A cancelled send that settles after a newer one started does not replace its response.
			if (this.state.sending === cancel) {
				this.state.exchange = exchange;
				this.state.responseLanguage = undefined;
				this.state.generating = false;
				this.state.ranOnly = undefined;
				this.state.testDetail = undefined;
				this.state.breakStop = undefined;
				this.state.breaksClosed = undefined;
				// The Scripts tab in front shows this run's stops under its editor.
				if (exchange.breaks && this.activeTab() === 'scripts') {
					this.renderTabBody();
				}
				if (exchange.tests?.some(test => !test.passed && !test.skipped) || exchange.scriptError) {
					this.state.responseTab = 'tests';
				} else if (request.protocol === 'ai' && exchange.response && httpAiAnswerOf(exchange.response.body)) {
					this.state.responseTab = 'answer';
				} else if (this.state.responseTab === 'answer' || (this.state.responseTab === 'tests' && !exchange.tests?.length && !exchange.logs?.length)) {
					this.state.responseTab = 'body';
				}
			}
		} finally {
			if (this.state.sending === cancel) {
				this.state.sending = undefined;
				cancel.dispose();
				if (!this._store.isDisposed) {
					this.sendLabel?.(false);
					this.renderResponse();
				}
			}
		}
	}

	/** Shows an exchange that was sent elsewhere (a history entry, an agent's send). */
	showExchange(exchange: IHttpExchange): void {
		this.state.exchange = exchange;
		this.state.responseLanguage = undefined;
		this.renderResponse();
	}

	// --- Response ----------------------------------------------------------------------------------

	private renderResponse(): void {
		this.responseStore.clear();
		this.testList = undefined;
		this.streamPane = undefined;
		clearNode(this.responseEl);
		const protocol = this.protocol;
		if (httpProtocolInfo(protocol).stream) {
			// A connection's response is its timeline.
			this.streamPane = this.responseStore.add(this.instantiationService.createInstance(HttpStreamPane, this.responseEl, this.key, protocol, {
				createEditor: (host, value, language, readOnly, store) => this.createCodeEditor(host, value, language, readOnly, store),
				layoutEditors: () => this.layoutEditors(),
			}));
			this.streamPane.layout(this.width);
			return;
		}
		const bar = append(this.responseEl, $('.volt-http-res-bar'));
		const exchange = this.state.sending ? undefined : this.state.exchange;
		const response = exchange?.response;
		if (!response) {
			append(bar, $('span.volt-http-res-title')).textContent = localize('voltHttp.response', "Response");
			if (this.state.sending) {
				// As in Postman: a line runs across the top of the response while the request is out.
				append(append(this.responseEl, $('.volt-http-progress')), $('.volt-http-progress-bar'));
				const waiting = append(this.responseEl, $('.volt-http-waiting'));
				// allow-any-unicode-next-line
				append(waiting, $('.volt-http-waiting-title')).textContent = localize('voltHttp.sending', "Sending request…");
				const elapsed = append(waiting, $('.volt-http-waiting-time'));
				const tick = () => elapsed.textContent = formatHttpDuration(Date.now() - this.sentAt);
				tick();
				const targetWindow = getWindow(this.element);
				const timer = targetWindow.setInterval(tick, 100);
				this.responseStore.add(toDisposable(() => targetWindow.clearInterval(timer)));
				const cancel = append(waiting, $('button.volt-http-link')) as HTMLButtonElement;
				cancel.type = 'button';
				cancel.textContent = localize('voltHttp.cancel', "Cancel");
				cancel.addEventListener('click', () => this.cancelSend());
				return;
			}
			if (exchange) {
				append(append(bar, $('.volt-http-res-meta')), $('span.volt-http-pill.error')).textContent = localize('voltHttp.failed', "Failed");
				const error = append(this.responseEl, $('.volt-http-error'));
				append(error, $('.volt-http-error-title')).textContent = localize('voltHttp.couldNotSend', "Could not get a response");
				append(error, $('.volt-http-error-text')).textContent = [exchange.error, exchange.scriptError].filter(Boolean).join('\n');
				return;
			}
			const empty = append(this.responseEl, $('.volt-http-empty.response'));
			empty.appendChild(createHttpRequestIcon(32));
			append(empty, $('span')).textContent = localize('voltHttp.hint', "Enter a URL and press Send to get a response");
			return;
		}

		// Each Set-Cookie line as the server sent it (a joined header cannot be split back reliably).
		const cookies = httpResponseCookies(response);
		const tests = exchange.tests ?? [];
		const failed = tests.filter(test => !test.passed && !test.skipped).length;
		const answer = protocol === 'ai' ? httpAiAnswerOf(response.body) : undefined;
		if (this.state.responseTab === 'answer' && !answer) {
			this.state.responseTab = 'body';
		}
		const tabs = append(bar, $('.volt-http-res-tabs'));
		renderHttpTabs<HttpResponseTab>(tabs, [
			...(answer ? [{ id: 'answer' as const, label: localize('voltHttp.resAnswer', "Answer") }] : []),
			{ id: 'body', label: localize('voltHttp.resBody', "Body") },
			{ id: 'cookies', label: localize('voltHttp.resCookies', "Cookies"), count: cookies.length || undefined },
			{ id: 'headers', label: localize('voltHttp.resHeaders', "Headers"), count: Object.keys(response.headers).length },
			{ id: 'tests', label: localize('voltHttp.resTests', "Test Results"), ...(tests.length || exchange.scriptError ? { badge: { text: exchange.scriptError && !tests.length ? '!' : `${tests.length - failed}/${tests.length}`, kind: failed || exchange.scriptError ? 'error' as const : 'ok' as const } } : {}) },
		], this.state.responseTab, id => {
			this.state.responseTab = id;
			this.renderResponse();
		});
		const meta = append(bar, $('.volt-http-res-meta'));
		const pill = append(meta, $('span.volt-http-pill'));
		pill.classList.add(httpStatusClass(response.status));
		pill.textContent = `${response.status} ${response.statusText}`.trim();
		append(meta, $('span.volt-http-meta-dot'));
		const time = append(meta, $('span.volt-http-metric'));
		time.textContent = formatHttpDuration(response.durationMs);
		setAgentTooltip(time, localize('voltHttp.time', "Time"));
		append(meta, $('span.volt-http-meta-dot'));
		const size = append(meta, $('span.volt-http-metric'));
		size.textContent = formatHttpBytes(response.size);
		setAgentTooltip(size, localize('voltHttp.size', "Size"));

		switch (this.state.responseTab) {
			case 'answer': {
				if (!answer) {
					break;
				}
				const facts = [answer.model, answer.inputTokens !== undefined ? localize('voltHttp.aiTokensIn', "{0} tokens in", answer.inputTokens) : undefined, answer.outputTokens !== undefined ? localize('voltHttp.aiTokensOut', "{0} out", answer.outputTokens) : undefined, answer.stop].filter(Boolean).join('  \u00b7  ');
				const tools = append(this.responseEl, $('.volt-http-res-tools'));
				append(tools, $('span.volt-http-sublabel.inline')).textContent = facts;
				append(tools, $('.volt-http-spacer'));
				createHttpIconButton(tools, () => createHttpCopyIcon(15), localize('voltHttp.copyAnswer', "Copy answer"), () => void this.clipboardService.writeText(answer.text));
				const editor = this.createCodeEditor(append(this.responseEl, $('.volt-http-code.response')), answer.text, 'markdown', true, this.responseStore);
				editor.updateOptions({ wordWrap: 'on', lineNumbers: 'off', folding: false });
				this.layoutEditors();
				return;
			}
			case 'headers':
				renderHttpReadOnlyTable(append(this.responseEl, $('.volt-http-res-scroll')), [localize('voltHttp.key', "Key"), localize('voltHttp.value', "Value")], Object.entries(response.headers));
				return;
			case 'cookies':
				if (!cookies.length) {
					append(this.responseEl, $('.volt-http-empty.center')).textContent = localize('voltHttp.noCookies', "The response set no cookies");
					return;
				}
				renderHttpReadOnlyTable(append(this.responseEl, $('.volt-http-res-scroll')), [localize('voltHttp.cookieName', "Name"), localize('voltHttp.value', "Value"), localize('voltHttp.cookieAttributes', "Attributes")], cookies.map(cookie => [cookie.name, cookie.value, cookie.attributes]));
				return;
			case 'tests':
				this.renderTests(exchange);
				return;
		}

		const type = Object.entries(response.headers).find(([key]) => key.toLowerCase() === 'content-type')?.[1] ?? '';
		const detected = detectHttpBodyLanguage(type, response.body);
		const language: ResponseLanguage = this.state.pretty ? this.state.responseLanguage ?? detected : 'plaintext';
		// Pretty puts a minified body back on indented lines; Raw shows the bytes as they came.
		const text = this.state.pretty ? prettyHttpBody(response.body, language) : response.body;
		const tools = append(this.responseEl, $('.volt-http-res-tools'));
		createHttpDropdown<'pretty' | 'raw'>(append(tools, $('.volt-http-res-format')), this.contextViewService, {
			options: [{ id: 'pretty', label: localize('voltHttp.pretty', "Pretty"), description: localize('voltHttp.prettyDesc', "Formatted and coloured") }, { id: 'raw', label: localize('voltHttp.rawView', "Raw"), description: localize('voltHttp.rawDesc', "Exactly as received") }],
			value: this.state.pretty ? 'pretty' : 'raw',
			ariaLabel: localize('voltHttp.resView', "Response view"),
			width: 220,
			align: 'left',
			onChange: value => {
				this.state.pretty = value === 'pretty';
				this.renderResponse();
			},
		}, this.responseStore);
		if (this.state.pretty) {
			const formats: { id: ResponseLanguage; label: string }[] = [{ id: 'json', label: 'JSON' }, { id: 'xml', label: 'XML' }, { id: 'html', label: 'HTML' }, { id: 'javascript', label: 'JavaScript' }, { id: 'css', label: 'CSS' }, { id: 'plaintext', label: localize('voltHttp.resText', "Text") }];
			createHttpDropdown<ResponseLanguage>(append(tools, $('.volt-http-res-format')), this.contextViewService, {
				options: formats,
				value: language,
				ariaLabel: localize('voltHttp.resFormat', "Response format"),
				width: 180,
				align: 'left',
				onChange: value => {
					this.state.responseLanguage = value;
					this.renderResponse();
				},
			}, this.responseStore);
		}
		append(tools, $('.volt-http-spacer'));
		const editor = this.createCodeEditor(append(this.responseEl, $('.volt-http-code.response')), text, language, true, this.responseStore);
		editor.updateOptions({ wordWrap: this.state.wrap ? 'on' : 'off' });
		const wrap = createHttpIconButton(tools, Codicon.wordWrap, localize('voltHttp.wrap', "Wrap lines"), button => {
			this.state.wrap = !this.state.wrap;
			editor.updateOptions({ wordWrap: this.state.wrap ? 'on' : 'off' });
			button.classList.toggle('checked', this.state.wrap);
			button.setAttribute('aria-pressed', String(this.state.wrap));
		});
		wrap.classList.toggle('checked', this.state.wrap);
		wrap.setAttribute('aria-pressed', String(this.state.wrap));
		createHttpIconButton(tools, () => createHttpSearchIcon(15), localize('voltHttp.find', "Find in response"), () => {
			editor.focus();
			void editor.getAction('actions.find')?.run();
		});
		createHttpIconButton(tools, () => createHttpCopyIcon(15), localize('voltHttp.copy', "Copy response"), () => void this.clipboardService.writeText(editor.getValue()));
		createHttpIconButton(tools, Codicon.desktopDownload, localize('voltHttp.saveResponse', "Save response to a file"), () => void this.saveResponse(response.body, detected));
		this.layoutEditors();
	}

	private async saveResponse(body: string, language: ResponseLanguage): Promise<void> {
		const extension = language === 'plaintext' ? 'txt' : language === 'javascript' ? 'js' : language;
		const base = this.host.root ?? await this.fileDialogService.defaultFilePath();
		const target = await this.fileDialogService.showSaveDialog({ title: localize('voltHttp.saveResponse', "Save response to a file"), defaultUri: URI.joinPath(base, `response.${extension}`) });
		if (target) {
			await this.fileService.writeFile(target, VSBuffer.fromString(body));
		}
	}

	private renderTests(exchange: IHttpExchange): void {
		const tests = exchange.tests ?? [];
		const wrap = append(this.responseEl, $('.volt-http-tests'));
		if (exchange.scriptError) {
			const error = append(wrap, $('.volt-http-script-error'));
			error.appendChild(renderIcon(Codicon.error));
			append(error, $('span')).textContent = exchange.scriptError;
		}
		// A request that has tests but no results (they were cleared, or never ran on this response) keeps the head with Run All.
		const hasScript = !!this.request?.scripts.test.trim();
		const none = !tests.length && !exchange.scriptError && !exchange.logs?.length && !hasScript;
		const generator = (compact: boolean) => this.responseStore.add(this.instantiationService.createInstance(HttpTestGenerator, wrap, {
			context: () => {
				const spec = this.wireSpec();
				const current = this.state.exchange;
				return spec && current?.response ? { spec, exchange: current, existing: this.request?.scripts.test ?? '' } : undefined;
			},
			apply: script => this.applyGeneratedTests(script),
		}, compact));
		if (none) {
			// Nothing ran: offer to have the tests written, and say where they go by hand.
			generator(false);
			append(wrap, $('.volt-http-tests-note')).textContent = localize('voltHttp.noTests', "Or write them yourself: add pm.test(...) under Scripts, Post-response.");
			return;
		}
		const head = append(wrap, $('.volt-http-tests-head'));
		const passed = tests.filter(test => test.passed).length;
		append(head, $('span.volt-http-sublabel.inline')).textContent = tests.length ? localize('voltHttp.testsSummary', "{0} of {1} passed", passed, tests.length) : hasScript && !exchange.scriptError ? localize('voltHttp.testsNoResults', "No results. Run the tests to see them here.") : '';
		const only = this.state.ranOnly && tests.find(test => test.name === this.state.ranOnly);
		if (only) {
			// One test was run on its own: say which, so the other rows are not read as fresh results.
			const note = append(head, $('span.volt-http-tests-ran'));
			note.classList.add(only.passed ? 'pass' : 'fail');
			note.textContent = only.passed ? localize('voltHttp.ranOnlyPassed', "Ran only \"{0}\": passed", only.name) : localize('voltHttp.ranOnlyFailed', "Ran only \"{0}\": failed", only.name);
			setAgentTooltip(note, note.textContent);
		}
		append(head, $('.volt-http-spacer'));
		if (tests.length || hasScript) {
			const runAll = append(head, $('button.volt-http-link.volt-http-run-link')) as HTMLButtonElement;
			runAll.type = 'button';
			runAll.appendChild(renderIcon(Codicon.runAll));
			append(runAll, $('span')).textContent = localize('voltHttp.runAll', "Run All");
			setAgentTooltip(runAll, localize('voltHttp.runAllTitle', "Run every test again on this response, without sending"));
			runAll.addEventListener('click', () => void this.runTests(undefined));
		}
		if (tests.length || exchange.scriptError || exchange.logs?.length) {
			const clear = append(head, $('button.volt-http-link.volt-http-run-link')) as HTMLButtonElement;
			clear.type = 'button';
			clear.appendChild(renderIcon(Codicon.clearAll));
			append(clear, $('span')).textContent = localize('voltHttp.clearResults', "Clear");
			setAgentTooltip(clear, localize('voltHttp.clearResultsTitle', "Clear the test results and console output; the response and the tests themselves stay"));
			clear.addEventListener('click', () => this.clearTestResults());
		}
		const more = append(head, $('button.volt-http-link')) as HTMLButtonElement;
		more.type = 'button';
		more.textContent = this.state.generating ? localize('voltHttp.aiHide', "Hide Generator") : localize('voltHttp.aiMore', "Generate More Tests");
		more.addEventListener('click', () => {
			this.state.generating = !this.state.generating;
			this.renderResponse();
		});
		if (this.state.generating) {
			generator(true);
		}
		if (tests.length) {
			const host = append(wrap, $('.volt-http-test-list'));
			// The rows a play button or an editor link just ran are marked once, then the mark is spent.
			const ran = new Set(this.state.ranTests ?? []);
			this.state.ranTests = undefined;
			const renderer: IListRenderer<IHttpExchangeTest, { badge: HTMLElement; name: HTMLElement; error: HTMLElement; row: HTMLElement; run: HTMLButtonElement; test?: IHttpExchangeTest }> = {
				templateId: 'test',
				renderTemplate: container => {
					const row = append(container, $('.volt-http-test-row'));
					const template: { badge: HTMLElement; name: HTMLElement; error: HTMLElement; row: HTMLElement; run: HTMLButtonElement; test?: IHttpExchangeTest } = {
						row,
						badge: append(row, $('span.volt-http-test-badge')),
						name: append(row, $('span.volt-http-test-name')),
						error: append(row, $('span.volt-http-test-error')),
						run: createHttpIconButton(row, Codicon.play, localize('voltHttp.runTest', "Run Test"), () => template.test && void this.runTests([template.test.name])),
					};
					template.run.classList.add('volt-http-test-run');
					// The button's press must not also select the row under it.
					template.run.addEventListener('mousedown', event => event.stopPropagation());
					return template;
				},
				renderElement: (test, _index, template) => {
					template.test = test;
					setAgentTooltip(template.run, localize('voltHttp.runTestTitle', "Run \"{0}\" on the response in hand", test.name));
					template.row.classList.toggle('ran', ran.has(test.name));
					const kind = test.skipped ? 'skip' : test.passed ? 'pass' : 'fail';
					template.badge.className = `volt-http-test-badge ${kind}`;
					template.badge.textContent = test.skipped ? localize('voltHttp.testSkipped', "SKIP") : test.passed ? localize('voltHttp.testPassed', "PASS") : localize('voltHttp.testFailed', "FAIL");
					template.name.textContent = test.name;
					template.error.textContent = test.error ?? '';
					setAgentTooltip(template.row, test.error ? `${test.name}\n${test.error}` : test.name);
				},
				disposeTemplate: () => { },
			};
			const list = this.testList = this.responseStore.add(this.instantiationService.createInstance(WorkbenchList<IHttpExchangeTest>, 'VoltHttpTests', host, { getHeight: () => TEST_ROW_HEIGHT, getTemplateId: () => 'test' }, [renderer], {
				accessibilityProvider: { getAriaLabel: test => `${test.passed ? 'passed' : 'failed'} ${test.name} ${test.error ?? ''}`, getWidgetAriaLabel: () => localize('voltHttp.resTests', "Test Results") },
				multipleSelectionSupport: false,
			}));
			host.style.height = `${tests.length * TEST_ROW_HEIGHT}px`;
			list.layout(tests.length * TEST_ROW_HEIGHT, Math.max(100, this.width));
			list.splice(0, 0, [...tests]);
			// A click (or Enter) on a row opens what that test did under the list; again on it closes it.
			this.responseStore.add(list.onDidOpen(event => {
				const test = event.element;
				if (!test) {
					return;
				}
				this.state.testDetail = this.state.testDetail === test.name ? undefined : test.name;
				this.renderResponse();
			}));
			const open = this.state.testDetail !== undefined ? tests.findIndex(test => test.name === this.state.testDetail) : -1;
			if (open >= 0) {
				list.setSelection([open]);
				this.renderTestDetail(wrap, tests[open], exchange);
			}
		}
		if (exchange.logs?.length) {
			append(wrap, $('.volt-http-sublabel')).textContent = localize('voltHttp.console', "Console");
			const logs = append(wrap, $('.volt-http-console'));
			for (const log of exchange.logs) {
				const line = append(logs, $('.volt-http-console-line'));
				line.classList.add(log.level);
				line.textContent = log.text;
			}
		}
	}

	/** One test's detail under Test Results: its assertions, Expected and Actual, its console lines, and a way to its line. */
	private renderTestDetail(wrap: HTMLElement, test: IHttpExchangeTest, exchange: IHttpExchange): void {
		const script = this.request?.scripts.test ?? '';
		const line = test.errorLine ?? httpScriptTestSites(script).find(site => site.name === test.name)?.line;
		const host = append(wrap, $('.volt-http-test-detail-host'));
		const detail = this.responseStore.add(this.instantiationService.createInstance(HttpTestDetail, host, test, {
			...(line !== undefined ? { line } : {}),
			...(exchange.logs ? { logs: exchange.logs } : {}),
			onReveal: target => this.revealScriptLine('test', target),
			onRun: () => void this.runTests([test.name]),
			onAddToChat: text => this.host.addToChat(test.name, text),
			onClose: () => {
				this.state.testDetail = undefined;
				this.renderResponse();
			},
		}));
		this.responseStore.add(toDisposable(() => host.remove()));
		detail.element.scrollIntoView({ block: 'nearest' });
	}

	/** Opens Scripts at a phase and puts the caret on a line of it. */
	private revealScriptLine(phase: 'preRequest' | 'test', line: number): void {
		this.state.requestTab = 'scripts';
		this.state.scriptTab = phase;
		this.renderTabs();
		const editor = [...this.codeEditors].find(candidate => candidate.getModel()?.getLanguageId() === 'javascript');
		if (editor) {
			editor.revealLineInCenter(line);
			editor.setPosition({ lineNumber: line, column: 1 });
			editor.focus();
		}
	}

	/** Empties Test Results (results, console, script error). The response stays, so the tests can run on it again. */
	private clearTestResults(): void {
		const exchange = this.state.exchange;
		if (!exchange) {
			return;
		}
		const { tests: _tests, logs: _logs, scriptError: _scriptError, ...rest } = exchange;
		this.state.exchange = rest;
		this.state.ranTests = undefined;
		this.state.ranOnly = undefined;
		this.renderResponse();
	}

	/** Tests a model wrote: added under the ones the request has, then run on the response in hand. */
	private async applyGeneratedTests(script: string): Promise<void> {
		const request = this.request;
		const exchange = this.state.exchange;
		if (!request || !exchange) {
			return;
		}
		this.change(next => next.scripts.test = appendHttpTestScript(next.scripts.test, script));
		const current = this.request ?? request;
		try {
			this.state.exchange = await this.collections.retest(current, this.context, exchange);
		} catch (err) {
			this.notificationService.error(err instanceof Error ? err.message : String(err));
		}
		this.state.generating = false;
		this.state.responseTab = 'tests';
		this.renderTabs();
		this.renderResponse();
	}

	// --- Layout ------------------------------------------------------------------------------------

	layout(width: number, height: number): void {
		this.width = width;
		this.height = height;
		this.element.style.height = `${height}px`;
		this.layoutSplit();
	}

	private splitSpace(): number {
		return this.height ? this.height - this.requestEl.offsetTop - 1 : 0;
	}

	private layoutSplit(): void {
		const space = this.splitSpace();
		if (space > 0) {
			const min = Math.min(MIN_PANE_HEIGHT, space / 2);
			this.requestEl.style.height = `${Math.round(Math.min(Math.max(space * this.host.requestRatio, min), space - min))}px`;
		}
		this.layoutEditors();
		this.sash.layout();
		if (this.testList && this.width) {
			this.testList.layout(undefined, this.width);
		}
		this.streamPane?.layout(this.width);
		this.composer?.layout(this.width);
	}

	private layoutEditors(): void {
		if (!this.height) {
			return;
		}
		for (const editor of this.codeEditors) {
			const host = editor.getContainerDomNode();
			editor.layout({ width: host.clientWidth, height: host.clientHeight });
		}
		this.docsEditor?.layout(this.tabBody.clientWidth, this.tabBody.clientHeight);
		if (this.breaksPanel) {
			const host = this.breaksPanel.element.parentElement;
			this.breaksPanel.layout(host?.clientWidth ?? this.width, host?.clientHeight ?? BREAKS_PANEL_HEIGHT);
		}
	}

	focus(): void {
		const request = this.request;
		if (request && !request.url) {
			this.urlField?.input.focus();
		} else {
			this.nameInput?.blur();
			this.element.focus();
		}
	}
}

/** The cookies a response sets (`set-cookie` headers, joined by the transport with ", "). */
export function httpCookiesOf(headers: Readonly<Record<string, string>>): { name: string; value: string; attributes: string }[] {
	const raw = Object.entries(headers).filter(([key]) => key.toLowerCase() === 'set-cookie').map(([, value]) => value).join(', ');
	if (!raw) {
		return [];
	}
	// A comma also sits inside `Expires=Wed, 21 Oct ...`: split only where a new `name=` starts.
	return raw.split(/,\s*(?=[^;,=\s]+=)/).map(cookie => {
		const [pair, ...attributes] = cookie.split(';');
		const at = pair.indexOf('=');
		return { name: (at < 0 ? pair : pair.slice(0, at)).trim(), value: at < 0 ? '' : pair.slice(at + 1).trim(), attributes: attributes.map(item => item.trim()).filter(Boolean).join('; ') };
	}).filter(cookie => cookie.name);
}
