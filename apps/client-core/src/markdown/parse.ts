/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * A small GitHub-flavoured Markdown parser built for streaming replies.
 *
 * Blocks: ATX/setext headings, paragraphs, fenced code, `$$` math, block quotes (with GitHub
 * callouts), nested ordered/bullet/task lists, pipe tables, thematic breaks and HTML blocks.
 * Inlines: code spans, strong/em/strike, links, autolinks and bare URLs, images, hard breaks.
 *
 * Streaming: a reply grows by appending. Every top-level block but the last is final once text
 * follows it, so {@link parseMarkdown} given the previous document re-parses only from the start
 * of the previous last block and reuses the earlier block objects as they are. Views memoize on
 * block identity: only the block being written re-renders. Inline parses are cached by source.
 */

export type MdAlign = 'left' | 'center' | 'right' | null;
export type MdCallout = 'note' | 'tip' | 'important' | 'warning' | 'caution';

export type MdBlock =
	| { readonly type: 'paragraph'; readonly key: string; readonly text: string }
	| { readonly type: 'heading'; readonly key: string; readonly level: number; readonly text: string }
	| { readonly type: 'code'; readonly key: string; readonly lang: string; readonly code: string; readonly closed: boolean }
	| { readonly type: 'list'; readonly key: string; readonly ordered: boolean; readonly start: number; readonly tight: boolean; readonly items: readonly MdListItem[] }
	| { readonly type: 'quote'; readonly key: string; readonly blocks: readonly MdBlock[]; readonly callout?: MdCallout }
	| { readonly type: 'table'; readonly key: string; readonly align: readonly MdAlign[]; readonly header: readonly string[]; readonly rows: readonly (readonly string[])[] }
	| { readonly type: 'hr'; readonly key: string }
	| { readonly type: 'html'; readonly key: string; readonly text: string }
	| { readonly type: 'math'; readonly key: string; readonly text: string };

export interface MdListItem {
	readonly key: string;
	readonly checked?: boolean;
	readonly blocks: readonly MdBlock[];
}

export interface MdDocument {
	readonly text: string;
	readonly blocks: readonly MdBlock[];
	/** Per top-level block: its first line and its source, to reuse it in the next parse. */
	readonly starts: readonly number[];
	readonly sources: readonly string[];
}

const FENCE = /^( {0,3})(`{3,}|~{3,})[ \t]*([^\s`]*)[^`]*$/;
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const HR = /^ {0,3}(?:(?:-[ \t]*){3,}|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})$/;
const QUOTE = /^ {0,3}> ?/;
const BULLET = /^( {0,3})([-*+])([ \t]+|$)/;
const ORDERED = /^( {0,3})(\d{1,9})([.)])([ \t]+|$)/;
const TABLE_DELIM = /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;
const SETEXT = /^ {0,3}(={2,}|-{2,})[ \t]*$/;
const MATH_FENCE = /^ {0,3}\$\$[ \t]*$/;
const HTML_START = /^ {0,3}<(?:!--|\/?(?:div|details|summary|p|table|thead|tbody|tr|td|th|pre|section|article|aside|header|footer|nav|ul|ol|li|h[1-6]|blockquote|figure|picture|video|center|dl|dt|dd)\b)/i;
const CALLOUT = /^\[!(note|tip|important|warning|caution)\][ \t]*$/i;
const TASK = /^\[([ xX])\][ \t]+/;

function isBlank(line: string | undefined): boolean {
	return line === undefined || /^[ \t]*$/.test(line);
}

function indentOf(line: string): number {
	let n = 0;
	while (n < line.length && line[n] === ' ') {
		n++;
	}
	return n;
}

/** Leading tabs become spaces (4 per tab) so indentation compares by columns. */
function expandTabs(line: string): string {
	if (!line.includes('\t')) {
		return line;
	}
	let out = '';
	let i = 0;
	for (; i < line.length && (line[i] === ' ' || line[i] === '\t'); i++) {
		out += line[i] === '\t' ? ' '.repeat(4 - (out.length % 4)) : ' ';
	}
	return out + line.slice(i);
}

interface IListMarker {
	readonly indent: number;
	readonly ordered: boolean;
	readonly marker: string;
	readonly start: number;
	readonly contentOffset: number;
	readonly content: string;
}

function listMarker(line: string): IListMarker | undefined {
	if (HR.test(line)) {
		return undefined;
	}
	let m = BULLET.exec(line);
	if (m) {
		const indent = m[1].length;
		const spaces = m[3].length;
		const offset = indent + 1 + (spaces === 0 || spaces > 4 ? 1 : spaces);
		return { indent, ordered: false, marker: m[2], start: 1, contentOffset: offset, content: line.slice(Math.min(line.length, offset)) };
	}
	m = ORDERED.exec(line);
	if (m) {
		const indent = m[1].length;
		const width = m[2].length + 1;
		const spaces = m[4].length;
		const offset = indent + width + (spaces === 0 || spaces > 4 ? 1 : spaces);
		return { indent, ordered: true, marker: m[3], start: Number(m[2]), contentOffset: offset, content: line.slice(Math.min(line.length, offset)) };
	}
	return undefined;
}

function isTableStart(line: string, next: string | undefined): boolean {
	return line.includes('|') && next !== undefined && next.includes('|') && next.includes('-') && TABLE_DELIM.test(next);
}

/** Lines that end a paragraph without a blank line between. */
function interruptsParagraph(line: string, next: string | undefined): boolean {
	if (FENCE.test(line) || HEADING.test(line) || HR.test(line) || QUOTE.test(line) || MATH_FENCE.test(line) || HTML_START.test(line)) {
		return true;
	}
	const marker = listMarker(line);
	// An empty item, or an ordered list not starting at 1, does not interrupt a paragraph (GFM).
	if (marker && marker.content.trim() && (!marker.ordered || marker.start === 1)) {
		return true;
	}
	return isTableStart(line, next);
}

function splitRow(line: string): string[] {
	let row = line.trim();
	if (row.startsWith('|')) {
		row = row.slice(1);
	}
	if (row.endsWith('|') && !row.endsWith('\\|')) {
		row = row.slice(0, -1);
	}
	const cells: string[] = [];
	let cell = '';
	let inCode = false;
	for (let i = 0; i < row.length; i++) {
		const ch = row[i];
		if (ch === '\\' && row[i + 1] === '|') {
			cell += '|';
			i++;
		} else if (ch === '`') {
			inCode = !inCode;
			cell += ch;
		} else if (ch === '|' && !inCode) {
			cells.push(cell.trim());
			cell = '';
		} else {
			cell += ch;
		}
	}
	cells.push(cell.trim());
	return cells;
}

function parseAlign(line: string): MdAlign[] {
	return splitRow(line).map(cell => {
		const left = cell.startsWith(':');
		const right = cell.endsWith(':');
		return left && right ? 'center' : right ? 'right' : left ? 'left' : null;
	});
}

interface IParsed {
	readonly blocks: MdBlock[];
	readonly starts: number[];
	readonly ends: number[];
}

function parseBlocks(lines: readonly string[], prefix: string, lineOffset = 0): IParsed {
	const blocks: MdBlock[] = [];
	const starts: number[] = [];
	const ends: number[] = [];
	let i = 0;
	const push = (block: MdBlock, start: number) => {
		blocks.push(block);
		starts.push(start + lineOffset);
		ends.push(i + lineOffset);
	};
	const keyAt = (line: number) => `${prefix}${line + lineOffset}`;

	while (i < lines.length) {
		const line = lines[i];
		if (isBlank(line)) {
			i++;
			continue;
		}
		const start = i;
		const key = keyAt(start);
		let m: RegExpExecArray | null;

		if ((m = FENCE.exec(line))) {
			const indent = m[1].length;
			const fence = m[2];
			const close = new RegExp(`^ {0,3}${fence[0] === '`' ? '`' : '~'}{${fence.length},}[ \\t]*$`);
			const body: string[] = [];
			let closed = false;
			i++;
			while (i < lines.length) {
				if (close.test(lines[i])) {
					closed = true;
					i++;
					break;
				}
				const l = lines[i];
				body.push(indent ? l.slice(Math.min(indent, indentOf(l))) : l);
				i++;
			}
			push({ type: 'code', key, lang: (m[3] ?? '').toLowerCase(), code: body.join('\n'), closed }, start);
			continue;
		}

		if (MATH_FENCE.test(line)) {
			const body: string[] = [];
			i++;
			while (i < lines.length && !MATH_FENCE.test(lines[i])) {
				body.push(lines[i]);
				i++;
			}
			if (i < lines.length) {
				i++;
			}
			push({ type: 'math', key, text: body.join('\n') }, start);
			continue;
		}

		if ((m = HEADING.exec(line))) {
			i++;
			push({ type: 'heading', key, level: m[1].length, text: (m[2] ?? '').trim() }, start);
			continue;
		}

		if (HR.test(line)) {
			i++;
			push({ type: 'hr', key }, start);
			continue;
		}

		if (QUOTE.test(line)) {
			const inner: string[] = [];
			while (i < lines.length) {
				const l = lines[i];
				if (QUOTE.test(l)) {
					inner.push(l.replace(QUOTE, ''));
					i++;
				} else if (!isBlank(l) && inner.length && !isBlank(inner[inner.length - 1]) && !interruptsParagraph(l, lines[i + 1])) {
					inner.push(l);
					i++;
				} else {
					break;
				}
			}
			let callout: MdCallout | undefined;
			const first = CALLOUT.exec(inner[0]?.trim() ?? '');
			if (first) {
				callout = first[1].toLowerCase() as MdCallout;
				inner.shift();
			}
			push({ type: 'quote', key, blocks: parseBlocks(inner, `${key}.`).blocks, ...(callout ? { callout } : {}) }, start);
			continue;
		}

		const marker = listMarker(line);
		if (marker) {
			const list = parseList(lines, i, marker, key);
			i = list.next;
			push(list.block, start);
			continue;
		}

		if (isTableStart(line, lines[i + 1])) {
			const header = splitRow(line);
			const align = parseAlign(lines[i + 1]);
			const rows: string[][] = [];
			i += 2;
			while (i < lines.length && !isBlank(lines[i]) && lines[i].includes('|') && !FENCE.test(lines[i]) && !QUOTE.test(lines[i]) && !HEADING.test(lines[i])) {
				const cells = splitRow(lines[i]);
				rows.push(header.map((_, c) => cells[c] ?? ''));
				i++;
			}
			push({ type: 'table', key, align: header.map((_, c) => align[c] ?? null), header, rows }, start);
			continue;
		}

		if (HTML_START.test(line)) {
			const body: string[] = [];
			while (i < lines.length && !isBlank(lines[i])) {
				body.push(lines[i]);
				i++;
			}
			push({ type: 'html', key, text: body.join('\n') }, start);
			continue;
		}

		// Paragraph (or a setext heading when underlined).
		const para: string[] = [line.trim()];
		let setext = 0;
		i++;
		while (i < lines.length) {
			const l = lines[i];
			if (isBlank(l)) {
				break;
			}
			const underline = SETEXT.exec(l);
			if (underline) {
				setext = underline[1][0] === '=' ? 1 : 2;
				i++;
				break;
			}
			if (interruptsParagraph(l, lines[i + 1])) {
				break;
			}
			para.push(l.replace(/^ {1,3}/, ''));
			i++;
		}
		const text = para.join('\n');
		push(setext ? { type: 'heading', key, level: setext, text: text.replace(/\n/g, ' ') } : { type: 'paragraph', key, text }, start);
	}
	return { blocks, starts, ends };
}

function sameKindOfItem(a: IListMarker, b: IListMarker): boolean {
	return a.ordered === b.ordered && a.marker === b.marker;
}

function parseList(lines: readonly string[], from: number, first: IListMarker, key: string): { block: MdBlock; next: number } {
	const items: MdListItem[] = [];
	let tight = true;
	let i = from;
	while (i < lines.length) {
		const marker = listMarker(lines[i]);
		if (!marker || !sameKindOfItem(marker, first) || marker.indent >= first.contentOffset) {
			break;
		}
		const body: string[] = [marker.content];
		let sawBlank = false;
		let blankInside = false;
		i++;
		while (i < lines.length) {
			const l = lines[i];
			if (isBlank(l)) {
				body.push('');
				sawBlank = true;
				i++;
				continue;
			}
			const indent = indentOf(l);
			if (indent >= marker.contentOffset) {
				body.push(l.slice(marker.contentOffset));
				blankInside ||= sawBlank;
				sawBlank = false;
				i++;
				continue;
			}
			// A nested list indented less than the content (2 spaces under "1."): still this item's.
			const nested = listMarker(l);
			if (nested && indent > marker.indent) {
				body.push(l.slice(indent));
				blankInside ||= sawBlank;
				sawBlank = false;
				i++;
				continue;
			}
			// Lazy continuation of the item's paragraph.
			if (!sawBlank && !nested && !interruptsParagraph(l, lines[i + 1])) {
				body.push(l.trimStart());
				i++;
				continue;
			}
			break;
		}
		while (body.length > 1 && isBlank(body[body.length - 1])) {
			body.pop();
		}
		const next = i < lines.length ? listMarker(lines[i]) : undefined;
		const continues = !!next && sameKindOfItem(next, first) && next.indent < first.contentOffset;
		if (blankInside || (sawBlank && continues)) {
			tight = false;
		}
		const itemKey = `${key}.${items.length}`;
		const task = TASK.exec(body[0] ?? '');
		if (task) {
			body[0] = body[0].slice(task[0].length);
		}
		items.push({
			key: itemKey,
			...(task ? { checked: task[1] !== ' ' } : {}),
			blocks: parseBlocks(body, `${itemKey}.`).blocks,
		});
		if (sawBlank && !continues) {
			break;
		}
	}
	return { block: { type: 'list', key, ordered: first.ordered, start: first.start, tight, items }, next: i };
}

/**
 * Parses `text`. With `previous` (the document of an earlier, shorter version of the same text)
 * the blocks before its last one are reused unchanged and only the rest is parsed.
 */
export function parseMarkdown(text: string, previous?: MdDocument): MdDocument {
	if (previous && previous.text === text) {
		return previous;
	}
	const lines = text.split('\n').map(expandTabs);
	const reuse = previous && previous.blocks.length > 1 && text.startsWith(previous.text) ? previous.blocks.length - 1 : 0;
	const from = reuse ? previous!.starts[reuse] : 0;
	const parsed = parseBlocks(from ? lines.slice(from) : lines, 'b', from);
	const blocks: MdBlock[] = reuse ? previous!.blocks.slice(0, reuse) : [];
	const starts: number[] = reuse ? previous!.starts.slice(0, reuse) : [];
	const sources: string[] = reuse ? previous!.sources.slice(0, reuse) : [];
	for (let b = 0; b < parsed.blocks.length; b++) {
		const source = lines.slice(parsed.starts[b], parsed.ends[b]).join('\n');
		// The previous last block, unchanged (only blank lines followed): keep the same object.
		const prior = reuse && b === 0 && previous!.sources[reuse] === source && previous!.starts[reuse] === parsed.starts[b] ? previous!.blocks[reuse] : undefined;
		blocks.push(prior ?? parsed.blocks[b]);
		starts.push(parsed.starts[b]);
		sources.push(source);
	}
	return { text, blocks, starts, sources };
}

//#region Incremental cache

const MAX_DOCS = 400;
const docs = new Map<string, MdDocument>();

/**
 * The document for one piece of streamed text, keyed by where it lives (`<message>:<segment>`):
 * each update re-parses only the tail. Old keys are dropped least-recently-used first.
 */
export function markdownFor(key: string, text: string): MdDocument {
	const previous = docs.get(key);
	const doc = parseMarkdown(text, previous);
	if (previous) {
		docs.delete(key);
	}
	docs.set(key, doc);
	if (docs.size > MAX_DOCS) {
		const oldest = docs.keys().next().value;
		if (oldest !== undefined) {
			docs.delete(oldest);
		}
	}
	return doc;
}

//#endregion

//#region Inline

export type MdInline =
	| { readonly t: 'text'; readonly v: string }
	| { readonly t: 'code'; readonly v: string }
	| { readonly t: 'strong'; readonly c: readonly MdInline[] }
	| { readonly t: 'em'; readonly c: readonly MdInline[] }
	| { readonly t: 'del'; readonly c: readonly MdInline[] }
	| { readonly t: 'link'; readonly href: string; readonly c: readonly MdInline[] }
	| { readonly t: 'image'; readonly src: string; readonly alt: string }
	| { readonly t: 'br' };

const PUNCT = '!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~';
const MAX_INLINE_CACHE = 4000;
const inlineCache = new Map<string, readonly MdInline[]>();

/**
 * Inline content of a paragraph, heading or cell. `openEnded`: the text is still being written,
 * so an emphasis opened and not yet closed runs to the end instead of showing its `**`.
 */
export function parseInline(src: string, openEnded = false): readonly MdInline[] {
	const cacheKey = openEnded ? `\u0001${src}` : src;
	const hit = inlineCache.get(cacheKey);
	if (hit) {
		return hit;
	}
	const result = inlines(src, openEnded);
	inlineCache.set(cacheKey, result);
	if (inlineCache.size > MAX_INLINE_CACHE) {
		const oldest = inlineCache.keys().next().value;
		if (oldest !== undefined) {
			inlineCache.delete(oldest);
		}
	}
	return result;
}

function isSpace(ch: string | undefined): boolean {
	return ch === undefined || /\s/.test(ch);
}

function isWordChar(ch: string | undefined): boolean {
	return !!ch && /[\p{L}\p{N}]/u.test(ch);
}

/** Index just past the code span starting at `i`, or -1 when it isn't closed. */
function codeSpanEnd(s: string, i: number): { readonly end: number; readonly run: number; readonly close: number } | undefined {
	let run = 1;
	while (s[i + run] === '`') {
		run++;
	}
	let j = i + run;
	while (j < s.length) {
		const k = s.indexOf('`', j);
		if (k < 0) {
			return undefined;
		}
		let r = 1;
		while (s[k + r] === '`') {
			r++;
		}
		if (r === run) {
			return { end: k + r, run, close: k };
		}
		j = k + r;
	}
	return undefined;
}

function findBracketEnd(s: string, i: number, open: string, close: string): number {
	let depth = 0;
	for (let j = i; j < s.length; j++) {
		const ch = s[j];
		if (ch === '\\') {
			j++;
		} else if (ch === '`') {
			const span = codeSpanEnd(s, j);
			if (span) {
				j = span.end - 1;
			}
		} else if (ch === open) {
			depth++;
		} else if (ch === close) {
			depth--;
			if (!depth) {
				return j;
			}
		}
	}
	return -1;
}

function parseLinkAt(s: string, i: number): { readonly label: string; readonly href: string; readonly end: number } | undefined {
	const labelEnd = findBracketEnd(s, i, '[', ']');
	if (labelEnd < 0 || s[labelEnd + 1] !== '(') {
		return undefined;
	}
	const hrefEnd = findBracketEnd(s, labelEnd + 1, '(', ')');
	if (hrefEnd < 0) {
		return undefined;
	}
	let href = s.slice(labelEnd + 2, hrefEnd).trim();
	const titled = /^(\S+)\s+["'(].*["')]$/.exec(href);
	if (titled) {
		href = titled[1];
	}
	if (href.startsWith('<') && href.endsWith('>')) {
		href = href.slice(1, -1);
	}
	return { label: s.slice(i + 1, labelEnd), href, end: hrefEnd + 1 };
}

/** The closing delimiter for an emphasis opened at `from` (skipping code spans and doubled runs). */
function findCloser(s: string, from: number, delim: string): number {
	const ch = delim[0];
	for (let j = from; j < s.length; j++) {
		const c = s[j];
		if (c === '\\') {
			j++;
			continue;
		}
		if (c === '`') {
			const span = codeSpanEnd(s, j);
			if (span) {
				j = span.end - 1;
			}
			continue;
		}
		if (c !== ch) {
			continue;
		}
		let run = 1;
		while (s[j + run] === ch) {
			run++;
		}
		const canClose = !isSpace(s[j - 1]) && (ch !== '_' || !isWordChar(s[j + run]));
		if (canClose && run === delim.length) {
			return j;
		}
		// `***` closes a `**` and the em inside it together (`**a *b***`); `**` inside `*` is a nested strong.
		if (canClose && run > delim.length && (run >= 3 || delim.length >= 2)) {
			return j + run - delim.length;
		}
		j += run - 1;
	}
	return -1;
}

function inlines(s: string, openEnded: boolean): MdInline[] {
	const out: MdInline[] = [];
	let text = '';
	const flush = () => {
		if (text) {
			out.push({ t: 'text', v: text });
			text = '';
		}
	};
	let i = 0;
	while (i < s.length) {
		const ch = s[i];

		if (ch === '\\') {
			const next = s[i + 1];
			if (next === '\n') {
				flush();
				out.push({ t: 'br' });
				i += 2;
				continue;
			}
			if (next !== undefined && PUNCT.includes(next)) {
				text += next;
				i += 2;
				continue;
			}
		}

		if (ch === '`') {
			const span = codeSpanEnd(s, i);
			if (span) {
				flush();
				let code = s.slice(i + span.run, span.close).replace(/\n/g, ' ');
				if (code.length > 2 && code.startsWith(' ') && code.endsWith(' ') && code.trim()) {
					code = code.slice(1, -1);
				}
				out.push({ t: 'code', v: code });
				i = span.end;
				continue;
			}
			let run = 1;
			while (s[i + run] === '`') {
				run++;
			}
			text += s.slice(i, i + run);
			i += run;
			continue;
		}

		if (ch === '!' && s[i + 1] === '[') {
			const link = parseLinkAt(s, i + 1);
			if (link) {
				flush();
				out.push({ t: 'image', src: link.href, alt: link.label });
				i = link.end;
				continue;
			}
		}

		if (ch === '[') {
			const link = parseLinkAt(s, i);
			if (link) {
				flush();
				out.push({ t: 'link', href: link.href, c: inlines(link.label, false) });
				i = link.end;
				continue;
			}
		}

		if (ch === '<') {
			const rest = s.slice(i, i + 300);
			const auto = /^<((?:https?|mailto):[^\s<>]+)>/i.exec(rest);
			if (auto) {
				flush();
				out.push({ t: 'link', href: auto[1], c: [{ t: 'text', v: auto[1].replace(/^mailto:/i, '') }] });
				i += auto[0].length;
				continue;
			}
			const br = /^<br\s*\/?>/i.exec(rest);
			if (br) {
				flush();
				out.push({ t: 'br' });
				i += br[0].length;
				continue;
			}
			// Inline tags agents use for emphasis (<kbd>, <sub>, <b>...): drop the tag, keep the text.
			const tag = /^<\/?(?:kbd|sub|sup|b|i|u|em|strong|span|small|mark|code|ins|del|s)\b[^>]*>/i.exec(rest);
			if (tag) {
				i += tag[0].length;
				continue;
			}
		}

		if ((ch === 'h' || ch === 'w') && (i === 0 || /[\s(\[{"'*_~]/.test(s[i - 1]))) {
			const url = /^(?:https?:\/\/|www\.)[^\s<]*[^\s<.,:;"')\]!?*_~]/.exec(s.slice(i, i + 2000));
			if (url) {
				let href = url[0];
				// A ")" belongs to the URL only when it closes one inside it.
				while (href.endsWith(')') && (href.match(/\)/g)?.length ?? 0) > (href.match(/\(/g)?.length ?? 0)) {
					href = href.slice(0, -1);
				}
				flush();
				out.push({ t: 'link', href: href.startsWith('www.') ? `https://${href}` : href, c: [{ t: 'text', v: href }] });
				i += href.length;
				continue;
			}
		}

		if (ch === '~' && s[i + 1] === '~' && !isSpace(s[i + 2])) {
			const close = s.indexOf('~~', i + 2);
			if (close > i + 2 && !isSpace(s[close - 1])) {
				flush();
				out.push({ t: 'del', c: inlines(s.slice(i + 2, close), false) });
				i = close + 2;
				continue;
			}
		}

		if ((ch === '*' || ch === '_') && (ch === '*' || !isWordChar(s[i - 1]))) {
			let run = 1;
			while (s[i + run] === ch) {
				run++;
			}
			const size = Math.min(run, 3);
			if (!isSpace(s[i + size]) && run <= 3) {
				const delim = ch.repeat(size);
				const close = findCloser(s, i + size, delim);
				if (close > i + size || (openEnded && close < 0 && i + size < s.length)) {
					const end = close > 0 ? close : s.length;
					const inner = inlines(s.slice(i + size, end), openEnded && close < 0);
					flush();
					out.push(size === 3 ? { t: 'strong', c: [{ t: 'em', c: inner }] } : size === 2 ? { t: 'strong', c: inner } : { t: 'em', c: inner });
					i = close > 0 ? close + size : s.length;
					continue;
				}
			}
			text += s.slice(i, i + run);
			i += run;
			continue;
		}

		if (ch === '\n') {
			text = text.replace(/[ \t]+$/, '');
			flush();
			out.push({ t: 'br' });
			i++;
			continue;
		}

		text += ch;
		i++;
	}
	flush();
	return out;
}

/** The text of inline nodes without formatting (alt text, accessibility labels, copy). */
export function inlineText(nodes: readonly MdInline[]): string {
	let out = '';
	for (const node of nodes) {
		switch (node.t) {
			case 'text':
			case 'code':
				out += node.v;
				break;
			case 'br':
				out += '\n';
				break;
			case 'image':
				out += node.alt;
				break;
			default:
				out += inlineText(node.c);
		}
	}
	return out;
}

/** HTML blocks show as text: tags removed, entities for the common characters decoded. */
export function stripHtml(html: string): string {
	return html
		.replace(/<br\s*\/?>/gi, '\n')
		.replace(/<\/(p|div|li|tr|h[1-6]|summary|details)>/gi, '\n')
		.replace(/<!--[\s\S]*?-->/g, '')
		.replace(/<[^>]+>/g, '')
		.replace(/&nbsp;/g, ' ')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, '\'')
		.replace(/&amp;/g, '&')
		.replace(/\n{3,}/g, '\n\n')
		.trim();
}

//#endregion
