/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Places text-anchored edits (`find` -> `replace`) in a document. Pure: text in, offsets out.
 * The occurrence nearest the cursor wins, so a repeated line resolves to the one being worked on.
 */

import { IRange } from '../../../../../editor/common/core/range.js';

export interface IAnchorMatch {
	/** Offset of the first replaced character. */
	readonly start: number;
	/** Offset after the last replaced character. */
	readonly end: number;
	/** The replacement, re-indented when the match ignored indentation. */
	readonly replacement: string;
}

/**
 * Exact match first. Otherwise the same lines with different indentation or trailing spaces
 * (models often normalize both); the replacement then takes the file's indentation.
 */
export function locateAnchor(text: string, find: string, replacement: string, nearOffset: number): IAnchorMatch | undefined {
	find = find.replace(/\r\n/g, '\n');
	replacement = replacement.replace(/\r\n/g, '\n');
	const exact = nearestOccurrence(text, find, nearOffset);
	if (exact !== undefined) {
		return { start: exact, end: exact + find.length, replacement };
	}
	return locateIgnoringIndent(text, find, replacement, nearOffset);
}

function nearestOccurrence(text: string, find: string, nearOffset: number): number | undefined {
	let best: number | undefined;
	let bestDistance = Number.POSITIVE_INFINITY;
	for (let at = text.indexOf(find); at !== -1; at = text.indexOf(find, at + 1)) {
		// Zero when the occurrence contains the cursor.
		const distance = at > nearOffset ? at - nearOffset : Math.max(0, nearOffset - (at + find.length));
		if (distance < bestDistance) {
			best = at;
			bestDistance = distance;
		}
	}
	return best;
}

function locateIgnoringIndent(text: string, find: string, replacement: string, nearOffset: number): IAnchorMatch | undefined {
	const findLines = find.replace(/\n+$/, '').split('\n').map(line => line.trim());
	if (!findLines.some(Boolean)) {
		return undefined;
	}
	const lines = text.split('\n');
	const starts: number[] = [];
	let offset = 0;
	for (const line of lines) {
		starts.push(offset);
		offset += line.length + 1;
	}
	let best: { line: number; distance: number } | undefined;
	for (let i = 0; i + findLines.length <= lines.length; i++) {
		if (!findLines.every((wanted, k) => lines[i + k].trim() === wanted)) {
			continue;
		}
		const distance = Math.abs(starts[i] - nearOffset);
		if (!best || distance < best.distance) {
			best = { line: i, distance };
		}
	}
	if (!best) {
		return undefined;
	}
	const first = lines[best.line];
	const last = best.line + findLines.length - 1;
	const fileIndent = /^\s*/.exec(first)![0];
	const modelIndent = /^\s*/.exec(find)![0];
	return {
		// Whole lines, without the line break after the last one.
		start: starts[best.line],
		end: starts[last] + lines[last].length,
		replacement: reindent(replacement, modelIndent, fileIndent),
	};
}

/** Swaps the model's base indentation for the file's on every line that starts with it. */
function reindent(text: string, from: string, to: string): string {
	if (from === to) {
		return text;
	}
	return text.split('\n').map(line => {
		if (!line.trim()) {
			return line;
		}
		return line.startsWith(from) ? to + line.slice(from.length) : to + line.trimStart();
	}).join('\n');
}

/** 1-based line/column of `offset` in `text`, for text that starts at `firstLineNumber`. */
export function positionAt(text: string, offset: number, firstLineNumber = 1): { lineNumber: number; column: number } {
	let line = firstLineNumber;
	let lineStart = 0;
	for (let i = text.indexOf('\n'); i !== -1 && i < offset; i = text.indexOf('\n', i + 1)) {
		line++;
		lineStart = i + 1;
	}
	return { lineNumber: line, column: offset - lineStart + 1 };
}

export function rangeAt(text: string, start: number, end: number, firstLineNumber = 1): IRange {
	const from = positionAt(text, start, firstLineNumber);
	const to = positionAt(text, end, firstLineNumber);
	return { startLineNumber: from.lineNumber, startColumn: from.column, endLineNumber: to.lineNumber, endColumn: to.column };
}
