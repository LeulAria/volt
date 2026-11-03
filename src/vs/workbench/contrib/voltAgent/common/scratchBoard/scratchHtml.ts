/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Scratch rich text without a DOM: a small parser for the sanitized HTML subset the board stores
 * (paragraphs, inline marks, lists and checklists, tables, code), and conversions to markdown and
 * plain text for agents, search and row excerpts.
 */

export interface IHtmlNode {
	/** Lower-case tag name; undefined for a text node. */
	readonly tag: string | undefined;
	/** Decoded text of a text node. */
	readonly text?: string;
	readonly attrs: Readonly<Record<string, string>>;
	readonly children: IHtmlNode[];
}

const VOID_TAGS = new Set(['br', 'hr', 'img', 'input', 'wbr', 'col', 'meta', 'link']);
/** Tags that end an open paragraph when they start. */
const CLOSES_P = new Set(['p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'pre', 'blockquote', 'hr', 'table']);
/** A paragraph never closes across these. */
const P_SCOPE = new Set(['li', 'td', 'th', 'blockquote', 'div', 'table', 'ul', 'ol']);
const BLOCK_TAGS = new Set(['p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'pre', 'blockquote', 'hr', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th']);

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
	// allow-any-unicode-next-line
	amp: '&', lt: '<', gt: '>', quot: '"', apos: '\'', nbsp: ' ', ensp: ' ', emsp: ' ', thinsp: ' ',
	// allow-any-unicode-next-line
	ndash: '–', mdash: '—', hellip: '…', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
	// allow-any-unicode-next-line
	bull: '•', middot: '·', copy: '©', reg: '®', trade: '™', times: '×', divide: '÷',
	// allow-any-unicode-next-line
	laquo: '«', raquo: '»', larr: '←', rarr: '→', uarr: '↑', darr: '↓', deg: '°', euro: '€',
};

export function decodeEntities(text: string): string {
	if (text.indexOf('&') === -1) {
		return text;
	}
	return text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, body: string) => {
		if (body[0] === '#') {
			const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
			if (!Number.isFinite(code) || code < 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) {
				return match;
			}
			return code === 0 ? '\ufffd' : String.fromCodePoint(code);
		}
		return NAMED_ENTITIES[body] ?? NAMED_ENTITIES[body.toLowerCase()] ?? match;
	});
}

export function escapeHtml(text: string): string {
	return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

interface IMutableNode {
	tag: string | undefined;
	text?: string;
	attrs: Record<string, string>;
	children: IMutableNode[];
}

function parseAttributes(source: string): Record<string, string> {
	const attrs: Record<string, string> = {};
	const re = /([^\s"'>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(source))) {
		const name = m[1].toLowerCase();
		if (!(name in attrs)) {
			attrs[name] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? '');
		}
	}
	return attrs;
}

/** Tolerant HTML fragment parser for the rich-text subset. Never throws. */
export function parseHtmlFragment(html: string): IHtmlNode[] {
	const root: IMutableNode = { tag: '#root', attrs: {}, children: [] };
	const stack: IMutableNode[] = [root];
	const top = () => stack[stack.length - 1];
	const appendText = (raw: string) => {
		if (!raw) {
			return;
		}
		const text = decodeEntities(raw);
		const parent = top();
		const last = parent.children[parent.children.length - 1];
		if (last && last.tag === undefined) {
			last.text = (last.text ?? '') + text;
		} else {
			parent.children.push({ tag: undefined, text, attrs: {}, children: [] });
		}
	};
	/** Pops up to and including the nearest `tag`, unless a `scope` tag comes first. */
	const closeNearest = (tags: ReadonlySet<string>, scope: ReadonlySet<string>): boolean => {
		for (let i = stack.length - 1; i > 0; i--) {
			const t = stack[i].tag!;
			if (tags.has(t)) {
				stack.length = i;
				return true;
			}
			if (scope.has(t)) {
				return false;
			}
		}
		return false;
	};
	const open = (tag: string, attrs: Record<string, string>) => {
		if (CLOSES_P.has(tag)) {
			closeNearest(new Set(['p']), P_SCOPE);
		}
		if (tag === 'li') {
			closeNearest(new Set(['li']), new Set(['ul', 'ol', 'table']));
		} else if (tag === 'td' || tag === 'th') {
			closeNearest(new Set(['td', 'th']), new Set(['tr', 'table']));
		} else if (tag === 'tr') {
			closeNearest(new Set(['tr']), new Set(['table', 'thead', 'tbody', 'tfoot']));
		} else if (tag === 'thead' || tag === 'tbody' || tag === 'tfoot') {
			closeNearest(new Set(['thead', 'tbody', 'tfoot']), new Set(['table']));
		}
		const node: IMutableNode = { tag, attrs, children: [] };
		top().children.push(node);
		if (!VOID_TAGS.has(tag)) {
			stack.push(node);
		}
	};
	const close = (tag: string) => {
		for (let i = stack.length - 1; i > 0; i--) {
			if (stack[i].tag === tag) {
				stack.length = i;
				return;
			}
		}
		// A stray `</p>` makes an empty paragraph in browsers; nothing useful to keep here.
	};

	let i = 0;
	const n = html.length;
	while (i < n) {
		const lt = html.indexOf('<', i);
		if (lt === -1) {
			appendText(html.slice(i));
			break;
		}
		if (lt > i) {
			appendText(html.slice(i, lt));
		}
		if (html.startsWith('<!--', lt)) {
			const end = html.indexOf('-->', lt + 4);
			i = end === -1 ? n : end + 3;
			continue;
		}
		const closing = /^<\/([a-zA-Z][a-zA-Z0-9-]*)\s*>/.exec(html.slice(lt, lt + 64));
		if (closing) {
			close(closing[1].toLowerCase());
			i = lt + closing[0].length;
			continue;
		}
		const opening = /^<([a-zA-Z][a-zA-Z0-9-]*)((?:\s+[^\s"'>\/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*(\/?)>/.exec(html.slice(lt));
		if (opening) {
			const tag = opening[1].toLowerCase();
			const attrs = parseAttributes(opening[2]);
			open(tag, attrs);
			if (opening[3] === '/' && !VOID_TAGS.has(tag)) {
				close(tag);
			}
			i = lt + opening[0].length;
			if (tag === 'script' || tag === 'style') {
				// Raw text elements: skip to their end tag.
				const end = html.toLowerCase().indexOf(`</${tag}`, i);
				const stop = end === -1 ? n : end;
				i = stop;
			}
			continue;
		}
		// A lone `<` is text.
		appendText('<');
		i = lt + 1;
	}
	return root.children;
}

// ---- Shared walking helpers ----------------------------------------------------------------

function isBlock(node: IHtmlNode): boolean {
	return node.tag !== undefined && BLOCK_TAGS.has(node.tag);
}

/** Raw text of a subtree, without whitespace collapsing (for code). */
function rawText(node: IHtmlNode): string {
	if (node.tag === undefined) {
		return node.text ?? '';
	}
	if (node.tag === 'br') {
		return '\n';
	}
	let out = '';
	for (const child of node.children) {
		out += rawText(child);
	}
	return out;
}

function collapseWhitespace(text: string): string {
	return text.replace(/[ \t\r\n\f]+/g, ' ');
}

function codeLanguage(pre: IHtmlNode): string {
	const sources = [pre, ...pre.children.filter(c => c.tag === 'code')];
	for (const node of sources) {
		const cls = node.attrs['class'] ?? '';
		const m = /(?:^|\s)(?:language|lang)-([\w+#.-]+)/.exec(cls);
		if (m) {
			return m[1];
		}
		const data = node.attrs['data-language'];
		if (data && /^[\w+#.-]+$/.test(data)) {
			return data;
		}
	}
	return '';
}

function preText(pre: IHtmlNode): string {
	return rawText(pre).replace(/\u00a0/g, ' ').replace(/\n$/, '');
}

// ---- Markdown --------------------------------------------------------------------------------

function wrapMark(marker: string, inner: string): string {
	const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(inner)!;
	if (!m[2]) {
		return inner;
	}
	return `${m[1]}${marker}${m[2]}${marker}${m[3]}`;
}

function inlineCode(text: string): string {
	const content = text.replace(/\n/g, ' ');
	if (!content) {
		return '';
	}
	let longest = 0;
	for (const run of content.match(/`+/g) ?? []) {
		longest = Math.max(longest, run.length);
	}
	const fence = '`'.repeat(longest + 1);
	const pad = content.startsWith('`') || content.endsWith('`') ? ' ' : '';
	return `${fence}${pad}${content}${pad}${fence}`;
}

function escapeMarkdownText(text: string): string {
	return text.replace(/([*`])/g, '\\$1');
}

function markdownInline(nodes: readonly IHtmlNode[], inTable: boolean): string {
	let out = '';
	for (const node of nodes) {
		out += markdownInlineNode(node, inTable);
	}
	return out;
}

function markdownInlineNode(node: IHtmlNode, inTable: boolean): string {
	if (node.tag === undefined) {
		const text = escapeMarkdownText(collapseWhitespace(node.text ?? ''));
		return inTable ? text.replace(/\|/g, '\\|') : text;
	}
	switch (node.tag) {
		case 'br':
			return inTable ? '<br>' : '\n';
		case 'strong': case 'b':
			return wrapMark('**', markdownInline(node.children, inTable));
		case 'em': case 'i':
			return wrapMark('*', markdownInline(node.children, inTable));
		case 's': case 'del': case 'strike':
			return wrapMark('~~', markdownInline(node.children, inTable));
		case 'code': {
			const code = inlineCode(rawText(node).replace(/\u00a0/g, ' '));
			return inTable ? code.replace(/\|/g, '\\|') : code;
		}
		case 'a': {
			const inner = markdownInline(node.children, inTable).trim();
			const href = (node.attrs['href'] ?? '').trim();
			if (!href) {
				return inner;
			}
			const target = /[\s()<>]/.test(href) ? `<${href.replace(/[<>]/g, encodeURIComponent)}>` : href;
			if (!inner) {
				return `<${href}>`;
			}
			return `[${inner}](${target})`;
		}
		case 'img': {
			const src = node.attrs['src'] ?? '';
			return src ? `![${node.attrs['alt'] ?? ''}](${src})` : '';
		}
		case 'input':
			return '';
		default:
			// u, span, mark, unknown inline wrappers, and blocks met in inline context.
			if (isBlock(node)) {
				const inner = markdownInline(node.children, inTable);
				return inTable ? ` ${inner} ` : `\n${inner}\n`;
			}
			return markdownInline(node.children, inTable);
	}
}

/** Collapses the spaces around line breaks and at both ends of an inline run. */
function tidyInline(text: string): string {
	return text.replace(/\u00a0/g, ' ').replace(/[ \t]*\n[ \t]*/g, '\n').replace(/ {2,}/g, ' ').replace(/^\n+|\n+$/g, '').trim();
}

function indentLines(text: string, indent: string, firstIndent = indent): string {
	return text.split('\n').map((line, i) => (line ? (i === 0 ? firstIndent : indent) + line : line)).join('\n');
}

function markdownTable(table: IHtmlNode): string {
	const rows: { cells: string[] }[] = [];
	const visit = (node: IHtmlNode) => {
		for (const child of node.children) {
			if (child.tag === 'tr') {
				const cells: string[] = [];
				for (const cell of child.children) {
					if (cell.tag === 'td' || cell.tag === 'th') {
						cells.push(tidyInline(markdownInline(cell.children, true)).replace(/\n/g, '<br>'));
					}
				}
				rows.push({ cells });
			} else if (child.tag === 'thead' || child.tag === 'tbody' || child.tag === 'tfoot') {
				visit(child);
			}
		}
	};
	visit(table);
	if (!rows.length) {
		return '';
	}
	// GFM tables need exactly one header row; the first row plays that part.
	const columns = Math.max(1, ...rows.map(r => r.cells.length));
	const widths: number[] = new Array(columns).fill(3);
	for (const row of rows) {
		for (let c = 0; c < columns; c++) {
			widths[c] = Math.max(widths[c], (row.cells[c] ?? '').length);
		}
	}
	const line = (cells: readonly string[]) => '| ' + widths.map((w, c) => (cells[c] ?? '').padEnd(w)).join(' | ') + ' |';
	const out = [line(rows[0].cells), '| ' + widths.map(w => '-'.repeat(w)).join(' | ') + ' |'];
	for (let r = 1; r < rows.length; r++) {
		out.push(line(rows[r].cells));
	}
	return out.join('\n');
}

function markdownList(list: IHtmlNode): string {
	const ordered = list.tag === 'ol';
	let index = ordered ? Math.max(0, parseInt(list.attrs['start'] ?? '1', 10) || 1) : 0;
	const items: string[] = [];
	for (const child of list.children) {
		if (child.tag === 'li') {
			items.push(markdownListItem(child, ordered ? `${index++}. ` : '- '));
		} else if (child.tag === 'ul' || child.tag === 'ol') {
			// A list nested straight in a list (contenteditable does this): indent under the last item.
			const nested = indentLines(markdownList(child), '  ');
			if (items.length) {
				items[items.length - 1] += '\n' + nested;
			} else {
				items.push(nested);
			}
		} else if (child.tag !== undefined || (child.text ?? '').trim()) {
			const text = tidyInline(markdownInlineNode(child, false));
			if (text) {
				items.push(markdownListItem({ tag: 'li', attrs: {}, children: [child] }, ordered ? `${index++}. ` : '- '));
			}
		}
	}
	return items.join('\n');
}

function markdownListItem(li: IHtmlNode, marker: string): string {
	const checked = li.attrs['data-checked'];
	const box = checked === 'true' ? '[x] ' : checked === 'false' ? '[ ] ' : '';
	const blocks = markdownBlocks(li.children);
	const indent = ' '.repeat(marker.length);
	if (!blocks.length) {
		return (marker + box).trimEnd();
	}
	let body = '';
	blocks.forEach((block, i) => {
		if (i === 0) {
			body = block.text;
		} else {
			body += (block.kind === 'list' ? '\n' : '\n\n') + block.text;
		}
	});
	return indentLines(body, indent, marker + box);
}

interface IMarkdownBlock {
	readonly kind: 'para' | 'list' | 'other';
	readonly text: string;
}

function markdownBlocks(nodes: readonly IHtmlNode[]): IMarkdownBlock[] {
	const blocks: IMarkdownBlock[] = [];
	let run: IHtmlNode[] = [];
	const flush = () => {
		if (run.length) {
			const text = tidyInline(markdownInline(run, false));
			if (text) {
				blocks.push({ kind: 'para', text });
			}
			run = [];
		}
	};
	for (const node of nodes) {
		if (!isBlock(node)) {
			run.push(node);
			continue;
		}
		flush();
		const block = markdownBlock(node);
		if (block && block.text) {
			blocks.push(block);
		}
	}
	flush();
	return blocks;
}

function markdownBlock(node: IHtmlNode): IMarkdownBlock | undefined {
	switch (node.tag) {
		case 'p': case 'div': case 'td': case 'th': case 'tr': case 'thead': case 'tbody': case 'tfoot': {
			const inner = markdownBlocks(node.children);
			return inner.length ? { kind: inner.length === 1 ? inner[0].kind : 'other', text: joinBlocks(inner) } : undefined;
		}
		case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6': {
			const text = tidyInline(markdownInline(node.children, false)).replace(/\n/g, ' ');
			return text ? { kind: 'other', text: `${'#'.repeat(Number(node.tag[1]))} ${text}` } : undefined;
		}
		case 'ul': case 'ol': {
			const text = markdownList(node);
			return text ? { kind: 'list', text } : undefined;
		}
		case 'li':
			return { kind: 'list', text: markdownListItem(node, '- ') };
		case 'blockquote': {
			const inner = joinBlocks(markdownBlocks(node.children));
			return inner ? { kind: 'other', text: inner.split('\n').map(line => line ? `> ${line}` : '>').join('\n') } : undefined;
		}
		case 'pre': {
			const code = preText(node);
			let longest = 2;
			for (const run of code.match(/^`{3,}/gm) ?? []) {
				longest = Math.max(longest, run.length);
			}
			const fence = '`'.repeat(longest + 1);
			return { kind: 'other', text: `${fence}${codeLanguage(node)}\n${code}\n${fence}` };
		}
		case 'hr':
			return { kind: 'other', text: '---' };
		case 'table': {
			const text = markdownTable(node);
			return text ? { kind: 'other', text } : undefined;
		}
		default:
			return undefined;
	}
}

function joinBlocks(blocks: readonly IMarkdownBlock[]): string {
	return blocks.map(b => b.text).join('\n\n');
}

/** GitHub-flavoured markdown for the rich-text subset. */
export function htmlToMarkdown(html: string): string {
	return joinBlocks(markdownBlocks(parseHtmlFragment(html))).replace(/\s+$/, '');
}

// ---- Plain text ------------------------------------------------------------------------------

function plainInline(nodes: readonly IHtmlNode[]): string {
	let out = '';
	for (const node of nodes) {
		if (node.tag === undefined) {
			out += collapseWhitespace(node.text ?? '');
		} else if (node.tag === 'br') {
			out += '\n';
		} else if (node.tag === 'img') {
			out += node.attrs['alt'] ?? '';
		} else if (isBlock(node)) {
			out += '\n' + plainBlocks([node]).join('\n') + '\n';
		} else {
			out += plainInline(node.children);
		}
	}
	return out;
}

function plainBlocks(nodes: readonly IHtmlNode[], depth = 0): string[] {
	const lines: string[] = [];
	let run: IHtmlNode[] = [];
	const flush = () => {
		if (run.length) {
			const text = tidyInline(plainInline(run));
			if (text) {
				lines.push(text);
			}
			run = [];
		}
	};
	for (const node of nodes) {
		if (!isBlock(node)) {
			run.push(node);
			continue;
		}
		flush();
		switch (node.tag) {
			case 'ul': case 'ol': {
				let index = node.tag === 'ol' ? (parseInt(node.attrs['start'] ?? '1', 10) || 1) : 0;
				for (const child of node.children) {
					if (child.tag === 'li') {
						const checked = child.attrs['data-checked'];
						const bullet = checked === 'true' ? '[x] ' : checked === 'false' ? '[ ] ' : node.tag === 'ol' ? `${index++}. ` : '• ';
						const body = plainBlocks(child.children, depth + 1);
						const pad = '  '.repeat(depth);
						if (!body.length) {
							lines.push((pad + bullet).trimEnd());
						} else {
							lines.push(pad + bullet + body[0].trimStart());
							for (const rest of body.slice(1)) {
								lines.push(rest.startsWith(pad + '  ') ? rest : pad + '  ' + rest.trimStart());
							}
						}
					} else if (child.tag === 'ul' || child.tag === 'ol') {
						lines.push(...plainBlocks([child], depth + 1));
					} else {
						const text = tidyInline(plainInline([child]));
						if (text) {
							lines.push('  '.repeat(depth) + '• ' + text);
						}
					}
				}
				break;
			}
			case 'pre':
				lines.push(preText(node));
				break;
			case 'hr':
				// allow-any-unicode-next-line
				lines.push('———');
				break;
			case 'table': {
				const visit = (parent: IHtmlNode) => {
					for (const child of parent.children) {
						if (child.tag === 'tr') {
							lines.push(child.children.filter(c => c.tag === 'td' || c.tag === 'th').map(c => tidyInline(plainInline(c.children)).replace(/\n/g, ' ')).join('\t'));
						} else if (child.tag === 'thead' || child.tag === 'tbody' || child.tag === 'tfoot') {
							visit(child);
						}
					}
				};
				visit(node);
				break;
			}
			default:
				lines.push(...plainBlocks(node.children, depth));
				break;
		}
	}
	flush();
	return lines;
}

/** Readable text: blocks on their own lines, bullets for lists, tabs between table cells. */
export function htmlToPlainText(html: string): string {
	return plainBlocks(parseHtmlFragment(html)).join('\n').replace(/\u00a0/g, ' ').trim();
}

/** Each line becomes a paragraph; blank lines keep their place. */
export function plainTextToHtml(text: string): string {
	return text.split(/\r\n|\r|\n/).map(line => line.length ? `<p>${escapeHtml(line)}</p>` : '<p><br></p>').join('');
}

/** No visible content: no text, rule, image or table. */
export function isEmptyRichText(html: string): boolean {
	const visit = (nodes: readonly IHtmlNode[]): boolean => {
		for (const node of nodes) {
			if (node.tag === undefined) {
				if ((node.text ?? '').replace(/[\s\u00a0\u200b]/g, '')) {
					return false;
				}
			} else if (node.tag === 'hr' || node.tag === 'img' || node.tag === 'table') {
				return false;
			} else if (!visit(node.children)) {
				return false;
			}
		}
		return true;
	};
	return visit(parseHtmlFragment(html));
}

/** One line of text for a row or a tooltip, cut with an ellipsis. */
export function richTextExcerpt(html: string, max: number): string {
	const text = htmlToPlainText(html).replace(/\s+/g, ' ').trim();
	if (text.length <= max) {
		return text;
	}
	return text.slice(0, Math.max(0, max - 1)).trimEnd() + '…';
}

// ---- Markdown detection ----------------------------------------------------------------------

/**
 * Whether pasted text is markdown worth rendering. One strong sign (a table, fenced code, a
 * heading with text after it, a list of two or more items) or two weaker ones (bold, links,
 * quotes, inline code, a lone heading).
 */
export function looksLikeMarkdown(text: string): boolean {
	const source = text.replace(/\r\n?/g, '\n').trim();
	if (!source) {
		return false;
	}
	const lines = source.split('\n');
	const nonEmpty = lines.filter(line => line.trim());
	if (nonEmpty.length === 1 && /^\s*(https?:\/\/|www\.)\S+\s*$/i.test(source)) {
		return false;
	}

	// Fenced code with a closing fence.
	const fences = lines.filter(line => /^\s{0,3}(```|~~~)/.test(line)).length;
	if (fences >= 2) {
		return true;
	}
	// A table: a row with pipes, then a separator row.
	for (let i = 0; i + 1 < lines.length; i++) {
		if (lines[i].includes('|') && /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(lines[i + 1]) && lines[i + 1].includes('-')
			&& (lines[i + 1].includes('|') || lines[i].trim().startsWith('|'))) {
			return true;
		}
	}
	const headingIndex = lines.findIndex(line => /^\s{0,3}#{1,6}\s+\S/.test(line));
	if (headingIndex !== -1 && lines.slice(headingIndex + 1).some(line => line.trim())) {
		return true;
	}
	const listItems = lines.filter(line => /^\s*([-*+]|\d{1,3}[.)])\s+\S/.test(line)).length;
	if (listItems >= 2) {
		return true;
	}

	let weak = 0;
	if (headingIndex !== -1) {
		weak++;
	}
	if (/(\*\*|__)(?=\S)[^\n]*?\S\1/.test(source)) {
		weak++;
	}
	if (/\[[^\]\n]+\]\([^)\s]+\)/.test(source)) {
		weak++;
	}
	if (lines.some(line => /^\s{0,3}>\s?\S/.test(line))) {
		weak++;
	}
	if (/(^|[^`])`[^`\n]+`(?!`)/.test(source)) {
		weak++;
	}
	if (lines.some(line => /^\s*[-*+]\s+\[[ xX]\]\s/.test(line))) {
		weak++;
	}
	if (lines.some(line => /^\s{0,3}(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) && nonEmpty.length > 1) {
		weak++;
	}
	if (/(^|\s)~~\S[^\n]*?\S~~/.test(source)) {
		weak++;
	}
	return weak >= 2;
}
