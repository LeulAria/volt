/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * What of a composer draft decides the composer's layout other than its height: whether it is empty
 * (a resized composer goes back to its size, the placeholder shows) and whether it has several lines
 * (the follow-up pill opens into the full composer). A keystroke that keeps the shape and the
 * draft's height needs no layout.
 */
export function composerDraftShape(value: string): string {
	return `${value.trim() ? 'text' : 'empty'}:${value.includes('\n') ? 'lines' : 'line'}`;
}

/**
 * `text` with its whitespace runs made one space, trimmed, and cut to `max` characters (with `...`
 * when cut): the conversation lines the composer's ghost text reads. It runs on every keystroke,
 * over replies that can be tens of thousands of characters while they stream, so it reads only as
 * much of the text as the cut needs.
 */
export function clipForPrediction(text: string, max: number): string {
	for (let end = max * 2 + 16; end < text.length; end *= 2) {
		const head = clippedHead(text.slice(0, end), max);
		if (head !== undefined) {
			return head;
		}
	}
	const flat = text.replace(/\s+/g, ' ').trim();
	return flat.length <= max ? flat : `${flat.slice(0, max)}...`;
}

/** {@link clipForPrediction} of `pieces` joined, reading only the pieces the cut needs. */
export function clipPiecesForPrediction(pieces: Iterable<string>, max: number): string {
	let text = '';
	let next = max * 2 + 16;
	for (const piece of pieces) {
		text += piece;
		if (text.length >= next) {
			next = text.length * 2;
			const head = clippedHead(text, max);
			if (head !== undefined) {
				return head;
			}
		}
	}
	return clipForPrediction(text, max);
}

/**
 * The cut of a whole text from a prefix of it, when the prefix decides it: whitespace runs leave no
 * two spaces in a row, so two flattened characters past the cut hold a letter, the trimmed whole
 * runs past `max` too, and its first `max` characters are the prefix's.
 */
function clippedHead(prefix: string, max: number): string | undefined {
	const flat = prefix.replace(/\s+/g, ' ').trimStart();
	return flat.length >= max + 2 ? `${flat.slice(0, max)}...` : undefined;
}

/** The last `count` lines of `text` after its trailing whitespace, as `split('\n').slice(-count)` gives them, without splitting the whole text. */
export function lastLines(text: string, count: number): string {
	const trimmed = text.trimEnd();
	let start = trimmed.length;
	for (let i = 0; i < count; i++) {
		if (start <= 0) {
			return trimmed;
		}
		start = trimmed.lastIndexOf('\n', start - 1);
		if (start < 0) {
			return trimmed;
		}
	}
	return trimmed.slice(start + 1);
}
