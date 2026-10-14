/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { IVoltCodeIndexLine } from './voltCodeIndex.js';

/**
 * Matching candidate files in-process, line by line the way ripgrep reports them. Only patterns
 * whose meaning is the same in JavaScript and in ripgrep's regex engine run here: `\w \d \s \b`
 * and their negations are translated to the Unicode classes ripgrep means by them; anything else
 * (POSIX classes, `\p{...}` names, possessive quantifiers, inline flags mid-pattern) goes to
 * ripgrep with the candidate files, so results never depend on which engine ran.
 */

export interface IJsMatcher {
	/** Global + multiline: finds match starts in the whole text. */
	readonly whole: RegExp;
	/** The same pattern without `g`, for testing one line alone. */
	readonly line: RegExp;
	readonly multiline: boolean;
}

const UNSUPPORTED = [
	/\[\[:/, // POSIX classes
	/\\[AzZQEGKhHRXNCpPk]/, // engine-specific escapes and Unicode class names (spelled differently in JS)
	/\\[xu]\{/, // braced code points
	/[*+?}]\+/, // possessive quantifiers
	/\(\?>/, // atomic groups
	/\(\?#/, // comments
	/\(\?P>/, // recursion
];

/**
 * ripgrep's Unicode-aware classes (Rust regex, Unicode on), as JavaScript `u`-flag syntax. Rust's
 * `\w` is Alphabetic + Mark + Decimal_Number + Connector_Punctuation + Join_Control; `\d` is
 * Decimal_Number; `\s` is White_Space; `\b` is a boundary between `\w` and not `\w`.
 * JavaScript's own `\w \d \s \b` are ASCII (and `\s` a different set), hence the rewrite.
 */
const WORD = '\\p{Alphabetic}\\p{M}\\p{Nd}\\p{Pc}\\p{Join_Control}';
const OUTSIDE: Record<string, string> = {
	w: `[${WORD}]`,
	W: `[^${WORD}]`,
	d: '\\p{Nd}',
	D: '\\P{Nd}',
	s: '\\p{White_Space}',
	S: '\\P{White_Space}',
	b: `(?:(?<=[${WORD}])(?![${WORD}])|(?<![${WORD}])(?=[${WORD}]))`,
	B: `(?:(?<=[${WORD}])(?=[${WORD}])|(?<![${WORD}])(?![${WORD}]))`,
};
/** Inside `[...]`; `\W` has no in-class form without the `v` flag, and `\b` means backspace there. */
const INSIDE: Record<string, string> = {
	w: WORD,
	d: '\\p{Nd}',
	D: '\\P{Nd}',
	s: '\\p{White_Space}',
	S: '\\P{White_Space}',
};

/** Rewrites `\w \d \s \b` (and negations) to ripgrep's meaning; undefined when a use has no JS form. */
export function translateUnicodeClasses(source: string): string | undefined {
	let out = '';
	let inClass = false;
	for (let i = 0; i < source.length; i++) {
		const c = source[i];
		if (c === '\\') {
			const next = source[i + 1] ?? '';
			i++;
			if ('wWdDsSbB'.includes(next) && next) {
				const replacement = inClass ? INSIDE[next] : OUTSIDE[next];
				if (replacement === undefined) {
					return undefined;
				}
				out += replacement;
			} else {
				out += c + next;
			}
			continue;
		}
		if (c === '[' && !inClass) {
			inClass = true;
		} else if (c === ']' && inClass) {
			inClass = false;
		}
		out += c;
	}
	return out;
}

/** True when ripgrep's `-w` (match surrounded by non-word characters) equals `\b...\b` for this text. */
function wordEdged(text: string): boolean {
	const edge = /^[\p{Alphabetic}\p{M}\p{Nd}\p{Pc}\p{Join_Control}]$/u;
	const chars = [...text];
	return chars.length > 0 && edge.test(chars[0]) && edge.test(chars[chars.length - 1]);
}

/** Converts newlines in a pattern to `\r?\n` (outside classes), as ripgrep does with `--crlf`. */
function crlf(source: string): string {
	let out = '';
	let inClass = false;
	for (let i = 0; i < source.length; i++) {
		const c = source[i];
		if (c === '\\') {
			const next = source[i + 1] ?? '';
			if (!inClass && next === 'n') {
				out += '(?:\\r?\\n)';
			} else {
				out += c + next;
			}
			i++;
			continue;
		}
		if (c === '[') {
			inClass = true;
		} else if (c === ']') {
			inClass = false;
		} else if (c === '\n' && !inClass) {
			out += '(?:\\r?\\n)';
			continue;
		}
		out += c;
	}
	return out;
}

/** Character classes that nest or use set operations (Rust syntax) have no JS meaning. */
function hasRustClassSyntax(source: string): boolean {
	let inClass = false;
	for (let i = 0; i < source.length; i++) {
		const c = source[i];
		if (c === '\\') {
			i++;
			continue;
		}
		if (!inClass) {
			if (c === '[') {
				inClass = true;
				// `[]...]` and `[^]...]` start with a literal bracket in Rust, an empty class in JS.
				const start = source[i + 1] === '^' ? i + 2 : i + 1;
				if (source[start] === ']') {
					return true;
				}
			}
			continue;
		}
		if (c === '[') {
			return true;
		}
		if ((c === '&' || c === '-' || c === '~') && source[i + 1] === c) {
			return true;
		}
		if (c === ']') {
			inClass = false;
		}
	}
	return false;
}

/**
 * A JavaScript matcher with ripgrep's meaning, or undefined when the pattern must go to ripgrep.
 */
export function createJsMatcher(pattern: string, isRegExp: boolean, caseSensitive: boolean, multiline: boolean, wholeWord: boolean): IJsMatcher | undefined {
	// ripgrep's -w wraps the pattern in non-word-or-edge guards; for a literal that starts and
	// ends with a word character that is exactly `\b...\b`. Anything else stays with ripgrep.
	if (wholeWord && (isRegExp || !wordEdged(pattern))) {
		return undefined;
	}
	let source: string;
	let ignoreCase = !caseSensitive;
	let dotAll = false;
	if (isRegExp) {
		source = pattern;
		const lead = /^\(\?([imsx-]+)\)/.exec(source);
		if (lead) {
			if (lead[1].includes('x') || lead[1].includes('-')) {
				return undefined;
			}
			ignoreCase ||= lead[1].includes('i');
			dotAll = lead[1].includes('s');
			source = source.slice(lead[0].length);
		}
		if (UNSUPPORTED.some(re => re.test(source)) || /\(\?[a-zA-Z-]*[:)]/.test(source) || hasRustClassSyntax(source)) {
			return undefined;
		}
		source = source.replace(/\(\?P<([A-Za-z_]\w*)>/g, '(?<$1>').replace(/\(\?P=([A-Za-z_]\w*)\)/g, '\\k<$1>');
		const translated = translateUnicodeClasses(source);
		if (translated === undefined) {
			return undefined;
		}
		source = translated;
	} else {
		source = pattern.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
		if (wholeWord) {
			source = `${OUTSIDE.b}(?:${source})${OUTSIDE.b}`;
		}
	}
	const hasNewline = /\\n|\n/.test(source);
	if (hasNewline && !multiline) {
		return undefined; // ripgrep refuses a newline outside multiline mode
	}
	source = crlf(source);
	const flags = `mu${ignoreCase ? 'i' : ''}${dotAll ? 's' : ''}`;
	try {
		return { whole: new RegExp(source, `g${flags}`), line: new RegExp(source, flags), multiline };
	} catch {
		return undefined;
	}
}

export interface ITextMatches {
	readonly matches: number;
	readonly lines: IVoltCodeIndexLine[];
}

function clip(text: string, column: number, max: number): string {
	if (text.length <= max) {
		return text;
	}
	// Keep the match in view on long (often minified) lines.
	const start = column > max - 100 ? Math.max(0, column - 100) : 0;
	return `${start > 0 ? '\u2026' : ''}${text.slice(start, start + max)}\u2026`;
}

/**
 * Matching lines of `text` (at most `budget` of them), with `context` lines around each, the
 * way ripgrep reports them: in line mode a match never spans lines; in multiline mode a match
 * is reported on the line it starts on.
 */
export function matchText(text: string, matcher: IJsMatcher, context: number, budget: number, maxLineChars: number): ITextMatches {
	const found: { line: number; start: number; end: number; column: number }[] = [];
	const re = matcher.whole;
	let lineNo = 1;
	let lineStart = 0;
	let pos = 0;
	while (pos <= text.length && found.length < budget) {
		re.lastIndex = pos;
		const m = re.exec(text);
		if (!m) {
			break;
		}
		const at = m.index;
		for (let nl = text.indexOf('\n', lineStart); nl >= 0 && nl < at; nl = text.indexOf('\n', lineStart)) {
			lineNo++;
			lineStart = nl + 1;
		}
		let lineEnd = text.indexOf('\n', at);
		if (lineEnd < 0) {
			lineEnd = text.length;
		}
		const contentEnd = lineEnd > lineStart && text.charCodeAt(lineEnd - 1) === 13 ? lineEnd - 1 : lineEnd;
		let ok = true;
		if (!matcher.multiline && at + m[0].length > lineEnd) {
			// The match ran past the line; ripgrep only sees one line at a time.
			matcher.line.lastIndex = 0;
			ok = matcher.line.test(text.slice(lineStart, contentEnd));
		}
		if (ok) {
			found.push({ line: lineNo, start: lineStart, end: contentEnd, column: at - lineStart });
		}
		// One report per line; a multiline match resumes after its end, as ripgrep does.
		pos = matcher.multiline ? Math.max(lineEnd + 1, at + m[0].length) : lineEnd + 1;
	}
	if (!found.length) {
		return { matches: 0, lines: [] };
	}
	if (!context) {
		return { matches: found.length, lines: found.map(hit => ({ line: hit.line, text: clip(text.slice(hit.start, hit.end), hit.column, maxLineChars), match: true })) };
	}
	const all = text.split('\n');
	const out = new Map<number, IVoltCodeIndexLine>();
	for (const hit of found) {
		for (let line = Math.max(1, hit.line - context); line <= Math.min(all.length, hit.line + context); line++) {
			if (line === hit.line) {
				out.set(line, { line, text: clip(text.slice(hit.start, hit.end), hit.column, maxLineChars), match: true });
			} else if (!out.has(line)) {
				out.set(line, { line, text: clip(all[line - 1].replace(/\r$/, ''), 0, maxLineChars), match: false });
			}
		}
	}
	return { matches: found.length, lines: [...out.values()].sort((a, b) => a.line - b.line) };
}
