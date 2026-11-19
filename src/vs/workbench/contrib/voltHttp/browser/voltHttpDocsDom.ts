/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { HttpMdAlign, HttpMdBlock, HttpMdInline, IHttpMdListItem } from '../common/httpMarkdown.js';

/*
 * The Docs editor's two halves of the DOM: drawing the Markdown model as elements, and reading
 * elements (ours, and whatever Chromium made of them while the user typed) back into the model.
 * Elements are only ever created, never parsed from text.
 */

const NBSP = new RegExp(String.fromCharCode(0xa0), 'g');
const ZERO_WIDTH = new RegExp(String.fromCharCode(0x200b), 'g');
const BLOCK_TAGS = new Set(['P', 'DIV', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'PRE', 'BLOCKQUOTE', 'UL', 'OL', 'LI', 'TABLE', 'HR', 'SECTION', 'ARTICLE', 'HEADER', 'FOOTER']);

function make(parent: Node, tag: string): HTMLElement {
	const owner = parent.ownerDocument ?? (parent as Document);
	return parent.appendChild(owner.createElement(tag));
}

function isElement(node: Node): node is HTMLElement {
	return node.nodeType === 1;
}

/** Whether an image address may be loaded in the window: anything else shows its alt text. */
function loadableImage(src: string): boolean {
	return /^(?:https:|data:image\/)/i.test(src);
}

// --- Drawing -----------------------------------------------------------------------------------

export function renderHttpDocsInlines(parent: Node, inlines: readonly HttpMdInline[]): void {
	const owner = parent.ownerDocument ?? (parent as Document);
	for (const node of inlines) {
		switch (node.type) {
			case 'text':
				parent.appendChild(owner.createTextNode(node.text));
				break;
			case 'strong':
				renderHttpDocsInlines(make(parent, 'strong'), node.children);
				break;
			case 'em':
				renderHttpDocsInlines(make(parent, 'em'), node.children);
				break;
			case 'strike':
				renderHttpDocsInlines(make(parent, 's'), node.children);
				break;
			case 'code':
				make(parent, 'code').textContent = node.text;
				break;
			case 'link': {
				// No href: a click never navigates the window. The editor opens it on Cmd/Ctrl+click.
				const link = make(parent, 'a');
				link.dataset.href = node.href;
				link.title = node.href;
				if (node.title) {
					link.dataset.title = node.title;
				}
				renderHttpDocsInlines(link, node.children);
				break;
			}
			case 'image': {
				const image = make(parent, 'img') as HTMLImageElement;
				image.dataset.src = node.src;
				image.alt = node.alt;
				if (node.title) {
					image.dataset.title = node.title;
				}
				if (loadableImage(node.src)) {
					image.src = node.src;
				}
				break;
			}
			case 'break':
				make(parent, 'br');
				break;
		}
	}
}

function fillInlines(element: HTMLElement, inlines: readonly HttpMdInline[]): void {
	renderHttpDocsInlines(element, inlines);
	if (!element.firstChild) {
		// An empty block needs something to hold the caret.
		make(element, 'br');
	}
}

/** A code block: its text always ends with one line end more than the code, so the last line can be empty. */
export function createHttpDocsCodeBlock(owner: Document, text: string, language: string): HTMLElement {
	const pre = owner.createElement('pre');
	pre.spellcheck = false;
	if (language) {
		pre.dataset.language = language;
	}
	pre.appendChild(owner.createTextNode(`${text}\n`));
	return pre;
}

function renderItem(list: HTMLElement, item: IHttpMdListItem): void {
	const element = make(list, 'li');
	if (item.checked !== undefined) {
		element.classList.add('task');
		element.dataset.checked = String(item.checked);
	}
	const [first, ...rest] = item.children;
	if (first?.type === 'paragraph' && rest.every(block => block.type === 'list')) {
		// The usual item: its text straight in the <li>, a nested list under it.
		fillInlines(element, first.children);
		renderHttpDocsBlocks(element, rest);
	} else if (!item.children.length) {
		make(element, 'br');
	} else {
		renderHttpDocsBlocks(element, item.children);
	}
}

export function renderHttpDocsBlocks(parent: Node, blocks: readonly HttpMdBlock[]): void {
	const owner = parent.ownerDocument ?? (parent as Document);
	for (const block of blocks) {
		switch (block.type) {
			case 'paragraph':
				fillInlines(make(parent, 'p'), block.children);
				break;
			case 'heading':
				fillInlines(make(parent, `h${Math.max(1, Math.min(6, block.level))}`), block.children);
				break;
			case 'code':
				parent.appendChild(createHttpDocsCodeBlock(owner, block.text, block.language));
				break;
			case 'quote': {
				const quote = make(parent, 'blockquote');
				renderHttpDocsBlocks(quote, block.children);
				if (!quote.firstChild) {
					make(make(quote, 'p'), 'br');
				}
				break;
			}
			case 'list': {
				const list = make(parent, block.ordered ? 'ol' : 'ul');
				if (block.ordered && block.start !== undefined && block.start !== 1) {
					list.setAttribute('start', String(block.start));
				}
				for (const item of block.items) {
					renderItem(list, item);
				}
				break;
			}
			case 'table': {
				const table = make(parent, 'table');
				const cell = (row: HTMLElement, tag: string, inlines: readonly HttpMdInline[], align: HttpMdAlign) => {
					const element = make(row, tag);
					if (align) {
						element.dataset.align = align;
						element.style.textAlign = align;
					}
					fillInlines(element, inlines);
				};
				const head = make(make(table, 'thead'), 'tr');
				block.header.forEach((inlines, column) => cell(head, 'th', inlines, block.align[column]));
				const body = make(table, 'tbody');
				for (const cells of block.rows) {
					const row = make(body, 'tr');
					block.header.forEach((_header, column) => cell(row, 'td', cells[column] ?? [], block.align[column]));
				}
				break;
			}
			case 'rule':
				make(parent, 'hr');
				break;
		}
	}
}

// --- Reading -----------------------------------------------------------------------------------

function cleanText(text: string): string {
	return text.replace(ZERO_WIDTH, '').replace(NBSP, ' ');
}

/** A code block's text: line breaks as line ends, without the one line end kept after the code. */
export function httpDocsCodeText(pre: Node): string {
	let text = '';
	const walk = (node: Node) => {
		if (node.nodeType === 3) {
			text += (node.nodeValue ?? '').replace(ZERO_WIDTH, '');
		} else if (isElement(node)) {
			if (node.tagName === 'BR') {
				text += '\n';
				return;
			}
			const block = (node.tagName === 'DIV' || node.tagName === 'P') && text && !text.endsWith('\n');
			if (block) {
				text += '\n';
			}
			node.childNodes.forEach(walk);
		}
	};
	pre.childNodes.forEach(walk);
	return text.endsWith('\n') ? text.slice(0, -1) : text;
}

function markOf(element: HTMLElement): ('strong' | 'em' | 'strike')[] {
	const marks: ('strong' | 'em' | 'strike')[] = [];
	const tag = element.tagName;
	const weight = element.style.fontWeight;
	if (weight ? weight === 'bold' || weight === 'bolder' || Number(weight) >= 600 : tag === 'B' || tag === 'STRONG') {
		marks.push('strong');
	}
	const slant = element.style.fontStyle;
	if (slant ? slant === 'italic' || slant === 'oblique' : tag === 'I' || tag === 'EM') {
		marks.push('em');
	}
	if (tag === 'S' || tag === 'STRIKE' || tag === 'DEL' || `${element.style.textDecorationLine} ${element.style.textDecoration}`.includes('line-through')) {
		marks.push('strike');
	}
	return marks;
}

function readInline(node: Node, out: HttpMdInline[]): void {
	if (node.nodeType === 3) {
		const text = cleanText(node.nodeValue ?? '');
		if (text) {
			out.push({ type: 'text', text });
		}
		return;
	}
	if (!isElement(node)) {
		return;
	}
	switch (node.tagName) {
		case 'BR':
			out.push({ type: 'break' });
			return;
		case 'IMG': {
			const src = node.dataset.src ?? node.getAttribute('src') ?? '';
			if (src) {
				out.push({ type: 'image', src, alt: node.getAttribute('alt') ?? '', ...(node.dataset.title ? { title: node.dataset.title } : {}) });
			}
			return;
		}
		case 'CODE':
		case 'TT':
		case 'SAMP': {
			const text = cleanText(node.textContent ?? '');
			if (text) {
				out.push({ type: 'code', text });
			}
			return;
		}
		case 'SCRIPT':
		case 'STYLE':
			return;
	}
	let children: HttpMdInline[] = [];
	node.childNodes.forEach(child => readInline(child, children));
	if (node.tagName === 'A') {
		const href = node.dataset.href ?? node.getAttribute('href') ?? '';
		if (href) {
			children = [{ type: 'link', href, ...(node.dataset.title ? { title: node.dataset.title } : {}), children }];
		}
	}
	for (const mark of markOf(node)) {
		children = [{ type: mark, children }];
	}
	out.push(...children);
}

export function readHttpDocsInlines(element: Node): HttpMdInline[] {
	const out: HttpMdInline[] = [];
	element.childNodes.forEach(child => readInline(child, out));
	return out;
}

function isBlock(node: Node): node is HTMLElement {
	return isElement(node) && BLOCK_TAGS.has(node.tagName);
}

function hasBlockChild(element: HTMLElement): boolean {
	for (const child of element.childNodes) {
		if (isBlock(child)) {
			return true;
		}
	}
	return false;
}

function readList(element: HTMLElement): HttpMdBlock {
	const items: { checked?: boolean; children: HttpMdBlock[] }[] = [];
	for (const child of element.children) {
		if (child.tagName === 'UL' || child.tagName === 'OL') {
			// Chromium nests a list beside the item it belongs under, not inside it.
			const nested = readList(child as HTMLElement);
			if (items.length) {
				items[items.length - 1].children.push(nested);
			} else {
				items.push({ children: [nested] });
			}
			continue;
		}
		const item = child as HTMLElement;
		const children = readHttpDocsBlocks(item);
		items.push(item.classList.contains('task') ? { checked: item.dataset.checked === 'true', children } : { children });
	}
	const start = Number(element.getAttribute('start'));
	const ordered = element.tagName === 'OL';
	return { type: 'list', ordered, ...(ordered && Number.isInteger(start) && start !== 1 && element.hasAttribute('start') ? { start } : {}), items };
}

function readTable(element: HTMLElement): HttpMdBlock[] {
	const rows = [...element.querySelectorAll('tr')].filter(row => row.closest('table') === element);
	if (!rows.length) {
		return [];
	}
	const cellsOf = (row: Element) => [...row.children].filter(cell => cell.tagName === 'TH' || cell.tagName === 'TD') as HTMLElement[];
	const head = cellsOf(rows[0]);
	const columns = Math.max(1, ...rows.map(row => cellsOf(row).length));
	const read = (cells: readonly HTMLElement[]) => {
		const out: HttpMdInline[][] = [];
		for (let column = 0; column < columns; column++) {
			out.push(cells[column] ? readHttpDocsInlines(cells[column]) : []);
		}
		return out;
	};
	const align: HttpMdAlign[] = [];
	for (let column = 0; column < columns; column++) {
		const mark = head[column]?.dataset.align;
		align.push(mark === 'left' || mark === 'center' || mark === 'right' ? mark : undefined);
	}
	return [{ type: 'table', align, header: read(head), rows: rows.slice(1).map(row => read(cellsOf(row))) }];
}

function readBlock(element: HTMLElement): HttpMdBlock[] {
	const tag = element.tagName;
	switch (tag) {
		case 'H1': case 'H2': case 'H3': case 'H4': case 'H5': case 'H6':
			return [{ type: 'heading', level: Number(tag[1]), children: readHttpDocsInlines(element) }];
		case 'PRE':
			return [{ type: 'code', language: element.dataset.language ?? '', text: httpDocsCodeText(element) }];
		case 'BLOCKQUOTE':
			return [{ type: 'quote', children: readHttpDocsBlocks(element) }];
		case 'UL':
		case 'OL':
			return [readList(element)];
		case 'TABLE':
			return readTable(element);
		case 'HR':
			return [{ type: 'rule' }];
	}
	return hasBlockChild(element) ? readHttpDocsBlocks(element) : [{ type: 'paragraph', children: readHttpDocsInlines(element) }];
}

/** The blocks under `parent`; text and inline elements lying loose between blocks are paragraphs. */
export function readHttpDocsBlocks(parent: Node): HttpMdBlock[] {
	const blocks: HttpMdBlock[] = [];
	let loose: HttpMdInline[] = [];
	const flush = () => {
		if (loose.some(node => node.type !== 'break' && (node.type !== 'text' || node.text.trim()))) {
			blocks.push({ type: 'paragraph', children: loose });
		}
		loose = [];
	};
	for (const child of parent.childNodes) {
		if (isBlock(child)) {
			flush();
			blocks.push(...readBlock(child));
		} else {
			readInline(child, loose);
		}
	}
	flush();
	return blocks;
}
