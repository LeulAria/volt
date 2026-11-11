/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/voltHttp.css';
import { $, addDisposableListener, append, clearNode, Dimension, EventType } from '../../../../base/browser/dom.js';
import { IInputBoxStyles, InputBox } from '../../../../base/browser/ui/inputbox/inputBox.js';
import { renderIcon } from '../../../../base/browser/ui/iconLabel/iconLabels.js';
import { Orientation, Sash } from '../../../../base/browser/ui/sash/sash.js';
import { Checkbox } from '../../../../base/browser/ui/toggle/toggle.js';
import { CancellationToken, CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Emitter } from '../../../../base/common/event.js';
import { DisposableStore, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { basename } from '../../../../base/common/resources.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { CodeEditorWidget } from '../../../../editor/browser/widget/codeEditor/codeEditorWidget.js';
import { IEditorOptions as ICodeEditorOptions } from '../../../../editor/common/config/editorOptions.js';
import { ITextModel } from '../../../../editor/common/model.js';
import { ILanguageService } from '../../../../editor/common/languages/language.js';
import { IModelService } from '../../../../editor/common/services/model.js';
import { localize } from '../../../../nls.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { IContextViewService } from '../../../../platform/contextview/browser/contextView.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { defaultCheckboxStyles, defaultInputBoxStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { EditorPane } from '../../../browser/parts/editor/editorPane.js';
import { IEditorOpenContext, IEditorSerializer, IUntypedEditorInput } from '../../../common/editor.js';
import { EditorInput } from '../../../common/editor/editorInput.js';
import { IEditorGroup } from '../../../services/editor/common/editorGroupsService.js';
import { HTTP_METHODS, IHttpRequestSpec } from '../../../services/voltRuntime/common/ide/httpFile.js';
import { createVoltButton } from '../../voltAgent/browser/chrome/voltButton.js';
import { createVoltDropdown } from '../../voltAgent/browser/ui/dropdown/voltDropdown.js';
import { showVoltMenu } from '../../voltAgent/browser/ui/menu/voltMenu.js';
import { IHttpExchange, IVoltHttpService } from './voltHttpService.js';

export const VOLT_HTTP_EDITOR_ID = 'workbench.editor.voltHttpRequest';
export const VOLT_HTTP_INPUT_ID = 'workbench.input.voltHttpRequest';

type BodyMode = 'none' | 'json' | 'text' | 'xml' | 'form' | 'graphql';
type AuthMode = 'none' | 'bearer' | 'basic' | 'apikey';
type RequestTab = 'params' | 'headers' | 'body' | 'auth';
type ResponseTab = 'body' | 'headers' | 'raw';
type ResponseLanguage = 'json' | 'xml' | 'html' | 'javascript' | 'css' | 'plaintext';

interface IKeyValue {
	key: string;
	value: string;
	enabled: boolean;
}

/** What the request editor edits; compiled into an `.http` request on send and save. */
export interface IHttpDraft {
	name: string;
	method: string;
	url: string;
	headers: IKeyValue[];
	bodyMode: BodyMode;
	body: string;
	form: IKeyValue[];
	graphqlVariables: string;
	auth: { mode: AuthMode; token: string; user: string; password: string; keyName: string; keyValue: string; keyIn: 'header' | 'query' };
}

function emptyDraft(): IHttpDraft {
	return { name: '', method: 'GET', url: '', headers: [], bodyMode: 'none', body: '', form: [], graphqlVariables: '', auth: { mode: 'none', token: '', user: '', password: '', keyName: 'X-API-Key', keyValue: '', keyIn: 'header' } };
}

/** An `.http` request opened for editing: body mode and auth are read back from its headers. */
export function draftFromSpec(spec: IHttpRequestSpec): IHttpDraft {
	const draft = emptyDraft();
	draft.name = spec.name ?? '';
	draft.method = spec.method;
	draft.url = spec.url;
	const type = spec.headers.find(([key]) => key.toLowerCase() === 'content-type')?.[1] ?? '';
	for (const [key, value] of spec.headers) {
		const lower = key.toLowerCase();
		if (lower === 'authorization' && /^bearer\s+/i.test(value)) {
			draft.auth = { ...draft.auth, mode: 'bearer', token: value.replace(/^bearer\s+/i, '') };
		} else if (lower === 'authorization' && /^basic\s+/i.test(value)) {
			const [user, password] = value.replace(/^basic\s+/i, '').split(/\s+|:/);
			draft.auth = { ...draft.auth, mode: 'basic', user: user ?? '', password: password ?? '' };
		} else if (lower !== 'content-type' || !spec.body) {
			draft.headers.push({ key, value, enabled: true });
		}
	}
	if (spec.body) {
		if (/graphql/i.test(type) || spec.headers.some(([key, value]) => key.toLowerCase() === 'x-request-type' && value === 'GraphQL')) {
			draft.bodyMode = 'graphql';
			const [query, variables] = spec.body.split(/\n\s*\n(?=\s*\{)/);
			draft.body = query;
			draft.graphqlVariables = variables ?? '';
		} else if (/x-www-form-urlencoded/.test(type)) {
			draft.bodyMode = 'form';
			draft.form = spec.body.split('&').filter(Boolean).map(pair => {
				const [key, value] = pair.split('=');
				return { key: decodeURIComponent(key ?? ''), value: decodeURIComponent(value ?? ''), enabled: true };
			});
		} else {
			draft.bodyMode = /json/.test(type) || /^\s*[[{]/.test(spec.body) ? 'json' : /xml/.test(type) ? 'xml' : 'text';
			draft.body = spec.body;
		}
	}
	return draft;
}

export function specFromDraft(draft: IHttpDraft, line = 0): IHttpRequestSpec {
	const headers: [string, string][] = draft.headers.filter(item => item.enabled && item.key.trim()).map(item => [item.key.trim(), item.value]);
	let url = draft.url.trim();
	switch (draft.auth.mode) {
		case 'bearer': headers.push(['Authorization', `Bearer ${draft.auth.token}`]); break;
		case 'basic': headers.push(['Authorization', `Basic ${draft.auth.user}:${draft.auth.password}`]); break;
		case 'apikey':
			if (draft.auth.keyIn === 'header') {
				headers.push([draft.auth.keyName, draft.auth.keyValue]);
			} else {
				url += `${url.includes('?') ? '&' : '?'}${encodeURIComponent(draft.auth.keyName)}=${encodeURIComponent(draft.auth.keyValue)}`;
			}
			break;
	}
	const hasType = headers.some(([key]) => key.toLowerCase() === 'content-type');
	let body: string | undefined;
	switch (draft.bodyMode) {
		case 'json': body = draft.body; if (!hasType) { headers.push(['Content-Type', 'application/json']); } break;
		case 'xml': body = draft.body; if (!hasType) { headers.push(['Content-Type', 'application/xml']); } break;
		case 'text': body = draft.body; if (!hasType) { headers.push(['Content-Type', 'text/plain']); } break;
		case 'form':
			body = draft.form.filter(item => item.enabled && item.key.trim()).map(item => `${encodeURIComponent(item.key.trim())}=${encodeURIComponent(item.value)}`).join('&');
			if (!hasType) { headers.push(['Content-Type', 'application/x-www-form-urlencoded']); }
			break;
		case 'graphql':
			headers.push(['X-Request-Type', 'GraphQL']);
			if (!hasType) { headers.push(['Content-Type', 'application/json']); }
			body = draft.graphqlVariables.trim() ? `${draft.body.trim()}\n\n${draft.graphqlVariables.trim()}` : draft.body;
			break;
	}
	return { ...(draft.name.trim() ? { name: draft.name.trim().replace(/\s+/g, '-') } : {}), method: draft.method, url, headers, ...(body !== undefined && body !== '' ? { body } : {}), line };
}

/** GraphQL bodies are sent as JSON `{ query, variables }`, the way REST Client sends them. */
function wireSpec(spec: IHttpRequestSpec): IHttpRequestSpec {
	if (!spec.headers.some(([key, value]) => key === 'X-Request-Type' && value === 'GraphQL') || !spec.body) {
		return spec;
	}
	const [query, variables] = spec.body.split(/\n\s*\n(?=\s*\{)/);
	let parsed: unknown;
	try {
		parsed = variables ? JSON.parse(variables) : undefined;
	} catch {
		parsed = undefined;
	}
	return { ...spec, headers: spec.headers.filter(([key]) => key !== 'X-Request-Type'), body: JSON.stringify({ query, ...(parsed ? { variables: parsed } : {}) }) };
}

/** The request as a shell command; `{{variables}}` are left for the reader to fill in. */
export function curlFromSpec(spec: IHttpRequestSpec): string {
	const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
	const lines = [`curl${spec.method === 'GET' ? '' : ` -X ${spec.method}`} ${quote(spec.url)}`];
	for (const [key, value] of spec.headers) {
		lines.push(`-H ${quote(`${key}: ${value}`)}`);
	}
	if (spec.body) {
		lines.push(`--data-raw ${quote(spec.body)}`);
	}
	return lines.join(' \\\n  ');
}

export class VoltHttpRequestInput extends EditorInput {

	static readonly TypeID = VOLT_HTTP_INPUT_ID;

	readonly resource: URI;
	private readonly _onDidChangeDraft = this._register(new Emitter<void>());
	readonly onDidChangeDraft = this._onDidChangeDraft.event;
	/** The exchange to show when the pane opens (a history entry, or a send started by CodeLens). */
	pendingExchange: IHttpExchange | undefined;
	sendOnOpen = false;

	constructor(
		public draft: IHttpDraft,
		public source: { uri: URI; line: number } | undefined,
		id = generateUuid(),
	) {
		super();
		this.resource = URI.from({ scheme: 'volt-http', path: `/${id}` });
	}

	override get typeId(): string { return VoltHttpRequestInput.TypeID; }
	override get editorId(): string { return VOLT_HTTP_EDITOR_ID; }

	override getName(): string {
		if (this.draft.name.trim()) {
			return this.draft.name.trim();
		}
		if (!this.draft.url.trim()) {
			return localize('voltHttp.untitled', "New Request");
		}
		const path = this.draft.url.replace(/^[a-z]+:\/\/[^/]+/i, '').split('?')[0] || '/';
		return `${this.draft.method} ${path}`;
	}

	override getDescription(): string | undefined {
		return this.source ? basename(this.source.uri) : undefined;
	}

	override getIcon(): ThemeIcon {
		return Codicon.globe;
	}

	override matches(other: EditorInput | IUntypedEditorInput): boolean {
		if (other instanceof VoltHttpRequestInput) {
			return other === this || (!!this.source && !!other.source && other.source.uri.toString() === this.source.uri.toString() && other.source.line === this.source.line);
		}
		return super.matches(other);
	}

	update(draft: IHttpDraft): void {
		this.draft = draft;
		this._onDidChangeLabel.fire();
		this._onDidChangeDraft.fire();
	}

	setSource(source: { uri: URI; line: number }): void {
		this.source = source;
		this._onDidChangeLabel.fire();
	}
}

export class VoltHttpRequestInputSerializer implements IEditorSerializer {
	canSerialize(): boolean {
		return true;
	}
	serialize(input: EditorInput): string | undefined {
		return input instanceof VoltHttpRequestInput ? JSON.stringify({ draft: input.draft, source: input.source ? { uri: input.source.uri.toString(), line: input.source.line } : undefined }) : undefined;
	}
	deserialize(_instantiationService: IInstantiationService, raw: string): EditorInput | undefined {
		try {
			const data = JSON.parse(raw) as { draft: IHttpDraft; source?: { uri: string; line: number } };
			return new VoltHttpRequestInput({ ...emptyDraft(), ...data.draft }, data.source ? { uri: URI.parse(data.source.uri), line: data.source.line } : undefined);
		} catch {
			return undefined;
		}
	}
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

/** Inputs inside the URL box and the key/value tables: the cell is the field, so no fill or border. */
const FLAT_INPUT_STYLES: IInputBoxStyles = { ...defaultInputBoxStyles, inputBackground: 'transparent', inputBorder: 'transparent' };
const CHECKBOX_STYLES = { ...defaultCheckboxStyles, size: 16 };

/** The request pane's share of the space under the URL bar, and the least either pane keeps. */
const DEFAULT_REQUEST_RATIO = 0.5;
const MIN_PANE_HEIGHT = 120;

/**
 * The HTTP client's request editor, laid out like Postman: the request's file and name with the
 * environment and Save on top; the method and URL in one box beside a split Send; Params,
 * Authorization, Headers and Body tabs over bordered key/value tables (with Bulk Edit); a sash;
 * then the response (status, time, size; Body, Headers, Raw; format, wrap, find and copy). It
 * edits `.http` requests in place and saves back to the file, and its sends land in the same
 * history the agents' `ide http` capability uses.
 */
export class VoltHttpRequestEditor extends EditorPane {

	static readonly ID = VOLT_HTTP_EDITOR_ID;

	private root!: HTMLElement;
	private crumbs!: HTMLElement;
	private crumbFile!: HTMLElement;
	private nameBox!: InputBox;
	private headActions!: HTMLElement;
	private bar!: HTMLElement;
	private urlBox: InputBox | undefined;
	private requestEl!: HTMLElement;
	private tabsEl!: HTMLElement;
	private tabBody!: HTMLElement;
	private responseEl!: HTMLElement;
	private sash!: Sash;
	private requestRatio = DEFAULT_REQUEST_RATIO;
	private requestTab: RequestTab = 'params';
	private responseTab: ResponseTab = 'body';
	/** Picked in the response's format dropdown; cleared with each new response. */
	private responseLanguage: ResponseLanguage | undefined;
	private responseWrap = true;
	private bulkEdit = false;
	/** Set while the Params table writes the URL, so the URL's change does not redraw that table. */
	private syncingUrl = false;
	private readonly headStore = this._register(new DisposableStore());
	private readonly barStore = this._register(new DisposableStore());
	private readonly tabStore = this._register(new DisposableStore());
	private readonly responseStore = this._register(new DisposableStore());
	private readonly menu = this._register(new MutableDisposable());
	private readonly sending = this._register(new MutableDisposable<CancellationTokenSource>());
	private readonly codeEditors = new Set<CodeEditorWidget>();
	private exchange: IHttpExchange | undefined;
	private dimension: Dimension | undefined;
	private sendButtonEl: HTMLElement | undefined;
	private sendLabel: ((sending: boolean) => void) | undefined;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IContextViewService private readonly contextViewService: IContextViewService,
		@IModelService private readonly modelService: IModelService,
		@ILanguageService private readonly languageService: ILanguageService,
		@IClipboardService private readonly clipboardService: IClipboardService,
		@IVoltHttpService private readonly http: IVoltHttpService,
	) {
		super(VoltHttpRequestEditor.ID, group, telemetryService, themeService, storageService);
	}

	private get draft(): IHttpDraft {
		return (this.input as VoltHttpRequestInput | undefined)?.draft ?? emptyDraft();
	}

	private change(mutate: (draft: IHttpDraft) => void): void {
		const input = this.input as VoltHttpRequestInput | undefined;
		if (!input) {
			return;
		}
		const next = structuredClone(input.draft);
		mutate(next);
		input.update(next);
		this.renderTabStrip();
	}

	protected override createEditor(parent: HTMLElement): void {
		this.root = append(parent, $('.volt-http-editor'));

		const head = append(this.root, $('.volt-http-head'));
		this.crumbs = append(head, $('.volt-http-crumbs'));
		append(this.crumbs, $('span.volt-http-kind')).textContent = 'HTTP';
		this.crumbFile = append(this.crumbs, $('span.volt-http-crumb'));
		append(this.crumbs, $('span.volt-http-crumb-sep')).textContent = '/';
		this.nameBox = this._register(new InputBox(append(this.crumbs, $('.volt-http-name')), this.contextViewService, { placeholder: localize('voltHttp.namePlaceholder', "Untitled request"), ariaLabel: localize('voltHttp.name', "Request name"), inputBoxStyles: FLAT_INPUT_STYLES }));
		this._register(this.nameBox.onDidChange(value => this.change(draft => draft.name = value)));
		this.headActions = append(head, $('.volt-http-head-actions'));

		this.bar = append(this.root, $('.volt-http-bar'));
		this.bar.dataset.slot = 'bar';

		this.requestEl = append(this.root, $('.volt-http-request'));
		this.tabsEl = append(this.requestEl, $('.volt-http-tabs'));
		this.tabsEl.setAttribute('role', 'tablist');
		this.tabBody = append(this.requestEl, $('.volt-http-tab-body'));
		append(this.root, $('.volt-http-divider'));
		this.responseEl = append(this.root, $('.volt-http-response'));

		this.sash = this._register(new Sash(this.root, { getHorizontalSashTop: () => this.requestEl.offsetTop + this.requestEl.offsetHeight }, { orientation: Orientation.HORIZONTAL }));
		let startHeight = 0;
		this._register(this.sash.onDidStart(() => startHeight = this.requestEl.offsetHeight));
		this._register(this.sash.onDidChange(event => {
			const space = this.splitSpace();
			if (space > 0) {
				this.requestRatio = (startHeight + event.currentY - event.startY) / space;
				this.layoutSplit();
			}
		}));
		this._register(this.sash.onDidReset(() => {
			this.requestRatio = DEFAULT_REQUEST_RATIO;
			this.layoutSplit();
		}));

		this._register(this.http.onDidChangeEnvironment(() => this.renderHeadActions()));
		this._register(this.http.onDidChangeIndex(() => this.renderHeadActions()));
	}

	override async setInput(input: VoltHttpRequestInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);
		this.nameBox.value = input.draft.name;
		this.renderCrumbs();
		this.renderHeadActions();
		this.renderBar();
		this.renderTabs();
		this.exchange = input.pendingExchange;
		this.responseLanguage = undefined;
		input.pendingExchange = undefined;
		this.renderResponse();
		this.layoutSplit();
		if (input.sendOnOpen) {
			input.sendOnOpen = false;
			void this.send();
		}
	}

	override clearInput(): void {
		this.cancelSend();
		super.clearInput();
	}

	/** The `.http` file the request lives in, then its editable name. */
	private renderCrumbs(): void {
		const source = (this.input as VoltHttpRequestInput | undefined)?.source;
		this.crumbs.classList.toggle('no-source', !source);
		this.crumbFile.textContent = source ? basename(source.uri) : '';
		this.crumbFile.title = source ? source.uri.fsPath : '';
	}

	private renderHeadActions(): void {
		this.headStore.clear();
		clearNode(this.headActions);
		const env = append(this.headActions, $('.volt-http-env'));
		void this.http.environments().then(envs => {
			if (this.headStore.isDisposed || !env.parentElement) {
				return;
			}
			const names = Object.keys(envs);
			createVoltDropdown<string>(env, this.contextViewService, {
				options: [{ id: '', label: localize('voltHttp.noEnv', "No Environment") }, ...names.map(name => ({ id: name, label: name, description: localize('voltHttp.envVars', "{0} variables", Object.keys(envs[name]).length) }))],
				value: this.http.environment && names.includes(this.http.environment) ? this.http.environment : '',
				ariaLabel: localize('voltHttp.env', "Environment"),
				leadingIcon: Codicon.symbolVariable,
				align: 'right',
				onChange: value => this.http.setEnvironment(value || undefined),
			}, this.headStore);
		});
		const save = this.headStore.add(createVoltButton(this.headActions, 'ghost', { supportIcons: true, title: localize('voltHttp.saveTitle', "Save to .http file") }));
		save.label = `$(save) ${localize('voltHttp.save', "Save")}`;
		this.headStore.add(save.onDidClick(() => void this.save()));
	}

	/** The method and URL share one box; Send is split, its chevron holds the other ways to send. */
	private renderBar(): void {
		this.barStore.clear();
		clearNode(this.bar);
		const draft = this.draft;
		const group = append(this.bar, $('.volt-http-urlgroup'));
		const method = append(group, $('.volt-http-method'));
		method.dataset.method = draft.method;
		createVoltDropdown(method, this.contextViewService, {
			options: HTTP_METHODS.map(id => ({ id, label: id })),
			value: draft.method as typeof HTTP_METHODS[number],
			ariaLabel: localize('voltHttp.method', "Method"),
			width: 160,
			align: 'left',
			onChange: value => {
				method.dataset.method = value;
				this.change(next => next.method = value);
			},
		}, this.barStore);
		this.urlBox = this.barStore.add(new InputBox(append(group, $('.volt-http-url')), this.contextViewService, { placeholder: localize('voltHttp.urlPlaceholder', "Enter URL or paste text, e.g. https://api.example.com/users/{{id}}"), ariaLabel: localize('voltHttp.url', "URL"), inputBoxStyles: FLAT_INPUT_STYLES }));
		this.urlBox.value = draft.url;
		this.barStore.add(this.urlBox.onDidChange(value => {
			if (this.syncingUrl) {
				return;
			}
			this.change(next => next.url = value);
			if (this.requestTab === 'params') {
				this.renderTabBody();
			}
		}));
		this.barStore.add(addDisposableListener(this.urlBox.inputElement, EventType.KEY_DOWN, (event: KeyboardEvent) => {
			if (event.key === 'Enter') {
				event.preventDefault();
				void this.send();
			}
		}));

		const split = append(this.bar, $('.volt-http-send'));
		const send = this.barStore.add(createVoltButton(split, 'primary', { supportIcons: true }));
		this.sendButtonEl = send.element;
		this.sendLabel = sending => send.label = sending ? `$(debug-stop) ${localize('voltHttp.cancel', "Cancel")}` : localize('voltHttp.send', "Send");
		this.sendLabel(!!this.sending.value);
		this.barStore.add(send.onDidClick(() => this.sending.value ? this.cancelSend() : void this.send()));
		const more = this.barStore.add(createVoltButton(split, 'primary', { supportIcons: true, title: localize('voltHttp.moreSend', "More actions") }));
		more.element.classList.add('volt-http-send-more');
		more.element.setAttribute('aria-haspopup', 'menu');
		more.label = '$(chevron-down)';
		this.barStore.add(more.onDidClick(() => this.showSendMenu(more.element)));
	}

	private showSendMenu(anchor: HTMLElement): void {
		type Action = 'curl' | 'format' | 'clear';
		const items: { id: Action; label: string; icon: ThemeIcon }[] = [
			{ id: 'curl', label: localize('voltHttp.copyCurl', "Copy as cURL"), icon: Codicon.terminal },
			...(this.draft.bodyMode === 'json' ? [{ id: 'format' as const, label: localize('voltHttp.beautify', "Beautify Body"), icon: Codicon.json }] : []),
			...(this.exchange ? [{ id: 'clear' as const, label: localize('voltHttp.clearResponse', "Clear Response"), icon: Codicon.clearAll }] : []),
		];
		this.menu.value = showVoltMenu<Action>(this.contextViewService, {
			anchor,
			align: 'right',
			ariaLabel: localize('voltHttp.moreSend', "More actions"),
			sections: [{ id: 'send', items: items.map(item => ({ ...item, data: item.id })) }],
			onPick: item => {
				switch (item.data) {
					case 'curl': void this.clipboardService.writeText(curlFromSpec(wireSpec(specFromDraft(this.draft)))); break;
					case 'format': this.beautifyBody(); break;
					case 'clear':
						this.exchange = undefined;
						this.renderResponse();
						break;
				}
			},
		});
	}

	private renderTabs(): void {
		this.renderTabStrip();
		this.renderTabBody();
	}

	/** Postman's tab strip: a green dot on a tab that sends something, the header count in green. */
	private renderTabStrip(): void {
		clearNode(this.tabsEl);
		const draft = this.draft;
		const headers = draft.headers.filter(item => item.enabled && item.key).length;
		const tabs: { id: RequestTab; label: string; dot?: boolean; count?: number }[] = [
			{ id: 'params', label: localize('voltHttp.params', "Params"), dot: this.queryParams().length > 0 },
			{ id: 'auth', label: localize('voltHttp.authorization', "Authorization"), dot: draft.auth.mode !== 'none' },
			{ id: 'headers', label: localize('voltHttp.headers', "Headers"), count: headers || undefined },
			{ id: 'body', label: localize('voltHttp.body', "Body"), dot: draft.bodyMode !== 'none' },
		];
		for (const { id, label, dot, count } of tabs) {
			this.drawTab(this.tabsEl, label, id === this.requestTab, dot, count, () => {
				this.requestTab = id;
				this.renderTabs();
			});
		}
	}

	private drawTab(parent: HTMLElement, label: string, active: boolean, dot: boolean | undefined, count: number | undefined, select: () => void): void {
		const tab = append(parent, $('button.volt-http-tab')) as HTMLButtonElement;
		tab.type = 'button';
		tab.classList.toggle('active', active);
		tab.setAttribute('role', 'tab');
		tab.setAttribute('aria-selected', String(active));
		append(tab, $('span')).textContent = label;
		if (count !== undefined) {
			append(tab, $('span.volt-http-tab-count')).textContent = `(${count})`;
		}
		if (dot) {
			append(tab, $('span.volt-http-tab-dot'));
		}
		tab.addEventListener('click', select);
	}

	private renderTabBody(): void {
		this.tabStore.clear();
		clearNode(this.tabBody);
		const draft = this.draft;
		switch (this.requestTab) {
			case 'params':
				this.renderKeyValues(this.tabBody, localize('voltHttp.queryParams', "Query Params"), this.queryParams().map(([key, value]) => ({ key, value, enabled: true })), rows => this.setQueryParams(rows));
				break;
			case 'headers':
				this.renderKeyValues(this.tabBody, localize('voltHttp.headers', "Headers"), draft.headers, rows => this.change(next => next.headers = rows));
				break;
			case 'body': this.renderBody(); break;
			case 'auth': this.renderAuth(); break;
		}
		this.layoutEditors();
	}

	private queryParams(): [string, string][] {
		const query = this.draft.url.split('?')[1]?.split('#')[0];
		return query ? query.split('&').filter(Boolean).map(pair => {
			const at = pair.indexOf('=');
			return at < 0 ? [safeDecode(pair), ''] : [safeDecode(pair.slice(0, at)), safeDecode(pair.slice(at + 1))];
		}) : [];
	}

	private setQueryParams(rows: IKeyValue[]): void {
		const base = this.draft.url.split('?')[0];
		const query = rows.filter(row => row.enabled && row.key).map(row => `${encodeParam(row.key)}${row.value ? `=${encodeParam(row.value)}` : ''}`).join('&');
		const url = query ? `${base}?${query}` : base;
		this.change(next => next.url = url);
		if (this.urlBox && this.urlBox.value !== url) {
			this.syncingUrl = true;
			try {
				this.urlBox.value = url;
			} finally {
				this.syncingUrl = false;
			}
		}
	}

	/**
	 * A bordered key/value table (check, Key, Value, Bulk Edit); a blank row at the end always waits
	 * for the next entry. Bulk Edit swaps the table for `key:value` lines, `//` in front of a disabled one.
	 */
	private renderKeyValues(parent: HTMLElement, title: string | undefined, rows: readonly IKeyValue[], save: (rows: IKeyValue[]) => void): void {
		const section = append(parent, $('.volt-http-section'));
		const head = append(section, $('.volt-http-section-head'));
		if (title) {
			append(head, $('span.volt-http-section-title')).textContent = title;
		}
		const headActions = append(head, $('.volt-http-section-actions'));
		const holder = append(section, $('.volt-http-kv'));
		const store = this.tabStore.add(new DisposableStore());
		const blank = (): IKeyValue => ({ key: '', value: '', enabled: true });
		const working: IKeyValue[] = [...rows.map(row => ({ ...row })), blank()];
		const commit = () => save(working.filter(row => row.key || row.value));
		const toggleBulk = () => {
			this.bulkEdit = !this.bulkEdit;
			draw();
		};
		const draw = () => {
			store.clear();
			clearNode(holder);
			clearNode(headActions);
			section.classList.toggle('bulk', this.bulkEdit);
			head.classList.toggle('hidden', !title && !this.bulkEdit);
			if (this.bulkEdit) {
				const link = append(headActions, $('button.volt-http-link')) as HTMLButtonElement;
				link.type = 'button';
				link.textContent = localize('voltHttp.keyValueEdit', "Key-Value Edit");
				link.addEventListener('click', toggleBulk);
				const text = working.filter(row => row.key || row.value).map(row => `${row.enabled ? '' : '//'}${row.key}:${row.value}`).join('\n');
				const editor = this.createCodeEditor(append(holder, $('.volt-http-code.bulk')), text, 'plaintext', false, store);
				editor.updateOptions({ lineNumbers: 'off', folding: false, padding: { top: 8, bottom: 8 } });
				store.add(editor.onDidChangeModelContent(() => {
					working.splice(0, working.length, ...parseBulk(editor.getValue()), blank());
					commit();
				}));
				this.layoutEditors();
				return;
			}
			const table = append(holder, $('.volt-http-table'));
			table.setAttribute('role', 'table');
			const filled = working.slice(0, -1);
			const headRow = append(table, $('.volt-http-tr.head'));
			headRow.setAttribute('role', 'row');
			const allCell = append(headRow, $('.volt-http-td.check'));
			let all: Checkbox | undefined;
			if (filled.length) {
				const toggleAll = all = store.add(new Checkbox(localize('voltHttp.toggleAll', "Enable all"), filled.every(row => row.enabled), CHECKBOX_STYLES));
				allCell.appendChild(toggleAll.domNode);
				store.add(toggleAll.onChange(() => {
					for (const row of filled) {
						row.enabled = toggleAll.checked;
					}
					commit();
					draw();
				}));
			}
			append(headRow, $('.volt-http-td.label')).textContent = localize('voltHttp.key', "Key");
			append(headRow, $('.volt-http-td.label')).textContent = localize('voltHttp.value', "Value");
			const bulk = append(append(headRow, $('.volt-http-td.tail')), $('button.volt-http-link.muted')) as HTMLButtonElement;
			bulk.type = 'button';
			bulk.textContent = localize('voltHttp.bulkEdit', "Bulk Edit");
			bulk.addEventListener('click', toggleBulk);

			working.forEach((row, index) => {
				const line = append(table, $('.volt-http-tr'));
				line.setAttribute('role', 'row');
				const last = index === working.length - 1;
				line.classList.toggle('disabled', !row.enabled);
				const checkCell = append(line, $('.volt-http-td.check'));
				if (!last) {
					const check = store.add(new Checkbox(localize('voltHttp.enabled', "Enabled"), row.enabled, CHECKBOX_STYLES));
					checkCell.appendChild(check.domNode);
					store.add(check.onChange(() => {
						row.enabled = check.checked;
						line.classList.toggle('disabled', !row.enabled);
						commit();
						if (all) {
							all.checked = filled.every(item => item.enabled);
						}
					}));
				}
				const key = store.add(new InputBox(append(line, $('.volt-http-td.cell')), this.contextViewService, { placeholder: localize('voltHttp.key', "Key"), ariaLabel: localize('voltHttp.key', "Key"), inputBoxStyles: FLAT_INPUT_STYLES }));
				key.value = row.key;
				const value = store.add(new InputBox(append(line, $('.volt-http-td.cell')), this.contextViewService, { placeholder: localize('voltHttp.value', "Value"), ariaLabel: localize('voltHttp.value', "Value"), inputBoxStyles: FLAT_INPUT_STYLES }));
				value.value = row.value;
				const onEdit = () => {
					row.key = key.value;
					row.value = value.value;
					commit();
					if (last && (row.key || row.value)) {
						working.push(blank());
						const focusKey = key.hasFocus();
						draw();
						const inputs = holder.querySelectorAll<HTMLInputElement>('.volt-http-tr input.input');
						inputs[index * 2 + (focusKey ? 0 : 1)]?.focus();
					}
				};
				store.add(key.onDidChange(onEdit));
				store.add(value.onDidChange(onEdit));
				const tail = append(line, $('.volt-http-td.tail'));
				if (!last) {
					const remove = append(tail, $('button.volt-http-kv-remove')) as HTMLButtonElement;
					remove.type = 'button';
					remove.title = localize('voltHttp.remove', "Remove");
					remove.appendChild(renderIcon(Codicon.trash));
					remove.setAttribute('aria-label', localize('voltHttp.remove', "Remove"));
					remove.addEventListener('click', () => {
						working.splice(index, 1);
						commit();
						draw();
					});
				}
			});
		};
		draw();
	}

	/** Postman's body picker: none, x-www-form-urlencoded, raw (with its format) and GraphQL. */
	private renderBody(): void {
		const draft = this.draft;
		const modes = append(this.tabBody, $('.volt-http-modes'));
		modes.setAttribute('role', 'radiogroup');
		modes.setAttribute('aria-label', localize('voltHttp.bodyMode', "Body type"));
		const raw = draft.bodyMode === 'json' || draft.bodyMode === 'text' || draft.bodyMode === 'xml';
		const choices: { label: string; checked: boolean; mode: BodyMode; isRaw?: boolean }[] = [
			{ label: localize('voltHttp.bodyNone', "none"), checked: draft.bodyMode === 'none', mode: 'none' },
			{ label: 'x-www-form-urlencoded', checked: draft.bodyMode === 'form', mode: 'form' },
			{ label: 'raw', checked: raw, mode: raw ? draft.bodyMode : 'json', isRaw: true },
			{ label: 'GraphQL', checked: draft.bodyMode === 'graphql', mode: 'graphql' },
		];
		for (const { label, checked, mode, isRaw } of choices) {
			const radio = append(modes, $('button.volt-http-radio')) as HTMLButtonElement;
			radio.type = 'button';
			radio.setAttribute('role', 'radio');
			radio.setAttribute('aria-checked', String(checked));
			radio.classList.toggle('checked', checked);
			append(radio, $('span.volt-http-radio-dot'));
			append(radio, $('span')).textContent = label;
			radio.addEventListener('click', () => {
				if (!checked) {
					this.change(next => next.bodyMode = mode);
					this.renderTabs();
				}
			});
			if (isRaw && raw) {
				const format = append(modes, $('.volt-http-raw-format'));
				createVoltDropdown<BodyMode>(format, this.contextViewService, {
					options: [{ id: 'json', label: 'JSON' }, { id: 'text', label: localize('voltHttp.bodyText', "Text") }, { id: 'xml', label: 'XML' }],
					value: draft.bodyMode,
					ariaLabel: localize('voltHttp.rawFormat', "Raw format"),
					width: 160,
					align: 'left',
					onChange: value => {
						this.change(next => next.bodyMode = value);
						this.renderTabs();
					},
				}, this.tabStore);
			}
		}
		if (draft.bodyMode === 'json') {
			const beautify = append(modes, $('button.volt-http-link.end')) as HTMLButtonElement;
			beautify.type = 'button';
			beautify.textContent = localize('voltHttp.beautifyLink', "Beautify");
			beautify.addEventListener('click', () => this.beautifyBody());
		}
		if (draft.bodyMode === 'none') {
			append(this.tabBody, $('.volt-http-empty.center')).textContent = localize('voltHttp.noBody', "This request does not have a body");
			return;
		}
		if (draft.bodyMode === 'form') {
			this.renderKeyValues(this.tabBody, undefined, draft.form, rows => this.change(next => next.form = rows));
			return;
		}
		if (draft.bodyMode === 'graphql') {
			const split = append(this.tabBody, $('.volt-http-graphql'));
			const queryPane = append(split, $('.volt-http-graphql-pane'));
			append(queryPane, $('.volt-http-sublabel')).textContent = localize('voltHttp.query', "Query");
			const query = this.createCodeEditor(append(queryPane, $('.volt-http-code')), draft.body, 'graphql', false, this.tabStore);
			this.tabStore.add(query.onDidChangeModelContent(() => this.change(next => next.body = query.getValue())));
			const variablesPane = append(split, $('.volt-http-graphql-pane'));
			append(variablesPane, $('.volt-http-sublabel')).textContent = localize('voltHttp.variables', "GraphQL Variables");
			const variables = this.createCodeEditor(append(variablesPane, $('.volt-http-code')), draft.graphqlVariables, 'json', false, this.tabStore);
			this.tabStore.add(variables.onDidChangeModelContent(() => this.change(next => next.graphqlVariables = variables.getValue())));
			return;
		}
		const language = draft.bodyMode === 'json' ? 'json' : draft.bodyMode === 'xml' ? 'xml' : 'plaintext';
		const body = this.createCodeEditor(append(this.tabBody, $('.volt-http-code')), draft.body, language, false, this.tabStore);
		body.getContainerDomNode().dataset.role = 'body';
		this.tabStore.add(body.onDidChangeModelContent(() => this.change(next => next.body = body.getValue())));
	}

	private beautifyBody(): void {
		const editor = [...this.codeEditors].find(item => item.getContainerDomNode().dataset.role === 'body');
		try {
			const pretty = JSON.stringify(JSON.parse(editor?.getValue() ?? this.draft.body), null, 2);
			if (editor) {
				editor.setValue(pretty);
			} else {
				this.change(next => next.body = pretty);
			}
		} catch { /* not valid JSON yet */ }
	}

	/** Postman's auth page: the type and what it does on the left, its fields on the right. */
	private renderAuth(): void {
		const auth = this.draft.auth;
		const wrap = append(this.tabBody, $('.volt-http-auth'));
		const side = append(wrap, $('.volt-http-auth-type'));
		append(side, $('.volt-http-section-title')).textContent = localize('voltHttp.authType', "Auth Type");
		createVoltDropdown<AuthMode>(append(side, $('.volt-http-auth-pick')), this.contextViewService, {
			options: [
				{ id: 'none', label: localize('voltHttp.authNone', "No Auth") },
				{ id: 'bearer', label: localize('voltHttp.authBearer', "Bearer Token") },
				{ id: 'basic', label: localize('voltHttp.authBasic', "Basic Auth") },
				{ id: 'apikey', label: localize('voltHttp.authKey', "API Key") },
			],
			value: auth.mode,
			ariaLabel: localize('voltHttp.authMode', "Auth type"),
			width: 220,
			align: 'left',
			onChange: value => {
				this.change(next => next.auth.mode = value);
				this.renderTabs();
			},
		}, this.tabStore);
		const help: Record<AuthMode, string> = {
			none: localize('voltHttp.authNoneHelp', "This request does not use any authorization."),
			bearer: localize('voltHttp.authBearerHelp', "The token is sent in the Authorization header as \"Bearer <token>\". Use {{variables}} to keep secrets in an environment."),
			basic: localize('voltHttp.authBasicHelp', "The username and password are sent in the Authorization header."),
			apikey: localize('voltHttp.authKeyHelp', "The key and value are sent as a request header or a query parameter."),
		};
		append(side, $('.volt-http-auth-help')).textContent = help[auth.mode];
		const fields = append(wrap, $('.volt-http-auth-fields'));
		const field = (label: string, value: string, update: (value: string, draft: IHttpDraft) => void, password = false) => {
			const row = append(fields, $('.volt-http-field'));
			append(row, $('label')).textContent = label;
			const box = this.tabStore.add(new InputBox(append(row, $('.volt-http-field-input')), this.contextViewService, { type: password ? 'password' : 'text', placeholder: localize('voltHttp.varHint', "Value or {{variable}}"), ariaLabel: label, inputBoxStyles: defaultInputBoxStyles }));
			box.value = value;
			this.tabStore.add(box.onDidChange(next => this.change(draft => update(next, draft))));
		};
		switch (auth.mode) {
			case 'none':
				append(fields, $('.volt-http-empty.center')).textContent = localize('voltHttp.noAuth', "No authorization is sent.");
				break;
			case 'bearer':
				field(localize('voltHttp.token', "Token"), auth.token, (value, draft) => draft.auth.token = value, true);
				break;
			case 'basic':
				field(localize('voltHttp.user', "Username"), auth.user, (value, draft) => draft.auth.user = value);
				field(localize('voltHttp.password', "Password"), auth.password, (value, draft) => draft.auth.password = value, true);
				break;
			case 'apikey': {
				field(localize('voltHttp.keyName', "Key"), auth.keyName, (value, draft) => draft.auth.keyName = value);
				field(localize('voltHttp.keyValue', "Value"), auth.keyValue, (value, draft) => draft.auth.keyValue = value, true);
				const row = append(fields, $('.volt-http-field'));
				append(row, $('label')).textContent = localize('voltHttp.addTo', "Add to");
				createVoltDropdown<'header' | 'query'>(append(row, $('.volt-http-field-input')), this.contextViewService, {
					options: [{ id: 'header', label: localize('voltHttp.inHeader', "Header") }, { id: 'query', label: localize('voltHttp.inQuery', "Query Params") }],
					value: auth.keyIn,
					ariaLabel: localize('voltHttp.addTo', "Add to"),
					align: 'left',
					onChange: value => this.change(draft => draft.auth.keyIn = value),
				}, this.tabStore);
				break;
			}
		}
	}

	private createCodeEditor(host: HTMLElement, value: string, language: string, readOnly: boolean, store: DisposableStore): CodeEditorWidget {
		const editor = store.add(this.instantiationService.createInstance(CodeEditorWidget, host, { ...CODE_EDITOR_OPTIONS, readOnly, domReadOnly: readOnly }, { isSimpleWidget: false }));
		const languageId = this.languageService.isRegisteredLanguageId(language) ? language : 'plaintext';
		const model: ITextModel = store.add(this.modelService.createModel(value, this.languageService.createById(languageId), undefined));
		editor.setModel(model);
		this.codeEditors.add(editor);
		store.add(toDisposable(() => this.codeEditors.delete(editor)));
		return editor;
	}

	private cancelSend(): void {
		const pending = this.sending.value;
		if (!pending) {
			return;
		}
		pending.cancel();
		this.sending.clear();
		this.root.classList.remove('sending');
		this.sendLabel?.(false);
		this.renderResponse();
	}

	private async send(): Promise<void> {
		const input = this.input as VoltHttpRequestInput | undefined;
		if (!input || !this.draft.url.trim()) {
			this.urlBox?.focus();
			return;
		}
		this.sending.value?.cancel();
		const cancel = new CancellationTokenSource();
		this.sending.value = cancel;
		this.sendLabel?.(true);
		this.root.classList.add('sending');
		this.renderResponse();
		try {
			const spec = wireSpec(specFromDraft(this.draft, input.source?.line ?? 0));
			const exchange = await this.http.send(spec, { ...(input.source ? { source: input.source.uri } : {}), token: cancel.token });
			// A cancelled send that settles after a newer one started does not replace its response.
			if (!this.sending.value || this.sending.value === cancel) {
				this.exchange = exchange;
				this.responseLanguage = undefined;
			}
		} finally {
			if (this.sending.value === cancel) {
				this.sending.clear();
				this.root.classList.remove('sending');
				this.sendLabel?.(false);
				this.renderResponse();
			}
		}
	}

	private async save(): Promise<void> {
		const input = this.input as VoltHttpRequestInput | undefined;
		const target = input?.source?.uri ?? this.http.defaultFile();
		if (!input || !target) {
			return;
		}
		const line = await this.http.save(target, specFromDraft(this.draft), input.source?.line);
		input.setSource({ uri: target, line });
		this.renderCrumbs();
	}

	private renderResponse(): void {
		this.responseStore.clear();
		clearNode(this.responseEl);
		const bar = append(this.responseEl, $('.volt-http-res-bar'));
		const exchange = this.sending.value ? undefined : this.exchange;
		const response = exchange?.response;
		if (!response) {
			append(bar, $('span.volt-http-res-title')).textContent = localize('voltHttp.response', "Response");
			if (this.sending.value) {
				const waiting = append(this.responseEl, $('.volt-http-waiting'));
				waiting.appendChild(renderIcon(ThemeIcon.modify(Codicon.loading, 'spin')));
				// allow-any-unicode-next-line
				append(waiting, $('span')).textContent = localize('voltHttp.sending', "Sending request…");
				return;
			}
			if (exchange) {
				const meta = append(bar, $('.volt-http-res-meta'));
				append(meta, $('span.volt-http-pill.error')).textContent = localize('voltHttp.failed', "Failed");
				append(this.responseEl, $('.volt-http-error')).textContent = exchange.error ?? '';
				return;
			}
			const empty = append(this.responseEl, $('.volt-http-empty.response'));
			empty.appendChild(renderIcon(Codicon.send));
			append(empty, $('span')).textContent = localize('voltHttp.hint', "Send the request to see the response. Enter in the URL sends it.");
			return;
		}

		const tabs = append(bar, $('.volt-http-res-tabs'));
		tabs.setAttribute('role', 'tablist');
		const headerCount = Object.keys(response.headers).length;
		const responseTabs: { id: ResponseTab; label: string; count?: number }[] = [
			{ id: 'body', label: localize('voltHttp.resBody', "Body") },
			{ id: 'headers', label: localize('voltHttp.resHeaders', "Headers"), count: headerCount },
			{ id: 'raw', label: localize('voltHttp.resRaw', "Raw") },
		];
		for (const { id, label, count } of responseTabs) {
			this.drawTab(tabs, label, id === this.responseTab, undefined, count, () => {
				this.responseTab = id;
				this.renderResponse();
			});
		}
		const meta = append(bar, $('.volt-http-res-meta'));
		const pill = append(meta, $('span.volt-http-pill'));
		pill.classList.add(response.status >= 500 ? 'error' : response.status >= 400 ? 'warn' : response.status >= 300 ? 'info' : 'ok');
		pill.textContent = `${response.status} ${response.statusText}`.trim();
		append(meta, $('span.volt-http-meta-dot'));
		const time = append(meta, $('span.volt-http-metric'));
		time.textContent = formatDuration(response.durationMs);
		time.title = localize('voltHttp.time', "Time");
		append(meta, $('span.volt-http-meta-dot'));
		const size = append(meta, $('span.volt-http-metric'));
		size.textContent = formatBytes(response.size);
		size.title = localize('voltHttp.size', "Size");

		if (this.responseTab === 'headers') {
			const scroll = append(this.responseEl, $('.volt-http-res-scroll'));
			const table = append(scroll, $('.volt-http-table.readonly'));
			table.setAttribute('role', 'table');
			const headRow = append(table, $('.volt-http-tr.head'));
			append(headRow, $('.volt-http-td.label')).textContent = localize('voltHttp.key', "Key");
			append(headRow, $('.volt-http-td.label')).textContent = localize('voltHttp.value', "Value");
			for (const [key, value] of Object.entries(response.headers)) {
				const row = append(table, $('.volt-http-tr'));
				row.setAttribute('role', 'row');
				append(row, $('.volt-http-td.text')).textContent = key;
				append(row, $('.volt-http-td.text')).textContent = value;
			}
			return;
		}

		const type = Object.entries(response.headers).find(([key]) => key.toLowerCase() === 'content-type')?.[1] ?? '';
		const detected: ResponseLanguage = /json/.test(type) || /^\s*[[{]/.test(response.body) ? 'json' : /html/.test(type) ? 'html' : /xml/.test(type) ? 'xml' : /javascript/.test(type) ? 'javascript' : /css/.test(type) ? 'css' : 'plaintext';
		let language: ResponseLanguage = this.responseTab === 'raw' ? 'plaintext' : this.responseLanguage ?? detected;
		let text = response.body;
		if (this.responseTab === 'raw') {
			text = `HTTP ${response.status} ${response.statusText}\n${Object.entries(response.headers).map(([key, value]) => `${key}: ${value}`).join('\n')}\n\n${response.body}`;
		} else if (language === 'json') {
			try {
				text = JSON.stringify(JSON.parse(text), null, 2);
			} catch {
				language = this.responseLanguage === 'json' ? 'json' : 'plaintext';
			}
		}

		const tools = append(this.responseEl, $('.volt-http-res-tools'));
		if (this.responseTab === 'body') {
			const formats: { id: ResponseLanguage; label: string; icon: ThemeIcon }[] = [
				{ id: 'json', label: 'JSON', icon: Codicon.json },
				{ id: 'xml', label: 'XML', icon: Codicon.code },
				{ id: 'html', label: 'HTML', icon: Codicon.code },
				{ id: 'javascript', label: 'JavaScript', icon: Codicon.code },
				{ id: 'css', label: 'CSS', icon: Codicon.code },
				{ id: 'plaintext', label: localize('voltHttp.resText', "Text"), icon: Codicon.file },
			];
			createVoltDropdown<ResponseLanguage>(append(tools, $('.volt-http-res-format')), this.contextViewService, {
				options: formats,
				value: language,
				ariaLabel: localize('voltHttp.resFormat', "Response format"),
				width: 180,
				align: 'left',
				onChange: value => {
					this.responseLanguage = value;
					this.renderResponse();
				},
			}, this.responseStore);
		}
		append(tools, $('.volt-http-spacer'));
		const wrap = this.responseStore.add(createVoltButton(tools, 'ghost', { supportIcons: true, title: localize('voltHttp.wrap', "Wrap lines") }));
		wrap.label = '$(word-wrap)';
		wrap.element.classList.add('volt-http-icon-button');
		wrap.element.classList.toggle('checked', this.responseWrap);
		wrap.element.setAttribute('aria-pressed', String(this.responseWrap));
		const find = this.responseStore.add(createVoltButton(tools, 'ghost', { supportIcons: true, title: localize('voltHttp.find', "Find in response") }));
		find.label = '$(search)';
		find.element.classList.add('volt-http-icon-button');
		append(tools, $('span.volt-http-tool-sep'));
		const copy = this.responseStore.add(createVoltButton(tools, 'ghost', { supportIcons: true, title: localize('voltHttp.copy', "Copy response") }));
		copy.label = '$(copy)';
		copy.element.classList.add('volt-http-icon-button');

		const editor = this.createCodeEditor(append(this.responseEl, $('.volt-http-code.response')), text, language, true, this.responseStore);
		editor.updateOptions({ wordWrap: this.responseWrap ? 'on' : 'off' });
		this.responseStore.add(wrap.onDidClick(() => {
			this.responseWrap = !this.responseWrap;
			editor.updateOptions({ wordWrap: this.responseWrap ? 'on' : 'off' });
			wrap.element.classList.toggle('checked', this.responseWrap);
			wrap.element.setAttribute('aria-pressed', String(this.responseWrap));
		}));
		this.responseStore.add(find.onDidClick(() => {
			editor.focus();
			void editor.getAction('actions.find')?.run();
		}));
		this.responseStore.add(copy.onDidClick(() => void this.clipboardService.writeText(editor.getValue())));
		this.layoutEditors();
	}

	override layout(dimension: Dimension): void {
		this.dimension = dimension;
		this.root.style.height = `${dimension.height}px`;
		this.layoutSplit();
	}

	/** The height the request and response share: everything under the URL bar but the divider. */
	private splitSpace(): number {
		if (!this.dimension) {
			return 0;
		}
		return this.dimension.height - this.requestEl.offsetTop - 1;
	}

	private layoutSplit(): void {
		const space = this.splitSpace();
		if (space > 0) {
			const min = Math.min(MIN_PANE_HEIGHT, space / 2);
			const height = Math.round(Math.min(Math.max(space * this.requestRatio, min), space - min));
			this.requestEl.style.height = `${height}px`;
		}
		this.layoutEditors();
		this.sash.layout();
	}

	/** Code editors size to their hosts (flex boxes); they need explicit layouts. */
	private layoutEditors(): void {
		if (!this.dimension) {
			return;
		}
		for (const editor of this.codeEditors) {
			const host = editor.getContainerDomNode();
			editor.layout({ width: host.clientWidth, height: host.clientHeight });
		}
	}

	override focus(): void {
		super.focus();
		(this.draft.url ? this.sendButtonEl : this.urlBox?.inputElement)?.focus();
	}
}

/** Bulk Edit's lines: `key:value`, `//` in front of a disabled row. */
function parseBulk(text: string): IKeyValue[] {
	const rows: IKeyValue[] = [];
	for (const raw of text.split(/\r?\n/)) {
		const disabled = /^\s*\/\//.test(raw);
		const line = disabled ? raw.replace(/^\s*\/\//, '') : raw;
		if (!line.trim()) {
			continue;
		}
		const at = line.indexOf(':');
		rows.push(at < 0 ? { key: line.trim(), value: '', enabled: !disabled } : { key: line.slice(0, at).trim(), value: line.slice(at + 1).trimStart(), enabled: !disabled });
	}
	return rows;
}

function safeDecode(value: string): string {
	try {
		return decodeURIComponent(value);
	} catch {
		return value;
	}
}

/** Keeps `{{variables}}` readable in the URL. */
function encodeParam(value: string): string {
	return value.split(/(\{\{[^}]*\}\})/).map(part => part.startsWith('{{') ? part : encodeURIComponent(part)).join('');
}

function formatBytes(bytes: number): string {
	return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : bytes >= 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${bytes} B`;
}

function formatDuration(ms: number): string {
	return ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${Math.round(ms)} ms`;
}
