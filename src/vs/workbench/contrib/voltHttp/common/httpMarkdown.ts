/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*
 * The Markdown of a request's documentation as a small block/inline model, and back. The Docs
 * editor draws the model, reads what the user made of it and writes Markdown again, so the file
 * keeps plain Markdown (what Postman stores) while the user edits rich text.
 *
 * The parser follows CommonMark and GFM closely enough for documentation: ATX and setext headings,
 * paragraphs, emphasis, strikethrough, code spans, fenced and indented code, links, images, nested
 * bullet and numbered lists, task items, block quotes, pipe tables, rules and hard breaks. Raw HTML
 * and entities are kept as the text they are. The serializer writes one canonical form, so writing
 * what was parsed is stable from the first pass on.
 */

export type HttpMdMark = 'strong' | 'em' | 'strike';

export type HttpMdInline =
	| { readonly type: 'text'; readonly text: string }
	| { readonly type: HttpMdMark; readonly children: readonly HttpMdInline[] }
	| { readonly type: 'code'; readonly text: string }
	| { readonly type: 'link'; readonly href: string; readonly title?: string; readonly children: readonly HttpMdInline[] }
	| { readonly type: 'image'; readonly src: string; readonly alt: string; readonly title?: string }
	| { readonly type: 'break' };

export type HttpMdAlign = 'left' | 'center' | 'right' | undefined;

export interface IHttpMdListItem {
	/** A task item's box; absent for a plain item. */
	readonly checked?: boolean;
	readonly children: readonly HttpMdBlock[];
}

export type HttpMdBlock =
	| { readonly type: 'paragraph'; readonly children: readonly HttpMdInline[] }
	| { readonly type: 'heading'; readonly level: number; readonly children: readonly HttpMdInline[] }
	| { readonly type: 'code'; readonly language: string; readonly text: string }
	| { readonly type: 'quote'; readonly children: readonly HttpMdBlock[] }
	| { readonly type: 'list'; readonly ordered: boolean; readonly start?: number; readonly items: readonly IHttpMdListItem[] }
	| { readonly type: 'table'; readonly align: readonly HttpMdAlign[]; readonly header: readonly (readonly HttpMdInline[])[]; readonly rows: readonly (readonly (readonly HttpMdInline[])[])[] }
	| { readonly type: 'rule' };

// --- Parsing: blocks ---------------------------------------------------------------------------

const FENCE = /^ {0,3}(`{3,}|~{3,})[ \t]*(.*)$/;
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*))?$/;
const RULE = /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/;
const QUOTE = /^ {0,3}>/;
const LIST = /^( {0,3})(?:([-*+])|(\d{1,9})([.)]))(?:([ \t]+)(.*))?$/;
const SETEXT = /^ {0,3}(=+|-+)[ \t]*$/;
const TABLE_DELIMITER = /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;
const PUNCTUATION = /[!-\/:-@\[-`{-~]/;

function isBlank(line: string): boolean {
	return !line.trim();
}

/** The width of a line's leading white space, a tab counting as four. */
function indentOf(line: string): number {
	let width = 0;
	for (const char of line) {
		if (char === ' ') {
			width++;
		} else if (char === '\t') {
			width += 4;
		} else {
			break;
		}
	}
	return width;
}

/** `line` without up to `width` columns of leading white space. */
function stripIndent(line: string, width: number): string {
	if (width <= 0) {
		return line;
	}
	const lead = /^[ \t]*/.exec(line)?.[0] ?? '';
	const spaces = lead.replace(/\t/g, '    ');
	return spaces.slice(Math.min(width, spaces.length)) + line.slice(lead.length);
}

function fenceOf(line: string): { readonly marker: string; readonly info: string } | undefined {
	const match = FENCE.exec(line);
	if (!match || (match[1][0] === '`' && match[2].includes('`'))) {
		return undefined;
	}
	return { marker: match[1], info: match[2].trim() };
}

interface IListMarker {
	readonly ordered: boolean;
	readonly start: number;
	/** Where the item's content starts: what its other lines are indented by. */
	readonly width: number;
	readonly rest: string;
}

function listMarker(line: string): IListMarker | undefined {
	const match = LIST.exec(line);
	if (!match) {
		return undefined;
	}
	const marker = match[2] ?? `${match[3]}${match[4]}`;
	const gap = (match[5] ?? '').replace(/\t/g, '    ');
	const rest = match[6] ?? '';
	const base = match[1].length + marker.length;
	// More than four spaces after the marker is one space and then indented code.
	const own = !rest.trim() || gap.length > 4 ? 1 : gap.length;
	return {
		ordered: !match[2],
		start: match[3] ? Number(match[3]) : 1,
		width: base + own,
		rest: rest.trim() ? gap.slice(own) + rest : '',
	};
}

/** Whether `line` starts a block that ends the paragraph above it. */
function startsBlock(line: string): boolean {
	if (fenceOf(line) || HEADING.test(line) || QUOTE.test(line) || RULE.test(line)) {
		return true;
	}
	const marker = listMarker(line);
	return !!marker && !!marker.rest.trim() && (!marker.ordered || marker.start === 1);
}

function splitTableRow(line: string): string[] {
	let text = line.trim();
	if (text.startsWith('|')) {
		text = text.slice(1);
	}
	const cells: string[] = [];
	let cell = '';
	let closed = false;
	for (let at = 0; at < text.length; at++) {
		const char = text[at];
		closed = false;
		if (char === '\\' && text[at + 1] === '|') {
			cell += '|';
			at++;
		} else if (char === '\\' && text[at + 1] === '\\') {
			cell += '\\\\';
			at++;
		} else if (char === '|') {
			cells.push(cell.trim());
			cell = '';
			closed = true;
		} else {
			cell += char;
		}
	}
	if (!closed) {
		cells.push(cell.trim());
	}
	return cells;
}

/** The column alignments when a table's header is on `lines[at]`, else undefined. */
function tableAt(lines: readonly string[], at: number): HttpMdAlign[] | undefined {
	const header = lines[at];
	const delimiter = lines[at + 1];
	if (delimiter === undefined || !header.includes('|') || !TABLE_DELIMITER.test(delimiter)) {
		return undefined;
	}
	const marks = splitTableRow(delimiter);
	if (marks.length !== splitTableRow(header).length) {
		return undefined;
	}
	return marks.map(mark => mark.startsWith(':') && mark.endsWith(':') && mark.length > 1 ? 'center' : mark.endsWith(':') ? 'right' : mark.startsWith(':') ? 'left' : undefined);
}

function listItem(children: HttpMdBlock[]): IHttpMdListItem {
	const first = children[0];
	const lead = first?.type === 'paragraph' ? first.children[0] : undefined;
	const task = lead?.type === 'text' ? /^\[([ xX])\](?:[ \t]+|$)/.exec(lead.text) : null;
	if (!task || first?.type !== 'paragraph' || lead?.type !== 'text') {
		return { children };
	}
	const rest = lead.text.slice(task[0].length);
	const inline = rest ? [{ type: 'text' as const, text: rest }, ...first.children.slice(1)] : first.children.slice(1);
	return { checked: task[1] !== ' ', children: inline.length ? [{ type: 'paragraph', children: inline }, ...children.slice(1)] : children.slice(1) };
}

function parseBlocks(lines: readonly string[]): HttpMdBlock[] {
	const blocks: HttpMdBlock[] = [];
	let at = 0;
	while (at < lines.length) {
		const line = lines[at];
		if (isBlank(line)) {
			at++;
			continue;
		}

		const fence = fenceOf(line);
		if (fence) {
			const indent = indentOf(line);
			const text: string[] = [];
			at++;
			while (at < lines.length) {
				const close = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(lines[at]);
				if (close && close[1][0] === fence.marker[0] && close[1].length >= fence.marker.length) {
					at++;
					break;
				}
				text.push(stripIndent(lines[at], indent));
				at++;
			}
			blocks.push({ type: 'code', language: fence.info, text: text.join('\n') });
			continue;
		}

		if (indentOf(line) >= 4) {
			const text: string[] = [];
			while (at < lines.length && (isBlank(lines[at]) || indentOf(lines[at]) >= 4)) {
				text.push(stripIndent(lines[at], 4));
				at++;
			}
			while (text.length && isBlank(text[text.length - 1])) {
				text.pop();
			}
			blocks.push({ type: 'code', language: '', text: text.join('\n') });
			continue;
		}

		const heading = HEADING.exec(line);
		if (heading) {
			const raw = (heading[2] ?? '').replace(/(^|[ \t]+)#+[ \t]*$/, '').trim();
			blocks.push({ type: 'heading', level: heading[1].length, children: parseHttpMarkdownInline(raw) });
			at++;
			continue;
		}

		if (RULE.test(line)) {
			blocks.push({ type: 'rule' });
			at++;
			continue;
		}

		if (QUOTE.test(line)) {
			const inner: string[] = [];
			while (at < lines.length) {
				const next = lines[at];
				const last = inner[inner.length - 1];
				if (QUOTE.test(next)) {
					inner.push(next.replace(/^ {0,3}> ?/, ''));
				} else if (!isBlank(next) && last !== undefined && !isBlank(last) && !startsBlock(next) && !startsBlock(last) && !listMarker(next)) {
					// A paragraph inside the quote may go on without its mark.
					inner.push(next);
				} else {
					break;
				}
				at++;
			}
			blocks.push({ type: 'quote', children: parseBlocks(inner) });
			continue;
		}

		const first = listMarker(line);
		if (first) {
			const items: IHttpMdListItem[] = [];
			while (at < lines.length) {
				const marker = listMarker(lines[at]);
				if (!marker || marker.ordered !== first.ordered || RULE.test(lines[at])) {
					break;
				}
				const own: string[] = [marker.rest];
				at++;
				while (at < lines.length) {
					const next = lines[at];
					if (isBlank(next)) {
						let after = at;
						while (after < lines.length && isBlank(lines[after])) {
							after++;
						}
						if (after < lines.length && indentOf(lines[after]) >= marker.width) {
							for (; at < after; at++) {
								own.push('');
							}
							continue;
						}
						break;
					}
					if (indentOf(next) >= marker.width) {
						own.push(stripIndent(next, marker.width));
						at++;
						continue;
					}
					const last = own[own.length - 1];
					if (!isBlank(last) && !startsBlock(next) && !listMarker(next) && !fenceOf(last) && !HEADING.test(last) && !RULE.test(last)) {
						own.push(next.trimStart());
						at++;
						continue;
					}
					break;
				}
				items.push(listItem(parseBlocks(own)));
				let after = at;
				while (after < lines.length && isBlank(lines[after])) {
					after++;
				}
				if (after === at) {
					continue;
				}
				const next = after < lines.length ? listMarker(lines[after]) : undefined;
				if (next && next.ordered === first.ordered && !RULE.test(lines[after])) {
					at = after;
					continue;
				}
				break;
			}
			blocks.push({ type: 'list', ordered: first.ordered, ...(first.ordered && first.start !== 1 ? { start: first.start } : {}), items });
			continue;
		}

		const align = tableAt(lines, at);
		if (align) {
			const header = splitTableRow(line).map(parseHttpMarkdownInline);
			const rows: HttpMdInline[][][] = [];
			at += 2;
			while (at < lines.length && !isBlank(lines[at]) && !startsBlock(lines[at])) {
				const cells = splitTableRow(lines[at]);
				rows.push(align.map((_mark, column) => parseHttpMarkdownInline(cells[column] ?? '')));
				at++;
			}
			blocks.push({ type: 'table', align, header, rows });
			continue;
		}

		const text: string[] = [line.trimStart()];
		let setext = 0;
		at++;
		while (at < lines.length) {
			const next = lines[at];
			if (isBlank(next)) {
				break;
			}
			const under = SETEXT.exec(next);
			if (under) {
				setext = under[1][0] === '=' ? 1 : 2;
				at++;
				break;
			}
			if (startsBlock(next) || tableAt(lines, at)) {
				break;
			}
			text.push(next.trimStart());
			at++;
		}
		const children = parseHttpMarkdownInline(text.join('\n').trim());
		blocks.push(setext ? { type: 'heading', level: setext, children } : { type: 'paragraph', children });
	}
	return blocks;
}

/** Markdown as blocks. Never throws: what it cannot place stays text. */
export function parseHttpMarkdown(markdown: string): HttpMdBlock[] {
	return parseBlocks(markdown.replace(/\r\n?/g, '\n').split('\n'));
}

// --- Parsing: inlines --------------------------------------------------------------------------

interface IDelimiter {
	readonly type: 'delimiter';
	readonly char: string;
	count: number;
	readonly canOpen: boolean;
	readonly canClose: boolean;
}

function isDelimiter(part: HttpMdInline | IDelimiter): part is IDelimiter {
	return part.type === 'delimiter';
}

function isSpace(char: string | undefined): boolean {
	return char === undefined || /\s/.test(char);
}

function isPunctuation(char: string | undefined): boolean {
	return char !== undefined && PUNCTUATION.test(char);
}

function unescapeMarkdown(text: string): string {
	return text.replace(/\\([!-\/:-@\[-`{-~])/g, '$1');
}

interface ILinkMatch {
	readonly label: string;
	readonly href: string;
	readonly title?: string;
	readonly end: number;
}

/** The `[label](destination "title")` whose `[` is at `open`. */
function linkAt(source: string, open: number): ILinkMatch | undefined {
	let depth = 0;
	let close = -1;
	for (let at = open; at < source.length; at++) {
		const char = source[at];
		if (char === '\\') {
			at++;
		} else if (char === '`') {
			let run = 1;
			while (source[at + run] === '`') {
				run++;
			}
			const end = closingBackticks(source, at + run, run);
			at = end < 0 ? at + run - 1 : end + run - 1;
		} else if (char === '[') {
			depth++;
		} else if (char === ']') {
			depth--;
			if (depth === 0) {
				close = at;
				break;
			}
		}
	}
	if (close < 0 || source[close + 1] !== '(') {
		return undefined;
	}
	let at = close + 2;
	const skipSpace = () => {
		while (at < source.length && /\s/.test(source[at])) {
			at++;
		}
	};
	skipSpace();
	let href = '';
	if (source[at] === '<') {
		const end = source.indexOf('>', at);
		if (end < 0 || source.slice(at, end).includes('\n')) {
			return undefined;
		}
		href = source.slice(at + 1, end);
		at = end + 1;
	} else {
		let parens = 0;
		const from = at;
		while (at < source.length) {
			const char = source[at];
			if (char === '\\' && at + 1 < source.length) {
				at += 2;
				continue;
			}
			if (/\s/.test(char)) {
				break;
			}
			if (char === '(') {
				parens++;
			} else if (char === ')') {
				if (parens === 0) {
					break;
				}
				parens--;
			}
			at++;
		}
		href = source.slice(from, at);
	}
	skipSpace();
	let title: string | undefined;
	const quote = source[at];
	if (quote === '"' || quote === '\'') {
		let end = at + 1;
		while (end < source.length && source[end] !== quote) {
			end += source[end] === '\\' ? 2 : 1;
		}
		if (end >= source.length) {
			return undefined;
		}
		title = unescapeMarkdown(source.slice(at + 1, end));
		at = end + 1;
		skipSpace();
	}
	if (source[at] !== ')') {
		return undefined;
	}
	return { label: source.slice(open + 1, close), href: unescapeMarkdown(href), ...(title ? { title } : {}), end: at + 1 };
}

/** Where a run of exactly `run` backticks starts at or after `from`, else -1. */
function closingBackticks(source: string, from: number, run: number): number {
	let at = from;
	while (at < source.length) {
		if (source[at] !== '`') {
			at++;
			continue;
		}
		let length = 1;
		while (source[at + length] === '`') {
			length++;
		}
		if (length === run) {
			return at;
		}
		at += length;
	}
	return -1;
}

function partsToInlines(parts: readonly (HttpMdInline | IDelimiter)[]): HttpMdInline[] {
	const out: HttpMdInline[] = [];
	for (const part of parts) {
		const node: HttpMdInline | undefined = isDelimiter(part) ? (part.count ? { type: 'text', text: part.char.repeat(part.count) } : undefined) : part;
		if (!node) {
			continue;
		}
		const last = out[out.length - 1];
		if (node.type === 'text' && last?.type === 'text') {
			out[out.length - 1] = { type: 'text', text: last.text + node.text };
		} else {
			out.push(node);
		}
	}
	return out;
}

/** Pairs the emphasis marks: each closer takes the nearest opener of its kind on its left. */
function resolveEmphasis(parts: (HttpMdInline | IDelimiter)[]): HttpMdInline[] {
	let at = 0;
	while (at < parts.length) {
		const closer = parts[at];
		if (!isDelimiter(closer) || !closer.canClose || !closer.count) {
			at++;
			continue;
		}
		const need = closer.char === '~' ? 2 : 1;
		let found = -1;
		for (let before = at - 1; before >= 0; before--) {
			const part = parts[before];
			if (isDelimiter(part) && part.char === closer.char && part.canOpen && part.count >= need) {
				found = before;
				break;
			}
		}
		if (found < 0 || closer.count < need) {
			at++;
			continue;
		}
		const opener = parts[found] as IDelimiter;
		const use = closer.char === '~' || (opener.count >= 2 && closer.count >= 2) ? 2 : 1;
		const children = partsToInlines(parts.slice(found + 1, at));
		const type: HttpMdMark = closer.char === '~' ? 'strike' : use === 2 ? 'strong' : 'em';
		opener.count -= use;
		closer.count -= use;
		parts.splice(found + 1, at - found - 1, { type, children });
		at = found + 2;
	}
	return partsToInlines(parts);
}

/** One block's text as inlines. */
export function parseHttpMarkdownInline(source: string): HttpMdInline[] {
	const parts: (HttpMdInline | IDelimiter)[] = [];
	let text = '';
	const flush = () => {
		if (text) {
			parts.push({ type: 'text', text });
			text = '';
		}
	};
	let at = 0;
	const skipLineStart = () => {
		while (source[at] === ' ' || source[at] === '\t') {
			at++;
		}
	};
	while (at < source.length) {
		const char = source[at];
		if (char === '\\') {
			const next = source[at + 1];
			if (next === '\n') {
				flush();
				parts.push({ type: 'break' });
				at += 2;
				skipLineStart();
			} else if (isPunctuation(next)) {
				text += next;
				at += 2;
			} else {
				text += char;
				at++;
			}
			continue;
		}
		if (char === '`') {
			let run = 1;
			while (source[at + run] === '`') {
				run++;
			}
			const close = closingBackticks(source, at + run, run);
			if (close < 0) {
				text += source.slice(at, at + run);
				at += run;
				continue;
			}
			let code = source.slice(at + run, close).replace(/\n/g, ' ');
			if (code.length > 1 && code.startsWith(' ') && code.endsWith(' ') && code.trim()) {
				code = code.slice(1, -1);
			}
			flush();
			parts.push({ type: 'code', text: code });
			at = close + run;
			continue;
		}
		if (char === '!' && source[at + 1] === '[') {
			const image = linkAt(source, at + 1);
			if (image) {
				flush();
				parts.push({ type: 'image', src: image.href, alt: httpMarkdownPlainText(parseHttpMarkdownInline(image.label)), ...(image.title ? { title: image.title } : {}) });
				at = image.end;
				continue;
			}
		}
		if (char === '[') {
			const link = linkAt(source, at);
			if (link) {
				flush();
				parts.push({ type: 'link', href: link.href, ...(link.title ? { title: link.title } : {}), children: parseHttpMarkdownInline(link.label) });
				at = link.end;
				continue;
			}
		}
		if (char === '<') {
			const rest = source.slice(at, at + 2100);
			const auto = /^<([a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^\s<>]*)>/.exec(rest);
			if (auto) {
				flush();
				parts.push({ type: 'link', href: auto[1], children: [{ type: 'text', text: auto[1] }] });
				at += auto[0].length;
				continue;
			}
			const br = /^<br[ \t]*\/?>/i.exec(rest);
			if (br) {
				flush();
				parts.push({ type: 'break' });
				at += br[0].length;
				continue;
			}
		}
		if (char === '*' || char === '_' || char === '~') {
			let run = 1;
			while (source[at + run] === char) {
				run++;
			}
			if (char === '~' && run < 2) {
				text += char;
				at++;
				continue;
			}
			const before = source[at - 1];
			const after = source[at + run];
			const left = !isSpace(after) && (!isPunctuation(after) || isSpace(before) || isPunctuation(before));
			const right = !isSpace(before) && (!isPunctuation(before) || isSpace(after) || isPunctuation(after));
			flush();
			parts.push({
				type: 'delimiter',
				char,
				count: run,
				canOpen: char === '_' ? left && (!right || isPunctuation(before)) : left,
				canClose: char === '_' ? right && (!left || isPunctuation(after)) : right,
			});
			at += run;
			continue;
		}
		if (char === '\n') {
			const hard = /[^ \t] {2,}$/.test(text) || (/^ {2,}$/.test(text) && parts.length > 0);
			text = text.replace(/[ \t]+$/, '');
			if (hard) {
				flush();
				parts.push({ type: 'break' });
			} else {
				text += '\n';
			}
			at++;
			skipLineStart();
			continue;
		}
		text += char;
		at++;
	}
	flush();
	return resolveEmphasis(parts);
}

/** The words of some inlines, marks dropped. */
export function httpMarkdownPlainText(inlines: readonly HttpMdInline[]): string {
	let out = '';
	for (const node of inlines) {
		switch (node.type) {
			case 'text':
			case 'code': out += node.text; break;
			case 'image': out += node.alt; break;
			case 'break': out += '\n'; break;
			default: out += httpMarkdownPlainText(node.children);
		}
	}
	return out;
}

// --- Serializing -------------------------------------------------------------------------------

type InlineParent = Extract<HttpMdInline, { readonly children: readonly HttpMdInline[] }>;

function hasChildren(node: HttpMdInline): node is InlineParent {
	return node.type === 'strong' || node.type === 'em' || node.type === 'strike' || node.type === 'link';
}

function withChildren(node: InlineParent, children: readonly HttpMdInline[]): InlineParent {
	return { ...node, children };
}

/**
 * Inlines in the one shape that writes as valid Markdown: neighbouring text joined, a mark inside
 * the same mark dropped, neighbouring equal marks joined (`<b>a</b><b>b</b>` is one bold run), and
 * white space and breaks at a mark's edges moved outside it (`** a**` is not bold).
 */
function tidyInlines(nodes: readonly HttpMdInline[], active: readonly string[]): HttpMdInline[] {
	const out: HttpMdInline[] = [];
	const push = (node: HttpMdInline) => {
		const last = out[out.length - 1];
		if (node.type === 'text') {
			if (!node.text) {
				return;
			}
			if (last?.type === 'text') {
				out[out.length - 1] = { type: 'text', text: last.text + node.text };
				return;
			}
		} else if (last && hasChildren(node) && hasChildren(last) && last.type === node.type && (node.type !== 'link' || (last.type === 'link' && last.href === node.href && last.title === node.title))) {
			out[out.length - 1] = withChildren(last, tidyInlines([...last.children, ...node.children], [...active, node.type]));
			return;
		}
		out.push(node);
	};
	for (const node of nodes) {
		if (!hasChildren(node)) {
			push(node.type === 'text' ? { type: 'text', text: node.text.replace(/\xa0/g, ' ').replace(/[ \t]*\n[ \t]*/g, '\n') } : node);
			continue;
		}
		if (active.includes(node.type)) {
			for (const child of tidyInlines(node.children, active)) {
				push(child);
			}
			continue;
		}
		const kids = tidyInlines(node.children, [...active, node.type]);
		const lead: HttpMdInline[] = [];
		const trail: HttpMdInline[] = [];
		while (kids.length) {
			const first = kids[0];
			if (first.type === 'break') {
				lead.push(first);
				kids.shift();
				continue;
			}
			const space = first.type === 'text' ? /^\s+/.exec(first.text)?.[0] : undefined;
			if (first.type !== 'text' || !space) {
				break;
			}
			lead.push({ type: 'text', text: space });
			if (space.length === first.text.length) {
				kids.shift();
				continue;
			}
			kids[0] = { type: 'text', text: first.text.slice(space.length) };
			break;
		}
		while (kids.length) {
			const last = kids[kids.length - 1];
			if (last.type === 'break') {
				trail.unshift(last);
				kids.pop();
				continue;
			}
			const space = last.type === 'text' ? /\s+$/.exec(last.text)?.[0] : undefined;
			if (last.type !== 'text' || !space) {
				break;
			}
			trail.unshift({ type: 'text', text: space });
			kids[kids.length - 1] = { type: 'text', text: last.text.slice(0, -space.length) };
			break;
		}
		lead.forEach(push);
		if (kids.length) {
			push(withChildren(node, kids));
		}
		trail.forEach(push);
	}
	return out;
}

/** A block's inlines, tidied and without white space or breaks at either end. */
function blockInlines(nodes: readonly HttpMdInline[]): HttpMdInline[] {
	const tidy = tidyInlines(nodes, []);
	// White space around a hard break is not there once written and read: it goes now.
	const out: HttpMdInline[] = [];
	tidy.forEach((node, index) => {
		if (node.type !== 'text') {
			out.push(node);
			return;
		}
		let text = node.text;
		if (tidy[index - 1]?.type === 'break') {
			text = text.trimStart();
		}
		if (tidy[index + 1]?.type === 'break') {
			text = text.trimEnd();
		}
		if (text) {
			out.push({ type: 'text', text });
		}
	});
	while (out.length) {
		const first = out[0];
		if (first.type === 'break' || (first.type === 'text' && !first.text.trim())) {
			out.shift();
		} else {
			if (first.type === 'text') {
				out[0] = { type: 'text', text: first.text.trimStart() };
			}
			break;
		}
	}
	while (out.length) {
		const last = out[out.length - 1];
		if (last.type === 'break' || (last.type === 'text' && !last.text.trim())) {
			out.pop();
		} else {
			if (last.type === 'text') {
				out[out.length - 1] = { type: 'text', text: last.text.trimEnd() };
			}
			break;
		}
	}
	return out;
}

function isWordChar(char: string | undefined): boolean {
	return char !== undefined && /[\p{L}\p{N}]/u.test(char);
}

/** Text with the characters escaped that would start Markdown where it stands. */
function escapeText(text: string, beforeLink: boolean): string {
	let out = '';
	for (let at = 0; at < text.length; at++) {
		const char = text[at];
		const before = text[at - 1];
		const after = text[at + 1];
		switch (char) {
			case '\\':
				out += after === undefined || after === '\n' || isPunctuation(after) ? '\\\\' : char;
				break;
			case '`':
				out += '\\`';
				break;
			case '*':
				out += before !== undefined && after !== undefined && /\s/.test(before) && /\s/.test(after) ? char : '\\*';
				break;
			case '_':
				out += (isWordChar(before) && isWordChar(after)) || (before !== undefined && after !== undefined && /\s/.test(before) && /\s/.test(after)) ? char : '\\_';
				break;
			case '~':
				out += before === '~' || after === '~' ? '\\~' : char;
				break;
			case ']':
				out += after === '(' ? '\\]' : char;
				break;
			case '!':
				out += (after === undefined && beforeLink) || (after === '[' && /^\[[^\]]*\]\(/.test(text.slice(at + 1))) ? '\\!' : char;
				break;
			case '<':
				out += /^<(?:[a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^\s<>]*>|br[ \t]*\/?>)/i.test(text.slice(at, at + 2100)) ? '\\<' : char;
				break;
			default:
				out += char;
		}
	}
	return out;
}

function codeSpan(text: string): string {
	const flat = text.replace(/\n/g, ' ');
	if (!flat) {
		return '';
	}
	let longest = 0;
	for (const run of flat.match(/`+/g) ?? []) {
		longest = Math.max(longest, run.length);
	}
	const fence = '`'.repeat(longest + 1);
	const pad = flat.startsWith('`') || flat.endsWith('`') || (flat.startsWith(' ') && flat.endsWith(' ') && !!flat.trim()) ? ' ' : '';
	return `${fence}${pad}${flat}${pad}${fence}`;
}

function linkDestination(href: string): string {
	if (!href || /[\s<>]/.test(href)) {
		return `<${href.replace(/[<>\n]/g, '')}>`;
	}
	let depth = 0;
	for (const char of href) {
		if (char === '(') {
			depth++;
		} else if (char === ')' && --depth < 0) {
			break;
		}
	}
	return depth === 0 ? href.replace(/\\(?=[!-\/:-@\[-`{-~])/g, '\\\\') : `<${href}>`;
}

function linkTail(href: string, title: string | undefined): string {
	return `(${linkDestination(href)}${title ? ` "${title.replace(/\n/g, ' ').replace(/(["\\])/g, '\\$1')}"` : ''})`;
}

interface IInlineStyle {
	/** What a hard break is written as. */
	readonly hardBreak: string;
	/** Whether a line end inside text may stay one. */
	readonly lines: boolean;
}

function writeInlines(nodes: readonly HttpMdInline[], style: IInlineStyle): string {
	let out = '';
	nodes.forEach((node, index) => {
		switch (node.type) {
			case 'text': {
				const text = escapeText(node.text, nodes[index + 1]?.type === 'link');
				out += style.lines ? text : text.replace(/\n/g, ' ');
				break;
			}
			case 'strong': out += `**${writeInlines(node.children, style)}**`; break;
			case 'em': out += `*${writeInlines(node.children, style)}*`; break;
			case 'strike': out += `~~${writeInlines(node.children, style)}~~`; break;
			case 'code': out += codeSpan(node.text); break;
			case 'link': {
				const only = node.children.length === 1 ? node.children[0] : undefined;
				out += only?.type === 'text' && only.text === node.href && !node.title && /^[a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^\s<>]*$/.test(node.href)
					? `<${node.href}>`
					: `[${writeInlines(node.children, style)}]${linkTail(node.href, node.title)}`;
				break;
			}
			case 'image': out += `![${node.alt.replace(/\n/g, ' ').replace(/([\\\[\]])/g, '\\$1')}]${linkTail(node.src, node.title)}`; break;
			case 'break': out += style.hardBreak; break;
		}
	});
	return out;
}

const PARAGRAPH_STYLE: IInlineStyle = { hardBreak: '\\\n', lines: true };
const HEADING_STYLE: IInlineStyle = { hardBreak: ' ', lines: false };
const CELL_STYLE: IInlineStyle = { hardBreak: '<br>', lines: false };

/** A paragraph line that would read as another block gets its first mark escaped. */
function escapeLineStart(line: string, first: boolean): string {
	if (/^#{1,6}(?:\s|$)/.test(line) || /^>/.test(line) || /^[-+](?:\s|$)/.test(line) || /^-(?:[ \t]*-){2,}[ \t]*$/.test(line) || (!first && /^(?:=+|-+)[ \t]*$/.test(line))) {
		return `\\${line}`;
	}
	const ordered = /^(\d{1,9})([.)])(?:\s|$)/.exec(line);
	if (ordered && (first || Number(ordered[1]) === 1)) {
		return `${ordered[1]}\\${line.slice(ordered[1].length)}`;
	}
	return line;
}

function writeParagraph(children: readonly HttpMdInline[]): string {
	const text = writeInlines(blockInlines(children), PARAGRAPH_STYLE);
	return text.split('\n').map((line, index) => escapeLineStart(line, index === 0)).join('\n');
}

function isTightItem(item: IHttpMdListItem): boolean {
	return item.children.every((child, index) => child.type === 'list' || (child.type === 'paragraph' && index === 0));
}

function writeBlock(block: HttpMdBlock): string {
	switch (block.type) {
		case 'paragraph':
			return writeParagraph(block.children);
		case 'heading': {
			const text = writeInlines(blockInlines(block.children), HEADING_STYLE).replace(/(^|[ \t])(#*)#$/, '$1$2\\#');
			return `${'#'.repeat(Math.max(1, Math.min(6, block.level)))}${text ? ` ${text}` : ''}`;
		}
		case 'code': {
			let longest = 2;
			for (const run of block.text.match(/^[ \t]*`{3,}/gm) ?? []) {
				longest = Math.max(longest, run.trim().length);
			}
			const fence = '`'.repeat(longest + 1);
			return `${fence}${block.language.replace(/[`\n]/g, '').trim()}\n${block.text ? `${block.text}\n` : ''}${fence}`;
		}
		case 'quote': {
			const inner = writeBlocks(block.children);
			return inner ? inner.split('\n').map(line => line ? `> ${line}` : '>').join('\n') : '';
		}
		case 'list': {
			const tight = block.items.every(isTightItem);
			const start = block.start ?? 1;
			return block.items.map((item, index) => {
				const marker = block.ordered ? `${start + index}. ` : '- ';
				const task = item.checked === undefined ? '' : item.checked ? '[x] ' : '[ ] ';
				const body = tight ? item.children.map(writeBlock).filter(text => text).join('\n') : writeBlocks(item.children);
				const pad = ' '.repeat(marker.length);
				return `${task}${body}`.split('\n').map((line, row) => row === 0 ? `${marker}${line}`.trimEnd() : line ? `${pad}${line}` : '').join('\n');
			}).join(tight ? '\n' : '\n\n');
		}
		case 'table': {
			const columns = Math.max(1, block.header.length);
			const row = (cells: readonly (readonly HttpMdInline[])[]) => {
				const texts: string[] = [];
				for (let column = 0; column < columns; column++) {
					texts.push(writeInlines(blockInlines(cells[column] ?? []), CELL_STYLE).replace(/\|/g, '\\|'));
				}
				return `| ${texts.join(' | ')} |`;
			};
			const marks: string[] = [];
			for (let column = 0; column < columns; column++) {
				const align = block.align[column];
				marks.push(align === 'center' ? ':-:' : align === 'right' ? '--:' : align === 'left' ? ':--' : '---');
			}
			return [row(block.header), `| ${marks.join(' | ')} |`, ...block.rows.map(row)].join('\n');
		}
		case 'rule':
			return '---';
	}
}

function writeBlocks(blocks: readonly HttpMdBlock[]): string {
	const merged: HttpMdBlock[] = [];
	for (const block of blocks) {
		const last = merged[merged.length - 1];
		// Two lists of one kind in a row would read back as one: they are one.
		if (block.type === 'list' && last?.type === 'list' && last.ordered === block.ordered) {
			merged[merged.length - 1] = { ...last, items: [...last.items, ...block.items] };
		} else if (block.type !== 'list' || block.items.length) {
			merged.push(block);
		}
	}
	return merged.map(writeBlock).filter(text => text).join('\n\n');
}

/** Blocks as Markdown, in one canonical form and without a line end after the last block. */
export function serializeHttpMarkdown(blocks: readonly HttpMdBlock[]): string {
	return writeBlocks(blocks);
}

/** Whether a pasted text is worth reading as Markdown (it has block or inline marks). */
export function looksLikeHttpMarkdown(text: string): boolean {
	return /^ {0,3}(?:#{1,6}[ \t]|[-*+][ \t]|\d{1,9}[.)][ \t]|>|```|~~~)|^\s*\|.*\|\s*$/m.test(text) || /\*\*[^*\n]+\*\*|`[^`\n]+`|\[[^\]\n]+\]\([^)\n]+\)|~~[^~\n]+~~/.test(text);
}

/** A model's answer without the fence some models put around the whole of it. */
export function httpMarkdownFromAnswer(answer: string): string {
	const text = answer.replace(/\r\n?/g, '\n').trim();
	const fenced = /^```(?:markdown|md)?[ \t]*\n([\s\S]*?)\n?```$/.exec(text);
	// A fence around everything, not a document that only starts and ends with code blocks.
	if (fenced && !/^```/m.test(fenced[1])) {
		return fenced[1].trim();
	}
	const open = /^```(?:markdown|md)[ \t]*\n/.exec(text);
	return open ? text.slice(open[0].length).replace(/\n```$/, '').trim() : text;
}
