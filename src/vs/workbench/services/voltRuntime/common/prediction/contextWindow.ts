/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Pure text-windowing helpers for prediction context. String in, string out - the browser
 * layer feeds these from ITextModel; tests feed them literals.
 */

export interface IExcerptBudget {
	/** Max characters of prefix (text before the cursor). */
	before: number;
	/** Max characters of suffix (text after the cursor). */
	after: number;
}

export const DEFAULT_EXCERPT_BUDGET: IExcerptBudget = { before: 3000, after: 1500 };

export interface IExcerpt {
	prefix: string;
	suffix: string;
}

/**
 * Cuts a prefix/suffix window around `offset`. Cuts snap outward to the next line break so
 * the model never sees a half line at the window edge (except at file boundaries).
 */
export function extractExcerpt(text: string, offset: number, budget: IExcerptBudget = DEFAULT_EXCERPT_BUDGET): IExcerpt {
	const clamped = Math.max(0, Math.min(offset, text.length));

	let start = Math.max(0, clamped - budget.before);
	if (start > 0) {
		const nl = text.indexOf('\n', start);
		if (nl !== -1 && nl < clamped) {
			start = nl + 1;
		}
	}

	let end = Math.min(text.length, clamped + budget.after);
	if (end < text.length) {
		const nl = text.lastIndexOf('\n', end);
		if (nl > clamped) {
			end = nl;
		}
	}

	return { prefix: text.slice(start, clamped), suffix: text.slice(clamped, end) };
}

const IMPORT_LINE = /^\s*(import\s|from\s.+\simport\s|export\s+\{[^}]*\}\s+from\s|const\s+\w+\s*=\s*require\(|use\s+[\w:]+;|#include\s|using\s+[\w.]+;|require\s+['"]|package\s+[\w.]+)/;

/**
 * Collects the leading import/require block (first ~60 lines scanned). Language-agnostic
 * line heuristic - good enough for prompt context, never used for edits.
 */
export function extractImports(text: string, maxLines = 60): string {
	const out: string[] = [];
	const lines = text.split('\n', maxLines);
	for (const line of lines) {
		if (IMPORT_LINE.test(line)) {
			out.push(line.trimEnd());
		}
	}
	return out.join('\n');
}

/** Truncates a snippet for prompt/ring-buffer use, marking the cut. */
export function truncateSnippet(text: string, maxChars = 400): string {
	if (text.length <= maxChars) {
		return text;
	}
	return `${text.slice(0, maxChars)}...`;
}
