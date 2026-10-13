/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Turns a search pattern into the trigrams any matching file must contain, after Russ Cox's
 * "Regular Expression Matching with a Trigram Index" (Google Code Search): every regex node
 * reports its exact strings or its possible prefixes and suffixes, and concatenation and
 * alternation combine them into an AND/OR query. Literal runs come out as phrases, so the
 * index can also check that their trigrams sit next to each other (Blackbird's masks).
 *
 * Everything here over-approximates: a construct it does not understand matches anything.
 * The index then returns more candidates, never fewer, and the real regex decides.
 *
 * Strings are byte strings: one char per UTF-8 byte, ASCII letters lower-cased, which is
 * exactly what the index stores.
 */

export type TrigramQuery =
	| { readonly op: 'all' }
	| { readonly op: 'none' }
	| { readonly op: 'and'; readonly sub: readonly TrigramQuery[] }
	| { readonly op: 'or'; readonly sub: readonly TrigramQuery[] }
	/** All trigrams of `text` (3+ bytes), next to each other. */
	| { readonly op: 'phrase'; readonly text: string };

const ALL: TrigramQuery = { op: 'all' };
const NONE: TrigramQuery = { op: 'none' };

const MAX_EXACT = 7;
const MAX_SET = 20;
const MAX_CLASS = 100;

//#region Byte strings

const encoder = new TextEncoder();

/** ASCII lower-case of one byte. */
export function foldByte(byte: number): number {
	return byte >= 65 && byte <= 90 ? byte + 32 : byte;
}

/** The folded UTF-8 bytes of `text`, one char per byte. */
export function toByteString(text: string): string {
	const bytes = encoder.encode(text);
	let out = '';
	for (let i = 0; i < bytes.length; i++) {
		out += String.fromCharCode(foldByte(bytes[i]));
	}
	return out;
}

function codePointBytes(code: number): string {
	return toByteString(String.fromCodePoint(code));
}

//#endregion

//#region Query algebra

function and(a: TrigramQuery, b: TrigramQuery): TrigramQuery {
	if (a.op === 'none' || b.op === 'none') {
		return NONE;
	}
	if (a.op === 'all') {
		return b;
	}
	if (b.op === 'all') {
		return a;
	}
	const sub = [...(a.op === 'and' ? a.sub : [a]), ...(b.op === 'and' ? b.sub : [b])];
	return { op: 'and', sub: dedupe(sub) };
}

function or(a: TrigramQuery, b: TrigramQuery): TrigramQuery {
	if (a.op === 'all' || b.op === 'all') {
		return ALL;
	}
	if (a.op === 'none') {
		return b;
	}
	if (b.op === 'none') {
		return a;
	}
	const sub = [...(a.op === 'or' ? a.sub : [a]), ...(b.op === 'or' ? b.sub : [b])];
	return { op: 'or', sub: dedupe(sub) };
}

function dedupe(sub: TrigramQuery[]): TrigramQuery[] {
	const seen = new Set<string>();
	return sub.filter(query => {
		const key = JSON.stringify(query);
		if (seen.has(key)) {
			return false;
		}
		seen.add(key);
		return true;
	});
}

/** The OR of the strings' phrases; nothing can be required when one is shorter than a trigram. */
function andStrings(query: TrigramQuery, strings: ReadonlySet<string>): TrigramQuery {
	if (!strings.size || minLen(strings) < 3) {
		return query;
	}
	let any: TrigramQuery = NONE;
	for (const text of strings) {
		any = or(any, { op: 'phrase', text });
	}
	return and(query, any);
}

//#endregion

//#region String sets

function minLen(set: ReadonlySet<string>): number {
	let min = Infinity;
	for (const text of set) {
		min = Math.min(min, text.length);
	}
	return set.size ? min : 0;
}

function union(a: ReadonlySet<string>, b: ReadonlySet<string>): Set<string> {
	return new Set([...a, ...b]);
}

function cross(a: ReadonlySet<string>, b: ReadonlySet<string>): Set<string> {
	const out = new Set<string>();
	for (const x of a) {
		for (const y of b) {
			out.add(x + y);
		}
	}
	return out;
}

/** Sorted (by reversed text for suffixes) with no string that extends another one. */
function trimSet(set: ReadonlySet<string>, isSuffix: boolean): Set<string> {
	const key = (text: string) => isSuffix ? [...text].reverse().join('') : text;
	const sorted = [...set].sort((a, b) => key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0);
	const out: string[] = [];
	for (const text of sorted) {
		const last = out[out.length - 1];
		if (last !== undefined && (isSuffix ? text.endsWith(last) : text.startsWith(last))) {
			continue;
		}
		out.push(text);
	}
	return new Set(out);
}

//#endregion

//#region Analysis

interface IInfo {
	canEmpty: boolean;
	/** Every string the node can match, when that set is small; otherwise undefined. */
	exact: Set<string> | undefined;
	prefix: Set<string>;
	suffix: Set<string>;
	match: TrigramQuery;
}

const anyChar = (): IInfo => ({ canEmpty: false, exact: undefined, prefix: new Set(['']), suffix: new Set(['']), match: ALL });
const anyMatch = (): IInfo => ({ canEmpty: true, exact: undefined, prefix: new Set(['']), suffix: new Set(['']), match: ALL });
const emptyString = (): IInfo => ({ canEmpty: true, exact: new Set(['']), prefix: new Set(), suffix: new Set(), match: ALL });
const noMatch = (): IInfo => ({ canEmpty: false, exact: undefined, prefix: new Set(), suffix: new Set(), match: NONE });
const exactly = (strings: Iterable<string>): IInfo => {
	const exact = new Set(strings);
	return { canEmpty: exact.has(''), exact, prefix: new Set(), suffix: new Set(), match: ALL };
};

function addExact(info: IInfo): void {
	if (info.exact) {
		info.match = andStrings(info.match, info.exact);
	}
}

function simplifySet(info: IInfo, which: 'prefix' | 'suffix'): void {
	const isSuffix = which === 'suffix';
	let set: Set<string> = new Set(info[which]);
	info.match = andStrings(info.match, set);
	for (let n = 2; n > 0 && set.size > MAX_SET; n--) {
		set = new Set([...set].map(text => text.length >= n ? (isSuffix ? text.slice(text.length - n) : text.slice(0, n)) : text));
	}
	info[which] = trimSet(set, isSuffix);
}

function simplify(info: IInfo, force: boolean): void {
	if (info.exact) {
		const min = minLen(info.exact);
		if (info.exact.size > MAX_EXACT || (min >= 3 && force) || min >= 4) {
			addExact(info);
			for (const text of info.exact) {
				if (text.length < 3) {
					info.prefix.add(text);
					info.suffix.add(text);
				} else {
					info.prefix.add(text.slice(0, 2));
					info.suffix.add(text.slice(text.length - 2));
				}
			}
			info.exact = undefined;
		}
	}
	if (!info.exact) {
		simplifySet(info, 'prefix');
		simplifySet(info, 'suffix');
	}
}

function concat(x: IInfo, y: IInfo): IInfo {
	const xy: IInfo = { canEmpty: x.canEmpty && y.canEmpty, exact: undefined, prefix: new Set(), suffix: new Set(), match: and(x.match, y.match) };
	if (x.exact && y.exact) {
		xy.exact = cross(x.exact, y.exact);
	} else {
		if (x.exact) {
			xy.prefix = cross(x.exact, y.prefix);
		} else {
			xy.prefix = x.canEmpty ? union(x.prefix, y.prefix) : new Set(x.prefix);
		}
		if (y.exact) {
			xy.suffix = cross(x.suffix, y.exact);
		} else {
			xy.suffix = y.canEmpty ? union(y.suffix, x.suffix) : new Set(y.suffix);
		}
	}
	// The join of x's end and y's start holds a trigram neither side accounted for yet.
	if (!x.exact && !y.exact && x.suffix.size <= MAX_SET && y.prefix.size <= MAX_SET && minLen(x.suffix) + minLen(y.prefix) >= 3) {
		xy.match = andStrings(xy.match, cross(x.suffix, y.prefix));
	}
	simplify(xy, false);
	return xy;
}

function alternate(x: IInfo, y: IInfo): IInfo {
	const xy: IInfo = { canEmpty: x.canEmpty || y.canEmpty, exact: undefined, prefix: new Set(), suffix: new Set(), match: NONE };
	if (x.exact && y.exact) {
		xy.exact = union(x.exact, y.exact);
	} else if (x.exact) {
		xy.prefix = union(x.exact, y.prefix);
		xy.suffix = union(x.exact, y.suffix);
		addExact(x);
	} else if (y.exact) {
		xy.prefix = union(x.prefix, y.exact);
		xy.suffix = union(x.suffix, y.exact);
		addExact(y);
	} else {
		xy.prefix = union(x.prefix, y.prefix);
		xy.suffix = union(x.suffix, y.suffix);
	}
	xy.match = or(x.match, y.match);
	simplify(xy, false);
	return xy;
}

//#endregion

//#region Parser

type Node =
	| { readonly t: 'lit'; readonly s: string }
	| { readonly t: 'set'; readonly strings: readonly string[] }
	| { readonly t: 'any' }
	| { readonly t: 'anyMatch' }
	| { readonly t: 'empty' }
	| { readonly t: 'cat'; readonly subs: readonly Node[] }
	| { readonly t: 'alt'; readonly subs: readonly Node[] }
	| { readonly t: 'rep'; readonly sub: Node; readonly min: number; readonly max: number };

class Unsupported extends Error { }

const DIGITS = '0123456789';
const WORD = 'abcdefghijklmnopqrstuvwxyz0123456789_';
const SPACE = ' \t\n\r\f\v';
const POSIX: Record<string, string | undefined> = {
	digit: DIGITS,
	lower: 'abcdefghijklmnopqrstuvwxyz',
	upper: 'abcdefghijklmnopqrstuvwxyz',
	alpha: 'abcdefghijklmnopqrstuvwxyz',
	alnum: 'abcdefghijklmnopqrstuvwxyz0123456789',
	word: WORD,
	xdigit: '0123456789abcdef',
	space: SPACE,
	blank: ' \t',
};

class Parser {
	private pos = 0;

	constructor(private readonly src: string, private readonly caseInsensitive: boolean) { }

	parse(): Node {
		const node = this.alternation();
		if (this.pos < this.src.length) {
			throw new Unsupported();
		}
		return node;
	}

	private peek(offset = 0): string {
		return this.src[this.pos + offset] ?? '';
	}

	private alternation(): Node {
		const subs = [this.sequence()];
		while (this.peek() === '|') {
			this.pos++;
			subs.push(this.sequence());
		}
		return subs.length === 1 ? subs[0] : { t: 'alt', subs };
	}

	private sequence(): Node {
		const subs: Node[] = [];
		while (this.pos < this.src.length && this.peek() !== '|' && this.peek() !== ')') {
			const atom = this.atom();
			subs.push(this.quantified(atom));
		}
		return subs.length === 1 ? subs[0] : subs.length ? { t: 'cat', subs } : { t: 'empty' };
	}

	private quantified(atom: Node): Node {
		let node = atom;
		for (; ;) {
			const c = this.peek();
			let min: number;
			let max: number;
			if (c === '*') {
				min = 0; max = Infinity; this.pos++;
			} else if (c === '+') {
				min = 1; max = Infinity; this.pos++;
			} else if (c === '?') {
				min = 0; max = 1; this.pos++;
			} else if (c === '{') {
				const m = /^\{(\d*)(?:(,)(\d*))?\}/.exec(this.src.slice(this.pos));
				if (!m || (m[1] === '' && !m[2])) {
					return node; // a literal brace
				}
				min = m[1] === '' ? 0 : Number(m[1]);
				max = m[2] ? (m[3] === '' ? Infinity : Number(m[3])) : min;
				this.pos += m[0].length;
			} else {
				return node;
			}
			// Lazy or possessive.
			if (this.peek() === '?' || this.peek() === '+') {
				this.pos++;
			}
			node = { t: 'rep', sub: node, min, max };
		}
	}

	private atom(): Node {
		const c = this.peek();
		switch (c) {
			case '(':
				return this.group();
			case '[':
				return this.charClass();
			case '.':
				this.pos++;
				return { t: 'any' };
			case '^':
			case '$':
				this.pos++;
				return { t: 'empty' };
			case '\\':
				return this.escape();
			default: {
				const code = this.src.codePointAt(this.pos)!;
				this.pos += code > 0xffff ? 2 : 1;
				return this.char(code);
			}
		}
	}

	private char(code: number): Node {
		if (code === 10) {
			// Searches run with --crlf: a newline in the pattern also matches \r\n.
			return { t: 'set', strings: ['\n', '\r\n'] };
		}
		if (code > 127 && this.caseInsensitive) {
			// Only ASCII is folded in the index; another case of this letter has other bytes.
			return { t: 'any' };
		}
		return { t: 'lit', s: codePointBytes(code) };
	}

	private group(): Node {
		this.pos++; // (
		let capture = true;
		if (this.peek() === '?') {
			const rest = this.src.slice(this.pos + 1);
			if (rest.startsWith(':')) {
				this.pos += 2;
			} else if (rest.startsWith('=') || rest.startsWith('!')) {
				this.pos += 2;
				capture = false;
			} else if (rest.startsWith('<=') || rest.startsWith('<!')) {
				this.pos += 3;
				capture = false;
			} else if (rest.startsWith('>')) {
				this.pos += 2;
			} else if (rest.startsWith('#')) {
				const end = this.src.indexOf(')', this.pos);
				if (end < 0) {
					throw new Unsupported();
				}
				this.pos = end + 1;
				return { t: 'empty' };
			} else {
				const named = /^(?:P?<([A-Za-z_]\w*)>|'([A-Za-z_]\w*)')/.exec(rest);
				if (named) {
					this.pos += 1 + named[0].length;
				} else {
					const flags = /^([a-zA-Z-]*)([:)])/.exec(rest);
					if (!flags) {
						throw new Unsupported();
					}
					if (flags[1].includes('x')) {
						throw new Unsupported(); // whitespace-insensitive patterns are not analyzed
					}
					this.pos += 1 + flags[0].length;
					if (flags[2] === ')') {
						return { t: 'empty' };
					}
				}
			}
		}
		const inner = this.alternation();
		if (this.peek() !== ')') {
			throw new Unsupported();
		}
		this.pos++;
		// A lookaround is zero-width; requiring nothing of it only widens the match.
		return capture ? inner : { t: 'empty' };
	}

	private escape(): Node {
		this.pos++; // backslash
		const c = this.peek();
		this.pos++;
		switch (c) {
			case 'd': return { t: 'set', strings: [...DIGITS] };
			case 'w': return { t: 'set', strings: [...WORD] };
			case 's': return { t: 'set', strings: [...SPACE] };
			case 'D': case 'W': case 'S': case 'N': case 'X': case 'C': case 'h': case 'H': case 'V':
				return { t: 'any' };
			case 'R':
				return { t: 'anyMatch' };
			case 'b': case 'B': case 'A': case 'z': case 'Z': case 'G': case '<': case '>': case 'K':
				return { t: 'empty' };
			case 'n': return this.char(10);
			case 't': return { t: 'lit', s: '\t' };
			case 'r': return { t: 'lit', s: '\r' };
			case 'f': return { t: 'lit', s: '\f' };
			case 'v': return { t: 'lit', s: '\v' };
			case 'a': return { t: 'lit', s: '\x07' };
			case 'e': return { t: 'lit', s: '\x1b' };
			case '0': return { t: 'lit', s: '\0' };
			case 'x':
			case 'u': {
				const code = this.hexEscape(c === 'x' ? 2 : 4);
				return code === undefined ? { t: 'any' } : this.char(code);
			}
			case 'p':
			case 'P':
				if (this.peek() === '{') {
					const end = this.src.indexOf('}', this.pos);
					this.pos = end < 0 ? this.src.length : end + 1;
				} else {
					this.pos++;
				}
				return { t: 'any' };
			case 'c':
				this.pos++;
				return { t: 'any' };
			case 'k':
				if (this.peek() === '<' || this.peek() === '{' || this.peek() === '\'') {
					const close = this.peek() === '<' ? '>' : this.peek() === '{' ? '}' : '\'';
					const end = this.src.indexOf(close, this.pos + 1);
					this.pos = end < 0 ? this.src.length : end + 1;
				}
				return { t: 'anyMatch' };
			case 'Q': {
				const end = this.src.indexOf('\\E', this.pos);
				const text = this.src.slice(this.pos, end < 0 ? undefined : end);
				this.pos = end < 0 ? this.src.length : end + 2;
				return text ? { t: 'cat', subs: [...text].map(ch => this.char(ch.codePointAt(0)!)) } : { t: 'empty' };
			}
			case '':
				throw new Unsupported();
			default:
				if (c >= '1' && c <= '9') {
					while (/\d/.test(this.peek())) {
						this.pos++;
					}
					return { t: 'anyMatch' }; // a backreference
				}
				return this.char(c.codePointAt(0)!);
		}
	}

	/** After `\x` or `\u`: `{hex}` or a fixed number of hex digits. */
	private hexEscape(digits: number): number | undefined {
		if (this.peek() === '{') {
			const end = this.src.indexOf('}', this.pos);
			if (end < 0) {
				throw new Unsupported();
			}
			const code = parseInt(this.src.slice(this.pos + 1, end), 16);
			this.pos = end + 1;
			return Number.isFinite(code) && code <= 0x10ffff ? code : undefined;
		}
		const hex = this.src.slice(this.pos, this.pos + digits);
		if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length !== digits) {
			return undefined;
		}
		this.pos += digits;
		return parseInt(hex, 16);
	}

	/** A bracket class; a negated, nested or large class is any one char. */
	private charClass(): Node {
		this.pos++; // [
		let negated = false;
		if (this.peek() === '^') {
			negated = true;
			this.pos++;
		}
		const members = new Set<number>();
		let wide = negated;
		let first = true;
		for (; ;) {
			if (this.pos >= this.src.length) {
				throw new Unsupported();
			}
			const c = this.peek();
			if (c === ']' && !first) {
				this.pos++;
				break;
			}
			first = false;
			if (c === '[') {
				const posix = /^\[:(\^?)([a-z]+):\]/.exec(this.src.slice(this.pos));
				if (posix) {
					this.pos += posix[0].length;
					const chars = POSIX[posix[2]];
					if (!chars || posix[1]) {
						wide = true;
					} else {
						for (const ch of chars) {
							members.add(ch.charCodeAt(0));
						}
					}
					continue;
				}
				// A nested class (set union in Rust and Java): skip it whole.
				let depth = 0;
				do {
					const ch = this.peek();
					if (ch === '\\') {
						this.pos++;
					} else if (ch === '[') {
						depth++;
					} else if (ch === ']') {
						depth--;
					}
					this.pos++;
				} while (depth > 0 && this.pos < this.src.length);
				wide = true;
				continue;
			}
			if ((c === '&' && this.peek(1) === '&') || (c === '-' && this.peek(1) === '-') || (c === '~' && this.peek(1) === '~')) {
				this.pos += 2;
				wide = true; // set operations
				continue;
			}
			const lo = this.classAtom(members);
			if (lo === undefined) {
				wide = true;
				continue;
			}
			if (lo >= 0 && this.peek() === '-' && this.peek(1) !== ']' && this.peek(1) !== '') {
				this.pos++;
				const hi = this.classAtom(members);
				if (hi === undefined || hi < 0 || hi < lo) {
					wide = true;
					continue;
				}
				if (hi - lo > MAX_CLASS) {
					wide = true;
					continue;
				}
				for (let code = lo; code <= hi; code++) {
					members.add(code);
				}
			} else if (lo >= 0) {
				members.add(lo);
			}
		}
		if (wide || members.size > MAX_CLASS) {
			return { t: 'any' };
		}
		const strings = new Set<string>();
		for (const code of members) {
			if (code > 127 && this.caseInsensitive) {
				return { t: 'any' };
			}
			if (code === 10) {
				strings.add('\n');
				strings.add('\r\n');
			} else {
				strings.add(codePointBytes(code));
			}
		}
		return strings.size ? { t: 'set', strings: [...strings] } : { t: 'any' };
	}

	/**
	 * One class member: its code point; -1 when it was a shorthand (already added to `members`);
	 * undefined when it stands for a set too large to list.
	 */
	private classAtom(members: Set<number>): number | undefined {
		const c = this.peek();
		if (c !== '\\') {
			const code = this.src.codePointAt(this.pos)!;
			this.pos += code > 0xffff ? 2 : 1;
			return code;
		}
		this.pos++;
		const e = this.peek();
		this.pos++;
		const addAll = (chars: string) => {
			for (const ch of chars) {
				members.add(ch.charCodeAt(0));
			}
			return -1;
		};
		switch (e) {
			case 'd': return addAll(DIGITS);
			case 'w': return addAll(WORD);
			case 's': return addAll(SPACE);
			case 'D': case 'W': case 'S': case 'p': case 'P': case 'h': case 'H': case 'V':
				if ((e === 'p' || e === 'P') && this.peek() === '{') {
					const end = this.src.indexOf('}', this.pos);
					this.pos = end < 0 ? this.src.length : end + 1;
				} else if (e === 'p' || e === 'P') {
					this.pos++;
				}
				return undefined;
			case 'n': return 10;
			case 't': return 9;
			case 'r': return 13;
			case 'f': return 12;
			case 'v': return 11;
			case 'a': return 7;
			case 'e': return 27;
			case 'b': return 8;
			case '0': return 0;
			case 'x':
			case 'u': return this.hexEscape(e === 'x' ? 2 : 4);
			case '':
				throw new Unsupported();
			default:
				return e.codePointAt(0)!;
		}
	}
}

function analyze(node: Node): IInfo {
	let info: IInfo;
	switch (node.t) {
		case 'lit':
			info = exactly([node.s]);
			break;
		case 'set':
			info = exactly(node.strings);
			break;
		case 'any':
			return anyChar();
		case 'anyMatch':
			return anyMatch();
		case 'empty':
			return emptyString();
		case 'cat':
			info = node.subs.map(analyze).reduce((acc, next) => concat(acc, next), emptyString());
			break;
		case 'alt': {
			const subs = node.subs.map(analyze);
			info = subs.length ? subs.slice(1).reduce((acc, next) => alternate(acc, next), subs[0]) : noMatch();
			break;
		}
		case 'rep': {
			if (node.max === 0) {
				return emptyString();
			}
			if (node.min === 0 && node.max === 1) {
				info = alternate(analyze(node.sub), emptyString());
				break;
			}
			if (node.min === 0) {
				return anyMatch();
			}
			// At least one copy: the prefixes and suffixes stay, exactness goes.
			info = analyze(node.sub);
			if (info.exact) {
				info.prefix = new Set(info.exact);
				info.suffix = new Set(info.exact);
				info.exact = undefined;
			}
			break;
		}
	}
	simplify(info, false);
	return info;
}

//#endregion

/** The trigram query of a regular expression (ripgrep, PCRE or JavaScript syntax). */
export function regexTrigramQuery(pattern: string, caseInsensitive: boolean): TrigramQuery {
	let node: Node;
	try {
		node = new Parser(pattern, caseInsensitive).parse();
	} catch {
		return ALL;
	}
	const info = analyze(node);
	simplify(info, true);
	addExact(info);
	return info.match;
}

/** The trigram query of a plain-text pattern. */
export function literalTrigramQuery(text: string, caseInsensitive: boolean): TrigramQuery {
	// Let the regex analysis handle newlines (\r\n) and non-ASCII under case folding.
	return regexTrigramQuery(text.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&'), caseInsensitive);
}

/** How many phrases a query needs; 0 means it rules nothing out. */
export function queryPhrases(query: TrigramQuery): number {
	switch (query.op) {
		case 'phrase': return 1;
		case 'and':
		case 'or': return query.sub.reduce((sum, sub) => sum + queryPhrases(sub), 0);
		default: return 0;
	}
}
