/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/voltHttpDocs.css';
import { $, addDisposableListener, append, EventType, getWindow } from '../../../../base/browser/dom.js';
import { renderIcon } from '../../../../base/browser/ui/iconLabel/iconLabels.js';
import { Action } from '../../../../base/common/actions.js';
import { raceCancellation, RunOnceScheduler } from '../../../../base/common/async.js';
import { CancellationToken, CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Disposable, DisposableStore, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { isMacintosh } from '../../../../base/common/platform.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { CodeEditorWidget } from '../../../../editor/browser/widget/codeEditor/codeEditorWidget.js';
import { IEditorOptions as ICodeEditorOptions } from '../../../../editor/common/config/editorOptions.js';
import { ILanguageService } from '../../../../editor/common/languages/language.js';
import { IModelService } from '../../../../editor/common/services/model.js';
import { localize } from '../../../../nls.js';
import { IContextViewService } from '../../../../platform/contextview/browser/contextView.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IAgentRuntimeService } from '../../../services/voltRuntime/common/runtime.js';
import { createVoltButton, voltButtonClasses } from '../../voltAgent/browser/chrome/voltButton.js';
import { IVoltDropdown } from '../../voltAgent/browser/ui/dropdown/voltDropdown.js';
import { HttpMdInline, httpMarkdownFromAnswer, looksLikeHttpMarkdown, parseHttpMarkdown, serializeHttpMarkdown } from '../common/httpMarkdown.js';
import { httpAiModelRef } from './voltHttpAiModel.js';
import { readHttpDocsBlocks, renderHttpDocsBlocks, renderHttpDocsInlines } from './voltHttpDocsDom.js';
import { createHttpDropdown, createHttpIconButton, showHttpActionMenu } from './voltHttpWidgets.js';

export interface IHttpDocsEditorOptions {
	/** Markdown. */
	readonly value: string;
	readonly placeholder?: string;
	readonly onChange: (markdown: string) => void;
	/** What the request is (method, URL, headers, body, last response), for "Write with AI". No link when absent. */
	readonly aiContext?: () => string | undefined;
}

/** The two ways to edit: rich text drawn from the Markdown, or the Markdown itself. */
export type HttpDocsMode = 'rich' | 'markdown';

type HttpDocsStyle = 'p' | 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6';
type HttpDocsCommand = 'bold' | 'italic' | 'strike' | 'bullets' | 'numbers' | 'link' | 'table' | 'image' | 'quote' | 'code' | 'codeBlock';

const MODE_KEY = 'volt.http.docsEditorMode';
/** How long typing may pause before the Markdown is written out. */
const CHANGE_DELAY = 150;
/** Under this width the less used buttons move into the "More" menu. */
const NARROW_WIDTH = 520;
const AI_TIMEOUT_MS = 120_000;
const MAX_CONTEXT = 12_000;
const ZERO_WIDTH_SPACE = String.fromCharCode(0x200b);
const NBSP = new RegExp(String.fromCharCode(0xa0), 'g');
const SVG_NS = 'http://www.w3.org/2000/svg';
const MOD = isMacintosh ? 'Cmd' : 'Ctrl';

/** Who the writer is; an agent's one-shot call would otherwise answer as a chat-title or coding agent. */
export const HTTP_DOCS_SYSTEM_PROMPT = 'You write API reference documentation in Markdown. You are given one HTTP request and reply with its documentation only: Markdown, no preamble, no closing remarks, no tool use, no questions.';

/** What the model is asked for: concise reference documentation of the request in `context`. */
export function httpDocsPrompt(context: string): string {
	const request = context.length > MAX_CONTEXT ? `${context.slice(0, MAX_CONTEXT)}\n... (cut)` : context;
	return [
		'Write the documentation of this API request in Markdown, the way a good API reference documents one endpoint.',
		'',
		'Rules:',
		'- Markdown only: no preamble, no closing remarks, no fence around the whole answer.',
		'- Start with one or two sentences on what the request does. No top-level title: the request already has a name.',
		'- Then short sections under `###` headings, only the ones that apply: Parameters (a table: name, in, type, required, description), Headers (a table), Body (a table of the fields, then a short example), Example response (a fenced code block with its language, cut down to what shows the shape), Errors (a table of the likely status codes and what they mean).',
		'- Read types and meaning from the URL, the values and the last response. Never invent fields or endpoints that are not shown; write "unknown" rather than guess.',
		'- Never repeat secrets: write a placeholder such as `{{token}}` for authorization values, API keys and cookies.',
		'- Concise: under 400 words outside code blocks.',
		'',
		'The request:',
		request,
	].join('\n');
}

export interface IHttpWrittenDocs {
	/** What the model wrote, as Markdown; partial when the call was cancelled. */
	readonly markdown: string;
	/** Why the text cannot be used. Absent for usable text, and for a cancelled call. */
	readonly failure?: string;
}

/**
 * Has `ref` write documentation for `prompt`. A chat model streams it (`onPartial` sees it grow);
 * an agent answers in one tool-less call of its own. Never throws.
 */
export async function writeHttpDocs(runtime: IAgentRuntimeService, ref: string, prompt: string, token: CancellationToken, onPartial?: (markdown: string) => void): Promise<IHttpWrittenDocs> {
	let answer = '';
	let failure: string | undefined;
	try {
		if (runtime.resolveCatalogItem(ref)?.kind === 'agent') {
			const text = await raceCancellation(runtime.generateText(prompt, { ref, systemPrompt: HTTP_DOCS_SYSTEM_PROMPT, timeoutMs: AI_TIMEOUT_MS - 5000 }), token);
			if (text === undefined && !token.isCancellationRequested) {
				failure = localize('voltHttp.docsAiAgentFailed', "{0} did not answer. Check that it is signed in, or pick another model.", runtime.resolveCatalogItem(ref)?.label ?? ref);
			}
			answer = text ?? '';
		} else {
			for await (const event of runtime.streamModel(ref, [{ role: 'system', content: HTTP_DOCS_SYSTEM_PROMPT }, { role: 'user', content: prompt }], runtime.getModelOptions(ref), token, 'code')) {
				if (token.isCancellationRequested) {
					break;
				}
				if (event.type === 'text.delta' && event.delta) {
					answer += event.delta;
					onPartial?.(httpMarkdownFromAnswer(answer));
				} else if (event.type === 'error') {
					failure = event.message;
					break;
				}
			}
		}
	} catch (err) {
		failure = err instanceof Error ? err.message : String(err);
	}
	const markdown = httpMarkdownFromAnswer(answer);
	if (token.isCancellationRequested) {
		return { markdown };
	}
	if (!failure && !markdown.trim()) {
		failure = localize('voltHttp.docsAiEmpty', "The model did not answer with documentation. Try another model.");
	}
	return { markdown, ...(failure ? { failure } : {}) };
}

/** Markdown in the one form the editor writes, so what a model wrote reads back unchanged. */
export function canonicalHttpDocs(markdown: string): string {
	return serializeHttpMarkdown(parseHttpMarkdown(markdown));
}

const SOURCE_OPTIONS: ICodeEditorOptions = {
	minimap: { enabled: false },
	scrollBeyondLastLine: false,
	lineNumbers: 'off',
	lineDecorationsWidth: 8,
	glyphMargin: false,
	folding: false,
	wordWrap: 'on',
	renderLineHighlight: 'none',
	overviewRulerLanes: 0,
	hideCursorInOverviewRuler: true,
	scrollbar: { verticalScrollbarSize: 8, horizontalScrollbarSize: 8, alwaysConsumeMouseWheel: false },
	fontSize: 13,
	lineHeight: 20,
	padding: { top: 10, bottom: 10 },
	automaticLayout: false,
	fixedOverflowWidgets: true,
	unicodeHighlight: { ambiguousCharacters: false, invisibleCharacters: false },
};

/** A small line icon in currentColor, for the marks codicons do not have. */
function lineIcon(paths: readonly string[], rect?: Record<string, string>): () => SVGElement {
	return () => {
		const svg = document.createElementNS(SVG_NS, 'svg');
		svg.classList.add('volt-http-svg-icon');
		svg.setAttribute('viewBox', '0 0 16 16');
		svg.setAttribute('width', '16');
		svg.setAttribute('height', '16');
		svg.setAttribute('fill', 'none');
		svg.setAttribute('stroke', 'currentColor');
		svg.setAttribute('stroke-width', '1.2');
		svg.setAttribute('stroke-linecap', 'round');
		svg.setAttribute('stroke-linejoin', 'round');
		svg.setAttribute('aria-hidden', 'true');
		if (rect) {
			const element = document.createElementNS(SVG_NS, 'rect');
			for (const [name, value] of Object.entries(rect)) {
				element.setAttribute(name, value);
			}
			svg.appendChild(element);
		}
		for (const d of paths) {
			const path = document.createElementNS(SVG_NS, 'path');
			path.setAttribute('d', d);
			svg.appendChild(path);
		}
		return svg;
	};
}

const STRIKE_ICON = lineIcon(['M10.8 4.6C10.3 3.7 9.3 3.2 8 3.2c-1.7 0-2.9.9-2.9 2.2 0 .9.5 1.5 1.5 1.9', 'M5.1 11.3c.5 1 1.6 1.6 3 1.6 1.8 0 3-.9 3-2.3 0-.5-.2-1-.5-1.4', 'M2.5 8.2h11']);
const CODE_BLOCK_ICON = lineIcon(['M6.3 6.2 4.5 8l1.8 1.8', 'M9.7 6.2 11.5 8l-1.8 1.8'], { x: '1.5', y: '2.5', width: '13', height: '11', rx: '1.5' });

interface IToolbarButton {
	readonly command: HttpDocsCommand;
	readonly icon: ThemeIcon | (() => SVGElement);
	readonly label: string;
	/** Hidden in a narrow pane, where the "More" menu offers it instead. */
	readonly secondary: boolean;
}

/** Elements that hold one line of text the caret can be in. */
const TEXT_BLOCK = /^(P|DIV|H[1-6]|LI|PRE|TD|TH)$/;

/**
 * The Docs tab: the request's Markdown description, edited either as rich text (a contenteditable
 * drawn from the parsed Markdown and read back into Markdown as the user types) or as Markdown in a
 * code editor. The file always keeps Markdown, which is what Postman stores.
 */
export class HttpDocsEditor extends Disposable {

	readonly element: HTMLElement;

	private value: string;
	private mode: HttpDocsMode;
	/** The rich text has edits not yet written out as Markdown. */
	private dirty = false;
	private writing = false;
	private height = 0;
	private savedRange: Range | undefined;
	private settingSource = false;

	private readonly bar: HTMLElement;
	private readonly styleDropdown: IVoltDropdown<HttpDocsStyle>;
	private readonly modeDropdown: IVoltDropdown<HttpDocsMode>;
	private readonly buttons = new Map<HttpDocsCommand, HTMLButtonElement>();
	private readonly aiButton: HTMLButtonElement | undefined;
	private readonly status: HTMLElement;
	private readonly statusText: HTMLElement;
	private readonly statusCancel: HTMLButtonElement;
	private readonly body: HTMLElement;
	private readonly surface: HTMLElement;
	private readonly empty: HTMLElement;
	private readonly sourceHost: HTMLElement;
	private sourceEditor: CodeEditorWidget | undefined;

	private readonly changeScheduler = this._register(new RunOnceScheduler(() => this.flush(), CHANGE_DELAY));
	private readonly partialScheduler = this._register(new RunOnceScheduler(() => this.drawPartial(), 120));
	private partial = '';
	private readonly source = this._register(new MutableDisposable<DisposableStore>());
	private readonly popover = this._register(new MutableDisposable<DisposableStore>());
	private readonly menu = this._register(new MutableDisposable());
	private readonly aiRun = this._register(new MutableDisposable());

	constructor(
		parent: HTMLElement,
		private readonly options: IHttpDocsEditorOptions,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IContextViewService private readonly contextViewService: IContextViewService,
		@IStorageService private readonly storage: IStorageService,
		@IOpenerService private readonly openerService: IOpenerService,
		@IDialogService private readonly dialogService: IDialogService,
		@IAgentRuntimeService private readonly runtime: IAgentRuntimeService,
		@ILanguageService private readonly languageService: ILanguageService,
		@IModelService private readonly modelService: IModelService,
	) {
		super();
		this.value = options.value;
		this.mode = storage.get(MODE_KEY, StorageScope.PROFILE) === 'markdown' ? 'markdown' : 'rich';

		this.element = append(parent, $('.volt-http-docs-editor'));
		this._register(toDisposable(() => this.element.remove()));

		// --- Toolbar ---
		const barRow = append(this.element, $('.volt-http-docs-bar-row'));
		this.bar = append(barRow, $('.volt-http-docs-bar'));
		this.bar.setAttribute('role', 'toolbar');
		this.bar.setAttribute('aria-label', localize('voltHttp.docsToolbar', "Formatting"));
		// Pressing a button must not take the caret out of the text it formats.
		this._register(addDisposableListener(this.bar, EventType.MOUSE_DOWN, e => {
			if (this.mode === 'rich' && (e.target as HTMLElement).closest('button')) {
				e.preventDefault();
			}
		}));

		const styles: { id: HttpDocsStyle; label: string }[] = [
			{ id: 'p', label: localize('voltHttp.docsNormal', "Normal text") },
			{ id: 'h1', label: localize('voltHttp.docsH1', "Heading 1") },
			{ id: 'h2', label: localize('voltHttp.docsH2', "Heading 2") },
			{ id: 'h3', label: localize('voltHttp.docsH3', "Heading 3") },
			{ id: 'h4', label: localize('voltHttp.docsH4', "Heading 4") },
			{ id: 'h5', label: localize('voltHttp.docsH5', "Heading 5") },
			{ id: 'h6', label: localize('voltHttp.docsH6', "Heading 6") },
		];
		const styleHost = append(this.bar, $('.volt-http-docs-style'));
		this.styleDropdown = createHttpDropdown(styleHost, this.contextViewService, {
			options: styles,
			value: 'p',
			ariaLabel: localize('voltHttp.docsStyle', "Text style"),
			align: 'left',
			width: 180,
			searchFrom: 99,
			onChange: style => this.applyStyle(style),
		}, this._store);

		const groups: IToolbarButton[][] = [
			[
				{ command: 'bold', icon: Codicon.bold, label: localize('voltHttp.docsBold', "Bold ({0}+B)", MOD), secondary: false },
				{ command: 'italic', icon: Codicon.italic, label: localize('voltHttp.docsItalic', "Italic ({0}+I)", MOD), secondary: false },
				{ command: 'strike', icon: STRIKE_ICON, label: localize('voltHttp.docsStrike', "Strikethrough ({0}+Shift+X)", MOD), secondary: true },
			],
			[
				{ command: 'bullets', icon: Codicon.listUnordered, label: localize('voltHttp.docsBullets', "Bulleted list"), secondary: false },
				{ command: 'numbers', icon: Codicon.listOrdered, label: localize('voltHttp.docsNumbers', "Numbered list"), secondary: false },
			],
			[
				{ command: 'link', icon: Codicon.link, label: localize('voltHttp.docsLink', "Link ({0}+K)", MOD), secondary: true },
				{ command: 'table', icon: Codicon.table, label: localize('voltHttp.docsTable', "Table"), secondary: true },
				{ command: 'image', icon: Codicon.fileMedia, label: localize('voltHttp.docsImage', "Image"), secondary: true },
			],
			[
				{ command: 'quote', icon: Codicon.quote, label: localize('voltHttp.docsQuote', "Quote"), secondary: true },
				{ command: 'code', icon: Codicon.code, label: localize('voltHttp.docsCode', "Inline code ({0}+E)", MOD), secondary: true },
				{ command: 'codeBlock', icon: CODE_BLOCK_ICON, label: localize('voltHttp.docsCodeBlock', "Code block"), secondary: true },
			],
		];
		for (const group of groups) {
			const separator = append(this.bar, $('span.volt-http-docs-sep'));
			separator.classList.toggle('secondary', group.every(button => button.secondary));
			for (const spec of group) {
				const button = createHttpIconButton(this.bar, spec.icon, spec.label, () => this.run(spec.command));
				button.classList.add('volt-http-docs-button');
				button.classList.toggle('secondary', spec.secondary);
				button.setAttribute('aria-pressed', 'false');
				this.buttons.set(spec.command, button);
			}
		}
		const more = createHttpIconButton(this.bar, Codicon.ellipsis, localize('voltHttp.docsMore', "More formatting"), anchor => {
			const actions = groups.flat().filter(spec => spec.secondary).map(spec => new Action(`voltHttp.docs.${spec.command}`, spec.label, undefined, this.mode === 'rich' && !this.writing, async () => this.run(spec.command)));
			this.menu.value = showHttpActionMenu(this.contextViewService, anchor, this.element, actions, localize('voltHttp.docsMoreMenu', "More formatting"));
		});
		more.classList.add('volt-http-docs-button', 'volt-http-docs-more');

		append(this.bar, $('.volt-http-docs-spacer'));
		if (options.aiContext) {
			const ai = append(this.bar, $('button.volt-http-docs-ai')) as HTMLButtonElement;
			ai.classList.add(...voltButtonClasses('ghost'));
			ai.type = 'button';
			const label = localize('voltHttp.docsAi', "Write with AI");
			ai.title = label;
			ai.setAttribute('aria-label', label);
			ai.appendChild(renderIcon(Codicon.wand));
			append(ai, $('span.volt-http-docs-ai-label')).textContent = label;
			this._register(addDisposableListener(ai, EventType.CLICK, () => void this.writeWithAi()));
			this.aiButton = ai;
		}
		const modeHost = append(this.bar, $('.volt-http-docs-mode'));
		this.modeDropdown = createHttpDropdown(modeHost, this.contextViewService, {
			options: [
				{ id: 'rich', label: localize('voltHttp.docsRich', "Volt editor"), description: localize('voltHttp.docsRichDesc', "Rich text, saved as Markdown"), icon: Codicon.edit },
				{ id: 'markdown', label: localize('voltHttp.docsMarkdown', "Markdown"), description: localize('voltHttp.docsMarkdownDesc', "The Markdown source"), icon: Codicon.markdown },
			],
			value: this.mode,
			ariaLabel: localize('voltHttp.docsMode', "Editor"),
			align: 'right',
			width: 230,
			onChange: mode => this.setMode(mode),
		}, this._store);

		// --- Status of a running "Write with AI" ---
		this.status = append(this.element, $('.volt-http-docs-status'));
		this.status.setAttribute('role', 'status');
		this.statusText = append(this.status, $('span.volt-http-docs-status-text'));
		this.statusCancel = append(this.status, $('button.volt-http-link')) as HTMLButtonElement;
		this.statusCancel.type = 'button';
		this.statusCancel.textContent = localize('voltHttp.docsAiCancel', "Cancel");
		this._register(addDisposableListener(this.statusCancel, EventType.CLICK, () => this.aiRun.clear()));
		this.setStatus('');

		// --- Rich text ---
		this.body = append(this.element, $('.volt-http-docs-body'));
		const page = append(this.body, $('.volt-http-docs-page'));
		this.surface = append(page, $('.volt-http-docs-surface'));
		this.surface.contentEditable = 'true';
		this.surface.spellcheck = true;
		this.surface.setAttribute('role', 'textbox');
		this.surface.setAttribute('aria-multiline', 'true');
		this.surface.setAttribute('aria-label', localize('voltHttp.docsLabel', "Documentation"));
		this.empty = append(page, $('.volt-http-docs-empty'));
		append(this.empty, $('span.volt-http-docs-placeholder')).textContent = options.placeholder ?? localize('voltHttp.docsDefaultPlaceholder', "Document this request");
		if (options.aiContext) {
			const link = append(this.empty, $('button.volt-http-link.volt-http-docs-empty-ai')) as HTMLButtonElement;
			link.type = 'button';
			link.textContent = localize('voltHttp.docsAiLink', "Write with AI");
			this._register(addDisposableListener(link, EventType.CLICK, () => void this.writeWithAi()));
		}
		this.registerRichListeners();

		// --- Markdown source ---
		this.sourceHost = append(this.element, $('.volt-http-docs-source'));

		this.showMode();
	}

	// --- Contract --------------------------------------------------------------------------------

	/** Replaces the content without calling `onChange`. */
	setValue(markdown: string): void {
		if (markdown === this.value && !this.dirty) {
			return;
		}
		this.changeScheduler.cancel();
		this.dirty = false;
		this.value = markdown;
		if (this.mode === 'rich') {
			this.renderRich(markdown);
		} else {
			this.setSource(markdown);
		}
		this.updateEmpty();
	}

	layout(width: number, height: number): void {
		this.height = height;
		this.element.classList.toggle('narrow', width > 0 && width < NARROW_WIDTH);
		this.layoutSource();
	}

	focus(): void {
		if (this.mode === 'markdown') {
			this.sourceEditor?.focus();
		} else {
			this.restoreSelection();
		}
	}

	/** The Markdown as it stands, edits not yet written out included. */
	getValue(): string {
		this.flush();
		return this.value;
	}

	/** The mode in use. */
	getMode(): HttpDocsMode {
		return this.mode;
	}

	// --- Modes -----------------------------------------------------------------------------------

	setMode(mode: HttpDocsMode): void {
		if (mode === this.mode) {
			return;
		}
		this.flush();
		this.popover.clear();
		this.mode = mode;
		this.storage.store(MODE_KEY, mode, StorageScope.PROFILE, StorageTarget.USER);
		this.modeDropdown.set(mode);
		this.showMode();
		this.focus();
	}

	private showMode(): void {
		const markdown = this.mode === 'markdown';
		this.element.classList.toggle('markdown', markdown);
		if (markdown) {
			this.surface.replaceChildren();
			this.savedRange = undefined;
			this.createSource();
		} else {
			this.source.clear();
			this.sourceEditor = undefined;
			this.renderRich(this.value);
		}
		this.updateToolbar();
		this.updateEmpty();
		this.layoutSource();
	}

	private createSource(): void {
		const store = new DisposableStore();
		this.source.value = store;
		const editor = store.add(this.instantiationService.createInstance(CodeEditorWidget, this.sourceHost, { ...SOURCE_OPTIONS, placeholder: this.options.placeholder ?? localize('voltHttp.docsSourcePlaceholder', "Document this request") }, { isSimpleWidget: false }));
		const languageId = this.languageService.isRegisteredLanguageId('markdown') ? 'markdown' : 'plaintext';
		editor.setModel(store.add(this.modelService.createModel(this.value, this.languageService.createById(languageId), undefined)));
		store.add(editor.onDidChangeModelContent(() => {
			if (!this.settingSource) {
				this.dirty = true;
				this.changeScheduler.schedule();
				this.updateEmpty();
			}
		}));
		store.add(editor.onDidBlurEditorText(() => this.flush()));
		// A save or send with the modifier writes the last keystrokes out first.
		store.add(editor.onKeyDown(e => {
			if (e.metaKey || e.ctrlKey) {
				this.flush();
			}
		}));
		store.add(toDisposable(() => this.sourceHost.replaceChildren()));
		this.sourceEditor = editor;
	}

	private setSource(markdown: string): void {
		const model = this.sourceEditor?.getModel();
		if (!model || model.getValue() === markdown) {
			return;
		}
		this.settingSource = true;
		try {
			model.setValue(markdown);
		} finally {
			this.settingSource = false;
		}
	}

	private layoutSource(): void {
		if (this.sourceEditor && this.height) {
			this.sourceEditor.layout({ width: this.sourceHost.clientWidth, height: this.sourceHost.clientHeight });
		}
	}

	// --- Writing Markdown out --------------------------------------------------------------------

	private edited(): void {
		this.dirty = true;
		this.changeScheduler.schedule();
		this.updateEmpty();
		this.updateActive();
	}

	private flush(): void {
		this.changeScheduler.cancel();
		if (!this.dirty || this.writing) {
			return;
		}
		this.dirty = false;
		const next = this.mode === 'rich' ? serializeHttpMarkdown(readHttpDocsBlocks(this.surface)) : this.sourceEditor?.getValue() ?? this.value;
		if (next !== this.value) {
			this.value = next;
			this.options.onChange(next);
		}
	}

	// --- Rich text: drawing ----------------------------------------------------------------------

	private get doc(): Document {
		return this.surface.ownerDocument;
	}

	private renderRich(markdown: string): void {
		this.surface.replaceChildren();
		this.savedRange = undefined;
		renderHttpDocsBlocks(this.surface, parseHttpMarkdown(markdown));
		this.ensureEditableEnd();
	}

	/** A line to put the caret on after a last block that cannot hold one (code, table, rule), or in an empty document. */
	private ensureEditableEnd(): void {
		const last = this.surface.lastElementChild;
		if (!last || /^(PRE|TABLE|HR|UL|OL|BLOCKQUOTE)$/.test(last.tagName)) {
			this.surface.appendChild(this.emptyParagraph());
		}
	}

	private emptyParagraph(): HTMLElement {
		const paragraph = this.doc.createElement('p');
		paragraph.appendChild(this.doc.createElement('br'));
		return paragraph;
	}

	private hasContent(): boolean {
		if (this.mode === 'markdown') {
			return !!(this.sourceEditor?.getValue() ?? this.value).trim();
		}
		return !!this.surface.textContent?.replace(new RegExp(ZERO_WIDTH_SPACE, 'g'), '').trim() || !!this.surface.querySelector('img, table, hr, pre, li, blockquote');
	}

	private updateEmpty(): void {
		const content = this.hasContent();
		this.empty.classList.toggle('hidden', this.mode !== 'rich' || content || this.writing);
		this.aiButton?.classList.toggle('hidden', !content && this.mode === 'rich' && !this.writing);
	}

	private updateToolbar(): void {
		const rich = this.mode === 'rich' && !this.writing;
		for (const button of this.buttons.values()) {
			button.disabled = !rich;
		}
		this.bar.querySelector<HTMLButtonElement>('.volt-http-docs-more')!.disabled = !rich;
		this.styleDropdown.element.disabled = !rich;
		this.modeDropdown.element.disabled = this.writing;
		if (this.aiButton) {
			this.aiButton.disabled = this.writing;
		}
		this.surface.contentEditable = this.writing ? 'false' : 'true';
		this.sourceEditor?.updateOptions({ readOnly: this.writing });
		this.updateActive();
	}

	// --- Rich text: selection --------------------------------------------------------------------

	private selection(): Selection | null {
		return getWindow(this.surface).getSelection();
	}

	/** The selection's range when it is in the text. */
	private currentRange(): Range | undefined {
		const selection = this.selection();
		if (!selection?.rangeCount) {
			return undefined;
		}
		const range = selection.getRangeAt(0);
		return this.surface.contains(range.startContainer) && this.surface.contains(range.endContainer) ? range : undefined;
	}

	/** Puts the focus back in the text, with the selection it had (or the caret at the end). */
	private restoreSelection(): void {
		this.surface.focus({ preventScroll: true });
		const selection = this.selection();
		if (!selection) {
			return;
		}
		const saved = this.savedRange;
		if (saved && this.surface.contains(saved.startContainer) && this.surface.contains(saved.endContainer)) {
			selection.removeAllRanges();
			selection.addRange(saved);
		} else if (!this.currentRange()) {
			this.placeCaretAtEnd(this.surface.lastElementChild ?? this.surface);
		}
	}

	private placeCaret(node: Node, offset: number): void {
		const selection = this.selection();
		const range = this.doc.createRange();
		range.setStart(node, offset);
		range.collapse(true);
		selection?.removeAllRanges();
		selection?.addRange(range);
		this.savedRange = range.cloneRange();
	}

	private placeCaretAtEnd(element: Node): void {
		const range = this.doc.createRange();
		range.selectNodeContents(element);
		range.collapse(false);
		const selection = this.selection();
		selection?.removeAllRanges();
		selection?.addRange(range);
		this.savedRange = range.cloneRange();
	}

	private anchorElement(): HTMLElement | undefined {
		const range = this.currentRange() ?? this.savedRange;
		let node: Node | null | undefined = range?.startContainer;
		if (node && node.nodeType !== 1) {
			node = node.parentNode;
		}
		return node && this.surface.contains(node) ? node as HTMLElement : undefined;
	}

	/** The nearest element matching `selector` around the caret, inside the text. */
	private closest(selector: string): HTMLElement | undefined {
		const found = this.anchorElement()?.closest(selector) as HTMLElement | null | undefined;
		return found && found !== this.surface && this.surface.contains(found) ? found : undefined;
	}

	/** The element holding the caret's line. */
	private textBlock(): HTMLElement | undefined {
		for (let node: HTMLElement | null | undefined = this.anchorElement(); node && node !== this.surface; node = node.parentElement) {
			if (TEXT_BLOCK.test(node.tagName)) {
				return node;
			}
		}
		return undefined;
	}

	/** The child of the text the caret is in. */
	private topBlock(node: Node | undefined): HTMLElement | undefined {
		let current: Node | null | undefined = node;
		while (current && current.parentNode !== this.surface) {
			current = current.parentNode;
		}
		return current && current.nodeType === 1 ? current as HTMLElement : undefined;
	}

	private textBeforeCaret(block: HTMLElement): string {
		const selection = this.selection();
		if (!selection?.rangeCount || !selection.anchorNode) {
			return '';
		}
		const range = this.doc.createRange();
		range.setStart(block, 0);
		try {
			range.setEnd(selection.anchorNode, selection.anchorOffset);
		} catch {
			return '';
		}
		return range.toString().replace(NBSP, ' ').replace(new RegExp(ZERO_WIDTH_SPACE, 'g'), '');
	}

	private textAfterCaret(block: HTMLElement): string {
		const selection = this.selection();
		if (!selection?.rangeCount || !selection.focusNode) {
			return '';
		}
		const range = this.doc.createRange();
		range.selectNodeContents(block);
		try {
			range.setStart(selection.focusNode, selection.focusOffset);
		} catch {
			return '';
		}
		return range.toString();
	}

	private updateActive(): void {
		const rich = this.mode === 'rich' && !this.writing;
		const element = rich ? this.anchorElement() : undefined;
		const on = new Set<HttpDocsCommand>();
		let style: HttpDocsStyle = 'p';
		let listSeen = false;
		for (let node: HTMLElement | null | undefined = element; node && node !== this.surface; node = node.parentElement) {
			const tag = node.tagName;
			const weight = node.style.fontWeight;
			if (tag === 'B' || tag === 'STRONG' || weight === 'bold' || Number(weight) >= 600) {
				on.add('bold');
			}
			if (tag === 'I' || tag === 'EM' || node.style.fontStyle === 'italic') {
				on.add('italic');
			}
			if (tag === 'S' || tag === 'STRIKE' || tag === 'DEL' || node.style.textDecorationLine.includes('line-through')) {
				on.add('strike');
			}
			if (tag === 'A') {
				on.add('link');
			} else if (tag === 'CODE') {
				on.add('code');
			} else if (tag === 'PRE') {
				on.add('codeBlock');
			} else if (tag === 'BLOCKQUOTE') {
				on.add('quote');
			} else if (tag === 'TABLE') {
				on.add('table');
			} else if ((tag === 'UL' || tag === 'OL') && !listSeen) {
				listSeen = true;
				on.add(tag === 'UL' ? 'bullets' : 'numbers');
			} else if (/^H[1-6]$/.test(tag) && style === 'p') {
				style = tag.toLowerCase() as HttpDocsStyle;
			}
		}
		if (on.has('codeBlock')) {
			on.delete('code');
		}
		for (const [command, button] of this.buttons) {
			const active = on.has(command);
			button.classList.toggle('checked', active);
			button.setAttribute('aria-pressed', String(active));
		}
		if (this.styleDropdown.value !== style) {
			this.styleDropdown.set(style);
		}
	}

	// --- Rich text: events -----------------------------------------------------------------------

	private registerRichListeners(): void {
		const surface = this.surface;
		this._register(addDisposableListener(surface, EventType.FOCUS, () => {
			try {
				this.doc.execCommand('defaultParagraphSeparator', false, 'p');
				this.doc.execCommand('styleWithCSS', false, 'false');
			} catch {
				// Engines without these keep their defaults.
			}
		}));
		this._register(addDisposableListener(surface, EventType.BLUR, () => this.flush()));
		this._register(addDisposableListener(surface, 'input', e => this.onInput(e as InputEvent)));
		this._register(addDisposableListener(surface, EventType.KEY_DOWN, e => this.onKeyDown(e)));
		this._register(addDisposableListener(surface, 'paste', e => this.onPaste(e as ClipboardEvent)));
		this._register(addDisposableListener(surface, 'drop', e => this.onDrop(e as DragEvent)));
		this._register(addDisposableListener(surface, EventType.CLICK, e => this.onClick(e)));
		this._register(addDisposableListener(this.body, EventType.MOUSE_DOWN, e => {
			// A click in the margin around the text puts the caret at its end.
			if ((e.target === this.body || (e.target as HTMLElement).classList.contains('volt-http-docs-page')) && this.mode === 'rich' && !this.writing) {
				e.preventDefault();
				surface.focus({ preventScroll: true });
				this.placeCaretAtEnd(surface.lastElementChild ?? surface);
			}
		}));
		this._register(addDisposableListener(this.doc, 'selectionchange', () => {
			const range = this.currentRange();
			if (range) {
				this.savedRange = range.cloneRange();
				this.updateActive();
			}
		}));
	}

	private onInput(e: InputEvent): void {
		if (e.inputType === 'insertText' && e.data === ' ') {
			this.blockShortcut(false);
		}
		this.edited();
	}

	private onKeyDown(e: KeyboardEvent): void {
		if (e.isComposing || e.keyCode === 229) {
			return;
		}
		const mod = isMacintosh ? e.metaKey : e.ctrlKey;
		const key = e.key.toLowerCase();
		const handled = (run: () => void) => {
			// Before the edit: an edit made while the key is still being delivered can deliver it again.
			e.preventDefault();
			e.stopPropagation();
			run();
		};
		if (mod && !e.altKey) {
			if (!e.shiftKey && key === 'b') { handled(() => this.run('bold')); return; }
			if (!e.shiftKey && key === 'i') { handled(() => this.run('italic')); return; }
			if (!e.shiftKey && key === 'u') { handled(() => undefined); return; }
			if (!e.shiftKey && key === 'k') { handled(() => this.run('link')); return; }
			if (!e.shiftKey && key === 'e') { handled(() => this.run('code')); return; }
			if (e.shiftKey && key === 'x') { handled(() => this.run('strike')); return; }
			if (key === 'a' || key === 'z' || key === 'y' || key === 'c' || key === 'v' || key === 'x') {
				// The text's own select-all, undo and clipboard.
				e.stopPropagation();
				return;
			}
			// Save, send and the rest go on to the workbench with the last keystrokes written out.
			this.flush();
			return;
		}
		if (e.key === 'Tab' && !mod && !e.altKey) {
			const cell = this.closest('td, th');
			if (cell) {
				handled(() => this.moveCell(cell, e.shiftKey));
				return;
			}
			if (this.closest('li')) {
				handled(() => {
					this.doc.execCommand(e.shiftKey ? 'outdent' : 'indent');
					this.edited();
				});
				return;
			}
			if (this.closest('pre') && !e.shiftKey) {
				handled(() => {
					this.doc.execCommand('insertText', false, '\t');
					this.edited();
				});
				return;
			}
			return;
		}
		if (e.key === 'Enter' && !e.shiftKey && !mod && !e.altKey) {
			const pre = this.closest('pre');
			if (pre) {
				handled(() => this.enterInCode(pre));
				return;
			}
			const block = this.textBlock();
			if (block && /^```[^\s`]*$/.test(this.textBeforeCaret(block)) && !this.textAfterCaret(block).trim()) {
				handled(() => this.blockShortcut(true));
				return;
			}
		}
		if (e.key === 'Backspace' && !mod && !e.altKey) {
			const block = this.textBlock();
			const selection = this.selection();
			if (block && selection?.isCollapsed && !this.textBeforeCaret(block) && (/^(H[1-6]|PRE)$/.test(block.tagName) || (block.tagName !== 'LI' && this.closest('blockquote')))) {
				// Backspace at the start of a heading, code block or quote turns it back into text first.
				handled(() => {
					this.doc.execCommand('formatBlock', false, 'p');
					this.edited();
				});
				return;
			}
		}
	}

	private onClick(e: MouseEvent): void {
		const link = (e.target as HTMLElement).closest?.('a');
		if (!link || !this.surface.contains(link) || !(isMacintosh ? e.metaKey : e.ctrlKey)) {
			return;
		}
		const href = (link as HTMLElement).dataset.href ?? link.getAttribute('href') ?? '';
		if (href) {
			e.preventDefault();
			e.stopPropagation();
			void this.openerService.open(href, { allowCommands: false });
		}
	}

	private onPaste(e: ClipboardEvent): void {
		const data = e.clipboardData;
		if (!data) {
			return;
		}
		// Never the clipboard's HTML: plain text, or its Markdown read through the parser.
		e.preventDefault();
		e.stopPropagation();
		if (this.writing) {
			return;
		}
		const text = data.getData('text/plain').replace(/\r\n?/g, '\n');
		if (!text) {
			return;
		}
		if (this.closest('pre') || this.closest('code') || !looksLikeHttpMarkdown(text)) {
			this.doc.execCommand('insertText', false, text);
		} else {
			this.insertMarkdown(text);
		}
		this.edited();
	}

	private onDrop(e: DragEvent): void {
		e.preventDefault();
		e.stopPropagation();
		const text = e.dataTransfer?.getData('text/plain');
		if (!text || this.writing) {
			return;
		}
		const at = (this.doc as Document & { caretRangeFromPoint?(x: number, y: number): Range | null }).caretRangeFromPoint?.(e.clientX, e.clientY);
		if (at && this.surface.contains(at.startContainer)) {
			this.surface.focus({ preventScroll: true });
			this.placeCaret(at.startContainer, at.startOffset);
		}
		this.doc.execCommand('insertText', false, text);
		this.edited();
	}

	// --- Rich text: commands ---------------------------------------------------------------------

	private run(command: HttpDocsCommand): void {
		if (this.mode !== 'rich' || this.writing) {
			return;
		}
		this.restoreSelection();
		const doc = this.doc;
		switch (command) {
			case 'bold': doc.execCommand('bold'); break;
			case 'italic': doc.execCommand('italic'); break;
			case 'strike': doc.execCommand('strikeThrough'); break;
			case 'bullets': this.toggleList(false); break;
			case 'numbers': this.toggleList(true); break;
			case 'quote': doc.execCommand('formatBlock', false, this.closest('blockquote') ? 'p' : 'blockquote'); break;
			case 'codeBlock': this.toggleCodeBlock(); break;
			case 'code': this.toggleInlineCode(); break;
			case 'table': this.insertTable(); break;
			case 'link': this.editLink(); return;
			case 'image': this.editImage(); return;
		}
		this.edited();
	}

	private applyStyle(style: HttpDocsStyle): void {
		if (this.mode !== 'rich' || this.writing) {
			return;
		}
		this.restoreSelection();
		this.doc.execCommand('formatBlock', false, style);
		this.edited();
	}

	private toggleList(ordered: boolean): void {
		const list = this.closest('ul, ol');
		const same = list && (list.tagName === 'OL') === ordered;
		this.doc.execCommand(ordered ? 'insertOrderedList' : 'insertUnorderedList');
		if (!same) {
			this.ensureEditableEnd();
		}
	}

	private toggleCodeBlock(): void {
		if (this.closest('pre')) {
			this.doc.execCommand('formatBlock', false, 'p');
			return;
		}
		this.doc.execCommand('formatBlock', false, 'pre');
		this.prepareCodeBlock(this.closest('pre'));
	}

	/** A new code block: no spell checking, and the extra line end that lets its last line be empty. */
	private prepareCodeBlock(pre: HTMLElement | undefined, language?: string): void {
		if (!pre) {
			return;
		}
		pre.spellcheck = false;
		if (language) {
			pre.dataset.language = language;
		}
		if (!(pre.textContent ?? '').endsWith('\n')) {
			const selection = this.selection();
			const caret = selection?.rangeCount ? selection.getRangeAt(0).cloneRange() : undefined;
			if (pre.lastChild?.nodeName === 'BR') {
				pre.lastChild.remove();
			}
			pre.appendChild(this.doc.createTextNode('\n'));
			if (caret && pre.contains(caret.startContainer)) {
				selection?.removeAllRanges();
				selection?.addRange(caret);
			} else {
				this.placeCaret(pre.firstChild ?? pre, 0);
			}
		}
		this.ensureEditableEnd();
	}

	/** Enter in code is a line end; Enter on an empty last line leaves the block for a paragraph under it. */
	private enterInCode(pre: HTMLElement): void {
		const before = this.textBeforeCaret(pre);
		const after = this.textAfterCaret(pre);
		if (before.endsWith('\n') && (after === '' || after === '\n')) {
			this.doc.execCommand('delete');
			let next = pre.nextElementSibling as HTMLElement | null;
			if (!next || next.tagName !== 'P' || this.hasText(next)) {
				next = this.emptyParagraph();
				pre.after(next);
			}
			this.placeCaret(next, 0);
		} else {
			// In text that keeps its line ends this is a plain '\n' (insertText would split the block).
			this.doc.execCommand('insertLineBreak');
		}
		this.edited();
	}

	private hasText(element: HTMLElement): boolean {
		return !!element.textContent?.replace(new RegExp(ZERO_WIDTH_SPACE, 'g'), '').trim();
	}

	private toggleInlineCode(): void {
		const existing = this.closest('code');
		if (existing && !existing.closest('pre')) {
			const parent = existing.parentNode;
			while (existing.firstChild) {
				parent?.insertBefore(existing.firstChild, existing);
			}
			existing.remove();
			return;
		}
		const range = this.currentRange();
		if (!range || this.closest('pre')) {
			return;
		}
		const code = this.doc.createElement('code');
		if (range.collapsed) {
			code.textContent = ZERO_WIDTH_SPACE;
			range.insertNode(code);
			this.placeCaret(code.firstChild!, 1);
			return;
		}
		code.textContent = range.toString().replace(/\n/g, ' ');
		range.deleteContents();
		range.insertNode(code);
		const after = this.doc.createTextNode(ZERO_WIDTH_SPACE);
		code.after(after);
		this.placeCaret(after, 1);
	}

	private insertTable(): void {
		const range = this.currentRange();
		const top = this.topBlock(range?.startContainer);
		const cells = (): HttpMdInline[] => [];
		const fragment = this.doc.createDocumentFragment();
		renderHttpDocsBlocks(fragment, [{ type: 'table', align: [undefined, undefined, undefined], header: [cells(), cells(), cells()], rows: [[cells(), cells(), cells()], [cells(), cells(), cells()]] }]);
		const table = fragment.firstElementChild as HTMLElement;
		if (top && top.tagName === 'P' && !this.hasText(top) && !top.querySelector('img')) {
			top.replaceWith(fragment);
		} else if (top) {
			top.after(fragment);
		} else {
			this.surface.appendChild(fragment);
		}
		if (!table.nextElementSibling) {
			table.after(this.emptyParagraph());
		}
		const first = table.querySelector('th');
		if (first) {
			this.placeCaret(first, 0);
		}
	}

	/** Tab and Shift+Tab between the cells of a table; Tab in the last cell adds a row. */
	private moveCell(cell: HTMLElement, back: boolean): void {
		const table = cell.closest('table');
		if (!table) {
			return;
		}
		const cells = [...table.querySelectorAll<HTMLElement>('th, td')].filter(item => item.closest('table') === table);
		const index = cells.indexOf(cell);
		let next = cells[index + (back ? -1 : 1)];
		if (!next && !back) {
			const last = cell.closest('tr');
			const row = this.doc.createElement('tr');
			for (const source of last ? [...last.children] : []) {
				const td = this.doc.createElement('td');
				const align = (source as HTMLElement).dataset.align;
				if (align) {
					td.dataset.align = align;
					td.style.textAlign = align;
				}
				td.appendChild(this.doc.createElement('br'));
				row.appendChild(td);
			}
			let body = table.querySelector('tbody');
			if (!body) {
				body = this.doc.createElement('tbody');
				table.appendChild(body);
			}
			body.appendChild(row);
			next = row.firstElementChild as HTMLElement;
			this.edited();
		}
		if (next) {
			const range = this.doc.createRange();
			range.selectNodeContents(next);
			const selection = this.selection();
			selection?.removeAllRanges();
			selection?.addRange(range);
			this.savedRange = range.cloneRange();
		}
	}

	/** Blocks or marks typed as Markdown, read through the parser and drawn in place. */
	private insertMarkdown(text: string): void {
		const range = this.currentRange();
		if (!range) {
			return;
		}
		const blocks = parseHttpMarkdown(text);
		range.deleteContents();
		const fragment = this.doc.createDocumentFragment();
		if (blocks.length === 1 && blocks[0].type === 'paragraph') {
			renderHttpDocsInlines(fragment, blocks[0].children);
			const last = fragment.lastChild;
			range.insertNode(fragment);
			if (last) {
				const caret = this.doc.createRange();
				caret.setStartAfter(last);
				this.placeCaret(caret.startContainer, caret.startOffset);
			}
			return;
		}
		renderHttpDocsBlocks(fragment, blocks);
		const last = fragment.lastChild;
		const top = this.topBlock(range.startContainer);
		if (top && top.tagName === 'P' && !this.hasText(top)) {
			top.replaceWith(fragment);
		} else if (top) {
			top.after(fragment);
		} else {
			this.surface.appendChild(fragment);
		}
		this.ensureEditableEnd();
		if (last) {
			this.placeCaretAtEnd(last);
		}
	}

	/** "# ", "- ", "1. ", "> " and "``` " at the start of a line turn it into that block; "```lang" and Enter too. */
	private blockShortcut(enter: boolean): void {
		const block = this.textBlock();
		const selection = this.selection();
		if (!block || !selection?.isCollapsed || /^(PRE|TD|TH|LI)$/.test(block.tagName)) {
			return;
		}
		const before = this.textBeforeCaret(block);
		const match = enter ? /^(```)([^\s`]*)$/.exec(before) : /^(#{1,6}|[-*+]|\d{1,9}[.)]|>|```)([^\s`]*) $/.exec(before);
		if (!match || (match[2] && match[1] !== '```')) {
			return;
		}
		const marker = match[1];
		// The marker goes; what follows it on the line stays.
		const range = this.doc.createRange();
		range.setStart(block, 0);
		range.setEnd(selection.anchorNode!, selection.anchorOffset);
		selection.removeAllRanges();
		selection.addRange(range);
		this.doc.execCommand('delete');
		if (marker.startsWith('#')) {
			this.doc.execCommand('formatBlock', false, `h${marker.length}`);
		} else if (marker === '>') {
			this.doc.execCommand('formatBlock', false, 'blockquote');
		} else if (marker === '```') {
			this.doc.execCommand('formatBlock', false, 'pre');
			this.prepareCodeBlock(this.closest('pre'), match[2]);
		} else {
			const ordered = /^\d/.test(marker);
			this.doc.execCommand(ordered ? 'insertOrderedList' : 'insertUnorderedList');
			const start = ordered ? parseInt(marker, 10) : 1;
			const list = this.closest(ordered ? 'ol' : 'ul');
			if (list && start !== 1 && list.children.length === 1) {
				list.setAttribute('start', String(start));
			}
			this.ensureEditableEnd();
		}
		this.edited();
	}

	// --- Link and image popover ------------------------------------------------------------------

	private editLink(): void {
		const range = this.currentRange()?.cloneRange();
		if (!range) {
			return;
		}
		const anchor = this.closest('a');
		const selected = range.toString();
		const sameBlock = this.textBlockOf(range.startContainer) === this.textBlockOf(range.endContainer);
		this.showPopover(range, anchor ? localize('voltHttp.docsEditLink', "Edit link") : localize('voltHttp.docsAddLink', "Add link"), [
			{ id: 'text', label: localize('voltHttp.docsLinkText', "Text"), value: anchor?.textContent ?? (sameBlock ? selected : ''), placeholder: localize('voltHttp.docsLinkTextPlaceholder', "Link text") },
			{ id: 'url', label: localize('voltHttp.docsLinkUrl', "URL"), value: anchor?.dataset.href ?? '', placeholder: 'https://' },
		], values => {
			const url = values.get('url')?.trim() ?? '';
			if (!url) {
				return false;
			}
			const label = values.get('text') || url;
			if (anchor) {
				anchor.dataset.href = url;
				anchor.title = url;
				if (label !== anchor.textContent) {
					anchor.textContent = label;
				}
				this.placeCaretAtEnd(anchor);
			} else {
				const link = this.doc.createElement('a');
				link.dataset.href = url;
				link.title = url;
				if (sameBlock && !range.collapsed && selected === label) {
					link.appendChild(range.extractContents());
				} else {
					if (sameBlock) {
						range.deleteContents();
					} else {
						range.collapse(false);
					}
					link.textContent = label;
				}
				range.insertNode(link);
				const after = this.doc.createRange();
				after.setStartAfter(link);
				this.placeCaret(after.startContainer, after.startOffset);
			}
			return true;
		}, anchor ? {
			label: localize('voltHttp.docsRemoveLink', "Remove link"),
			run: () => {
				const parent = anchor.parentNode;
				const last = anchor.lastChild;
				while (anchor.firstChild) {
					parent?.insertBefore(anchor.firstChild, anchor);
				}
				anchor.remove();
				if (last) {
					this.placeCaretAtEnd(last);
				}
			},
		} : undefined);
	}

	private editImage(): void {
		const range = this.currentRange()?.cloneRange();
		if (!range) {
			return;
		}
		this.showPopover(range, localize('voltHttp.docsAddImage', "Add image"), [
			{ id: 'src', label: localize('voltHttp.docsImageUrl', "Image URL"), value: '', placeholder: 'https://' },
			{ id: 'alt', label: localize('voltHttp.docsImageAlt', "Alt text"), value: '', placeholder: localize('voltHttp.docsImageAltPlaceholder', "What the image shows") },
		], values => {
			const src = values.get('src')?.trim() ?? '';
			if (!src) {
				return false;
			}
			const fragment = this.doc.createDocumentFragment();
			renderHttpDocsInlines(fragment, [{ type: 'image', src, alt: values.get('alt')?.trim() ?? '' }]);
			const image = fragment.firstChild;
			range.collapse(false);
			range.insertNode(fragment);
			if (image) {
				const after = this.doc.createRange();
				after.setStartAfter(image);
				this.placeCaret(after.startContainer, after.startOffset);
			}
			return true;
		});
	}

	private textBlockOf(node: Node): HTMLElement | undefined {
		for (let current: Node | null = node; current && current !== this.surface; current = current.parentNode) {
			if (current.nodeType === 1 && TEXT_BLOCK.test((current as HTMLElement).tagName)) {
				return current as HTMLElement;
			}
		}
		return undefined;
	}

	/**
	 * A small form under the selection. `apply` returns false to keep it open (a required field is
	 * empty). Escape or a click elsewhere closes it and puts the caret back.
	 */
	private showPopover(range: Range, title: string, fields: readonly { id: string; label: string; value: string; placeholder: string }[], apply: (values: ReadonlyMap<string, string>) => boolean, secondary?: { label: string; run: () => void }): void {
		const store = new DisposableStore();
		this.popover.value = store;
		const popover = append(this.element, $('.volt-http-docs-popover'));
		popover.setAttribute('role', 'dialog');
		popover.setAttribute('aria-label', title);
		store.add(toDisposable(() => popover.remove()));
		append(popover, $('.volt-http-docs-popover-title')).textContent = title;
		const inputs = new Map<string, HTMLInputElement>();
		for (const field of fields) {
			const label = append(popover, $('label.volt-http-docs-popover-field'));
			append(label, $('span.volt-http-sublabel.inline')).textContent = field.label;
			const input = append(label, $('input.volt-http-input')) as HTMLInputElement;
			input.type = 'text';
			input.spellcheck = false;
			input.value = field.value;
			input.placeholder = field.placeholder;
			inputs.set(field.id, input);
		}
		const row = append(popover, $('.volt-http-docs-popover-actions'));
		const close = (restore: boolean) => {
			this.popover.clear();
			if (restore) {
				this.surface.focus({ preventScroll: true });
				const selection = this.selection();
				if (this.surface.contains(range.startContainer)) {
					selection?.removeAllRanges();
					selection?.addRange(range);
				}
			}
		};
		const done = () => {
			const values = new Map([...inputs].map(([id, input]) => [id, input.value]));
			this.surface.focus({ preventScroll: true });
			if (!apply(values)) {
				const missing = [...inputs.values()].find(input => !input.value.trim());
				missing?.focus();
				return;
			}
			this.popover.clear();
			this.edited();
		};
		if (secondary) {
			const remove = store.add(createVoltButton(row, 'ghost'));
			remove.element.classList.add('volt-button-small');
			remove.label = secondary.label;
			store.add(remove.onDidClick(() => {
				this.surface.focus({ preventScroll: true });
				secondary.run();
				this.popover.clear();
				this.edited();
			}));
		}
		append(row, $('.volt-http-docs-spacer'));
		const cancel = store.add(createVoltButton(row, 'secondary'));
		cancel.element.classList.add('volt-button-small');
		cancel.label = localize('voltHttp.docsPopoverCancel', "Cancel");
		store.add(cancel.onDidClick(() => close(true)));
		const ok = store.add(createVoltButton(row, 'primary'));
		ok.element.classList.add('volt-button-small');
		ok.label = localize('voltHttp.docsPopoverApply', "Apply");
		store.add(ok.onDidClick(done));
		store.add(addDisposableListener(popover, EventType.KEY_DOWN, e => {
			if (e.key === 'Escape') {
				e.preventDefault();
				e.stopPropagation();
				close(true);
			} else if (e.key === 'Enter' && (e.target as HTMLElement).tagName === 'INPUT') {
				e.preventDefault();
				e.stopPropagation();
				done();
			}
		}));
		store.add(addDisposableListener(this.doc, EventType.MOUSE_DOWN, e => {
			if (!popover.contains(e.target as Node)) {
				close(false);
			}
		}, true));

		// Under the selection, inside the editor's box.
		const box = this.element.getBoundingClientRect();
		const rects = range.getClientRects();
		let anchor = rects.length ? rects[rects.length - 1] : range.getBoundingClientRect();
		if (!anchor.height) {
			anchor = (this.textBlockOf(range.startContainer) ?? this.surface).getBoundingClientRect();
		}
		const width = Math.min(320, Math.max(220, box.width - 16));
		const left = Math.max(8, Math.min(anchor.left - box.left, box.width - width - 8));
		const below = anchor.bottom - box.top + 6;
		popover.style.width = `${width}px`;
		popover.style.left = `${left}px`;
		popover.style.top = `${Math.max(8, Math.min(below, box.height - popover.offsetHeight - 8))}px`;
		const first = [...inputs.values()].find(input => !input.value) ?? inputs.values().next().value;
		first?.focus();
		first?.select();
	}

	// --- Write with AI ---------------------------------------------------------------------------

	private setStatus(text: string, error = false, running = false): void {
		this.statusText.textContent = text;
		this.status.classList.toggle('error', error);
		this.status.classList.toggle('hidden', !text);
		this.statusCancel.classList.toggle('hidden', !running);
	}

	private async writeWithAi(): Promise<void> {
		if (this.aiRun.value) {
			return;
		}
		const context = this.options.aiContext?.();
		if (!context?.trim()) {
			this.setStatus(localize('voltHttp.docsAiNoContext', "There is nothing to document yet: give the request a URL first."), true);
			return;
		}
		const ref = httpAiModelRef(this.instantiationService);
		if (!ref) {
			this.setStatus(localize('voltHttp.docsAiNoModel', "No model is set up. Add one in Settings, Providers & Models."), true);
			return;
		}
		this.flush();
		const previous = this.value;
		if (previous.trim()) {
			const { confirmed } = await this.dialogService.confirm({
				type: 'question',
				message: localize('voltHttp.docsAiReplace', "Replace this request's documentation?"),
				detail: localize('voltHttp.docsAiReplaceDetail', "A model writes new documentation from the request. What is here now is replaced."),
				primaryButton: localize({ key: 'voltHttp.docsAiReplaceButton', comment: ['&& denotes a mnemonic'] }, "&&Replace"),
			});
			if (!confirmed || this._store.isDisposed || this.aiRun.value) {
				return;
			}
			this.flush();
		}
		const cancel = new CancellationTokenSource();
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			cancel.cancel();
		}, AI_TIMEOUT_MS);
		const started = Date.now();
		const targetWindow = getWindow(this.element);
		const tick = () => {
			const seconds = Math.floor((Date.now() - started) / 1000);
			// allow-any-unicode-next-line
			this.setStatus(seconds < 2 ? localize('voltHttp.docsAiWriting', "Writing documentation…") : localize('voltHttp.docsAiWritingFor', "Writing documentation… {0}s", seconds), false, true);
		};
		const ticker = targetWindow.setInterval(tick, 1000);
		this.popover.clear();
		this.writing = true;
		this.partial = '';
		this.aiRun.value = toDisposable(() => {
			targetWindow.clearInterval(ticker);
			clearTimeout(timer);
			cancel.dispose(true);
		});
		this.updateToolbar();
		this.updateEmpty();
		tick();

		const written = await writeHttpDocs(this.runtime, ref, httpDocsPrompt(context), cancel.token, partial => {
			this.partial = partial;
			if (!this.partialScheduler.isScheduled()) {
				this.partialScheduler.schedule();
			}
		});
		const cancelled = cancel.token.isCancellationRequested;
		this.aiRun.clear();
		this.partialScheduler.cancel();
		if (this._store.isDisposed) {
			return;
		}
		this.writing = false;
		if (written.failure || cancelled) {
			this.showMarkdown(previous);
			this.setStatus(written.failure ?? (timedOut ? localize('voltHttp.docsAiTimedOut', "The model took too long. Try again, or pick a faster model.") : localize('voltHttp.docsAiCancelled', "Stopped. The documentation is as it was.")), true);
		} else {
			const markdown = canonicalHttpDocs(written.markdown);
			this.showMarkdown(markdown);
			this.setStatus('');
			if (markdown !== this.value) {
				this.value = markdown;
				this.options.onChange(markdown);
			}
		}
		this.updateToolbar();
		this.updateEmpty();
	}

	/** What a streaming model has written so far, drawn in place of the content. */
	private drawPartial(): void {
		if (this.writing) {
			this.showMarkdown(this.partial);
			this.updateEmpty();
		}
	}

	private showMarkdown(markdown: string): void {
		this.dirty = false;
		this.changeScheduler.cancel();
		if (this.mode === 'rich') {
			this.renderRich(markdown);
		} else {
			this.setSource(markdown);
		}
	}
}
