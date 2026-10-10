/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Cleanup of raw inline-completion output from chat and FIM models. Pure functions.
 * Pipeline: strip fences and special tokens -> drop echoes of the text before the cursor ->
 * stop where the block ends -> drop what already follows the cursor -> fit the line suffix ->
 * cap length. Empty result means "show nothing".
 */

import { CURSOR_MARKER } from './predictionPrompt.js';

const MAX_COMPLETION_LINES = 16;

/** End-of-text and fill-in-the-middle control tokens that FIM and chat models leak into replies. */
const SPECIAL_TOKENS = /<\|(?:fim_(?:prefix|suffix|middle|pad)|endoftext|end_of_text|file_separator|im_end|im_start|eot_id|end|cursor|editable_region_(?:start|end))\|>|<(?:fim_(?:prefix|suffix|middle)|fim-(?:prefix|suffix|middle)|PRE|SUF|MID|EOT)>|<\/s>/g;

/** A line suffix made only of closing punctuation, which a multi-line completion may wrap around. */
const CLOSERS_ONLY = /^[\s)\]}>"'`;,]*$/;

const OPENERS: Record<string, string> = { '(': ')', '[': ']', '{': '}' };
const CLOSERS = new Set([')', ']', '}']);

/** Takes the first markdown code fence if present; otherwise returns the raw text. */
export function stripFences(text: string): string {
	const wrapped = /^\s*```[^\n]*\n([\s\S]*?)\n?```\s*$/.exec(text);
	if (wrapped) {
		return wrapped[1];
	}
	const embedded = /```[^\n]*\n([\s\S]*?)\n?```/.exec(text);
	if (embedded) {
		return embedded[1];
	}
	// A reply cut off by the token cap may open a fence and never close it.
	const unterminated = /^\s*```[^\n]*\n([\s\S]*)$/.exec(text);
	return unterminated ? unterminated[1] : text;
}

/** Removes the cursor marker and FIM / end-of-text control tokens; output stops at an end token. */
export function stripSpecialTokens(text: string): string {
	const end = /<\|(?:endoftext|end_of_text|file_separator|im_end|eot_id|end)\|>|<EOT>|<\/s>/.exec(text);
	if (end) {
		text = text.slice(0, end.index);
	}
	return text.split(CURSOR_MARKER).join('').replace(SPECIAL_TOKENS, '');
}

/**
 * Ghost text must be code. Agents often answer in English ("There is no meaningful value...").
 * Those must never be inserted into the buffer.
 */
export function isProseCompletion(text: string): boolean {
	const t = text.trim();
	if (!t) {
		return false;
	}
	if (/^(there is|there are|there'?s|i |i'm|i cannot|i can't|sorry|unfortunately|no meaningful|cannot |can't |the code|this (is|would|does|doesn't)|as an ai|here is|here's|sure[,.!]|based on|it (looks|seems)|you (can|should)|to complete|the (completion|cursor|insertion))/i.test(t)) {
		return true;
	}
	const codeChars = (t.match(/[{}();=<>[\].]/g) ?? []).length;
	const words = t.split(/\s+/).filter(Boolean);
	if (words.length >= 8 && codeChars < 2) {
		return true;
	}
	if (/[.!?]\s+[A-Z]/.test(t) && codeChars < 3) {
		return true;
	}
	return false;
}

/**
 * Chat models often re-emit the tail of the prompt before continuing. Drop the longest
 * suffix of `linePrefix` that the completion starts with. A single shared character only
 * counts when it is whitespace: `foo` + `o()` is far more likely a real continuation.
 */
export function dedupePrefixOverlap(completion: string, linePrefix: string): string {
	for (let len = Math.min(linePrefix.length, completion.length); len > 0; len--) {
		const head = completion.slice(0, len);
		if (linePrefix.endsWith(head) && (len > 1 || /\s/.test(head))) {
			return completion.slice(len);
		}
	}
	return completion;
}

/**
 * The model restarted from an earlier line ("function f() {\n  return " was before the cursor
 * and the reply starts with it again). Drops that echo, with or without the original indentation.
 */
export function dedupeLineEcho(completion: string, prefix: string, linePrefix: string): string {
	if (!prefix || !completion.includes('\n') && !linePrefix.trim()) {
		return completion;
	}
	const lines = prefix.split('\n');
	let best = 0;
	// Echoes that start on one of the last few lines before the cursor, longest first.
	for (let back = Math.min(lines.length, 6); back >= 1; back--) {
		const tail = lines.slice(lines.length - back).join('\n');
		if (!tail.trim()) {
			continue;
		}
		for (const candidate of [tail, tail.trimStart()]) {
			if (candidate.trim().length >= 3 && completion.startsWith(candidate) && candidate.length > best) {
				best = candidate.length;
			}
		}
		if (best) {
			break;
		}
	}
	return best ? completion.slice(best) : completion;
}

/**
 * Stops a multi-line completion where the cursor's block ends: at a line indented less than the
 * cursor's line, or no deeper than it when the cursor's line opens a block (`def f():`, `{`). A
 * line of closers there (`}`, `});`, `end`) is kept, because it closes the block the completion is
 * in; anything else (the next function, a dedented Python statement) is not.
 */
export function trimToBlock(completion: string, linePrefix: string): string {
	if (!completion.includes('\n')) {
		return completion;
	}
	const base = indentWidth(/^[ \t]*/.exec(linePrefix)![0]);
	const lines = completion.split('\n');
	const opensBlock = /([:{([]|=>|\b(?:do|then))\s*$/.test(linePrefix + lines[0]);
	for (let i = 1; i < lines.length; i++) {
		const line = lines[i];
		if (!line.trim()) {
			continue;
		}
		const indent = indentWidth(/^[ \t]*/.exec(line)![0]);
		if (opensBlock ? indent > base : indent >= base) {
			continue;
		}
		const closes = /^\s*([)\]}]+[;,)]*|end\b.*|fi|done|esac|#?endif\b.*)\s*$/.test(line);
		return lines.slice(0, closes ? i + 1 : i).join('\n');
	}
	return completion;
}

/**
 * Drops trailing completion lines that the document already has right after the cursor's line
 * (the model re-wrote the closing brace that is already there), and drops a completion that is
 * nothing but the text after the cursor.
 */
export function trimSuffixOverlap(completion: string, suffix: string, lineSuffix: string): string {
	if (!suffix) {
		return completion;
	}
	const after = suffix.startsWith(lineSuffix) ? suffix.slice(lineSuffix.length) : suffix;
	const nextLines = after.replace(/^\n/, '').split('\n').map(line => line.trim()).filter(Boolean).slice(0, 8);
	if (!nextLines.length || !completion.includes('\n')) {
		return completion;
	}
	const lines = completion.replace(/\s+$/, '').split('\n');
	// Largest m: the completion's last m non-empty lines equal the next m non-empty lines.
	for (let m = Math.min(nextLines.length, lines.length - 1); m >= 1; m--) {
		const tail = lines.slice(-m).map(line => line.trim());
		if (!tail.every((line, i) => line === nextLines[i])) {
			continue;
		}
		// `}` matching the document's `}` is a duplicate only when nothing inside the completion opened
		// it; a balanced `if (x) { ... }` keeps its own brace. Other lines must be more than a keyword.
		const closersOnly = tail.every(line => /^[)\]}]+[;,)]*$/.test(line));
		if (closersOnly ? !unmatchedTail(completion) : tail.join('').length < 6) {
			continue;
		}
		return lines.slice(0, lines.length - m).join('\n');
	}
	return completion;
}

/**
 * Index of the first closer in `text` that closes a bracket opened before the cursor (it has no
 * opener inside `text`), or -1. Brackets inside string literals are skipped.
 */
export function firstUnmatchedCloser(text: string): number {
	const stack: string[] = [];
	let quote: string | undefined;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (quote) {
			if (ch === '\\') {
				i++;
			} else if (ch === quote || ch === '\n' && quote !== '`') {
				quote = undefined;
			}
			continue;
		}
		if (ch === '"' || ch === '\'' || ch === '`') {
			quote = ch;
		} else if (OPENERS[ch]) {
			stack.push(OPENERS[ch]);
		} else if (CLOSERS.has(ch)) {
			if (!stack.length) {
				return i;
			}
			if (stack[stack.length - 1] === ch) {
				stack.pop();
			}
		}
	}
	return -1;
}

/**
 * The closers at the end of `text` that close brackets opened before the cursor, with anything
 * that follows them. `a, b);` -> `);`, `a(b)` -> ``.
 */
export function unmatchedTail(text: string): string {
	const at = firstUnmatchedCloser(text);
	if (at < 0) {
		return '';
	}
	const tail = text.slice(at);
	return /^[)\]}\s;,]*$/.test(tail) ? tail : '';
}

/** True when the cursor sits inside a string literal that starts on its line. */
function insideString(linePrefix: string): boolean {
	let quote: string | undefined;
	for (let i = 0; i < linePrefix.length; i++) {
		const ch = linePrefix[i];
		if (quote) {
			if (ch === '\\') {
				i++;
			} else if (ch === quote) {
				quote = undefined;
			}
		} else if (ch === '"' || ch === '\'' || ch === '`') {
			quote = ch;
		}
	}
	return quote !== undefined;
}

/**
 * Fits a completion for insertion at the cursor when text follows on the same line.
 * - completion already ends with the line suffix -> trim it (the editor keeps the original);
 * - code after the cursor -> keep only the first line, since a pure insertion may not span the
 *   suffix (ghost-text range rule), and trim closers the suffix already has;
 * - a suffix of closers only (`)`, `});`) is left to {@link inlineEditForLine}, which can wrap a
 *   multi-line completion around it.
 */
export function fitToLineSuffix(completion: string, lineSuffix: string): string {
	const trimmedSuffix = lineSuffix.trim();
	if (!trimmedSuffix) {
		return completion;
	}
	const closersOnly = CLOSERS_ONLY.test(lineSuffix);
	if (!closersOnly) {
		const newline = completion.indexOf('\n');
		if (newline !== -1) {
			completion = completion.slice(0, newline);
		}
	}
	if (completion.trimEnd().endsWith(trimmedSuffix)) {
		return completion.slice(0, completion.lastIndexOf(trimmedSuffix));
	}
	if (!closersOnly) {
		const tail = unmatchedTail(completion);
		if (tail && trimmedSuffix.startsWith(tail.trim())) {
			return completion.slice(0, completion.length - tail.length);
		}
	}
	return completion;
}

export function capLines(text: string, maxLines = MAX_COMPLETION_LINES): string {
	const lines = text.split('\n');
	return lines.length <= maxLines ? text : lines.slice(0, maxLines).join('\n');
}

export interface IInlinePostProcessInput {
	raw: string;
	linePrefix: string;
	lineSuffix: string;
	/** Text before the cursor (the excerpt). Enables multi-line echo removal. */
	prefix?: string;
	/** Text after the cursor (the excerpt). Enables removal of lines the document already has. */
	suffix?: string;
}

/** Full inline pipeline. Returns undefined when nothing worth showing survives. */
export function postProcessInline({ raw, linePrefix, lineSuffix, prefix, suffix }: IInlinePostProcessInput): string | undefined {
	let text = stripSpecialTokens(stripFences(raw.replace(/\r\n/g, '\n')));
	// Models occasionally prefix with a stray newline when the cursor is mid-line.
	if (linePrefix.trim().length > 0) {
		text = text.replace(/^\n+/, '');
	}
	text = dedupeLineEcho(text, prefix ?? linePrefix, linePrefix);
	text = dedupePrefixOverlap(text, linePrefix);
	text = trimToBlock(text, linePrefix);
	text = trimSuffixOverlap(text, suffix ?? '', lineSuffix);
	text = fitToLineSuffix(text, lineSuffix);
	text = capLines(text.replace(/\s+$/, m => (m.includes('\n') ? '' : m)));
	if (!text.trim() || isProseCompletion(text) || text.trim() === lineSuffix.trim()) {
		return undefined;
	}
	// A blank first line with nothing after it would just add an empty line.
	if (!text.replace(/^[ \t]*\n/, '').trim()) {
		return undefined;
	}
	return text;
}

/** How the editor applies a cleaned completion on the cursor's line. */
export interface IInlineLineEdit {
	/** Text that replaces the range. */
	readonly insertText: string;
	/** True: the range runs from the cursor to the end of the line (the suffix is re-emitted inside `insertText`). */
	readonly replacesLineSuffix: boolean;
}

/**
 * How a cleaned completion goes onto the cursor's line. With only closers after the cursor
 * (`foo(|)`, `{|}`, `useEffect(() => {|});`) the completion may close them itself
 * (`a, b);`, `x > 0) {` + a body) or put a body inside them. Either way it replaces the rest of the
 * line, and every character of the old suffix appears in the new text in order, so the editor
 * still renders it as ghost text (insertions only) and nothing is closed twice.
 */
export function inlineEditForLine(completion: string, linePrefix: string, lineSuffix: string): IInlineLineEdit {
	if (!lineSuffix.trim() || !CLOSERS_ONLY.test(lineSuffix)) {
		return { insertText: completion, replacesLineSuffix: false };
	}
	let rest = lineSuffix;
	const from = insideString(linePrefix) ? -1 : firstUnmatchedCloser(completion);
	if (from >= 0) {
		// The suffix's characters, matched in order from the first bracket the completion closes.
		let at = from;
		let i = 0;
		for (; i < rest.length; i++) {
			const ch = rest[i];
			if (/\s/.test(ch)) {
				continue;
			}
			const found = completion.indexOf(ch, at);
			if (found < 0) {
				break;
			}
			at = found + 1;
		}
		rest = rest.slice(i);
	}
	if (!completion.includes('\n') && rest === lineSuffix) {
		return { insertText: completion, replacesLineSuffix: false };
	}
	if (from < 0 && completion.includes('\n')) {
		// A body between the brackets: the closers go back on their own line, at the line's indent.
		return { insertText: `${completion}\n${/^[ \t]*/.exec(linePrefix)![0]}${rest.trimStart()}`, replacesLineSuffix: true };
	}
	return { insertText: completion + rest, replacesLineSuffix: true };
}

function indentWidth(indent: string): number {
	let width = 0;
	for (const ch of indent) {
		width += ch === '\t' ? 4 : 1;
	}
	return width;
}
