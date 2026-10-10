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

import { CURSOR_MARKER, hasCodeAfter, InlineWriting, OPENS_BLOCK } from './predictionPrompt.js';

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
/** The prompts ask for `<insert>...</insert>`: only what is between the tags is text. */
const INSERT_TAG = /<insert>([\s\S]*?)(?:<\/insert>|$)/;

/** A tool call written out as text (`<parameter name="x">`): not code or prose, whatever the prompt said. */
const TOOL_CALL_JUNK = /<\/?(?:antml:)?(?:parameter|invoke|function_calls|tool_call|tool_use)\b/i;

/**
 * The text between the insert tags, spaces and line breaks kept (an agent CLI trims an untagged
 * reply, which glued `return` and `a + b` into `returna + b`), or undefined when there are no tags.
 */
export function taggedInsert(text: string): string | undefined {
	return INSERT_TAG.exec(text)?.[1];
}

/** Whether the model answered with a tool call instead of text. */
export function isToolCallJunk(text: string): boolean {
	return TOOL_CALL_JUNK.test(text);
}

export function stripSpecialTokens(text: string): string {
	// Agent CLIs (`claude -p`) leak their own reminders into the reply, and models copy the tag.
	text = text.replace(/<system-reminder>[\s\S]*?(?:<\/system-reminder>|$)/g, '');
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
const ANSWER_NOTE = /^[([]\s*(nothing to |no (completion|insertion|code|change|continuation)s?\b|empty (reply|completion|insertion)\b)/i;

/** A reply about the task, not the text to insert. Prose is fine where the user writes prose; this never is. */
const META_REPLY = /^(sure[,!.]|okay[,!.]|here('s| is| are) (the|your|a)\b|as an ai\b|i (can't|cannot|can not) (help|complete|continue)\b|nothing to (insert|complete|add|continue)\b|no (completion|insertion|continuation) (is )?(needed|required|possible)\b|the (cursor|completion|insertion) (is|would|should)\b)/i;

/**
 * "(Nothing to insert: ...)", "[No completion]", "Sure, here is...": a note about the answer, not
 * the answer. Also after a line of real text: "Three\n(Nothing to insert: ...)".
 */
export function isAnswerNote(text: string): boolean {
	const t = text.trim();
	return META_REPLY.test(t) || TASK_TALK.test(t) || t.split('\n').some(line => ANSWER_NOTE.test(line.trim()));
}

/** A refusal or an aside about the autocomplete itself ("I'm not going to continue that text, since..."). */
const TASK_TALK = /\b(cursor marker|system (prompt|setup|reminder)|happy to help|as an (ai|assistant|autocomplete)|act as an? (autocomplete|assistant))\b|\bcontinu(e|es|ing) the (line|text|sentence|document|draft|paragraph|writing)\b|<\|cursor\|>|^i('m| am) (not going to|unable to|not able to)\b|\bi (can't|cannot|won't|will not) (continue|complete) (this|that|the)\b/i;

export function isProseCompletion(text: string): boolean {
	const t = text.trim();
	if (!t) {
		return false;
	}
	if (isAnswerNote(t)) {
		return true;
	}
	if (/^(nothing to (insert|complete|add)|no (completion|insertion) (is )?(needed|required|possible)|there is|there are|there'?s|i |i'm|i cannot|i can't|sorry|unfortunately|no meaningful|cannot |can't |the code|this (is|would|does|doesn't)|as an ai|here is|here's|sure[,.!]|based on|it (looks|seems)|you (can|should)|to complete|the (completion|cursor|insertion))/i.test(t)) {
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
	const opensBlock = OPENS_BLOCK.test(linePrefix + lines[0]);
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

/** A model stuck in a loop writes the same line again and again: one copy of the run stays. */
export function cutRepetition(text: string): string {
	const lines = text.split('\n');
	for (let i = 2; i < lines.length; i++) {
		if (lines[i].trim() && lines[i] === lines[i - 1] && lines[i] === lines[i - 2]) {
			return lines.slice(0, i - 1).join('\n');
		}
	}
	return text;
}

/**
 * A streamed code reply cut after its first line, when that line is all that can be used: code
 * follows the cursor, or the line ends a statement that opens no block. Undefined while the first
 * line is still coming, when more lines are wanted, or while the reply may still be repeating the
 * lines above the cursor (the echo is dropped later, and the real text comes after it).
 */
export function firstLineOnly(raw: string, prefix: string, linePrefix: string, lineSuffix: string): string | undefined {
	if (!linePrefix.trim()) {
		return undefined;
	}
	const text = stripSpecialTokens(raw.replace(/\r\n/g, '\n'));
	// Tagged replies only: before the tag (a preamble, a fence) nothing tells where the code starts.
	let start = /^\s*<insert>/.exec(text)?.[0].length;
	if (start === undefined) {
		return undefined;
	}
	while (text[start] === '\n') {
		start++;
	}
	const end = text.indexOf('\n', start);
	if (end < 0) {
		return undefined;
	}
	const line = text.slice(start, end);
	if (!line.trim() || line.includes('</insert>') || /^\s*```/.test(line)) {
		return undefined;
	}
	const echo = line.trim();
	if (echo.length >= 3 && prefix.split('\n').slice(-7, -1).some(above => above.trim() === echo)) {
		return undefined;
	}
	if (!hasCodeAfter(lineSuffix) && OPENS_BLOCK.test(linePrefix + line)) {
		return undefined;
	}
	return text.slice(0, end);
}

/**
 * The text a reply has inserted so far, cleaned the way the finished reply will be, for checking
 * the typing against it while it streams. Undefined while it may still be an echo of the code
 * above the cursor (nothing can be judged yet).
 */
export function partialInsertText(raw: string, prefix: string, linePrefix: string): string | undefined {
	const reply = stripSpecialTokens(raw.replace(/\r\n/g, '\n'));
	let text = taggedInsert(reply) ?? reply.replace(/^\s*```[^\n]*\n/, '');
	if (linePrefix.trim()) {
		text = text.replace(/^\n+/, '');
	}
	// A reply that so far is the start of a line above (or of the cursor's own line) may be an echo.
	const lead = text.trimStart();
	if (!lead || prefix.split('\n').slice(-6).some(line => line.trimStart().startsWith(lead))) {
		return undefined;
	}
	return dedupePrefixOverlap(dedupeLineEcho(text, prefix, linePrefix), linePrefix);
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
	/** Code (default), or writing: a Markdown or text document, or a comment in code. */
	writing?: InlineWriting;
}

/** Full inline pipeline. Returns undefined when nothing worth showing survives. */
export function postProcessInline({ raw, linePrefix, lineSuffix, prefix, suffix, writing = 'code' }: IInlinePostProcessInput): string | undefined {
	if (writing !== 'code') {
		// Markdown has fences of its own: they stay.
		return postProcessWriting(stripSpecialTokens(raw.replace(/\r\n/g, '\n')), linePrefix, lineSuffix, prefix, suffix, writing);
	}
	const reply = stripSpecialTokens(raw.replace(/\r\n/g, '\n'));
	let text = stripFences(taggedInsert(reply) ?? reply);
	if (isToolCallJunk(text)) {
		return undefined;
	}
	// Models occasionally prefix with a stray newline when the cursor is mid-line.
	if (linePrefix.trim().length > 0) {
		text = text.replace(/^\n+/, '');
	}
	text = dedupeLineEcho(text, prefix ?? linePrefix, linePrefix);
	text = dedupePrefixOverlap(text, linePrefix);
	text = trimToBlock(text, linePrefix);
	text = cutRepetition(text);
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

/**
 * Writing (Markdown, plain text, a comment): English is the point here, so only notes about the
 * answer are refused. No indentation-based block rules; the reply is one line and one sentence.
 */
function postProcessWriting(text: string, linePrefix: string, lineSuffix: string, prefix: string | undefined, suffix: string | undefined, writing: 'prose' | 'comment'): string | undefined {
	// The prompt asks for <insert>...</insert>: whatever the model says around it is not text.
	const tagged = taggedInsert(text);
	if (tagged !== undefined) {
		// A `<br>` on a line of its own is an HTML line break, not text.
		text = tagged.replace(/^[ \t]*<br\s*\/?>[ \t]*$/gim, '');
	} else {
		// Untagged: a fence around the whole reply is wrapping, not text.
		text = /^\s*```[^\n]*\n([\s\S]*?)\n?```\s*$/.exec(text)?.[1] ?? text;
	}
	// A line break first is a stray mid-sentence or on an empty line; after a finished line
	// (`Three|` -> `\nFour`) it starts the next one.
	if (writing === 'comment' || !linePrefix.trim() || /\s$/.test(linePrefix)) {
		text = text.replace(/^\n+/, '');
	}
	text = dedupeLineEcho(text, prefix ?? linePrefix, linePrefix);
	text = dedupePrefixOverlap(text, linePrefix);
	if (/\S\s$/.test(linePrefix)) {
		text = text.replace(/^[ \t]+/, '');
	}
	text = dropRestartedSentence(text, linePrefix);
	// The line's last words said again (`Three` -> ` Three`).
	const said = linePrefix.trim().toLowerCase();
	const reply = text.trim().toLowerCase();
	const at = said.length - reply.length;
	if (reply && said.endsWith(reply) && (at === 0 || !/[\p{L}\p{N}_]/u.test(said[at - 1]))) {
		return undefined;
	}
	text = trimSuffixOverlap(text, suffix ?? '', lineSuffix);
	text = fitToLineSuffix(text, lineSuffix);
	const line = oneLine(text, prefix ?? linePrefix, writing);
	if (line === undefined) {
		return undefined;
	}
	text = line;
	// One sentence at a time, like the composer: a second one is a guess on a guess.
	const sentence = /^[^\n]*?\S[.!?]["')\]]?(?=[ \t]+\S)/.exec(text);
	if (sentence) {
		text = sentence[0];
	}
	text = text.replace(/\s+$/, m => (m.includes('\n') ? '' : m));
	if (!text.trim() || isAnswerNote(text) || text.trim() === lineSuffix.trim()) {
		return undefined;
	}
	// Code symbols after a line of plain words (`that` -> ` ' ' + 'the' ...`) are a confused reply.
	if (writing === 'prose' && !/[{};=+<>`|\\]/.test(linePrefix) && (text.match(/[{};=+<>|\\]|' '|" "/g) ?? []).length >= 2) {
		return undefined;
	}
	return text;
}

/**
 * The writing reply is a line break and nothing else: the model says the line is finished but
 * not what comes next.
 */
export function repliedLineBreakOnly(raw: string): boolean {
	const text = stripSpecialTokens(raw.replace(/\r\n/g, '\n'));
	const inner = /<insert>([\s\S]*?)(?:<\/insert>|$)/.exec(text)?.[1] ?? text;
	return inner.includes('\n') && !inner.replace(/<br\s*\/?>/gi, '').trim();
}

/**
 * One line: the rest of this one, or (after a finished line) the next one. In lines written one
 * under another, the next line follows directly, without the blank line a model may put first. A
 * code fence is all or nothing.
 */
function oneLine(text: string, prefix: string, writing: 'prose' | 'comment'): string | undefined {
	const lines = text.split('\n');
	if (writing === 'comment') {
		return lines[0];
	}
	const breaks = lines.findIndex(line => line.trim());
	if (breaks < 0) {
		return '';
	}
	const lead = breaks > 1 && !/\n[ \t]*\n/.test(prefix.slice(-300)) ? '\n' : '\n'.repeat(breaks);
	if (/^\s*```/.test(lines[breaks])) {
		const close = lines.findIndex((line, i) => i > breaks && /^\s*```\s*$/.test(line));
		return close > 0 && close - breaks <= 8 ? lead + lines.slice(breaks, close + 1).join('\n') : undefined;
	}
	return lead + lines[breaks];
}

/**
 * The reply starts the sentence over and catches up with the line (`...editor that` ->
 * ` AI-powered code editor that helps you`): only what comes after the line's last three words.
 */
function dropRestartedSentence(text: string, linePrefix: string): string {
	const words = linePrefix.trim().split(/\s+/);
	if (words.length < 3) {
		return text;
	}
	const tail = words.slice(-3).map(word => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+');
	const match = new RegExp(`${tail}(?![\\p{L}\\p{N}])`, 'iu').exec(text);
	return match && match.index <= 60 ? text.slice(match.index + match[0].length) : text;
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
