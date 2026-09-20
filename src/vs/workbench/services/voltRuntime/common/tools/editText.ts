/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export interface IExactEdit {
	readonly oldString: string;
	readonly newString: string;
}

export type IEditTextResult =
	| { readonly text: string; readonly replacements: number; readonly fuzzy?: number }
	| { readonly error: string };

/** Below this similarity we refuse to guess (Roo multi-search-replace). */
const FUZZY_THRESHOLD = 0.84;
const FUZZY_GAP = 0.08;
const FUZZY_MAX_CHARS = 200_000;

/**
 * Exact search/replace against the original file. Ambiguous matches fail instead of guessing,
 * so the model has to tighten the old_string. Empty old_string is a create/overwrite of the
 * whole file only when the file is empty.
 *
 * When the exact string is missing, a unique high-similarity line window (middle-out) may
 * still apply. That recovery is reported via `fuzzy` so the model can see it guessed.
 */
export function applyExactEdits(original: string, edits: readonly IExactEdit[]): IEditTextResult {
	if (!edits.length) {
		return { error: 'No edits were provided. Pass old_string and new_string, or an edits array.' };
	}
	let text = original;
	let replacements = 0;
	let fuzzy = 0;
	for (const edit of edits) {
		if (!edit.oldString) {
			if (text.length) {
				return { error: 'old_string is empty. That is only allowed when the file is empty; otherwise pass the exact text to replace.' };
			}
			text = edit.newString;
			replacements++;
			continue;
		}
		const count = countOccurrences(text, edit.oldString);
		if (count === 1) {
			text = text.replace(edit.oldString, edit.newString);
			replacements++;
			continue;
		}
		if (count > 1) {
			return { error: `old_string matched ${count} times. Include more surrounding lines so the replacement is unique.` };
		}
		const recovered = findFuzzyMatch(text, edit.oldString);
		if (!recovered) {
			return { error: `old_string was not found in the file. It must match exactly, including whitespace. First 120 characters of the file:\n${original.slice(0, 120)}` };
		}
		text = text.slice(0, recovered.start) + edit.newString + text.slice(recovered.start + recovered.length);
		replacements++;
		fuzzy++;
	}
	return { text, replacements, ...(fuzzy ? { fuzzy } : {}) };
}

/**
 * Middle-out window search. Starts at the midpoint of the file so a near-match in
 * the middle of a large buffer is found without scanning every line first.
 */
export function findFuzzyMatch(haystack: string, needle: string): { start: number; length: number; score: number } | undefined {
	if (!needle || haystack.length > FUZZY_MAX_CHARS) {
		return undefined;
	}
	const hayLines = haystack.split('\n');
	const needleLines = needle.split('\n');
	if (!needleLines.length || needleLines.length > hayLines.length) {
		return undefined;
	}
	const mid = Math.floor((hayLines.length - needleLines.length) / 2);
	let best: { startLine: number; score: number } | undefined;
	let second = 0;
	const tryWindow = (startLine: number) => {
		if (startLine < 0 || startLine + needleLines.length > hayLines.length) {
			return;
		}
		const score = windowScore(hayLines.slice(startLine, startLine + needleLines.length), needleLines);
		if (!best || score > best.score) {
			second = best?.score ?? 0;
			best = { startLine, score };
		} else if (score > second) {
			second = score;
		}
	};
	for (let offset = 0; offset <= hayLines.length; offset++) {
		if (offset === 0) {
			tryWindow(mid);
			continue;
		}
		tryWindow(mid + offset);
		tryWindow(mid - offset);
	}
	if (!best || best.score < FUZZY_THRESHOLD || (second >= FUZZY_THRESHOLD && best.score - second < FUZZY_GAP)) {
		return undefined;
	}
	const start = hayLines.slice(0, best.startLine).join('\n').length + (best.startLine > 0 ? 1 : 0);
	const length = hayLines.slice(best.startLine, best.startLine + needleLines.length).join('\n').length;
	return { start, length, score: best.score };
}

function countOccurrences(haystack: string, needle: string): number {
	if (!needle) {
		return 0;
	}
	let count = 0;
	let from = 0;
	while (from <= haystack.length) {
		const at = haystack.indexOf(needle, from);
		if (at < 0) {
			break;
		}
		count++;
		from = at + needle.length;
	}
	return count;
}

function windowScore(window: readonly string[], needle: readonly string[]): number {
	if (window.length !== needle.length) {
		return 0;
	}
	let total = 0;
	for (let i = 0; i < window.length; i++) {
		total += similarity(normalizeQuotes(window[i]), normalizeQuotes(needle[i]));
	}
	return total / window.length;
}

function similarity(a: string, b: string): number {
	if (a === b) {
		return 1;
	}
	const max = Math.max(a.length, b.length);
	if (!max) {
		return 1;
	}
	if (Math.abs(a.length - b.length) / max > 0.4) {
		return 0;
	}
	return 1 - levenshtein(a, b) / max;
}

function normalizeQuotes(text: string): string {
	return text.replace(/[\u201c\u201d\u00ab\u00bb]/g, '\u0022').replace(/[\u2018\u2019]/g, '\'').replace(/\u00a0/g, ' ');
}

function levenshtein(a: string, b: string): number {
	if (a === b) {
		return 0;
	}
	if (!a.length) {
		return b.length;
	}
	if (!b.length) {
		return a.length;
	}
	const prev = new Array<number>(b.length + 1);
	const next = new Array<number>(b.length + 1);
	for (let j = 0; j <= b.length; j++) {
		prev[j] = j;
	}
	for (let i = 1; i <= a.length; i++) {
		next[0] = i;
		for (let j = 1; j <= b.length; j++) {
			const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
			next[j] = Math.min(next[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
		}
		for (let j = 0; j <= b.length; j++) {
			prev[j] = next[j];
		}
	}
	return prev[b.length];
}
