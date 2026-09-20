/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Cleanup of raw inline-completion output from chat models. Pure functions.
 * Pipeline: strip fences -> strip cursor echoes -> dedupe prefix overlap -> fit against the
 * line suffix -> cap length. Empty result means "show nothing".
 */

import { CURSOR_MARKER } from './predictionPrompt.js';

const MAX_COMPLETION_LINES = 16;

/** Takes the first markdown code fence if present; otherwise returns the raw text. */
export function stripFences(text: string): string {
	const wrapped = /^\s*```[^\n]*\n([\s\S]*?)\n?```\s*$/.exec(text);
	if (wrapped) {
		return wrapped[1];
	}
	const embedded = /```[^\n]*\n([\s\S]*?)\n?```/.exec(text);
	return embedded ? embedded[1] : text;
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
	if (/^(there is|there are|there'?s|i |i'm|i cannot|i can't|sorry|unfortunately|no meaningful|cannot |can't |the code|this (is|would|does|doesn't)|as an ai|here is|sure[,.])/i.test(t)) {
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
 * suffix of `linePrefix` that the completion starts with.
 */
export function dedupePrefixOverlap(completion: string, linePrefix: string): string {
	for (let len = Math.min(linePrefix.length, completion.length); len > 0; len--) {
		if (linePrefix.endsWith(completion.slice(0, len))) {
			return completion.slice(len);
		}
	}
	return completion;
}

/**
 * Fits a completion for insertion at the cursor when text follows on the same line.
 * - completion already ends with the line suffix -> trim it (the editor keeps the original);
 * - multiline completion with a non-empty line suffix -> keep only the first line, since a
 *   pure insertion may not span the suffix (ghost-text range rule).
 */
export function fitToLineSuffix(completion: string, lineSuffix: string): string {
	const trimmedSuffix = lineSuffix.trimEnd();
	if (trimmedSuffix.length > 0) {
		const newline = completion.indexOf('\n');
		if (newline !== -1) {
			completion = completion.slice(0, newline);
		}
		if (completion.trimEnd().endsWith(trimmedSuffix)) {
			completion = completion.slice(0, completion.lastIndexOf(trimmedSuffix));
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
}

/** Full inline pipeline. Returns undefined when nothing worth showing survives. */
export function postProcessInline({ raw, linePrefix, lineSuffix }: IInlinePostProcessInput): string | undefined {
	let text = stripFences(raw.replace(/\r\n/g, '\n'));
	text = text.split(CURSOR_MARKER).join('');
	// Models occasionally prefix with a stray newline when the cursor is mid-line.
	if (linePrefix.trim().length > 0) {
		text = text.replace(/^\n+/, '');
	}
	text = dedupePrefixOverlap(text, linePrefix);
	text = fitToLineSuffix(text, lineSuffix);
	text = capLines(text.replace(/\s+$/, m => (m.includes('\n') ? '' : m)));
	if (!text.trim() || isProseCompletion(text)) {
		return undefined;
	}
	return text;
}
