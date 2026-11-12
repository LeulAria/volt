/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/voltHttp.css';
import { $, addDisposableListener, append, clearNode, Dimension, EventType } from '../../../../base/browser/dom.js';
import { InputBox } from '../../../../base/browser/ui/inputbox/inputBox.js';
import { renderIcon } from '../../../../base/browser/ui/iconLabel/iconLabels.js';
import { CancellationToken, CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Emitter } from '../../../../base/common/event.js';
import { DisposableStore, MutableDisposable } from '../../../../base/common/lifecycle.js';
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
import { IContextViewService } from '../../../../platform/contextview/browser/contextView.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { defaultInputBoxStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { EditorPane } from '../../../browser/parts/editor/editorPane.js';
import { IEditorOpenContext, IEditorSerializer, IUntypedEditorInput } from '../../../common/editor.js';
import { EditorInput } from '../../../common/editor/editorInput.js';
import { IEditorGroup } from '../../../services/editor/common/editorGroupsService.js';
import { HTTP_METHODS, IHttpRequestSpec } from '../../../services/voltRuntime/common/ide/httpFile.js';
import { createVoltButton } from '../../voltAgent/browser/chrome/voltButton.js';
import { createVoltDropdown } from '../../voltAgent/browser/ui/dropdown/voltDropdown.js';
import { IHttpExchange, IVoltHttpService } from './voltHttpService.js';

export const VOLT_HTTP_EDITOR_ID = 'workbench.editor.voltHttpRequest';
export const VOLT_HTTP_INPUT_ID = 'workbench.input.voltHttpRequest';

type BodyMode = 'none' | 'json' | 'text' | 'xml' | 'form' | 'graphql';
type AuthMode = 'none' | 'bearer' | 'basic' | 'apikey';
type RequestTab = 'params' | 'headers' | 'body' | 'auth';
type ResponseTab = 'body' | 'headers' | 'raw';

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

/**
 * The HTTP client's request editor: method, URL, params, headers, body (JSON, text, XML, form,
 * GraphQL), auth and the environment on top; the response (status, time, size, pretty body,
 * headers, raw) below. It edits `.http` requests in place and saves back to the file, and its
 * sends land in the same history the agents' `ide http` capability uses.
 */
export class VoltHttpRequestEditor extends EditorPane {

	static readonly ID = VOLT_HTTP_EDITOR_ID;

	private root!: HTMLElement;
	private nameBox!: InputBox;
	private urlBox!: InputBox;
	private readonly barStore = this._register(new DisposableStore());
	private tabsEl!: HTMLElement;
	private tabBody!: HTMLElement;
	private responseEl!: HTMLElement;
	private requestTab: RequestTab = 'params';
	private responseTab: ResponseTab = 'body';
	private readonly tabStore = this._register(new DisposableStore());
	private readonly responseStore = this._register(new DisposableStore());
	private readonly sending = this._register(new MutableDisposable<CancellationTokenSource>());
	private exchange: IHttpExchange | undefined;
	private bodyEditor: CodeEditorWidget | undefined;
	private responseEditor: CodeEditorWidget | undefined;
	private dimension: Dimension | undefined;
	private sendButtonEl: HTMLElement | undefined;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IContextViewService private readonly contextViewService: IContextViewService,
		@IModelService private readonly modelService: IModelService,
		@ILanguageService private readonly languageService: ILanguageService,
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
	}

	protected override createEditor(parent: HTMLElement): void {
		this.root = append(parent, $('.volt-http-editor'));
		const head = append(this.root, $('.volt-http-head'));
		this.nameBox = this._register(new InputBox(append(head, $('.volt-http-name')), this.contextViewService, { placeholder: localize('voltHttp.namePlaceholder', "Untitled request"), ariaLabel: localize('voltHttp.name', "Request name"), inputBoxStyles: defaultInputBoxStyles }));
		this._register(this.nameBox.onDidChange(value => this.change(draft => draft.name = value)));
		const bar = append(this.root, $('.volt-http-bar'));
		bar.dataset.slot = 'bar';
		this.tabsEl = append(this.root, $('.volt-http-tabs'));
		this.tabBody = append(this.root, $('.volt-http-tab-body'));
		append(this.root, $('.volt-http-divider'));
		this.responseEl = append(this.root, $('.volt-http-response'));
		this._register(this.http.onDidChangeEnvironment(() => this.renderBar()));
		this._register(this.http.onDidChangeIndex(() => this.renderBar()));
	}

	override async setInput(input: VoltHttpRequestInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);
		this.nameBox.value = input.draft.name;
		this.renderBar();
		this.renderTabs();
		this.exchange = input.pendingExchange;
		input.pendingExchange = undefined;
		this.renderResponse();
		if (input.sendOnOpen) {
			input.sendOnOpen = false;
			void this.send();
		}
	}

	override clearInput(): void {
		this.sending.clear();
		super.clearInput();
	}

	private renderBar(): void {
		const bar = this.root.querySelector<HTMLElement>('.volt-http-bar');
		if (!bar) {
			return;
		}
		this.barStore.clear();
		clearNode(bar);
		const draft = this.draft;
		const method = append(bar, $('.volt-http-method'));
		method.dataset.method = draft.method;
		createVoltDropdown(method, this.contextViewService, {
			options: HTTP_METHODS.map(id => ({ id, label: id })),
			value: draft.method as typeof HTTP_METHODS[number],
			ariaLabel: localize('voltHttp.method', "Method"),
			width: 140,
			onChange: value => {
				method.dataset.method = value;
				this.change(next => next.method = value);
			},
		}, this.barStore);
		this.urlBox = this.barStore.add(new InputBox(append(bar, $('.volt-http-url')), this.contextViewService, { placeholder: localize('voltHttp.urlPlaceholder', "https://api.example.com/users/{{id}}"), ariaLabel: localize('voltHttp.url', "URL"), inputBoxStyles: defaultInputBoxStyles }));
		this.urlBox.value = draft.url;
		this.barStore.add(this.urlBox.onDidChange(value => {
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
		const env = append(bar, $('.volt-http-env'));
		void this.http.environments().then(envs => {
			if (this.barStore.isDisposed) {
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
			}, this.barStore);
		});
		const send = this.barStore.add(createVoltButton(bar, 'primary', { supportIcons: true }));
		this.sendButtonEl = send.element;
		send.label = this.sending.value ? `$(debug-stop) ${localize('voltHttp.cancel', "Cancel")}` : `$(send) ${localize('voltHttp.send', "Send")}`;
		this.barStore.add(send.onDidClick(() => this.sending.value ? this.sending.clear() : void this.send()));
		const save = this.barStore.add(createVoltButton(bar, 'secondary', { supportIcons: true, title: localize('voltHttp.saveTitle', "Save to .http file") }));
		save.label = `$(save) ${localize('voltHttp.save', "Save")}`;
		this.barStore.add(save.onDidClick(() => void this.save()));
	}

	private renderTabs(): void {
		clearNode(this.tabsEl);
		const draft = this.draft;
		const params = this.queryParams().length;
		const headers = draft.headers.filter(item => item.enabled && item.key).length;
		const tabs: [RequestTab, string, number | string | undefined][] = [
			['params', localize('voltHttp.params', "Params"), params || undefined],
			['headers', localize('voltHttp.headers', "Headers"), headers || undefined],
			['body', localize('voltHttp.body', "Body"), draft.bodyMode === 'none' ? undefined : draft.bodyMode.toUpperCase()],
			['auth', localize('voltHttp.auth', "Auth"), draft.auth.mode === 'none' ? undefined : draft.auth.mode],
		];
		for (const [id, label, badge] of tabs) {
			const tab = append(this.tabsEl, $('button.volt-http-tab')) as HTMLButtonElement;
			tab.type = 'button';
			tab.classList.toggle('active', id === this.requestTab);
			tab.setAttribute('role', 'tab');
			tab.setAttribute('aria-selected', String(id === this.requestTab));
			append(tab, $('span')).textContent = label;
			if (badge !== undefined) {
				append(tab, $('span.volt-http-badge')).textContent = String(badge);
			}
			tab.addEventListener('click', () => {
				this.requestTab = id;
				this.renderTabs();
			});
		}
		this.renderTabBody();
	}

	private renderTabBody(): void {
		this.tabStore.clear();
		this.bodyEditor = undefined;
		clearNode(this.tabBody);
		const draft = this.draft;
		switch (this.requestTab) {
			case 'params':
				this.renderKeyValues(this.tabBody, this.queryParams().map(([key, value]) => ({ key, value, enabled: true })), rows => this.setQueryParams(rows), localize('voltHttp.param', "Parameter"));
				break;
			case 'headers':
				this.renderKeyValues(this.tabBody, draft.headers, rows => this.change(next => next.headers = rows), localize('voltHttp.header', "Header"));
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
			this.urlBox.value = url;
		}
	}

	/** Key/value rows; a blank row at the end always waits for the next entry. */
	private renderKeyValues(parent: HTMLElement, rows: readonly IKeyValue[], save: (rows: IKeyValue[]) => void, noun: string): void {
		const grid = append(parent, $('.volt-http-kv'));
		const working = [...rows.map(row => ({ ...row })), { key: '', value: '', enabled: true }];
		const commit = () => save(working.filter(row => row.key || row.value));
		const draw = () => {
			clearNode(grid);
			working.forEach((row, index) => {
				const line = append(grid, $('.volt-http-kv-row'));
				const last = index === working.length - 1;
				const check = append(line, $('input.volt-http-kv-check')) as HTMLInputElement;
				check.type = 'checkbox';
				check.checked = row.enabled;
				check.disabled = last;
				check.setAttribute('aria-label', localize('voltHttp.enabled', "Enabled"));
				check.addEventListener('change', () => {
					row.enabled = check.checked;
					commit();
				});
				const key = this.tabStore.add(new InputBox(append(line, $('.volt-http-kv-key')), this.contextViewService, { placeholder: noun, inputBoxStyles: defaultInputBoxStyles }));
				key.value = row.key;
				const value = this.tabStore.add(new InputBox(append(line, $('.volt-http-kv-value')), this.contextViewService, { placeholder: localize('voltHttp.value', "Value"), inputBoxStyles: defaultInputBoxStyles }));
				value.value = row.value;
				const onEdit = () => {
					row.key = key.value;
					row.value = value.value;
					commit();
					if (last && (row.key || row.value)) {
						working.push({ key: '', value: '', enabled: true });
						const focusKey = key.hasFocus();
						draw();
						const inputs = grid.querySelectorAll<HTMLInputElement>('.volt-http-kv-row input.input');
						inputs[index * 2 + (focusKey ? 0 : 1)]?.focus();
					}
				};
				this.tabStore.add(key.onDidChange(onEdit));
				this.tabStore.add(value.onDidChange(onEdit));
				const remove = append(line, $('button.volt-http-kv-remove')) as HTMLButtonElement;
				remove.type = 'button';
				remove.appendChild(renderIcon(Codicon.close));
				remove.setAttribute('aria-label', localize('voltHttp.remove', "Remove"));
				remove.style.visibility = last ? 'hidden' : '';
				remove.addEventListener('click', () => {
					working.splice(index, 1);
					commit();
					draw();
				});
			});
		};
		draw();
	}

	private renderBody(): void {
		const draft = this.draft;
		const top = append(this.tabBody, $('.volt-http-body-top'));
		const modes: { id: BodyMode; label: string }[] = [
			{ id: 'none', label: localize('voltHttp.bodyNone', "No Body") },
			{ id: 'json', label: 'JSON' },
			{ id: 'text', label: localize('voltHttp.bodyText', "Text") },
			{ id: 'xml', label: 'XML' },
			{ id: 'form', label: localize('voltHttp.bodyForm', "Form URL Encoded") },
			{ id: 'graphql', label: 'GraphQL' },
		];
		createVoltDropdown<BodyMode>(top, this.contextViewService, {
			options: modes,
			value: draft.bodyMode,
			ariaLabel: localize('voltHttp.bodyMode', "Body type"),
			width: 200,
			onChange: value => {
				this.change(next => next.bodyMode = value);
				this.renderTabs();
			},
		}, this.tabStore);
		if (draft.bodyMode === 'json') {
			const format = this.tabStore.add(createVoltButton(top, 'ghost', { supportIcons: true }));
			format.label = `$(json) ${localize('voltHttp.format', "Format")}`;
			this.tabStore.add(format.onDidClick(() => {
				try {
					const pretty = JSON.stringify(JSON.parse(this.bodyEditor?.getValue() ?? ''), null, 2);
					this.bodyEditor?.setValue(pretty);
				} catch { /* not valid JSON yet */ }
			}));
		}
		if (draft.bodyMode === 'none') {
			append(this.tabBody, $('.volt-http-empty')).textContent = localize('voltHttp.noBody', "This request has no body.");
			return;
		}
		if (draft.bodyMode === 'form') {
			this.renderKeyValues(this.tabBody, draft.form, rows => this.change(next => next.form = rows), localize('voltHttp.field', "Field"));
			return;
		}
		const language = draft.bodyMode === 'json' ? 'json' : draft.bodyMode === 'xml' ? 'xml' : draft.bodyMode === 'graphql' ? 'graphql' : 'plaintext';
		this.bodyEditor = this.createCodeEditor(append(this.tabBody, $('.volt-http-code')), draft.body, language, false, this.tabStore);
		this.tabStore.add(this.bodyEditor.onDidChangeModelContent(() => this.change(next => next.body = this.bodyEditor!.getValue())));
		if (draft.bodyMode === 'graphql') {
			append(this.tabBody, $('.volt-http-sublabel')).textContent = localize('voltHttp.variables', "Variables (JSON)");
			const variables = this.createCodeEditor(append(this.tabBody, $('.volt-http-code.small')), draft.graphqlVariables, 'json', false, this.tabStore);
			this.tabStore.add(variables.onDidChangeModelContent(() => this.change(next => next.graphqlVariables = variables.getValue())));
		}
	}

	private renderAuth(): void {
		const auth = this.draft.auth;
		const top = append(this.tabBody, $('.volt-http-body-top'));
		createVoltDropdown<AuthMode>(top, this.contextViewService, {
			options: [
				{ id: 'none', label: localize('voltHttp.authNone', "No Auth") },
				{ id: 'bearer', label: localize('voltHttp.authBearer', "Bearer Token") },
				{ id: 'basic', label: localize('voltHttp.authBasic', "Basic Auth") },
				{ id: 'apikey', label: localize('voltHttp.authKey', "API Key") },
			],
			value: auth.mode,
			ariaLabel: localize('voltHttp.authMode', "Auth type"),
			width: 200,
			onChange: value => {
				this.change(next => next.auth.mode = value);
				this.renderTabs();
			},
		}, this.tabStore);
		const field = (label: string, value: string, update: (value: string, draft: IHttpDraft) => void, password = false) => {
			const row = append(this.tabBody, $('.volt-http-field'));
			append(row, $('label')).textContent = label;
			const box = this.tabStore.add(new InputBox(append(row, $('.volt-http-field-input')), this.contextViewService, { type: password ? 'password' : 'text', placeholder: localize('voltHttp.varHint', "Value or {{variable}}"), inputBoxStyles: defaultInputBoxStyles }));
			box.value = value;
			this.tabStore.add(box.onDidChange(next => this.change(draft => update(next, draft))));
		};
		switch (auth.mode) {
			case 'none':
				append(this.tabBody, $('.volt-http-empty')).textContent = localize('voltHttp.noAuth', "No authorization is sent.");
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
				const row = append(this.tabBody, $('.volt-http-field'));
				append(row, $('label')).textContent = localize('voltHttp.addTo', "Add to");
				createVoltDropdown<'header' | 'query'>(append(row, $('.volt-http-field-input')), this.contextViewService, {
					options: [{ id: 'header', label: localize('voltHttp.inHeader', "Header") }, { id: 'query', label: localize('voltHttp.inQuery', "Query Params") }],
					value: auth.keyIn,
					ariaLabel: localize('voltHttp.addTo', "Add to"),
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
		return editor;
	}

	private async send(): Promise<void> {
		const input = this.input as VoltHttpRequestInput | undefined;
		if (!input || !this.draft.url.trim()) {
			this.urlBox?.focus();
			return;
		}
		const cancel = new CancellationTokenSource();
		this.sending.value = cancel;
		this.renderBar();
		this.root.classList.add('sending');
		this.renderResponse();
		try {
			const spec = wireSpec(specFromDraft(this.draft, input.source?.line ?? 0));
			this.exchange = await this.http.send(spec, { ...(input.source ? { source: input.source.uri } : {}), token: cancel.token });
		} finally {
			if (this.sending.value === cancel) {
				this.sending.clear();
			}
			this.root.classList.remove('sending');
			this.renderBar();
			this.renderResponse();
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
	}

	private renderResponse(): void {
		this.responseStore.clear();
		this.responseEditor = undefined;
		clearNode(this.responseEl);
		if (this.sending.value) {
			const waiting = append(this.responseEl, $('.volt-http-waiting'));
			waiting.appendChild(renderIcon(ThemeIcon.modify(Codicon.loading, 'spin')));
			append(waiting, $('span')).textContent = localize('voltHttp.sending', "Sending request\u2026");
			return;
		}
		const exchange = this.exchange;
		if (!exchange) {
			const empty = append(this.responseEl, $('.volt-http-empty.response'));
			empty.appendChild(renderIcon(Codicon.send));
			append(empty, $('span')).textContent = localize('voltHttp.hint', "Send the request to see the response. Enter in the URL sends it.");
			return;
		}
		const status = append(this.responseEl, $('.volt-http-status'));
		if (exchange.error || !exchange.response) {
			const pill = append(status, $('span.volt-http-pill.error'));
			pill.textContent = localize('voltHttp.failed', "Failed");
			append(this.responseEl, $('.volt-http-error')).textContent = exchange.error ?? '';
			return;
		}
		const response = exchange.response;
		const pill = append(status, $('span.volt-http-pill'));
		pill.classList.add(response.status >= 500 ? 'error' : response.status >= 400 ? 'warn' : response.status >= 300 ? 'info' : 'ok');
		pill.textContent = `${response.status} ${response.statusText}`.trim();
		append(status, $('span.volt-http-metric')).textContent = `${response.durationMs} ms`;
		append(status, $('span.volt-http-metric')).textContent = formatBytes(response.size);
		const tabs = append(status, $('.volt-http-tabs.inline'));
		for (const [id, label] of [['body', localize('voltHttp.resBody', "Body")], ['headers', localize('voltHttp.resHeaders', "Headers ({0})", Object.keys(response.headers).length)], ['raw', localize('voltHttp.resRaw', "Raw")]] as const) {
			const tab = append(tabs, $('button.volt-http-tab')) as HTMLButtonElement;
			tab.type = 'button';
			tab.textContent = label;
			tab.classList.toggle('active', id === this.responseTab);
			tab.addEventListener('click', () => {
				this.responseTab = id;
				this.renderResponse();
			});
		}
		const copy = this.responseStore.add(createVoltButton(status, 'ghost', { supportIcons: true, title: localize('voltHttp.copy', "Copy body") }));
		copy.label = '$(copy)';
		this.responseStore.add(copy.onDidClick(() => void navigator.clipboard.writeText(response.body)));
		const type = Object.entries(response.headers).find(([key]) => key.toLowerCase() === 'content-type')?.[1] ?? '';
		if (this.responseTab === 'headers') {
			const table = append(this.responseEl, $('.volt-http-headers'));
			for (const [key, value] of Object.entries(response.headers)) {
				const row = append(table, $('.volt-http-header-row'));
				append(row, $('span.key')).textContent = key;
				append(row, $('span.value')).textContent = value;
			}
			return;
		}
		let text = response.body;
		let language = /json/.test(type) ? 'json' : /html/.test(type) ? 'html' : /xml/.test(type) ? 'xml' : /javascript/.test(type) ? 'javascript' : /css/.test(type) ? 'css' : 'plaintext';
		if (this.responseTab === 'body' && (language === 'json' || /^\s*[[{]/.test(text))) {
			try {
				text = JSON.stringify(JSON.parse(text), null, 2);
				language = 'json';
			} catch { /* keep as is */ }
		}
		if (this.responseTab === 'raw') {
			text = `HTTP ${response.status} ${response.statusText}\n${Object.entries(response.headers).map(([key, value]) => `${key}: ${value}`).join('\n')}\n\n${response.body}`;
			language = 'plaintext';
		}
		this.responseEditor = this.createCodeEditor(append(this.responseEl, $('.volt-http-code.response')), text, language, true, this.responseStore);
		this.layoutEditors();
	}

	override layout(dimension: Dimension): void {
		this.dimension = dimension;
		this.root.style.height = `${dimension.height}px`;
		this.layoutEditors();
	}

	/** Code editors size to their hosts (flex boxes); they need explicit layouts. */
	private layoutEditors(): void {
		if (!this.dimension) {
			return;
		}
		for (const editor of [this.bodyEditor, this.responseEditor]) {
			const host = editor?.getContainerDomNode().parentElement;
			if (editor && host) {
				editor.layout({ width: host.clientWidth, height: host.clientHeight });
			}
		}
		for (const host of this.tabBody.querySelectorAll<HTMLElement>('.volt-http-code.small')) {
			host.style.height = '120px';
		}
	}

	override focus(): void {
		super.focus();
		(this.draft.url ? this.sendButtonEl : this.urlBox?.inputElement)?.focus();
	}
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
