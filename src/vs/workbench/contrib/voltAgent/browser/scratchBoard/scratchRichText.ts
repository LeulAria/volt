/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { DomSanitizerConfig, safeSetInnerHtml, sanitizeHtml } from '../../../../../base/browser/domSanitize.js';
import { marked } from '../../../../../base/common/marked/marked.js';
import { ILanguageService } from '../../../../../editor/common/languages/language.js';
import { highlight } from '../blocks/agentCodeBlock.js';

/**
 * Rich text on the board: a small HTML vocabulary (what markdown can say, plus underline and
 * checklists). Stored sanitized; edited in place with contenteditable; pasted markdown is
 * rendered into it, never shown as source.
 */

export const RICH_TEXT_TAGS = [
	'p', 'br', 'strong', 'b', 'em', 'i', 'u', 's', 'del', 'code', 'pre', 'a', 'ul', 'ol', 'li',
	'h1', 'h2', 'h3', 'blockquote', 'hr', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'span', 'div', 'mark',
	// A quieter line under a card's title (a diagram's subtitles).
	'small',
] as const;

const LINK_PROTOCOLS = ['http', 'https', 'mailto'];

const RICH_CONFIG: DomSanitizerConfig = {
	allowedTags: { override: RICH_TEXT_TAGS },
	allowedAttributes: {
		override: [
			'href',
			{ attributeName: 'data-checked', shouldKeep: (_el, data) => data.attrValue === 'true' || data.attrValue === 'false' },
			{ attributeName: 'class', shouldKeep: (el, data) => el.tagName === 'CODE' && /^language-[\w#+.-]{1,40}$/.test(data.attrValue) },
			{ attributeName: 'align', shouldKeep: (el, data) => (el.tagName === 'TD' || el.tagName === 'TH') && /^(left|center|right)$/.test(data.attrValue) },
		],
	},
	allowedLinkProtocols: { override: LINK_PROTOCOLS },
};

/** Marked's task lists come with <input type=checkbox>; let them through once to turn into data-checked. */
const MARKDOWN_CONFIG: DomSanitizerConfig = {
	...RICH_CONFIG,
	allowedTags: { override: [...RICH_TEXT_TAGS, 'input'] },
	allowedAttributes: { override: [...(RICH_CONFIG.allowedAttributes!.override!), 'type', 'checked'] },
};

/** Inline styles from pasted HTML, kept only long enough to read marks from (no url(), no expressions). */
const PASTE_STYLE = /^[\w\s:;.#%,-]{0,500}$/;

/** Pasted HTML: spans and <b> keep their style briefly, because Google Docs and others mark bold or italic that way. */
const PASTE_CONFIG: DomSanitizerConfig = {
	...RICH_CONFIG,
	allowedAttributes: {
		override: [
			...RICH_CONFIG.allowedAttributes!.override!,
			{ attributeName: 'style', shouldKeep: (el, data) => (el.tagName === 'SPAN' || el.tagName === 'B') && PASTE_STYLE.test(data.attrValue) },
		],
	},
};

export function sanitizeRichHtml(html: string): string {
	return sanitizeHtml(html, RICH_CONFIG).toString();
}

/** Rich text for insertHTML: the window only takes TrustedHTML there. */
export function trustedRichHtml(html: string): TrustedHTML {
	return sanitizeHtml(html, RICH_CONFIG);
}

/** HTML from the clipboard (another app's copy) as board rich text. */
export function pastedHtmlToRich(html: string, doc: Document): string {
	const container = doc.createElement('div');
	safeSetInnerHtml(container, html, PASTE_CONFIG);
	return normalizeRichDom(container);
}

/** The marks an inline style stands for; a <b> is bold unless its style says otherwise (Google Docs' wrapper). */
function styleMarks(style: string, isBold: boolean): string[] {
	const s = style.toLowerCase();
	const marks: string[] = [];
	const weight = /font-weight\s*:\s*([a-z0-9]+)/.exec(s)?.[1];
	if (weight ? weight === 'bold' || weight === 'bolder' || parseInt(weight, 10) >= 600 : isBold) {
		marks.push('strong');
	}
	if (/font-style\s*:\s*italic/.test(s)) {
		marks.push('em');
	}
	if (/text-decoration[\w-]*\s*:[^;]*underline/.test(s)) {
		marks.push('u');
	}
	if (/text-decoration[\w-]*\s*:[^;]*line-through/.test(s)) {
		marks.push('s');
	}
	return marks;
}

export function setRichHtml(node: HTMLElement, html: string): void {
	safeSetInnerHtml(node, html, RICH_CONFIG);
}

/** Markdown (GitHub flavour: tables, task lists, fences) as board rich text. */
export function markdownToRichHtml(markdown: string, doc: Document): string {
	let html: string;
	try {
		html = marked.parse(markdown, { async: false, gfm: true, breaks: false }) as string;
	} catch {
		return plainTextAsRichHtml(markdown);
	}
	const container = doc.createElement('div');
	safeSetInnerHtml(container, html, MARKDOWN_CONFIG);
	for (const input of Array.from(container.querySelectorAll('input'))) {
		const li = input.closest('li');
		if (li && input.getAttribute('type') === 'checkbox') {
			li.setAttribute('data-checked', input.hasAttribute('checked') ? 'true' : 'false');
			// Loose lists wrap the item in <p>; the checkbox drawing sits on the <li>.
			const next = input.nextSibling;
			if (next && next.nodeType === Node.TEXT_NODE && next.textContent?.startsWith(' ')) {
				next.textContent = next.textContent.slice(1);
			}
		}
		input.remove();
	}
	return normalizeRichDom(container);
}

export function plainTextAsRichHtml(text: string): string {
	const lines = text.replace(/\r\n?/g, '\n').split('\n');
	return lines.map(line => line ? `<p>${escapeText(line)}</p>` : '<p><br></p>').join('');
}

function escapeText(text: string): string {
	return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const INLINE_RENAMES: Readonly<Record<string, string>> = { B: 'strong', I: 'em', STRIKE: 's', DEL: 's' };
const BLOCKS = new Set(['P', 'UL', 'OL', 'H1', 'H2', 'H3', 'BLOCKQUOTE', 'PRE', 'TABLE', 'HR', 'DIV']);

/**
 * Cleans what contenteditable produced (divs for lines, <b>, <strike>, styled spans, stray
 * <br>s) into the stored vocabulary, sanitized. Mutates `root`.
 */
const NESTED_BLOCK = /^(UL|OL|H1|H2|H3|BLOCKQUOTE|PRE|TABLE|HR|P|DIV)$/;

/** Splits paragraphs that hold blocks into those blocks plus paragraphs of what was around them. */
export function liftNestedBlocks(root: HTMLElement): boolean {
	let changed = false;
	for (const p of Array.from(root.querySelectorAll('p'))) {
		if (!Array.from(p.children).some(c => NESTED_BLOCK.test(c.tagName))) {
			continue;
		}
		changed = true;
		const parent = p.parentNode!;
		let run: HTMLElement | undefined;
		for (const child of Array.from(p.childNodes)) {
			if (child.nodeType === Node.ELEMENT_NODE && NESTED_BLOCK.test((child as Element).tagName)) {
				run = undefined;
				parent.insertBefore(child, p);
			} else if (child.nodeType === Node.TEXT_NODE && !run && !(child.textContent ?? '').replace(/[\u200b\s]/g, '')) {
				child.remove();
			} else {
				if (!run) {
					run = p.ownerDocument.createElement('p');
					parent.insertBefore(run, p);
				}
				run.appendChild(child);
			}
		}
		p.remove();
	}
	return changed;
}

/**
 * Inline content sitting at the top level goes into paragraphs. While editing (`live`), blank runs
 * stay where they are: the caret may be in one.
 */
export function wrapLooseInline(root: HTMLElement, live: boolean): boolean {
	const doc = root.ownerDocument;
	let changed = false;
	let pending: Node[] = [];
	const flush = (before: Node | null) => {
		if (!pending.length) {
			return;
		}
		const meaningful = pending.some(n => n.nodeType !== Node.TEXT_NODE || (n.textContent ?? '').trim().length > 0);
		if (meaningful) {
			const p = doc.createElement('p');
			for (const n of pending) {
				p.appendChild(n);
			}
			root.insertBefore(p, before);
			changed = true;
		} else if (!live) {
			for (const n of pending) {
				n.parentNode?.removeChild(n);
			}
			changed = true;
		}
		pending = [];
	};
	for (const node of Array.from(root.childNodes)) {
		if (node.nodeType === Node.ELEMENT_NODE && BLOCKS.has((node as Element).tagName)) {
			flush(node);
		} else if (node.nodeType === Node.ELEMENT_NODE && (node as Element).tagName === 'BR' && pending.length === 0) {
			// A bare <br> between blocks is an empty line.
			const p = doc.createElement('p');
			p.appendChild(doc.createElement('br'));
			root.replaceChild(p, node);
			changed = true;
		} else {
			pending.push(node);
		}
	}
	flush(null);
	return changed;
}

export function normalizeRichDom(root: HTMLElement): string {
	const doc = root.ownerDocument;
	const rename = (el: Element, tag: string): Element => {
		const next = doc.createElement(tag);
		for (const attr of Array.from(el.attributes)) {
			next.setAttribute(attr.name, attr.value);
		}
		while (el.firstChild) {
			next.appendChild(el.firstChild);
		}
		el.replaceWith(next);
		return next;
	};
	const unwrap = (el: Element) => {
		while (el.firstChild) {
			el.parentNode?.insertBefore(el.firstChild, el);
		}
		el.remove();
	};
	// Deepest first so renames do not invalidate the walk.
	const all = Array.from(root.querySelectorAll('*')).reverse();
	for (const el of all) {
		const tag = el.tagName;
		const style = tag === 'SPAN' || tag === 'B' ? el.getAttribute('style') : null;
		if (style !== null) {
			// Styled text from a paste: its marks as tags, the style itself dropped.
			const marks = styleMarks(style, tag === 'B');
			if (!marks.length) {
				unwrap(el);
				continue;
			}
			const outer = doc.createElement(marks[0]);
			let inner = outer;
			for (const mark of marks.slice(1)) {
				inner = inner.appendChild(doc.createElement(mark));
			}
			while (el.firstChild) {
				inner.appendChild(el.firstChild);
			}
			el.replaceWith(outer);
			continue;
		}
		if (INLINE_RENAMES[tag]) {
			rename(el, INLINE_RENAMES[tag]);
		} else if (tag === 'SPAN' || tag === 'FONT') {
			if (!el.attributes.length || tag === 'FONT') {
				unwrap(el);
			}
		} else if (tag === 'DIV') {
			// A line contenteditable made: a paragraph, unless it holds blocks of its own.
			if (Array.from(el.children).some(c => BLOCKS.has(c.tagName))) {
				unwrap(el);
			} else {
				rename(el, 'p');
			}
		}
	}
	liftNestedBlocks(root);
	wrapLooseInline(root, false);
	// Trailing empty lines are noise.
	while (root.lastElementChild && root.lastElementChild.tagName === 'P' && isEmptyBlock(root.lastElementChild) && root.children.length > 1) {
		root.lastElementChild.remove();
	}
	if (root.children.length === 1 && root.firstElementChild?.tagName === 'P' && isEmptyBlock(root.firstElementChild)) {
		return '';
	}
	return sanitizeRichHtml(root.innerHTML);
}

function isEmptyBlock(el: Element): boolean {
	return (el.textContent ?? '').replace(/\u200b/g, '').trim() === '' && !el.querySelector('hr, img');
}

/** Colours code fences with the editor's own tokenizer; plain when the language is unknown. */
export async function highlightCodeBlocks(root: HTMLElement, languageService: ILanguageService): Promise<void> {
	const blocks = Array.from(root.querySelectorAll('pre > code'));
	for (const code of blocks) {
		if (code.getAttribute('data-highlighted') === 'true') {
			continue;
		}
		const match = /language-([\w#+.-]+)/.exec(code.className);
		if (!match) {
			continue;
		}
		const text = code.textContent ?? '';
		try {
			const lines = await highlight(languageService, match[1].toLowerCase(), text.replace(/\n$/, ''));
			if (!code.isConnected || code.textContent !== text) {
				continue;
			}
			const fragment = root.ownerDocument.createDocumentFragment();
			lines.forEach((line, i) => {
				for (const node of line) {
					fragment.appendChild(node.cloneNode(true));
				}
				if (i < lines.length - 1) {
					fragment.appendChild(root.ownerDocument.createTextNode('\n'));
				}
			});
			code.replaceChildren(fragment);
			code.setAttribute('data-highlighted', 'true');
		} catch {
			// No tokenizer: the block stays plain.
		}
	}
}
