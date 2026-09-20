/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

const MAX_LINES = 2000;
const MAX_CHARS = 50_000;

export interface ITruncatedText {
	readonly text: string;
	readonly truncated: boolean;
	readonly totalLines: number;
	readonly shownLines: number;
}

/**
 * Head truncation that tells the model how to page. Line numbers are `N | ` so later edits can
 * cite them. The 20/80 head/tail split is for command output, where the failure is usually at
 * the end.
 */
export function addLineNumbers(text: string, startLine = 1): string {
	const lines = text.split('\n');
	const width = String(startLine + lines.length - 1).length;
	return lines.map((line, i) => `${String(startLine + i).padStart(width, ' ')} | ${line}`).join('\n');
}

export function truncateHead(text: string, maxLines = MAX_LINES, maxChars = MAX_CHARS): ITruncatedText {
	const lines = text.split('\n');
	let shown = lines;
	let truncated = false;
	if (shown.length > maxLines) {
		shown = shown.slice(0, maxLines);
		truncated = true;
	}
	let out = shown.join('\n');
	if (out.length > maxChars) {
		out = out.slice(0, maxChars);
		truncated = true;
		shown = out.split('\n');
	}
	if (truncated) {
		out += `\n\n[Showing ${shown.length} of ${lines.length} lines. Re-read with offset=${shown.length + 1} to continue.]`;
	}
	return { text: out, truncated, totalLines: lines.length, shownLines: shown.length };
}

/** Keep 20% of the head and 80% of the tail so compile errors at the end survive. */
export function truncateHeadTail(text: string, maxChars = MAX_CHARS): ITruncatedText {
	if (text.length <= maxChars) {
		const lines = text.split('\n');
		return { text, truncated: false, totalLines: lines.length, shownLines: lines.length };
	}
	const head = Math.max(200, Math.floor(maxChars * 0.2));
	const tail = maxChars - head;
	const omitted = text.length - head - tail;
	const out = `${text.slice(0, head)}\n\n[... ${omitted} characters omitted ...]\n\n${text.slice(-tail)}`;
	const lines = text.split('\n');
	return { text: out, truncated: true, totalLines: lines.length, shownLines: out.split('\n').length };
}

export function stringifyUnknown(value: unknown): string {
	if (value === undefined || value === null) {
		return '';
	}
	if (typeof value === 'string') {
		return value;
	}
	try {
		return JSON.stringify(value, undefined, 2);
	} catch {
		return String(value);
	}
}
