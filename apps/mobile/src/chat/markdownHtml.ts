/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { type MdBlock, parseInline } from '@volt/client-core';

/**
 * HTML inside Markdown, read the way GitHub renders a README. Block tags (`<div align="center">`,
 * `<p>`, `<details>`, `<h1>`, tables, lists) become containers around the Markdown blocks between
 * them; inline tags (`<img>`, `<picture>`, `<a>`, `<b>`, `<kbd>`, `<sub>`...) become spans; comments
 * and tags with nothing to draw leave only their text. Reference links (`[text][ref]` and a
 * `[ref]: url` line) are rewritten to inline links before the Markdown is parsed.
 *
 * Plain chat text never pays for any of it: every entry point returns early unless the text has a
 * `<`, a `![` or a `]:`. No React Native here, so it runs (and is checked) under Node.
 */

export type HAlign = 'left' | 'center' | 'right';
export type HAttrs = Readonly<Record<string, string>>;

export interface IHImage {
	readonly t: 'image';
	readonly src: string;
	readonly alt: string;
	/** The `width`/`height` attributes as written (`64`, `64px`, `100%`). */
	readonly width?: string;
	readonly height?: string;
	/** `<picture>` sources for a dark and a light theme. */
	readonly dark?: string;
	readonly light?: string;
}

/** Markdown's inline nodes (a superset of `MdInline`) plus images with sizes and HTML-only spans. */
export type HInline =
	| { readonly t: 'text'; readonly v: string }
	| { readonly t: 'code'; readonly v: string }
	| { readonly t: 'math'; readonly v: string }
	| { readonly t: 'br' }
	| { readonly t: 'strong' | 'em' | 'del'; readonly c: readonly HInline[] }
	| { readonly t: 'link'; readonly href: string; readonly c: readonly HInline[] }
	| IHImage
	/** `kbd`, `sub`, `sup`, `mark`, `u`, `small`... styled by tag; anything else just shows its children. */
	| { readonly t: 'tag'; readonly tag: string; readonly c: readonly HInline[] };

type HContainer = Extract<HInline, { readonly c: readonly HInline[] }>;

/** A document with HTML in it: Markdown blocks, inline runs inside HTML elements, and the elements. */
export type HBlock =
	| { readonly k: 'md'; readonly key: string; readonly block: MdBlock }
	| { readonly k: 'flow'; readonly key: string; readonly nodes: readonly HInline[] }
	| { readonly k: 'el'; readonly key: string; readonly tag: string; readonly attrs: HAttrs; readonly align?: HAlign; readonly children: readonly HBlock[] };

export type HElement = Extract<HBlock, { readonly k: 'el' }>;

//#region Reference links

const DEFINITION = /^ {0,3}\[([^\]\n]+)\]:[ \t]*(<[^>\n]*>|\S+)(?:[ \t]+(?:"[^"\n]*"|'[^'\n]*'|\([^)\n]*\)))?[ \t]*$/;
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/;

function refLabel(label: string): string {
	return label.trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * `[text][ref]`, `[text][]` and `[ref]` rewritten to `[text](url)` from the `[ref]: url` lines,
 * which are removed. The same string back when there are no definitions (chat text, always).
 */
export function withReferenceLinks(text: string): string {
	if (!text.includes(']:')) {
		return text;
	}
	const lines = text.split('\n');
	const defs = new Map<string, string>();
	const kind: ('text' | 'code' | 'def')[] = [];
	let fence: string | undefined;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const open = FENCE_OPEN.exec(line);
		if (fence) {
			kind.push('code');
			if (open && open[1][0] === fence[0] && open[1].length >= fence.length && !line.slice(open[0].length).trim()) {
				fence = undefined;
			}
			continue;
		}
		if (open) {
			fence = open[1];
			kind.push('code');
			continue;
		}
		const def = DEFINITION.exec(line);
		// `[^1]: ...` is a footnote, not a link.
		if (def && !def[1].startsWith('^')) {
			const label = refLabel(def[1]);
			if (label && !defs.has(label)) {
				defs.set(label, def[2].replace(/^<|>$/g, ''));
			}
			kind.push('def');
			continue;
		}
		kind.push('text');
	}
	if (!defs.size) {
		return text;
	}
	const out: string[] = [];
	let chunk: string[] = [];
	const flush = () => {
		if (chunk.length) {
			out.push(rewriteRefs(chunk.join('\n'), defs));
			chunk = [];
		}
	};
	lines.forEach((line, i) => {
		if (kind[i] === 'text') {
			chunk.push(line);
		} else {
			flush();
			if (kind[i] === 'code') {
				out.push(line);
			}
		}
	});
	flush();
	return out.join('\n');
}

/** Index just past the code span at `i`, or past its backticks when it isn't closed. */
function codeSpanEnd(s: string, i: number): number {
	let run = 1;
	while (s[i + run] === '`') {
		run++;
	}
	let j = i + run;
	while (j < s.length) {
		const k = s.indexOf('`', j);
		if (k < 0) {
			break;
		}
		let r = 1;
		while (s[k + r] === '`') {
			r++;
		}
		if (r === run) {
			return k + r;
		}
		j = k + r;
	}
	return i + run;
}

function matchBracket(s: string, i: number, open: string, close: string): number {
	let depth = 0;
	for (let j = i; j < s.length; j++) {
		const ch = s[j];
		if (ch === '\\') {
			j++;
		} else if (ch === '`') {
			j = codeSpanEnd(s, j) - 1;
		} else if (ch === open) {
			depth++;
		} else if (ch === close && !--depth) {
			return j;
		}
	}
	return -1;
}

function destination(url: string): string {
	return url.replace(/ /g, '%20').replace(/\(/g, '%28').replace(/\)/g, '%29');
}

function rewriteRefs(s: string, defs: ReadonlyMap<string, string>): string {
	let out = '';
	let i = 0;
	while (i < s.length) {
		const ch = s[i];
		if (ch === '\\') {
			out += s.slice(i, i + 2);
			i += 2;
			continue;
		}
		if (ch === '`') {
			const end = codeSpanEnd(s, i);
			out += s.slice(i, end);
			i = end;
			continue;
		}
		const close = ch === '[' ? matchBracket(s, i, '[', ']') : -1;
		if (close < 0) {
			out += ch;
			i++;
			continue;
		}
		const label = s.slice(i + 1, close);
		const inner = rewriteRefs(label, defs);
		const next = s[close + 1];
		if (next === '(') {
			const end = matchBracket(s, close + 1, '(', ')');
			if (end > 0) {
				out += `[${inner}]${s.slice(close + 1, end + 1)}`;
				i = end + 1;
				continue;
			}
		}
		if (next === '[') {
			const refClose = s.indexOf(']', close + 2);
			const url = refClose > 0 ? defs.get(refLabel(s.slice(close + 2, refClose) || label)) : undefined;
			if (url !== undefined) {
				out += `[${inner}](${destination(url)})`;
				i = refClose + 1;
				continue;
			}
		}
		const url = next === ':' ? undefined : defs.get(refLabel(label));
		out += url !== undefined ? `[${inner}](${destination(url)})` : `[${inner}]`;
		i = close + 1;
	}
	return out;
}

//#endregion

//#region HTML tokens

type Token =
	| { readonly kind: 'open'; readonly name: string; readonly attrs: HAttrs; readonly self: boolean }
	| { readonly kind: 'close'; readonly name: string }
	| { readonly kind: 'text'; readonly v: string };

const TAG_AT = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:\s+[^\s"'>\/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*(\/?)>/y;
const ATTR = /([^\s"'>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
/** Tags that lay out as blocks: they end the inline run they appear in. */
const BLOCK = new Set([
	'address', 'article', 'aside', 'blockquote', 'caption', 'center', 'dd', 'details', 'dialog', 'div', 'dl', 'dt', 'fieldset',
	'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hgroup', 'hr', 'li', 'main', 'nav',
	'ol', 'p', 'pre', 'section', 'summary', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'ul',
]);
/** Tags whose content is never shown (GitHub drops them, or there is nothing to draw it with). */
const SKIP = new Set(['script', 'style', 'template', 'noscript', 'iframe', 'object', 'svg', 'math', 'video', 'audio', 'canvas', 'textarea', 'select', 'head', 'title']);
const INLINE = new Set([
	'a', 'abbr', 'acronym', 'b', 'bdi', 'bdo', 'big', 'br', 'button', 'cite', 'code', 'data', 'del', 'dfn', 'em', 'font', 'i', 'img',
	'input', 'ins', 'kbd', 'label', 'mark', 'nobr', 'picture', 'q', 'rp', 'rt', 'ruby', 's', 'samp', 'small', 'source', 'span',
	'strike', 'strong', 'sub', 'sup', 'time', 'tt', 'u', 'var', 'wbr',
]);
/**
 * In a chat reply only the tags agents use on purpose are HTML: "the <p> tag" in prose stays
 * text. An `<a>` needs its `href` and an `<img>` its `src`.
 */
const CHAT_INLINE = new Set(['a', 'b', 'br', 'code', 'del', 'em', 'i', 'img', 'ins', 'kbd', 'mark', 'picture', 's', 'small', 'source', 'span', 'strong', 'sub', 'sup', 'u', 'wbr']);

function isHtmlTag(name: string): boolean {
	return INLINE.has(name) || BLOCK.has(name) || SKIP.has(name) || VOID.has(name);
}

function isChatTag(name: string, rawAttrs: string, closing: boolean): boolean {
	if (!CHAT_INLINE.has(name)) {
		return false;
	}
	return closing || (name === 'a' ? /\bhref\s*=/i.test(rawAttrs) : name === 'img' ? /\bsrc\s*=/i.test(rawAttrs) : true);
}

function parseAttrs(raw: string): HAttrs {
	const attrs: Record<string, string> = Object.create(null);
	if (raw) {
		for (const m of raw.matchAll(ATTR)) {
			const name = m[1].toLowerCase();
			if (!(name in attrs)) {
				attrs[name] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? '');
			}
		}
	}
	return attrs;
}

/** The tag at `i` (`TAG_AT` matched there), as a token. */
function tagToken(m: RegExpExecArray): Token {
	const name = m[2].toLowerCase();
	return m[1] ? { kind: 'close', name } : { kind: 'open', name, attrs: parseAttrs(m[3]), self: !!m[4] || VOID.has(name) };
}

/** An HTML block's tokens: every tag is a tag (unknown ones drop out later), comments disappear. */
function tokenize(src: string): Token[] {
	const out: Token[] = [];
	let text = '';
	let i = 0;
	while (i < src.length) {
		const lt = src.indexOf('<', i);
		if (lt < 0) {
			text += src.slice(i);
			break;
		}
		text += src.slice(i, lt);
		if (src.startsWith('<!--', lt)) {
			const end = src.indexOf('-->', lt + 4);
			i = end < 0 ? src.length : end + 3;
			continue;
		}
		if (src.startsWith('<!', lt) || src.startsWith('<?', lt)) {
			const end = src.indexOf('>', lt);
			i = end < 0 ? src.length : end + 1;
			continue;
		}
		TAG_AT.lastIndex = lt;
		const m = TAG_AT.exec(src);
		if (!m) {
			text += '<';
			i = lt + 1;
			continue;
		}
		if (text) {
			out.push({ kind: 'text', v: text });
			text = '';
		}
		out.push(tagToken(m));
		i = lt + m[0].length;
	}
	if (text) {
		out.push({ kind: 'text', v: text });
	}
	return out;
}

const NAMED: Readonly<Record<string, string>> = {
	amp: '&', lt: '<', gt: '>', quot: '"', apos: '\'', nbsp: ' ', ensp: ' ', emsp: ' ', thinsp: ' ', zwj: '‍',
	zwnj: '‌', shy: '­', copy: '©', reg: '®', trade: '™', hellip: '…', mdash: '—', ndash: '–', minus: '−', middot: '·',
	bull: '•', rarr: '→', larr: '←', uarr: '↑', darr: '↓', harr: '↔', rArr: '⇒', lArr: '⇐', times: '×', divide: '÷', plusmn: '±',
	laquo: '«', raquo: '»', ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’', sbquo: '‚', bdquo: '„', deg: '°', para: '¶', sect: '§',
	euro: '€', pound: '£', yen: '¥', cent: '¢', frac12: '½', frac14: '¼', frac34: '¾', le: '≤', ge: '≥', ne: '≠', infin: '∞',
	check: '✓', cross: '✗', star: '☆', starf: '★', hearts: '♥', dagger: '†', Dagger: '‡', permil: '‰', prime: '′', Prime: '″',
	iexcl: '¡', iquest: '¿', brvbar: '¦', not: '¬', micro: 'µ', sup2: '²', sup3: '³', sup1: '¹', ordf: 'ª', ordm: 'º',
};

/** `&amp;`, `&nbsp;`, `&#169;`, `&#x1F680;`: the characters. Unknown entities stay as written. */
export function decodeEntities(s: string): string {
	if (!s.includes('&')) {
		return s;
	}
	return s.replace(/&(#\d{1,7}|#[xX][0-9a-fA-F]{1,6}|[a-zA-Z][a-zA-Z0-9]{1,31});/g, (m, body: string) => {
		if (body[0] === '#') {
			const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
			return code > 0 && code <= 0x10FFFF ? String.fromCodePoint(code) : m;
		}
		return NAMED[body] ?? m;
	});
}

//#endregion

//#region Inline

type Part = HInline | Token;

interface IInlineFrame {
	readonly name: string;
	readonly attrs: HAttrs;
	readonly c: HInline[];
	readonly sources: { readonly media: string; readonly src: string }[];
}

function isToken(part: Part): part is Token {
	return 'kind' in part;
}

function firstSrc(srcset: string | undefined): string | undefined {
	return srcset?.trim().split(/\s*,\s*/)[0]?.split(/\s+/)[0] || undefined;
}

function imageFrom(attrs: HAttrs): IHImage | undefined {
	const src = attrs.src || firstSrc(attrs.srcset) || attrs['data-src'];
	if (!src) {
		return undefined;
	}
	return { t: 'image', src, alt: attrs.alt ?? attrs.title ?? '', ...(attrs.width ? { width: attrs.width } : {}), ...(attrs.height ? { height: attrs.height } : {}) };
}

export function plainText(nodes: readonly HInline[]): string {
	let out = '';
	for (const node of nodes) {
		out += node.t === 'text' || node.t === 'code' || node.t === 'math' ? node.v : node.t === 'br' ? '\n' : node.t === 'image' ? node.alt : plainText(node.c);
	}
	return out;
}

/** A closed inline element as nodes: `<a href>` a link, `<b>` strong, `<code>` code, `<picture>` its image. */
function finishInline(f: IInlineFrame): HInline[] {
	const c = f.c;
	switch (f.name) {
		case 'a':
			return f.attrs.href && c.length ? [{ t: 'link', href: f.attrs.href, c }] : c;
		case 'b': case 'strong':
			return c.length ? [{ t: 'strong', c }] : [];
		case 'i': case 'em': case 'cite': case 'dfn': case 'var':
			return c.length ? [{ t: 'em', c }] : [];
		case 's': case 'del': case 'strike':
			return c.length ? [{ t: 'del', c }] : [];
		case 'code': case 'tt': case 'samp': {
			const v = plainText(c);
			return v ? [{ t: 'code', v }] : [];
		}
		case 'q':
			return [{ t: 'text', v: '“' }, ...c, { t: 'text', v: '”' }];
		case 'kbd': case 'sub': case 'sup': case 'mark': case 'u': case 'ins': case 'small': case 'big': case 'abbr':
			return c.length ? [{ t: 'tag', tag: f.name, c }] : [];
		case 'picture': {
			const img = c.find((node): node is IHImage => node.t === 'image');
			let dark: string | undefined;
			let light: string | undefined;
			for (const source of f.sources) {
				if (/prefers-color-scheme:\s*dark/i.test(source.media)) {
					dark ??= source.src;
				} else if (/prefers-color-scheme:\s*light/i.test(source.media)) {
					light ??= source.src;
				}
			}
			const base: IHImage | undefined = img ?? (f.sources[0] ? { t: 'image', src: f.sources[0].src, alt: '' } : undefined);
			return base ? [{ ...base, ...(dark ? { dark } : {}), ...(light ? { light } : {}) }] : [];
		}
		default:
			return c;
	}
}

/** Inline nodes and tag tokens in order, nested back into elements; unclosed tags close at the end. */
function buildInline(parts: readonly Part[]): HInline[] {
	const root: IInlineFrame = { name: '', attrs: {}, c: [], sources: [] };
	const stack: IInlineFrame[] = [root];
	let skip: string | undefined;
	let skipDepth = 0;
	const pop = () => {
		const frame = stack.pop()!;
		stack[stack.length - 1].c.push(...finishInline(frame));
	};
	for (const part of parts) {
		const top = stack[stack.length - 1];
		if (!isToken(part)) {
			if (!skip) {
				top.c.push(part);
			}
			continue;
		}
		if (skip) {
			if (part.kind !== 'text' && part.name === skip) {
				skipDepth += part.kind === 'open' ? (part.self ? 0 : 1) : -1;
				if (!skipDepth) {
					skip = undefined;
				}
			}
			continue;
		}
		if (part.kind === 'text') {
			top.c.push({ t: 'text', v: part.v });
			continue;
		}
		if (part.kind === 'close') {
			let at = stack.length - 1;
			while (at > 0 && stack[at].name !== part.name) {
				at--;
			}
			while (at > 0 && stack.length > at) {
				pop();
			}
			continue;
		}
		const { name, attrs } = part;
		if (SKIP.has(name)) {
			if (!part.self) {
				skip = name;
				skipDepth = 1;
			}
			continue;
		}
		if (name === 'img') {
			const image = imageFrom(attrs);
			if (image) {
				top.c.push(image);
			}
		} else if (name === 'br' || name === 'hr') {
			top.c.push({ t: 'br' });
		} else if (name === 'source') {
			const picture = [...stack].reverse().find(frame => frame.name === 'picture');
			const src = firstSrc(attrs.srcset) ?? attrs.src;
			if (picture && src) {
				picture.sources.push({ media: attrs.media ?? '', src });
			}
		} else if (name === 'input') {
			if ((attrs.type ?? '').toLowerCase() === 'checkbox') {
				top.c.push({ t: 'text', v: 'checked' in attrs ? '☑ ' : '☐ ' });
			}
		} else if (!part.self) {
			stack.push({ name, attrs, c: [], sources: [] });
		}
	}
	while (stack.length > 1) {
		pop();
	}
	return root.c;
}

const PLACEHOLDER = /<(\d+)>/g;
const PLACEHOLDER_ANY = /<\d+>/g;

/**
 * The text with each HTML tag (outside code spans) swapped for a placeholder `<n>` and every
 * comment removed. Markdown then parses around the placeholders; `<` keeps a bare URL from
 * running into one. Undefined when there was nothing to swap.
 */
function replaceTags(s: string, doc: boolean): { readonly text: string; readonly tokens: readonly Token[] } | undefined {
	let out = '';
	const tokens: Token[] = [];
	let last = 0;
	let i = 0;
	while (i < s.length) {
		const ch = s[i];
		if (ch === '\\') {
			i += 2;
			continue;
		}
		if (ch === '`') {
			i = codeSpanEnd(s, i);
			continue;
		}
		if (ch === '<') {
			if (s.startsWith('<!--', i)) {
				const end = s.indexOf('-->', i + 4);
				out += s.slice(last, i);
				i = last = end < 0 ? s.length : end + 3;
				continue;
			}
			TAG_AT.lastIndex = i;
			const m = TAG_AT.exec(s);
			const name = m?.[2].toLowerCase();
			if (m && name && (doc ? isHtmlTag(name) : isChatTag(name, m[3], !!m[1]))) {
				out += `${s.slice(last, i)}<${tokens.length}>`;
				tokens.push(tagToken(m));
				i = last = i + m[0].length;
				continue;
			}
		}
		i++;
	}
	return last ? { text: out + s.slice(last), tokens } : undefined;
}

/** Parsed Markdown with the placeholders put back as the tags they stood for. */
function expandTags(nodes: readonly HInline[], tokens: readonly Token[]): HInline[] {
	const parts: Part[] = [];
	for (const node of nodes) {
		if (node.t === 'text') {
			let at = 0;
			for (const m of node.v.matchAll(PLACEHOLDER)) {
				if (m.index > at) {
					parts.push({ t: 'text', v: node.v.slice(at, m.index) });
				}
				const token = tokens[Number(m[1])];
				if (token) {
					parts.push(token);
				}
				at = m.index + m[0].length;
			}
			if (at < node.v.length) {
				parts.push(at ? { t: 'text', v: node.v.slice(at) } : node);
			}
		} else if (node.t === 'image') {
			parts.push(node.alt.includes('<') ? { ...node, alt: node.alt.replace(PLACEHOLDER_ANY, '') } : node);
		} else if (node.t === 'link') {
			parts.push({ ...node, href: node.href.replace(PLACEHOLDER_ANY, ''), c: expandTags(node.c, tokens) });
		} else if ('c' in node) {
			parts.push({ ...node, c: expandTags(node.c, tokens) } as HContainer);
		} else {
			parts.push(node);
		}
	}
	return buildInline(parts);
}

function mapText(nodes: readonly HInline[], fn: (v: string) => string): HInline[] {
	const out: HInline[] = [];
	for (const node of nodes) {
		if (node.t === 'text') {
			const v = fn(node.v);
			const prev = out[out.length - 1];
			if (prev?.t === 'text') {
				out[out.length - 1] = { t: 'text', v: prev.v + v };
			} else if (v) {
				out.push({ t: 'text', v });
			}
		} else if ('c' in node) {
			const c = mapText(node.c, fn);
			if (c.length) {
				out.push({ ...node, c } as HContainer);
			}
		} else {
			out.push(node);
		}
	}
	return out.filter(node => node.t !== 'text' || node.v);
}

function trimEdge(nodes: readonly HInline[], end: boolean): HInline[] {
	const out = [...nodes];
	while (out.length) {
		const at = end ? out.length - 1 : 0;
		const node = out[at];
		if (node.t === 'text') {
			const v = end ? node.v.replace(/[ \t\r\n]+$/, '') : node.v.replace(/^[ \t\r\n]+/, '');
			if (v) {
				out[at] = { t: 'text', v };
				break;
			}
			out.splice(at, 1);
		} else if ('c' in node) {
			const c = trimEdge(node.c, end);
			if (c.length) {
				out[at] = { ...node, c } as HContainer;
				break;
			}
			out.splice(at, 1);
		} else {
			break;
		}
	}
	return out;
}

/**
 * Inline content tidied for drawing: entities decoded, whitespace collapsed as HTML does
 * (`collapse`), spaces trimmed at the ends of each line, and a last `<br>` dropped (one at the
 * end of a block draws nothing). A run of nothing but `<br>`s keeps them all: it is blank lines.
 */
export function normalizeFlow(nodes: readonly HInline[], collapse: boolean): HInline[] {
	const mapped = mapText(nodes, v => {
		const decoded = decodeEntities(v);
		return collapse ? decoded.replace(/[ \t\r\n]+/g, ' ') : decoded;
	});
	const lines: HInline[][] = [[]];
	for (const node of mapped) {
		if (node.t === 'br') {
			lines.push([]);
		} else {
			lines[lines.length - 1].push(node);
		}
	}
	const trimmed = lines.map(line => trimEdge(trimEdge(line, false), true));
	if (trimmed.every(line => !line.length)) {
		return trimmed.slice(1).map(() => ({ t: 'br' }));
	}
	// Only the last break draws nothing: `text<br><br>` keeps one empty line.
	if (!trimmed[trimmed.length - 1].length) {
		trimmed.pop();
	}
	const out: HInline[] = [];
	trimmed.forEach((line, i) => {
		if (i) {
			out.push({ t: 'br' });
		}
		out.push(...line);
	});
	return out;
}

/** GitHub joins a paragraph's lines with a space; a line ending in two spaces or `\` still breaks. */
function joinSoftBreaks(s: string): string {
	if (!s.includes('\n')) {
		return s;
	}
	const lines = s.split('\n');
	let out = lines[0];
	for (let i = 1; i < lines.length; i++) {
		out += /(?: {2,}|\\)$/.test(lines[i - 1]) ? '\n' : ' ';
		out += lines[i];
	}
	return out;
}

const RICH_MAX = 600;
const richCache = new Map<string, readonly HInline[] | null>();

/**
 * A paragraph's inline nodes with its HTML and images, or undefined when it has neither (chat
 * text then takes the plain path). `doc`: a README or other document, where every HTML tag
 * counts, lines join with a space and entities decode, as on GitHub.
 */
export function richInlines(src: string, doc: boolean, open = false): readonly HInline[] | undefined {
	if (!doc && !src.includes('<') && !src.includes('![')) {
		return undefined;
	}
	const key = `${doc ? 'd' : 'c'}${open ? 'o' : '-'}${src}`;
	const hit = richCache.get(key);
	if (hit !== undefined) {
		return hit ?? undefined;
	}
	const result = computeRich(src, doc, open);
	richCache.set(key, result ?? null);
	if (richCache.size > RICH_MAX) {
		const oldest = richCache.keys().next().value;
		if (oldest !== undefined) {
			richCache.delete(oldest);
		}
	}
	return result;
}

function computeRich(src: string, doc: boolean, open: boolean): readonly HInline[] | undefined {
	const s = doc ? joinSoftBreaks(src) : src;
	const tagged = s.includes('<') ? replaceTags(s, doc) : undefined;
	const nodes = parseInline(tagged ? tagged.text : s, open) as readonly HInline[];
	if (!doc && !tagged && !hasImage(nodes)) {
		return undefined;
	}
	return normalizeFlow(tagged ? expandTags(nodes, tagged.tokens) : nodes, doc);
}

export function hasImage(nodes: readonly HInline[]): boolean {
	return nodes.some(node => node.t === 'image' || ('c' in node && hasImage(node.c)));
}

/** The image when the inline content is only that (optionally inside a link). */
export function soleImageOf(nodes: readonly HInline[]): IHImage | undefined {
	const visible = nodes.filter(node => !(node.t === 'text' && !node.v.trim()));
	const node = visible.length === 1 ? visible[0] : undefined;
	if (node?.t === 'image') {
		return node;
	}
	const inner = node?.t === 'link' && node.c.length === 1 ? node.c[0] : undefined;
	return inner?.t === 'image' ? inner : undefined;
}

//#endregion

//#region Flow

/** One piece of a line of inline content that has pictures in it. */
export type FlowItem =
	| { readonly k: 'text'; readonly nodes: readonly HInline[] }
	| { readonly k: 'image'; readonly image: IHImage; readonly href?: string }
	/** A line break; `empty` when the line it ends had nothing on it. */
	| { readonly k: 'break'; readonly empty: boolean }
	/** The space between two pictures (badges side by side). */
	| { readonly k: 'space' };

type Piece = HInline | { readonly image: IHImage; readonly href?: string };

function isPicture(piece: Piece): piece is { readonly image: IHImage; readonly href?: string } {
	return 'image' in piece;
}

/** Pictures lifted out of the spans around them (a linked badge keeps its link), text kept in its spans. */
function pieces(nodes: readonly HInline[], href: string | undefined): Piece[] {
	const out: Piece[] = [];
	for (const node of nodes) {
		if (node.t === 'image') {
			out.push({ image: node, ...(href ? { href } : {}) });
		} else if ('c' in node && hasImage(node.c)) {
			let run: HInline[] = [];
			const flush = () => {
				if (run.length) {
					out.push({ ...node, c: run } as HContainer);
					run = [];
				}
			};
			for (const piece of pieces(node.c, node.t === 'link' ? node.href : href)) {
				if (isPicture(piece) || piece.t === 'br') {
					flush();
					out.push(piece);
				} else {
					run.push(piece);
				}
			}
			flush();
		} else {
			out.push(node);
		}
	}
	return out;
}

/** Inline content with pictures as a row of pieces that wraps like text; undefined without pictures. */
export function flowItems(nodes: readonly HInline[]): readonly FlowItem[] | undefined {
	if (!hasImage(nodes)) {
		return undefined;
	}
	const items: FlowItem[] = [];
	let run: HInline[] = [];
	const flush = () => {
		if (!run.length) {
			return;
		}
		const text = plainText(run);
		if (!text.trim()) {
			items.push({ k: 'space' });
		} else {
			// The text's own edge spaces become gaps beside the pictures next to it.
			if (/^\s/.test(text)) {
				items.push({ k: 'space' });
			}
			items.push({ k: 'text', nodes: trimEdge(trimEdge(run, false), true) });
			if (/\s$/.test(text)) {
				items.push({ k: 'space' });
			}
		}
		run = [];
	};
	for (const piece of pieces(nodes, undefined)) {
		if (isPicture(piece)) {
			flush();
			items.push({ k: 'image', image: piece.image, ...(piece.href ? { href: piece.href } : {}) });
		} else if (piece.t === 'br') {
			flush();
			const prev = items[items.length - 1];
			items.push({ k: 'break', empty: !prev || prev.k === 'break' });
		} else {
			run.push(piece);
		}
	}
	flush();
	// A space only separates two pieces on the same line, once.
	const out: FlowItem[] = [];
	items.forEach((item, i) => {
		const prev = out[out.length - 1];
		const next = items[i + 1];
		if (item.k !== 'space' || (prev && prev.k !== 'break' && prev.k !== 'space' && next && next.k !== 'break' && next.k !== 'space')) {
			out.push(item);
		}
	});
	return out;
}

//#endregion

//#region Blocks

interface IBlockFrame {
	readonly tag: string;
	readonly attrs: HAttrs;
	readonly key: string;
	readonly children: HBlock[];
	parts: Token[];
}

/** HTML block tags (CommonMark kinds 1 and 6) the Markdown parser doesn't start an HTML block for. */
const LEADING_BLOCK = new Set([
	'address', 'base', 'body', 'caption', 'col', 'colgroup', 'dialog', 'fieldset', 'figcaption', 'form', 'frame', 'frameset', 'head', 'hgroup', 'hr',
	'html', 'iframe', 'legend', 'link', 'main', 'menu', 'meta', 'noframes', 'noscript', 'optgroup', 'option', 'param', 'script', 'search', 'source',
	'style', 'template', 'textarea', 'tfoot', 'title', 'track',
]);
const LEADING_TAG = /^ {0,3}<(\/?)([a-zA-Z][a-zA-Z0-9-]*)/;

/**
 * A paragraph GitHub reads as an HTML block: one starting with `<hr>`, `<script>`..., or (in a
 * document) whose first line is nothing but a tag (`<img ...>`, `<br />`, `<a href>`), so the
 * pictures and breaks of consecutive ones flow together as on GitHub. In a chat reply only `<hr>`.
 */
function isHtmlParagraph(block: MdBlock, doc: boolean): boolean {
	if (block.type !== 'paragraph' || !block.text.startsWith('<')) {
		return false;
	}
	const m = LEADING_TAG.exec(block.text);
	const name = m?.[2].toLowerCase();
	if (!m || !name) {
		return false;
	}
	if (!doc) {
		return name === 'hr' && !m[1];
	}
	if (LEADING_BLOCK.has(name)) {
		return true;
	}
	if (!isHtmlTag(name)) {
		return false;
	}
	const first = block.text.split('\n', 1)[0].trimEnd();
	TAG_AT.lastIndex = 0;
	return TAG_AT.exec(first)?.[0].length === first.length;
}

export function hasHtmlBlock(blocks: readonly MdBlock[], doc = false): boolean {
	return blocks.some(block => block.type === 'html' || isHtmlParagraph(block, doc));
}

export function alignOf(tag: string, attrs: HAttrs): HAlign | undefined {
	if (tag === 'center') {
		return 'center';
	}
	const value = (attrs.align ?? /text-align\s*:\s*(left|center|right)/i.exec(attrs.style ?? '')?.[1] ?? '').toLowerCase();
	return value === 'center' || value === 'right' || value === 'left' ? value : undefined;
}

/** Elements an opening tag closes first, HTML-style (`<li>` after `<li>`, anything after `<p>`). */
const IMPLIED: Readonly<Record<string, { readonly close: readonly string[]; readonly within: readonly string[] }>> = {
	li: { close: ['li'], within: ['ul', 'ol'] },
	dt: { close: ['dt', 'dd'], within: ['dl'] },
	dd: { close: ['dt', 'dd'], within: ['dl'] },
	tr: { close: ['tr', 'td', 'th'], within: ['table', 'thead', 'tbody', 'tfoot'] },
	td: { close: ['td', 'th'], within: ['tr'] },
	th: { close: ['td', 'th'], within: ['tr'] },
	thead: { close: ['thead', 'tbody', 'tr', 'td', 'th'], within: ['table'] },
	tbody: { close: ['thead', 'tbody', 'tr', 'td', 'th'], within: ['table'] },
};

/**
 * A block list with HTML blocks in it as a tree: an HTML block's tags open and close elements
 * (`<div align="center">` in one block and `</div>` in a later one hold the Markdown between);
 * inline tags and text inside elements become runs of inline content. Comments, including ones
 * that run across blank lines, are dropped.
 */
export function structureHtml(blocks: readonly MdBlock[], doc = false): readonly HBlock[] {
	const root: IBlockFrame = { tag: '', attrs: {}, key: 'h', children: [], parts: [] };
	const stack: IBlockFrame[] = [root];
	const top = () => stack[stack.length - 1];
	let skip: string | undefined;
	let skipDepth = 0;
	let inComment = false;
	const flush = (frame: IBlockFrame) => {
		if (!frame.parts.length) {
			return;
		}
		const nodes = normalizeFlow(buildInline(frame.parts), true);
		frame.parts = [];
		if (nodes.length) {
			frame.children.push({ k: 'flow', key: `${frame.key}.${frame.children.length}`, nodes });
		}
	};
	const close = () => {
		const frame = stack.pop()!;
		if (frame.tag === 'pre') {
			const code = decodeEntities(frame.parts.map(part => part.kind === 'text' ? part.v : '').join('')).replace(/^\n/, '').replace(/\s+$/, '');
			frame.parts = [];
			const lang = /(?:^|\s)(?:lang(?:uage)?-)(\S+)/.exec(frame.attrs.class ?? '')?.[1] ?? frame.attrs.lang ?? '';
			top().children.push({ k: 'md', key: frame.key, block: { type: 'code', key: frame.key, lang: lang.toLowerCase(), code, closed: true } });
			return;
		}
		flush(frame);
		if (!frame.children.length && frame.tag !== 'td' && frame.tag !== 'th') {
			return;
		}
		const align = alignOf(frame.tag, frame.attrs);
		top().children.push({ k: 'el', key: frame.key, tag: frame.tag, attrs: frame.attrs, ...(align ? { align } : {}), children: frame.children });
	};
	const find = (names: readonly string[], within: readonly string[] = []) => {
		for (let at = stack.length - 1; at > 0; at--) {
			if (names.includes(stack[at].tag)) {
				return at;
			}
			if (within.includes(stack[at].tag)) {
				return -1;
			}
		}
		return -1;
	};
	const closeTo = (at: number) => {
		while (at > 0 && stack.length > at) {
			close();
		}
	};
	for (const block of blocks) {
		let source: string;
		if (block.type === 'html') {
			source = block.text;
		} else if (block.type === 'paragraph' && isHtmlParagraph(block, doc)) {
			source = block.text;
		} else if (inComment) {
			source = block.type === 'paragraph' || block.type === 'heading' ? block.text : '';
		} else {
			flush(top());
			top().children.push({ k: 'md', key: block.key, block });
			continue;
		}
		if (inComment) {
			const end = source.indexOf('-->');
			if (end < 0 || block.type !== 'html') {
				inComment = end < 0;
				continue;
			}
			inComment = false;
			source = source.slice(end + 3);
		}
		const lastOpen = source.lastIndexOf('<!--');
		if (lastOpen >= 0 && source.indexOf('-->', lastOpen + 4) < 0) {
			inComment = true;
		}
		const tokens = tokenize(source);
		tokens.forEach((token, j) => {
			if (skip) {
				if (token.kind !== 'text' && token.name === skip) {
					skipDepth += token.kind === 'open' ? (token.self ? 0 : 1) : -1;
					if (!skipDepth) {
						skip = undefined;
					}
				}
				return;
			}
			const frame = top();
			if (token.kind === 'text' || (frame.tag === 'pre' && token.name !== 'pre')) {
				frame.parts.push(token);
				return;
			}
			const name = token.name;
			if (token.kind === 'open' && SKIP.has(name)) {
				if (!token.self) {
					skip = name;
					skipDepth = 1;
				}
				return;
			}
			if (!BLOCK.has(name)) {
				frame.parts.push(token);
				return;
			}
			if (token.kind === 'close') {
				closeTo(find([name]));
				return;
			}
			if (frame.tag === 'p') {
				close();
			}
			const implied = IMPLIED[name];
			if (implied) {
				closeTo(find(implied.close, implied.within));
			}
			flush(top());
			const key = `${block.key}.${j}`;
			if (name === 'hr') {
				top().children.push({ k: 'el', key, tag: 'hr', attrs: token.attrs, children: [] });
			} else if (!token.self) {
				stack.push({ tag: name, attrs: token.attrs, key, children: [], parts: [] });
			}
		});
	}
	closeTo(1);
	flush(root);
	return root.children;
}

/** An HTML table's rows (inside `thead`/`tbody`/`tfoot` or not) and their cells. */
export function tableRows(table: HElement): readonly { readonly key: string; readonly cells: readonly HElement[] }[] {
	const rows: { key: string; cells: HElement[] }[] = [];
	const visit = (nodes: readonly HBlock[]) => {
		for (const node of nodes) {
			if (node.k !== 'el') {
				continue;
			}
			if (node.tag === 'tr') {
				rows.push({ key: node.key, cells: node.children.filter((cell): cell is HElement => cell.k === 'el' && (cell.tag === 'td' || cell.tag === 'th')) });
			} else if (node.tag === 'thead' || node.tag === 'tbody' || node.tag === 'tfoot') {
				visit(node.children);
			}
		}
	};
	visit(table.children);
	return rows.filter(row => row.cells.length);
}

//#endregion

//#region Paths and images

const FILE_NAMES = /^(?:LICEN[CS]E|COPYING|NOTICE|AUTHORS|CONTRIBUTORS|CHANGELOG|CHANGES|README|Makefile|Dockerfile|Procfile|Gemfile|Rakefile|Brewfile|Justfile|Vagrantfile|CODEOWNERS)$/i;

/** `rel` against the folder `base`; `..` and `.` resolved. `/x` is the folder's `x`, as GitHub reads a README. */
export function joinPath(base: string, rel: string): string {
	const sep = base.includes('\\') && !base.includes('/') ? '\\' : '/';
	const trimmed = base.replace(/[\\/]+$/, '');
	const under = rel.startsWith(trimmed + sep) || rel.startsWith(trimmed + '/') || rel === trimmed;
	const full = under ? rel : `${trimmed}${sep}${rel.replace(/^[\\/]+/, '')}`;
	const out: string[] = [];
	for (const part of full.split(/[\\/]/)) {
		if (part === '..') {
			if (out.length > 1) {
				out.pop();
			}
		} else if (part !== '.' && (part || !out.length)) {
			out.push(part);
		}
	}
	return out.join(sep) || sep;
}

function stripQuery(value: string): string {
	return value.replace(/[?#].*$/, '');
}

/**
 * A relative link in a document (`CONTRIBUTING.md#setup`, `docs/install`, `../x.ts#L12`) as the
 * file or folder it names on the computer. Undefined for anchors and other schemes.
 */
export function resolveDocTarget(href: string, baseDir: string): { readonly path: string; readonly line?: number; readonly dir: boolean } | undefined {
	let value = href.trim();
	if (!value || value.startsWith('#') || value.startsWith('//') || (/^[a-z][a-z0-9+.-]*:/i.test(value) && !/^file:/i.test(value))) {
		return undefined;
	}
	value = value.replace(/^file:\/\//i, '');
	const line = Number(/#L(\d+)/.exec(value)?.[1]) || undefined;
	value = stripQuery(value);
	try {
		value = decodeURI(value);
	} catch {
		// keep as written
	}
	if (!value) {
		return undefined;
	}
	const path = joinPath(baseDir, value);
	const name = path.split(/[\\/]/).pop() ?? '';
	const dir = /[\\/]$/.test(value) || !(/\.[\w-]+$/.test(name) || name.startsWith('.') || FILE_NAMES.test(name));
	return { path, ...(line ? { line } : {}), dir };
}

export type ImageTarget =
	| { readonly kind: 'remote'; readonly uri: string; readonly svg: boolean }
	| { readonly kind: 'data'; readonly uri: string; readonly svg: boolean }
	| { readonly kind: 'file'; readonly path: string; readonly svg: boolean };

const BADGE_HOSTS = /^(?:img\.shields\.io|badgen\.net|flat\.badgen\.net|badge\.fury\.io|forthebadge\.com|codecov\.io|coveralls\.io|app\.codacy\.com|api\.codacy\.com|snyk\.io|deepscan\.io|api\.netlify\.com|vercelbadge\.vercel\.app)$/i;

/** Where an image's bytes come from: the web, the source itself, or a file on the computer (`folder` resolves relative paths). */
export function imageTarget(src: string, folder: string | undefined, doc: boolean): ImageTarget | undefined {
	let value = src.trim().replace(/^<|>$/g, '');
	if (!value) {
		return undefined;
	}
	if (/^data:image\//i.test(value)) {
		return { kind: 'data', uri: value, svg: /^data:image\/svg\+xml/i.test(value) };
	}
	if (value.startsWith('//')) {
		value = `https:${value}`;
	}
	if (/^https?:\/\//i.test(value)) {
		// A file on GitHub's page for it: the raw bytes are one hop away.
		value = value.replace(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\//i, 'https://github.com/$1/$2/raw/');
		const host = /^https?:\/\/([^/:?#]+)/i.exec(value)?.[1] ?? '';
		const path = stripQuery(value.slice(value.indexOf(host) + host.length));
		return { kind: 'remote', uri: value, svg: /\.svg$/i.test(path) || BADGE_HOSTS.test(host) || /\/badge(?:[./]|$)/i.test(path) };
	}
	if (/^file:\/\//i.test(value)) {
		value = value.replace(/^file:\/\//i, '');
	} else if (/^[a-z][a-z0-9+.-]*:/i.test(value) && !/^[a-z]:[\\/]/i.test(value)) {
		return undefined;
	}
	value = stripQuery(value);
	try {
		value = decodeURI(value);
	} catch {
		// keep as written
	}
	const absolute = value.startsWith('/') || /^[a-z]:[\\/]/i.test(value);
	if (!folder && !absolute) {
		return undefined;
	}
	const path = folder && (!absolute || (doc && !/^[a-z]:[\\/]/i.test(value))) ? joinPath(folder, value) : value;
	return { kind: 'file', path, svg: /\.svg$/i.test(path) };
}

function svgLength(value: string | undefined): number | undefined {
	const m = value ? /^\s*([\d.]+)\s*(px)?\s*$/i.exec(value) : null;
	const n = m ? Number(m[1]) : NaN;
	return n > 0 ? n : undefined;
}

/** An SVG document's drawn size: its `width`/`height`, else its `viewBox`, else 300×150 (the browser default). */
export function svgSize(xml: string): { readonly width: number; readonly height: number; readonly viewBox?: string } | undefined {
	const tag = /<svg\b([^>]*)>/i.exec(xml);
	if (!tag) {
		return undefined;
	}
	const attrs = parseAttrs(tag[1]);
	const box = (attrs.viewbox ?? '').trim().split(/[\s,]+/).map(Number);
	const vbW = box.length === 4 && box[2] > 0 ? box[2] : undefined;
	const vbH = box.length === 4 && box[3] > 0 ? box[3] : undefined;
	let width = svgLength(attrs.width);
	let height = svgLength(attrs.height);
	if (width && !height) {
		height = vbW && vbH ? width * vbH / vbW : undefined;
	} else if (height && !width) {
		width = vbW && vbH ? height * vbW / vbH : undefined;
	}
	width ??= vbW ?? 300;
	height ??= vbH ?? 150;
	return { width, height, ...(vbW && vbH ? {} : { viewBox: `0 0 ${width} ${height}` }) };
}

/** Base64 to text, UTF-8 decoded (an SVG read from the computer). */
export function base64ToUtf8(base64: string): string {
	const binary = atob(base64.replace(/\s+/g, ''));
	let out = '';
	for (let i = 0; i < binary.length;) {
		const a = binary.charCodeAt(i++);
		if (a < 0x80) {
			out += String.fromCharCode(a);
		} else if (a < 0xE0) {
			out += String.fromCharCode(((a & 0x1F) << 6) | (binary.charCodeAt(i++) & 0x3F));
		} else if (a < 0xF0) {
			out += String.fromCharCode(((a & 0x0F) << 12) | ((binary.charCodeAt(i++) & 0x3F) << 6) | (binary.charCodeAt(i++) & 0x3F));
		} else {
			const cp = ((a & 0x07) << 18) | ((binary.charCodeAt(i++) & 0x3F) << 12) | ((binary.charCodeAt(i++) & 0x3F) << 6) | (binary.charCodeAt(i++) & 0x3F);
			out += String.fromCodePoint(cp);
		}
	}
	return out;
}

/** An SVG `data:` URI's document. */
export function svgFromDataUri(uri: string): string | undefined {
	const comma = uri.indexOf(',');
	if (comma < 0) {
		return undefined;
	}
	const head = uri.slice(0, comma);
	const body = uri.slice(comma + 1);
	try {
		return /;base64$/i.test(head) ? base64ToUtf8(decodeURIComponent(body)) : decodeURIComponent(body);
	} catch {
		return undefined;
	}
}

export interface IImageBox {
	readonly width: number | `${number}%`;
	readonly aspectRatio: number;
}

function dimension(value: string | undefined): { readonly px?: number; readonly pct?: number } {
	const m = value ? /^\s*([\d.]+)\s*(px|%)?\s*$/i.exec(value) : null;
	const n = m ? Number(m[1]) : NaN;
	if (!(n > 0)) {
		return {};
	}
	return m?.[2] === '%' ? { pct: Math.min(n, 100) } : { px: n };
}

/**
 * The box an image draws in, as a browser sizes `<img width height>`: the attributes when given
 * (`100%` is the column's width), else the picture's own size; the aspect ratio kept, and never
 * wider than the column (the view caps it with `maxWidth: '100%'`). Undefined until known.
 */
export function imageBox(width: string | undefined, height: string | undefined, natural: { readonly width: number; readonly height: number } | undefined): IImageBox | undefined {
	const w = dimension(width);
	const h = dimension(height);
	const ratio = natural && natural.height > 0 ? natural.width / natural.height : w.px && h.px ? w.px / h.px : undefined;
	if (w.pct) {
		return ratio ? { width: `${w.pct}%`, aspectRatio: ratio } : undefined;
	}
	if (w.px && h.px) {
		return { width: w.px, aspectRatio: w.px / h.px };
	}
	if (w.px) {
		return ratio ? { width: w.px, aspectRatio: ratio } : undefined;
	}
	if (h.px) {
		return ratio ? { width: h.px * ratio, aspectRatio: ratio } : undefined;
	}
	return natural && ratio ? { width: natural.width, aspectRatio: ratio } : undefined;
}

//#endregion
