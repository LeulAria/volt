/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { isHTMLElement, isHTMLInputElement } from '../../../../../base/browser/dom.js';
import { safeSetInnerHtml } from '../../../../../base/browser/domSanitize.js';
import * as marked from '../../../../../base/common/marked/marked.js';

/**
 * The editable preview of a markdown body. Each top-level block (a paragraph, a list, a code
 * block, ...) is rendered into its own wrapper that remembers the exact source it came from.
 * Serializing back emits untouched blocks verbatim and converts only the blocks the user edited,
 * so editing one sentence never reformats the rest of the file.
 */

const BLOCK_CLASS = 'volt-md-block';

interface IBlockState {
	readonly source: string;
	readonly html: string;
}

const blockStates = new WeakMap<HTMLElement, IBlockState>();

const sanitizerConfig = {
	allowedTags: { augment: ['input'] },
	allowedAttributes: { augment: ['class', 'checked', 'disabled', 'colspan', 'rowspan'] },
	allowRelativeLinkPaths: true,
	allowRelativeMediaPaths: true,
	allowedLinkProtocols: { override: ['http', 'https', 'mailto', 'file', 'vscode', 'vscode-file'] as readonly string[] },
	allowedMediaProtocols: { override: ['http', 'https', 'data', 'file', 'vscode-file'] as readonly string[] },
};

export interface IRenderedMarkdown {
	/** Source that preceded the first block (blank lines). */
	readonly lead: string;
}

/**
 * Renders `markdown` into `root`, one wrapper per block. `resolveImage` maps a relative image
 * path to a loadable URL (the original stays in `data-md-src`).
 */
export function renderEditableMarkdown(root: HTMLElement, markdown: string, resolveImage?: (src: string) => string | undefined): IRenderedMarkdown {
	root.replaceChildren();
	const instance = new marked.Marked({ gfm: true, breaks: false });
	const tokens = instance.lexer(markdown);
	let lead = '';
	const groups: { tokens: marked.Token[]; source: string }[] = [];
	for (const token of tokens) {
		if (token.type === 'space' || token.type === 'def') {
			if (groups.length) {
				groups[groups.length - 1].source += token.raw;
			} else {
				lead += token.raw;
			}
			continue;
		}
		groups.push({ tokens: [token], source: token.raw });
	}
	for (const group of groups) {
		const wrapper = root.ownerDocument.createElement('div');
		wrapper.className = BLOCK_CLASS;
		const list = Object.assign([...group.tokens], { links: tokens.links }) as marked.TokensList;
		let html = '';
		try {
			html = instance.parser(list, { async: false }) as string;
		} catch {
			html = '';
		}
		safeSetInnerHtml(wrapper, html, sanitizerConfig);
		if (resolveImage) {
			for (const image of wrapper.querySelectorAll('img')) {
				const src = image.getAttribute('src') ?? '';
				if (src && !/^(https?:|data:)/i.test(src)) {
					const resolved = resolveImage(src);
					image.dataset.mdSrc = src;
					if (resolved) {
						image.setAttribute('src', resolved);
					}
				}
			}
		}
		for (const checkbox of wrapper.querySelectorAll('input[type="checkbox"]')) {
			checkbox.setAttribute('contenteditable', 'false');
		}
		root.appendChild(wrapper);
		blockStates.set(wrapper, { source: group.source, html: wrapper.innerHTML });
	}
	return { lead };
}

/** The markdown for what `root` shows now. */
export function serializeEditableMarkdown(root: HTMLElement, rendered: IRenderedMarkdown): string {
	const out: string[] = [rendered.lead];
	const children = [...root.childNodes];
	let pending: Node[] = [];
	const flushLoose = () => {
		if (!pending.length) {
			return;
		}
		const text = blocksToMarkdown(pending).trim();
		if (text) {
			out.push(`${text}\n\n`);
		}
		pending = [];
	};
	for (const child of children) {
		if (isHTMLElement(child) && child.classList.contains(BLOCK_CLASS)) {
			flushLoose();
			const state = blockStates.get(child);
			if (state && child.innerHTML === state.html) {
				out.push(state.source);
				continue;
			}
			const text = blocksToMarkdown([...child.childNodes]).trim();
			if (text) {
				out.push(`${text}\n\n`);
			}
			continue;
		}
		pending.push(child);
	}
	flushLoose();
	let result = out.join('');
	// One newline at the end, like the files these come from.
	result = result.replace(/\s+$/, '');
	return result ? `${result}\n` : '';
}

/** Marks every block as unchanged, after the serialized text has been written back. */
export function rebaseEditableMarkdown(root: HTMLElement): void {
	for (const child of root.children) {
		if (isHTMLElement(child) && child.classList.contains(BLOCK_CLASS) && blockStates.has(child)) {
			const state = blockStates.get(child)!;
			if (child.innerHTML !== state.html) {
				blockStates.set(child, { source: `${blocksToMarkdown([...child.childNodes]).trim()}\n\n`, html: child.innerHTML });
			}
		}
	}
}

//#region DOM → markdown

const BLOCK_TAGS = new Set(['P', 'DIV', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'UL', 'OL', 'BLOCKQUOTE', 'PRE', 'HR', 'TABLE', 'SECTION', 'ARTICLE', 'DETAILS', 'FIGURE', 'LI']);

function isBlock(node: Node): boolean {
	return isHTMLElement(node) && BLOCK_TAGS.has(node.tagName);
}

/** Block-level children joined by blank lines; inline runs between blocks become paragraphs. */
export function blocksToMarkdown(nodes: readonly Node[]): string {
	const parts: string[] = [];
	let inline: Node[] = [];
	const flush = () => {
		if (inline.length) {
			const text = inlineToMarkdown(inline).trim();
			if (text) {
				parts.push(text);
			}
			inline = [];
		}
	};
	for (const node of nodes) {
		if (isBlock(node)) {
			flush();
			const text = blockToMarkdown(node as HTMLElement);
			if (text.trim()) {
				parts.push(text);
			}
		} else if (isHTMLElement(node) && node.classList.contains(BLOCK_CLASS)) {
			flush();
			const text = blocksToMarkdown([...node.childNodes]);
			if (text.trim()) {
				parts.push(text);
			}
		} else {
			inline.push(node);
		}
	}
	flush();
	return parts.join('\n\n');
}

function blockToMarkdown(element: HTMLElement): string {
	switch (element.tagName) {
		case 'H1': case 'H2': case 'H3': case 'H4': case 'H5': case 'H6': {
			const level = Number(element.tagName[1]);
			return `${'#'.repeat(level)} ${inlineToMarkdown([...element.childNodes]).replace(/\n+/g, ' ').trim()}`;
		}
		case 'P':
		case 'SECTION':
		case 'ARTICLE':
		case 'FIGURE':
			return hasBlockChild(element) ? blocksToMarkdown([...element.childNodes]) : inlineToMarkdown([...element.childNodes]).trim();
		case 'DIV':
			return hasBlockChild(element) ? blocksToMarkdown([...element.childNodes]) : inlineToMarkdown([...element.childNodes]).trim();
		case 'HR':
			return '---';
		case 'PRE':
			return codeBlock(element);
		case 'BLOCKQUOTE': {
			const inner = blocksToMarkdown([...element.childNodes]);
			return inner.split('\n').map(line => line ? `> ${line}` : '>').join('\n');
		}
		case 'UL':
		case 'OL':
			return listToMarkdown(element);
		case 'LI':
			return listItem(element, '- ');
		case 'TABLE':
			return tableToMarkdown(element);
		case 'DETAILS':
			return element.outerHTML;
		default:
			return inlineToMarkdown([...element.childNodes]).trim();
	}
}

function hasBlockChild(element: HTMLElement): boolean {
	return [...element.childNodes].some(isBlock);
}

function codeBlock(pre: HTMLElement): string {
	const code = pre.querySelector('code');
	const language = /(?:^|\s)language-([\w+#.-]+)/.exec(code?.className ?? '')?.[1] ?? '';
	const text = (code ?? pre).textContent?.replace(/\n$/, '') ?? '';
	let fence = '```';
	while (text.includes(fence)) {
		fence += '`';
	}
	return `${fence}${language}\n${text}\n${fence}`;
}

function listToMarkdown(list: HTMLElement): string {
	const ordered = list.tagName === 'OL';
	const start = ordered ? Number(list.getAttribute('start') ?? '1') || 1 : 1;
	const items = [...list.children].filter(child => child.tagName === 'LI') as HTMLElement[];
	const loose = items.some(item => [...item.children].some(child => child.tagName === 'P'));
	const lines = items.map((item, index) => listItem(item, ordered ? `${start + index}. ` : '- '));
	return lines.join(loose ? '\n\n' : '\n');
}

function listItem(item: HTMLElement, marker: string): string {
	const indent = ' '.repeat(marker.length);
	const inlineNodes: Node[] = [];
	const blocks: string[] = [];
	let checkbox = '';
	for (const child of item.childNodes) {
		if (isHTMLInputElement(child) && child.type === 'checkbox') {
			checkbox = child.checked ? '[x] ' : '[ ] ';
			continue;
		}
		if (isHTMLElement(child) && (child.tagName === 'UL' || child.tagName === 'OL')) {
			blocks.push(listToMarkdown(child));
		} else if (isBlock(child)) {
			if (isHTMLElement(child) && child.tagName === 'P' && !blocks.length && !inlineNodes.length) {
				for (const grand of child.childNodes) {
					if (isHTMLInputElement(grand) && grand.type === 'checkbox') {
						checkbox = grand.checked ? '[x] ' : '[ ] ';
					} else {
						inlineNodes.push(grand);
					}
				}
			} else {
				blocks.push(blockToMarkdown(child as HTMLElement));
			}
		} else {
			inlineNodes.push(child);
		}
	}
	const head = `${marker}${checkbox}${inlineToMarkdown(inlineNodes).replace(/\n+/g, ' ').trim()}`;
	const rest = blocks.map(block => block.split('\n').map(line => line ? `${indent}${line}` : '').join('\n'));
	return [head, ...rest].join('\n');
}

function tableToMarkdown(table: HTMLElement): string {
	const rows = [...table.querySelectorAll('tr')];
	if (!rows.length) {
		return '';
	}
	const matrix = rows.map(row => [...row.children].map(cell => inlineToMarkdown([...cell.childNodes]).replace(/\n+/g, ' ').replace(/\|/g, '\\|').trim()));
	const width = Math.max(...matrix.map(row => row.length));
	const header = rows[0];
	const aligns = [...header.children].map(cell => {
		const align = (cell as HTMLElement).getAttribute('align') ?? (cell as HTMLElement).style.textAlign;
		return align === 'center' ? ':---:' : align === 'right' ? '---:' : '---';
	});
	const line = (cells: string[]) => `| ${Array.from({ length: width }, (_, index) => cells[index] ?? '').join(' | ')} |`;
	const separator = `| ${Array.from({ length: width }, (_, index) => aligns[index] ?? '---').join(' | ')} |`;
	return [line(matrix[0]), separator, ...matrix.slice(1).map(line)].join('\n');
}

interface IInlineMarks {
	bold: boolean;
	italic: boolean;
	underline: boolean;
	strike: boolean;
}

function inlineToMarkdown(nodes: readonly Node[]): string {
	return nodes.map(node => inlineNode(node)).join('');
}

function inlineNode(node: Node): string {
	if (node.nodeType === Node.TEXT_NODE) {
		return escapeText((node.textContent ?? '').replace(/\u00a0/g, ' '));
	}
	if (!(isHTMLElement(node))) {
		return '';
	}
	const children = () => inlineToMarkdown([...node.childNodes]);
	switch (node.tagName) {
		case 'BR':
			return '  \n';
		case 'STRONG':
		case 'B':
			return wrap(children(), '**');
		case 'EM':
		case 'I':
			return wrap(children(), '*');
		case 'U':
		case 'INS':
			return wrapHtml(children(), 'u');
		case 'S':
		case 'DEL':
		case 'STRIKE':
			return wrap(children(), '~~');
		case 'CODE': {
			const text = node.textContent ?? '';
			const fence = text.includes('`') ? '``' : '`';
			return text ? `${fence}${fence.length > 1 ? ' ' : ''}${text}${fence.length > 1 ? ' ' : ''}${fence}` : '';
		}
		case 'A': {
			const href = node.getAttribute('href') ?? '';
			const label = children();
			if (!href) {
				return label;
			}
			if (label === href || label === escapeText(href)) {
				return `<${href}>`;
			}
			const title = node.getAttribute('title');
			return `[${label}](${href}${title ? ` "${title}"` : ''})`;
		}
		case 'IMG': {
			const src = node.dataset.mdSrc ?? node.getAttribute('src') ?? '';
			const alt = node.getAttribute('alt') ?? '';
			const title = node.getAttribute('title');
			return `![${alt}](${src}${title ? ` "${title}"` : ''})`;
		}
		case 'INPUT':
			return (node as HTMLInputElement).type === 'checkbox' ? ((node as HTMLInputElement).checked ? '[x] ' : '[ ] ') : '';
		case 'SUP':
		case 'SUB':
		case 'MARK':
		case 'KBD':
			return wrapHtml(children(), node.tagName.toLowerCase());
		case 'SPAN':
		case 'FONT': {
			const marks = styleMarks(node);
			let text = children();
			if (marks.strike) {
				text = wrap(text, '~~');
			}
			if (marks.underline) {
				text = wrapHtml(text, 'u');
			}
			if (marks.italic) {
				text = wrap(text, '*');
			}
			if (marks.bold) {
				text = wrap(text, '**');
			}
			return text;
		}
		default:
			if (isBlock(node)) {
				return `\n\n${blockToMarkdown(node)}\n\n`;
			}
			return children();
	}
}

/** Bold, italic, underline or strike-through written as inline style (pasted content, some edits). */
function styleMarks(element: HTMLElement): IInlineMarks {
	const style = element.style;
	const weight = style.fontWeight;
	const decoration = `${style.textDecoration} ${style.textDecorationLine}`;
	return {
		bold: weight === 'bold' || (Number(weight) >= 600),
		italic: style.fontStyle === 'italic',
		underline: decoration.includes('underline'),
		strike: decoration.includes('line-through'),
	};
}

/** Emphasis markers must hug the text: `** a **` does not render, so spaces move outside. */
function wrap(text: string, marker: string): string {
	if (!text.trim()) {
		return text;
	}
	const leading = /^\s*/.exec(text)![0];
	const trailing = /\s*$/.exec(text)![0];
	return `${leading}${marker}${text.trim()}${marker}${trailing}`;
}

function wrapHtml(text: string, tag: string): string {
	if (!text.trim()) {
		return text;
	}
	const leading = /^\s*/.exec(text)![0];
	const trailing = /\s*$/.exec(text)![0];
	return `${leading}<${tag}>${text.trim()}</${tag}>${trailing}`;
}

/**
 * Escapes only what would change meaning, so plain text round-trips unchanged: asterisks,
 * backticks, word-boundary underscores, a tag-like `<`, and `[`…`](` that would form a link.
 */
function escapeText(text: string): string {
	return text
		.replace(/\\/g, (match, offset: number, whole: string) => /[\\`*_[\]<>#]/.test(whole[offset + 1] ?? '') ? '\\\\' : match)
		.replace(/[*`]/g, '\\$&')
		.replace(/(^|\s)_|_(?=\s|$)/g, match => match.replace('_', '\\_'))
		.replace(/<(?=[A-Za-z/!])/g, '\\<')
		.replace(/\[([^\]]*)\]\(/g, '\\[$1\\](');
}

//#endregion

//#region Formatting

export type MarkdownFormat = 'bold' | 'italic' | 'underline' | 'strike' | 'link' | 'orderedList' | 'bulletList' | 'quote' | 'code' | 'codeBlock';

function selectionIn(root: HTMLElement): Selection | undefined {
	const selection = root.ownerDocument.getSelection();
	if (!selection || !selection.rangeCount) {
		return undefined;
	}
	const range = selection.getRangeAt(0);
	return root.contains(range.commonAncestorContainer) ? selection : undefined;
}

function closest(node: Node | null, tags: readonly string[], root: HTMLElement): HTMLElement | undefined {
	let current: Node | null = node;
	while (current && current !== root) {
		if (isHTMLElement(current) && tags.includes(current.tagName)) {
			return current;
		}
		current = current.parentNode;
	}
	return undefined;
}

/** Which formats apply to the current selection, for the toolbar's highlighted buttons. */
export function activeFormats(root: HTMLElement): Set<MarkdownFormat> {
	const active = new Set<MarkdownFormat>();
	const selection = selectionIn(root);
	if (!selection) {
		return active;
	}
	const doc = root.ownerDocument;
	const anchor = selection.anchorNode;
	const query = (command: string) => {
		try {
			return doc.queryCommandState(command);
		} catch {
			return false;
		}
	};
	if (query('bold') || closest(anchor, ['STRONG', 'B'], root)) {
		active.add('bold');
	}
	if (query('italic') || closest(anchor, ['EM', 'I'], root)) {
		active.add('italic');
	}
	if (query('underline') || closest(anchor, ['U', 'INS'], root)) {
		active.add('underline');
	}
	if (query('strikeThrough') || closest(anchor, ['S', 'DEL', 'STRIKE'], root)) {
		active.add('strike');
	}
	if (closest(anchor, ['A'], root)) {
		active.add('link');
	}
	if (closest(anchor, ['OL'], root)) {
		active.add('orderedList');
	} else if (closest(anchor, ['UL'], root)) {
		active.add('bulletList');
	}
	if (closest(anchor, ['BLOCKQUOTE'], root)) {
		active.add('quote');
	}
	if (closest(anchor, ['PRE'], root)) {
		active.add('codeBlock');
	} else if (closest(anchor, ['CODE'], root)) {
		active.add('code');
	}
	return active;
}

/** Applies a format to the selection. `url` is used for links. Returns whether the document changed. */
export function applyFormat(root: HTMLElement, format: MarkdownFormat, url?: string): boolean {
	const selection = selectionIn(root);
	if (!selection) {
		return false;
	}
	const doc = root.ownerDocument;
	const exec = (command: string, value?: string) => {
		try {
			doc.execCommand('styleWithCSS', false, 'false');
		} catch {
			// Older engines: tags are the default anyway.
		}
		return doc.execCommand(command, false, value);
	};
	const anchor = selection.anchorNode;
	switch (format) {
		case 'bold': return exec('bold');
		case 'italic': return exec('italic');
		case 'underline': return exec('underline');
		case 'strike': return exec('strikeThrough');
		case 'orderedList': return exec('insertOrderedList');
		case 'bulletList': return exec('insertUnorderedList');
		case 'link': {
			const existing = closest(anchor, ['A'], root);
			if (existing && !url) {
				const range = doc.createRange();
				range.selectNodeContents(existing);
				selection.removeAllRanges();
				selection.addRange(range);
				return exec('unlink');
			}
			return url ? exec('createLink', url) : false;
		}
		case 'quote': {
			const quote = closest(anchor, ['BLOCKQUOTE'], root);
			if (quote) {
				return exec('formatBlock', 'p');
			}
			return exec('formatBlock', 'blockquote');
		}
		case 'codeBlock': {
			const pre = closest(anchor, ['PRE'], root);
			return exec('formatBlock', pre ? 'p' : 'pre');
		}
		case 'code': {
			const code = closest(anchor, ['CODE'], root);
			if (code && !closest(code, ['PRE'], root)) {
				const text = doc.createTextNode(code.textContent ?? '');
				code.replaceWith(text);
				const range = doc.createRange();
				range.selectNodeContents(text);
				selection.removeAllRanges();
				selection.addRange(range);
				root.dispatchEvent(new InputEvent('input', { bubbles: true }));
				return true;
			}
			const range = selection.getRangeAt(0);
			if (range.collapsed) {
				return false;
			}
			const text = range.toString();
			return exec('insertHTML', `<code>${text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</code>`);
		}
	}
}

//#endregion
