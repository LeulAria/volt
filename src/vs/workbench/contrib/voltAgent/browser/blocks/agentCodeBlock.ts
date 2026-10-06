/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, getWindow } from '../../../../../base/browser/dom.js';
import { renderIcon } from '../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { posix } from '../../../../../base/common/path.js';
import { localize } from '../../../../../nls.js';
import { ILanguageService } from '../../../../../editor/common/languages/language.js';
import { PLAINTEXT_LANGUAGE_ID } from '../../../../../editor/common/languages/modesRegistry.js';
import { tokenizeToString } from '../../../../../editor/common/languages/textToHtmlTokenizer.js';
import { TokenizationRegistry } from '../../../../../editor/common/languages.js';
import { timeout } from '../../../../../base/common/async.js';
import { Event } from '../../../../../base/common/event.js';
import { markupToFragment } from './agentMarkupDom.js';

export interface ICodeCardOptions {
	readonly store: DisposableStore;
	readonly languageService?: ILanguageService;
	readonly onCopyText?: (text: string) => void;
	/** Called after async highlighting changed the block's size. */
	readonly onDidChangeSize?: () => void;
	/** Opens a cited file at its lines, from the header of a ```start:end:path card. */
	readonly onOpenPath?: (path: string, startLine?: number, endLine?: number) => void;
	/** Icon theme classes for the cited file. */
	readonly fileIconClasses?: (path: string) => readonly string[];
	/** Runs a shell block in the chat's terminal; absent while the reply still streams. */
	readonly onRunInTerminal?: (command: string) => void;
}

const SHELL_LANGS = new Set(['sh', 'bash', 'zsh', 'fish', 'shell', 'console', 'powershell', 'pwsh']);

/**
 * The command a shell block runs, or undefined when it should not offer Run (T3's rule): empty,
 * ending in a line continuation, or holding control or invisible format characters that could make
 * what is shown differ from what the terminal receives. A `$ ` prompt prefix is dropped.
 */
export function runnableShellCommand(language: string | undefined, code: string): string | undefined {
	if (!SHELL_LANGS.has((language ?? '').trim().toLowerCase())) {
		return undefined;
	}
	const command = code.replace(/\n$/, '').split('\n').map(line => line.replace(/^\$ /, '')).join('\n').trim();
	if (!command || command.endsWith('\\') || /[\p{Cc}\p{Cf}]/u.test(command.replace(/[\n\t]/g, ''))) {
		return undefined;
	}
	return command;
}

/** A code reference the way Cursor's agents write one: ```12:40:src/app.ts */
export interface ICodeCitation {
	readonly path: string;
	readonly startLine: number;
	readonly endLine: number;
}

export function parseCodeCitation(info: string | undefined): ICodeCitation | undefined {
	const match = /^(\d+):(\d+):(.+)$/.exec((info ?? '').trim());
	if (!match) {
		return undefined;
	}
	const startLine = Number(match[1]);
	return { path: match[3], startLine, endLine: Math.max(startLine, Number(match[2])) };
}

function dedent(text: string): string {
	const lines = text.split('\n');
	let common: string | undefined;
	for (const line of lines) {
		if (!line.trim()) {
			continue;
		}
		const indent = /^[ \t]*/.exec(line)![0];
		if (common === undefined || !indent.startsWith(common)) {
			let i = 0;
			while (common !== undefined && i < common.length && i < indent.length && common[i] === indent[i]) {
				i++;
			}
			common = common === undefined ? indent : common.slice(0, i);
		}
		if (!common) {
			return text;
		}
	}
	return common ? lines.map(line => line.startsWith(common!) ? line.slice(common!.length) : line.trimStart()).join('\n') : text;
}

/** The highlighter's alias for a cited file: its extension, or its name (Dockerfile, Makefile). */
function citationLanguage(path: string): string {
	const name = posix.basename(path).toLowerCase();
	const dot = name.lastIndexOf('.');
	return dot > 0 ? name.slice(dot + 1) : name;
}

export interface ICodeCardAction {
	readonly icon: ThemeIcon;
	readonly label: string;
	readonly run: () => void;
}

/** Highlighted lines keyed by language and source. Streaming re-renders hit this every frame. */
const highlightCache = new Map<string, Node[][]>();
const HIGHLIGHT_CACHE_MAX = 300;
/** The last highlight per language, so a growing streamed block keeps its earlier colours. */
const lastHighlight = new Map<string, { code: string; lines: Node[][] }>();

const DIFF_LANGS = new Set(['diff', 'patch']);

/**
 * Cursor's code card: a bordered `#181818` card, Menlo 12/18, no language label, and a copy
 * button that appears on hover. The body scrolls sideways instead of wrapping.
 */
export function renderCodeCard(parent: HTMLElement, language: string | undefined, code: string, options: ICodeCardOptions): HTMLElement {
	const citation = parseCodeCitation(language);
	// A cited snippet comes from the middle of a file; its shared indentation is noise.
	const text = citation ? dedent(code.replace(/\n$/, '')) : code.replace(/\n$/, '');
	const lang = citation ? citationLanguage(citation.path) : (language ?? '').trim().toLowerCase();
	if (!citation && (DIFF_LANGS.has(lang) || (!lang && looksLikeUnifiedDiff(text)))) {
		return renderDiffCard(parent, text, options);
	}
	const command = options.onRunInTerminal ? runnableShellCommand(lang, text) : undefined;
	const run = options.onRunInTerminal;
	const actions: ICodeCardAction[] = command && run
		? [{ label: localize('voltAgent.runInTerminal', "Run in terminal"), icon: Codicon.play, run: () => run(command) }]
		: [];
	const shell = createCodeCardShell(parent, options, actions, text);
	shell.card.dataset.lang = lang || 'text';
	if (citation) {
		renderCitationHeader(shell.card, citation, options);
	}
	const codeEl = append(shell.scroll, $('code.volt-md-code.volt-agent-searchable'));
	const key = `${lang}\n${text}`;
	const cached = highlightCache.get(key);
	if (cached) {
		appendLines(codeEl, cloneLines(cached));
		return shell.card;
	}
	appendLines(codeEl, provisionalLines(lang, text));
	if (options.languageService && lang) {
		highlight(options.languageService, lang, text).then(lines => {
			if (!shell.card.isConnected) {
				return;
			}
			codeEl.replaceChildren();
			appendLines(codeEl, cloneLines(lines));
			options.onDidChangeSize?.();
		}, () => { /* keep plain text */ });
	}
	return shell.card;
}

/** Cursor's header on a cited snippet: file icon, name, "Ln a–b"; clicking opens the file there. */
function renderCitationHeader(card: HTMLElement, citation: ICodeCitation, options: ICodeCardOptions): void {
	const header = $('button.volt-md-code-citation.show-file-icons') as HTMLButtonElement;
	header.type = 'button';
	const icon = append(header, $('span.volt-md-code-citation-icon'));
	icon.classList.add(...(options.fileIconClasses?.(citation.path) ?? []));
	append(header, $('span.volt-md-code-citation-name')).textContent = posix.basename(citation.path);
	const lines = citation.startLine === citation.endLine
		? localize('voltAgent.citationLine', "Ln {0}", citation.startLine)
		: localize('voltAgent.citationLines', "Ln {0}\u2013{1}", citation.startLine, citation.endLine);
	append(header, $('span.volt-md-code-citation-lines')).textContent = lines;
	header.setAttribute('aria-label', localize('voltAgent.openCitation', "Open {0}, {1}", citation.path, lines));
	const open = options.onOpenPath;
	if (open) {
		options.store.add(addDisposableListener(header, 'click', e => {
			e.preventDefault();
			e.stopPropagation();
			open(citation.path, citation.startLine, citation.endLine);
		}));
	} else {
		header.disabled = true;
	}
	card.classList.add('has-citation');
	card.insertBefore(header, card.firstChild);
}

export interface ICodeCardShell {
	readonly card: HTMLElement;
	readonly content: HTMLElement;
	readonly scroll: HTMLElement;
	readonly overlay: HTMLElement;
}

/** The card frame shared by code, diff and diagram blocks: border, hover tools and a sideways scroller. */
export function createCodeCardShell(parent: HTMLElement, options: ICodeCardOptions, actions: readonly ICodeCardAction[], copyText: string | (() => string)): ICodeCardShell {
	const card = append(parent, $('.volt-md-code-block'));
	const content = append(card, $('.volt-md-code-block-content'));
	const overlay = append(content, $('.volt-md-code-block-overlay'));
	for (const action of actions) {
		const button = append(overlay, $('button.volt-md-icon-button')) as HTMLButtonElement;
		button.type = 'button';
		button.title = action.label;
		button.setAttribute('aria-label', action.label);
		button.appendChild(renderIcon(action.icon));
		options.store.add(addDisposableListener(button, 'click', e => {
			e.preventDefault();
			e.stopPropagation();
			action.run();
		}));
	}
	if (options.onCopyText) {
		const copy = append(overlay, $('button.volt-md-icon-button.copy')) as HTMLButtonElement;
		copy.type = 'button';
		copy.title = localize('voltAgent.copyCode', "Copy code");
		copy.setAttribute('aria-label', copy.title);
		const iconSlot = append(copy, $('span.volt-md-icon-swap'));
		iconSlot.appendChild(renderIcon(Codicon.copy));
		options.store.add(addDisposableListener(copy, 'mousedown', e => e.stopPropagation()));
		options.store.add(addDisposableListener(copy, 'click', e => {
			e.preventDefault();
			e.stopPropagation();
			options.onCopyText?.(typeof copyText === 'string' ? copyText : copyText());
			iconSlot.replaceChildren(renderIcon(Codicon.check));
			copy.classList.add('copied');
			getWindow(copy).setTimeout(() => {
				copy.classList.remove('copied');
				iconSlot.replaceChildren(renderIcon(Codicon.copy));
			}, 1400);
		}));
	}
	const scroll = append(content, $('.volt-md-code-scroll'));
	return { card, content, scroll, overlay };
}

/**
 * Highlighted spans for each line of `text`, for callers that lay lines out themselves
 * (the inline edit diff). `alias` is a fence language or a file extension.
 */
export function highlightCodeLines(languageService: ILanguageService, alias: string, text: string): { sync?: Node[][]; done: Promise<Node[][]> } {
	const cached = highlightCache.get(`${alias}\n${text}`);
	if (cached) {
		return { sync: cloneLines(cached), done: Promise.resolve(cloneLines(cached)) };
	}
	return { done: highlight(languageService, alias, text).then(cloneLines) };
}

/** Cursor draws a ```diff fence as code lines tinted green/red with a strip at the left edge, without the +/- column. */
function renderDiffCard(parent: HTMLElement, text: string, options: ICodeCardOptions): HTMLElement {
	const shell = createCodeCardShell(parent, options, [], text);
	shell.card.classList.add('diff');
	const body = append(shell.scroll, $('code.volt-md-code.volt-md-diff.volt-agent-searchable'));
	const rows = text.split('\n').map(line => classifyDiffLine(line));
	const codeLines = rows.map(row => row.text);
	const lang = guessDiffLanguage(codeLines);
	const fill = (lines: readonly Node[][]) => {
		body.replaceChildren();
		rows.forEach((row, index) => {
			const line = append(body, $(`div.volt-md-diff-line.${row.kind}`));
			const content = append(line, $('span.volt-md-diff-text'));
			const nodes = row.kind === 'meta' ? [] : (lines[index] ?? []);
			if (nodes.length) {
				for (const node of nodes) {
					content.appendChild(node);
				}
			} else {
				content.textContent = row.text || '​';
			}
		});
	};
	const key = `${lang}\n${codeLines.join('\n')}`;
	const cached = highlightCache.get(key);
	fill(cached ? cloneLines(cached) : []);
	if (!cached && options.languageService && lang) {
		highlight(options.languageService, lang, codeLines.join('\n')).then(lines => {
			if (shell.card.isConnected) {
				fill(cloneLines(lines));
				options.onDidChangeSize?.();
			}
		}, () => { /* keep plain text */ });
	}
	return shell.card;
}

type DiffKind = 'added' | 'removed' | 'context' | 'meta';

export function classifyDiffLine(line: string): { kind: DiffKind; text: string } {
	if (/^(\+\+\+|---)\s/.test(line) || /^@@.*@@/.test(line) || /^diff --git /.test(line) || /^index [0-9a-f]+\.\.[0-9a-f]+/.test(line)) {
		return { kind: 'meta', text: line };
	}
	if (line.startsWith('+')) {
		return { kind: 'added', text: line.slice(1) };
	}
	if (line.startsWith('-')) {
		return { kind: 'removed', text: line.slice(1) };
	}
	return { kind: 'context', text: line.startsWith(' ') ? line.slice(1) : line };
}

export function looksLikeUnifiedDiff(text: string): boolean {
	const lines = text.split('\n');
	return lines.length > 1 && /^(---|\+\+\+|@@) /.test(lines[0]) && lines.some(line => /^@@ .* @@/.test(line));
}

/** Diff fences carry no language; most agent diffs are C-like source, which TypeScript colours sensibly. */
function guessDiffLanguage(lines: readonly string[]): string {
	const sample = lines.join('\n');
	if (/^\s*(def |import \w+$|from \w+ import|class \w+:)/m.test(sample)) {
		return 'python';
	}
	if (/[;{}]|=>|\bconst\b|\bfunction\b|\blet\b|\bexport\b/.test(sample)) {
		return 'typescript';
	}
	return '';
}

function resolveLanguageId(languageService: ILanguageService, alias: string): string | undefined {
	const normalized = LANGUAGE_ALIASES[alias] ?? alias;
	const byName = languageService.getLanguageIdByLanguageName(normalized);
	if (byName && byName !== PLAINTEXT_LANGUAGE_ID) {
		return byName;
	}
	if (languageService.isRegisteredLanguageId(normalized)) {
		return normalized;
	}
	const guessed = languageService.guessLanguageIdByFilepathOrFirstLine(URI.file(`/code.${normalized}`));
	return guessed && guessed !== 'unknown' && guessed !== PLAINTEXT_LANGUAGE_ID ? guessed : undefined;
}

/**
 * Languages come from extensions, which register after restored replies first render.
 * Wait (briefly) for the registry to learn the alias instead of giving up on colour.
 */
async function resolveLanguageIdWhenReady(languageService: ILanguageService, alias: string): Promise<string | undefined> {
	const deadline = Date.now() + 20000;
	let id = resolveLanguageId(languageService, alias);
	while (!id && Date.now() < deadline) {
		await Promise.race([Event.toPromise(languageService.onDidChange), timeout(1000)]);
		id = resolveLanguageId(languageService, alias);
	}
	return id;
}

const LANGUAGE_ALIASES: Record<string, string> = {
	ts: 'typescript',
	tsx: 'typescriptreact',
	js: 'javascript',
	jsx: 'javascriptreact',
	mjs: 'javascript',
	cjs: 'javascript',
	py: 'python',
	sh: 'shellscript',
	bash: 'shellscript',
	zsh: 'shellscript',
	shell: 'shellscript',
	console: 'shellscript',
	terminal: 'shellscript',
	yml: 'yaml',
	md: 'markdown',
	rs: 'rust',
	rb: 'ruby',
	kt: 'kotlin',
	cs: 'csharp',
	'c++': 'cpp',
	jsonc: 'jsonc',
	html: 'html',
	golang: 'go',
};

export async function highlight(languageService: ILanguageService, alias: string, text: string): Promise<Node[][]> {
	const key = `${alias}\n${text}`;
	const cached = highlightCache.get(key);
	if (cached) {
		return cached;
	}
	const languageId = await languageIdFor(languageService, alias);
	if (!languageId || !await tokenizerFor(languageService, languageId)) {
		throw new Error(`No tokenizer for ${alias}`);
	}
	const html = await tokenizeToString(languageService, text, languageId);
	const lines = htmlToLines(html);
	highlightCache.set(key, lines);
	lastHighlight.set(alias, { code: text, lines });
	if (highlightCache.size > HIGHLIGHT_CACHE_MAX) {
		const first = highlightCache.keys().next().value;
		if (first !== undefined) {
			highlightCache.delete(first);
		}
	}
	return lines;
}

/** Fences that name no language worth colouring. */
const PLAIN_ALIASES = new Set(['text', 'txt', 'plain', 'plaintext', 'output', 'console', 'log', 'none', 'nohighlight']);

/**
 * One lookup per alias and one tokenizer wait per language, shared by every card. A streaming
 * card re-renders many times a second with new text; each render waiting on its own would pile
 * up listeners on the language registry for as long as the wait lasts.
 */
const languageIds = new Map<string, Promise<string | undefined>>();
const tokenizers = new Map<string, Promise<boolean>>();

function languageIdFor(languageService: ILanguageService, alias: string): Promise<string | undefined> {
	if (PLAIN_ALIASES.has(alias)) {
		return Promise.resolve(undefined);
	}
	let request = languageIds.get(alias);
	if (!request) {
		// A miss is forgotten once settled, so a language an extension adds later still colours.
		request = resolveLanguageIdWhenReady(languageService, alias).then(id => {
			if (!id) {
				languageIds.delete(alias);
			}
			return id;
		});
		languageIds.set(alias, request);
	}
	return request;
}

function tokenizerFor(languageService: ILanguageService, languageId: string): Promise<boolean> {
	let request = tokenizers.get(languageId);
	if (!request) {
		request = waitForTokenizer(languageService, languageId).then(ready => {
			if (!ready) {
				tokenizers.delete(languageId);
			}
			return ready;
		});
		tokenizers.set(languageId, request);
	}
	return request;
}

/**
 * Resolves the language's tokenizer. Replies restored at startup render before extensions
 * register their grammars, so keep asking for a while instead of caching uncoloured text.
 */
async function waitForTokenizer(languageService: ILanguageService, languageId: string): Promise<boolean> {
	// TextMate registers a language's tokenizer only once something asks for its basic features.
	languageService.requestBasicLanguageFeatures(languageId);
	for (let attempt = 0; attempt < 50; attempt++) {
		if (await TokenizationRegistry.getOrCreate(languageId)) {
			return true;
		}
		await timeout(400);
	}
	return false;
}

/** Splits tokenizer output (`<div><span class="mtkN">…</span><br/>…</div>`) into per-line span lists. */
function htmlToLines(html: string): Node[][] {
	const fragment = markupToFragment(document, html, false);
	const root = fragment.firstElementChild ?? fragment;
	const lines: Node[][] = [[]];
	for (const child of [...root.childNodes]) {
		if (child.nodeName === 'BR') {
			lines.push([]);
			continue;
		}
		lines[lines.length - 1].push(child);
	}
	return lines;
}

/** While a new highlight is pending, reuse the colours of the lines that have not changed since the last one. */
function provisionalLines(alias: string, text: string): Node[][] {
	const lines = text.split('\n');
	const previous = lastHighlight.get(alias);
	if (!previous || !previous.lines.length) {
		return lines.map(line => [document.createTextNode(line)]);
	}
	const oldLines = previous.code.split('\n');
	return lines.map((line, index) => index < oldLines.length - 1 && oldLines[index] === line && previous.lines[index]
		? previous.lines[index].map(node => node.cloneNode(true))
		: [document.createTextNode(line)]);
}

function cloneLines(lines: readonly Node[][]): Node[][] {
	return lines.map(line => line.map(node => node.cloneNode(true)));
}

function appendLines(codeEl: HTMLElement, lines: Node[][]): void {
	for (const nodes of lines) {
		const line = append(codeEl, $('div.volt-md-code-line'));
		if (!nodes.length || (nodes.length === 1 && !nodes[0].textContent)) {
			line.textContent = '​';
			continue;
		}
		for (const node of nodes) {
			line.appendChild(node);
		}
	}
}
